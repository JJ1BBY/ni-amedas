# DESIGN.md — アメダス日別データ収集システム（検証済み正本）

> **重要:** 同梱の `CLAUDE.md` はハンドオフ仕様書だが、データソース記述（地点コード・URL・
> ファイル名・etrn列順）は**ほぼ全項目が誤っている**。2026-06-17 に実APIをcurlで叩いて
> 検証した結果に基づく**本書が実装の正本**である。CLAUDE.md の値は使わないこと。

---

## 1. アーキテクチャ概要

- **Runtime**: Cloudflare Workers（TypeScript）単体
- **DB**: Cloudflare D1（SQLite）
- **フロント配信**: 同一 Worker の静的アセット（`[assets] directory="./public"`）。Pages不使用
- **スケジュール**: 外部 cron-job.org → 保護付き `GET/POST /cron/collect?token=SECRET`
  （Cloudflare Cron Trigger は使わない。`wrangler.toml` に `[triggers]` なし）
- **コスト**: 上記ワークロードは Cloudflare 無料枠に収まる

すべて1つの Worker デプロイに集約（API + 差分補完 + 静的UI配信）。同一オリジンのため CORS 不要。

---

## 2. 地点コードは3体系が別物（最重要）

| 用途 | 原村の値 | 備考 |
|---|---|---|
| 正準キー `point_code` | `48561` | **bosai 5桁を採用**（観測番号で安定） |
| bosai_code | `48561` | bosai API のパス。`amedastable.json` の kjName で解決可 |
| etrn prec_no | `48` | 長野県 |
| etrn block_no | `0414` | **4桁・bosaiと別体系**。`48141`でも`48561`でもない |

- CLAUDE.md の `48141` は実は**白馬**（bosai で確認）。原村は `48561`。
- etrn block_no は `prefecture.php?prec_no=48` のHTML内 `viewPoint('a','0414','原村',…)` から取得
  （type `'a'` = daily_a1.php を使うアメダス地点）。

これらを `points` マスタテーブルで吸収し、**地点追加 = 1行 INSERT** で済むようにする。

---

## 3. bosai API（差分 ≤ 7日の補完）

- **URL**: `https://www.jma.go.jp/bosai/amedas/data/point/{bosai_code}/{YYYYMMDD}_{HH}.json`
  - CLAUDE.md の `_{HH}0000.json` は **404**。正しくは `_03.json` 等の**2桁**。
  - `{HH}` = `00 03 06 09 12 15 18 21`（3時間ファイル × 8本/日、各10分値）
- 値は `[値, 品質フラグ]` の配列。`[0]` が値（null は欠測）。
- 必要フィールド: `temp` / `precipitation10m` / `wind` / `sun10m`
- 日次集計:
  - `temp_max/min/avg` = temp の最大/最小/平均
  - `precip_sum` = **`precipitation10m` の合計**
    （※CLAUDE.md の「`precipitation1h` 合計」は移動1時間値の二重計上で約6倍過大になるため不採用）
  - `wind_max` = wind の最大
  - `sunshine_h` = `sun10m` の合計
- 404 の日はスキップ（bosai は直近のみ保持。古い日が混じる fallback 時に発生しうる）。
- **検証済み（2026-06-17）**:
  - `sun10m` は**分**単位（10=その10分が全て日照、`sun1h=1.0`時間と一致）→ 日合計は `sum/60` で時間化。
  - `precipitation10m`(mm) 合計＝日降水量。同日を etrn と突合し precip・wind は一致、temp/sun も近接
    （bosaiは10分標本のため最高気温はetrnの瞬間値よりやや低めに出る。≤7日補完では許容）。
  - 残課題（任意の改善）: temp_max/min は各エントリの `maxTemp`/`minTemp` を使うと etrn と更に整合。
    bosai 時刻軸（JST/UTC）は当日を取得しない運用のため実害なし。

---

## 4. etrn（差分 > 7日の補完 / 初回 seed）

- **URL**: `https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php?prec_no={prec}&block_no={block}&year={Y}&month={M}&day=&view=p1`
  - CLAUDE.md の `/obd/stats/etrn/...` は **301 リダイレクト**。`/obd` を除く。
- 文字コード UTF-8。`User-Agent: Mozilla/5.0` を付与。
- 欠測マーカーは複数: `///`（欠測）`×`（観測なし）空欄 `--` `)`（利用注意の括弧付き値は数値を採用）。
  → 数字・小数点・マイナス以外を除去し、数値化できなければ `null`。

### 4.1 列は固定indexにせず header-driven で解決（多地点対応の核心）

etrn の `daily_a1.php` は**観測センサ構成により列数が地点ごとに変わる**（原村は湿度センサ付き
で湿度2列が入る等）。固定 td インデックスで書くと2地点目で壊れる。

**方式**: テーブル先頭のグループ見出し行（`日 / 降水量 / 気温 / 湿度 / 風向・風速 / 日照時間 / 雪`）
の各セルの `colspan` を読み、累積でグループ開始leaf位置を算出。グループ内の小列オフセットは
グループ種別ごとに固定なので、グループが欠けても自動で位置が補正される。

| 取得値 | グループ | グループ内オフセット |
|---|---|---|
| precip_sum | 降水量 | 0（合計） |
| temp_avg | 気温 | 0 |
| temp_max | 気温 | 1 |
| temp_min | 気温 | 2 |
| wind_max | 風向・風速 | 1（平均風速=0, 最大風速の風速値=1） |
| sunshine_h | 日照時間 | 0 |

### 4.2 原村の実列（検証で確定、参考）

```
td0 日  td1 降水合計  td2 降水最大1h  td3 降水最大10min
td4 気温平均  td5 気温最高  td6 気温最低
td7 湿度平均  td8 湿度最小
td9 平均風速  td10 最大風速値  td11 最大風速向  td12 最大瞬間値  td13 最大瞬間向  td14 最多風向
td15 日照時間  td16 降雪合計  td17 最深積雪
```

→ 必要値: temp_max=td5, temp_min=td6, temp_avg=td4, precip_sum=td1, wind_max=td10, sunshine_h=td15。
（CLAUDE.md の「td2=最高気温」等は誤り。）

---

## 5. 差分補完ロジック（fillGap, `src/db.ts`）

```
1. SELECT MAX(date) WHERE point_code=? → latest
2. latest === null → スキップ（seed済み前提）
3. yesterday = 今日(JST) - 1
4. diffDays = yesterday - latest
5. diffDays <= 0 → スキップ
6. diffDays <= 7 → bosai で日ごと補完
7. diffDays >  7 → etrn で月ごと補完（失敗時 bosai フォールバック + ログ）
8. INSERT OR REPLACE INTO amedas_daily（冪等）
```

JST = UTC+9。日付は `YYYY-MM-DD` 文字列（JST暦日）で統一して扱う。

---

## 6. HTTP API

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/daily?point=48561&from=&to=` | 前方補完(fillGap)＋後方補完(backfill) 後に期間を SELECT → JSON 配列 |
| GET | `/api/points` | enabled 地点一覧 `[{point_code, name}]`（UIのセレクタ供給） |
| POST | `/api/points` | 地点登録（body: point_code/name/bosai_code/etrn_prec_no/etrn_block_no）。**token不要**（UIから人が追加できるよう開放。破壊的でないため） |
| DELETE | `/api/points?point=` | 地点＋日別データ削除。token は POST と同条件 |
| GET | `/api/resolve?prec=&block=` / `?bosai=` / `?name=` | etrn地点選択ページ＋amedastable で 名称↔bosai_code を解決（UIの「解析」用） |
| GET/POST | `/cron/collect?token=SECRET` | token 照合 → enabled 全地点 fillGap（cron-job.org が叩く） |
| GET | `/`, `/app.js` 等 | `public/` の静的アセット（Worker未マッチ時に配信） |

`CRON_TOKEN` は `wrangler secret put CRON_TOKEN` で設定。

### backfill（過去への遡及取得, `db.ts` backfillEtrn）

`/api/daily` で `from` が保存済みの最古日 `MIN(date)` より前なら、`[from, MIN-1]` を etrn で
月単位取得して保存する。**新しい月→古い月**の順で埋めるため `MIN` が連続的に過去へ伸び、穴が
できない。1リクエストの取得上限は既定 36ヶ月（Workers サブリクエスト上限対策）。超過分は
再アクセスで `MIN` が更新され続きから埋まる。月ごとに INSERT OR REPLACE するため途中失敗でも
進捗は残る。新規登録地点（データ0）は初回閲覧時にこの経路で `from` に応じ自動投入される。

---

## 7. デプロイ手順

```
1. wrangler d1 create amedas-db        # database_id を wrangler.toml に記入
2. wrangler d1 execute amedas-db --remote --file=schema.sql
3. wrangler secret put CRON_TOKEN
4. npx tsx scripts/seed.ts --point 48561 --from 2020-01-01 --to 2024-12-31
   wrangler d1 execute amedas-db --remote --file=seed.sql
5. wrangler deploy
6. cron-job.org に「Asia/Tokyo 06:00 に https://<worker>/cron/collect?token=<SECRET> をGETで叩く」を登録
```

---

## 7.5 出典表示の義務（気象庁利用規約）

唯一の実質的義務は **出典記載**。本実装では UI フッター（`public/index.html`）と README に下記を明記。

> 出典：気象庁ホームページ（https://www.jma.go.jp/）
> 本サイトの数値は、気象庁が公開する観測値（アメダス）を **日別に集計・加工** したもの。

日別集計（最高/最低/平均・降水合計・最大風速・日照）は加工値のため「加工した旨」の併記が必須。
再配布・公開時もこの表示を保持すること。

## 8. 地点を追加する手順（拡張ポイント）

1. bosai_code を `amedastable.json` の kjName から特定
2. etrn の prec_no / block_no を `prefecture.php` の `viewPoint('a',...)` から特定
3. `points` に1行 INSERT（`scripts/seed.ts` の REGISTRY にも追記）
4. 必要なら seed を実行 → 以降は fillGap が自動追従。UIは `/api/points` から自動でセレクタに出る
