# アメダス日別データ収集システム

Cloudflare Workers + D1 を使って、気象庁アメダスの日別気象データを取得・蓄積・APIとして提供するシステムを実装する。

---

## 技術スタック

- **Runtime**: Cloudflare Workers (TypeScript)
- **DB**: Cloudflare D1 (SQLite)
- **配信**: Cloudflare Pages（オプション、フロントエンドがある場合）
- **パッケージマネージャ**: npm
- **設定**: wrangler.toml

---

## プロジェクト構造

```
amedas-collector/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # Workerエントリポイント（ルーティング + Cron）
│   ├── db.ts             # D1操作ラッパー
│   ├── bosai.ts          # bosai API取得・集計
│   ├── etrn.ts           # etrn HTMLスクレイピング・パース
│   └── utils.ts          # 日付ユーティリティ
└── scripts/
    └── seed.ts           # 初回データ投入スクリプト（ローカル実行用）
```

---

## D1 スキーマ

```sql
CREATE TABLE IF NOT EXISTS amedas_daily (
  date        TEXT NOT NULL,
  point_code  TEXT NOT NULL,
  temp_max    REAL,
  temp_min    REAL,
  temp_avg    REAL,
  precip_sum  REAL,
  wind_max    REAL,
  sunshine_h  REAL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (date, point_code)
);
```

`wrangler d1 execute amedas-db --file=schema.sql` で適用する。

---

## データソース仕様

### bosai API（差分 ≤ 7日の補完に使用）

1日 = UTCベースの3時間ファイル × 8本

```
GET https://www.jma.go.jp/bosai/amedas/data/point/{point_code}/{YYYYMMDD}_{HH}0000.json
```

- `{HH}` は `00 03 06 09 12 15 18 21`
- 各JSONはキー=`YYYYMMDDHHmmss`、値=観測値オブジェクト
- 必要フィールド：`temp[0]`（気温℃）、`precipitation1h[0]`（1時間降水量mm）、`wind[0]`（風速m/s）

1日分の集計：
- `temp_max` / `temp_min` / `temp_avg`: temp の最大・最小・平均
- `precip_sum`: precipitation1h の合計
- `wind_max`: wind の最大

### etrn（差分 > 7日の補完に使用）

月単位でHTMLページをfetchしてテーブルをパース。

```
GET https://www.data.jma.go.jp/obd/stats/etrn/view/daily_a1.php
  ?prec_no=48&block_no={point_code}&year={YYYY}&month={M}&day=&view=p1
```

テーブルのカラム順（tbody内 `<tr>` の `<td>` 順）:

| インデックス | 内容 |
|---|---|
| 0 | 日（1〜31） |
| 1 | 降水量合計 (mm) |
| 2 | 最高気温 (℃) |
| 3 | 最低気温 (℃) |
| 4 | 平均気温 (℃) |
| 5 | 最大風速 (m/s) |
| 6 | 日照時間 (h) |

- `<td>` 内にHTMLタグが混在する場合はstrip後にparseFloat
- 欠損値（`---`等）は `null` として格納
- fetchする際は `User-Agent: Mozilla/5.0` を付与

---

## 差分補完ロジック（`src/db.ts` or `src/index.ts`）

```
1. D1から SELECT MAX(date) WHERE point_code = ? を取得 → latestDate
2. latestDate が null の場合は補完スキップ（seed済み前提）
3. yesterday = 今日(JST) - 1日
4. diffDays = yesterday - latestDate（日数）
5. diffDays <= 0 → スキップ
6. diffDays <= 7 → bosai.ts で日ごとに補完
7. diffDays > 7  → etrn.ts で月ごとに補完
8. 補完後 INSERT OR REPLACE INTO amedas_daily
```

JST = UTC+9。`new Date()` はUTCなので変換に注意。

---

## Worker エントリポイント仕様

### HTTPルーティング

```
GET /api/daily
  クエリパラメータ:
    point  : 地点コード（デフォルト: 48141）
    from   : YYYY-MM-DD
    to     : YYYY-MM-DD
  処理:
    1. 差分補完を実行（fillGap）
    2. D1から該当期間をSELECTしてJSONで返す
  レスポンス: Content-Type: application/json
    [ { date, point_code, temp_max, temp_min, temp_avg, precip_sum, wind_max, sunshine_h }, ... ]
```

### Cron Trigger

```toml
# wrangler.toml
[triggers]
crons = ["0 21 * * *"]   # UTC 21:00 = JST 06:00
```

Cron実行時は地点コード `48141` に対して差分補完のみ実行（HTTPレスポンスなし）。

---

## wrangler.toml テンプレート

```toml
name = "amedas-collector"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "amedas-db"
database_id = "YOUR_D1_DATABASE_ID"

[triggers]
crons = ["0 21 * * *"]
```

---

## 初回データ投入スクリプト（`scripts/seed.ts`）

ローカルで実行。対象地点・期間のetrnページを月単位でfetchしてパースし、SQLファイルを生成する。

```
npx ts-node scripts/seed.ts --point 48141 --from 2020-01-01 --to 2024-12-31
```

出力: `seed.sql`（INSERT OR REPLACE文の羅列）

その後:
```
wrangler d1 execute amedas-db --remote --file=seed.sql
```

---

## 対象地点（初期）

| point_code | 地点名 | prec_no |
|---|---|---|
| 48141 | 原村（長野県茅野市付近） | 48 |

---

## 実装上の注意

- WorkerからetrnへのリクエストがCloudflare IPでブロックされる場合、etrn補完はCron内でのみ実行し、HTTPリクエスト時はbosaiのみにフォールバックする
- etrnのHTMLパースはページ構造変更で壊れる可能性があるため、パースエラー時はbosaiにフォールバックしてエラーログを残す
- D1への書き込みは `INSERT OR REPLACE`（冪等）で統一する
- bosai APIの10分値ファイルは前日分まで確定。当日分は未確定のため取得しない
