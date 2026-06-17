// D1 操作ラッパ＋差分補完オーケストレーション。
// 注: bosai.ts / etrn.ts は db.ts から型のみ import するため実行時の循環依存はない。
import { fetchBosaiRange } from "./bosai";
import { fetchEtrnRange } from "./etrn";
import { addDays, diffDays, eachMonth, lastDayOfMonth, pad2, yesterdayJst } from "./utils";

export interface Point {
  point_code: string;
  name: string;
  bosai_code: string | null;
  etrn_prec_no: string | null;
  etrn_block_no: string | null;
  enabled: number;
}

export interface DailyRow {
  date: string;
  point_code: string;
  temp_max: number | null;
  temp_min: number | null;
  temp_avg: number | null;
  precip_sum: number | null;
  wind_max: number | null;
  sunshine_h: number | null;
}

export async function getPoints(db: D1Database, enabledOnly = true): Promise<Point[]> {
  const sql = enabledOnly
    ? "SELECT * FROM points WHERE enabled = 1 ORDER BY point_code"
    : "SELECT * FROM points ORDER BY point_code";
  const { results } = await db.prepare(sql).all<Point>();
  return results ?? [];
}

export async function addPoint(db: D1Database, p: Point): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO points (point_code, name, bosai_code, etrn_prec_no, etrn_block_no, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(p.point_code, p.name, p.bosai_code, p.etrn_prec_no, p.etrn_block_no, p.enabled ?? 1)
    .run();
}

export async function deletePoint(db: D1Database, pointCode: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM amedas_daily WHERE point_code = ?").bind(pointCode),
    db.prepare("DELETE FROM points WHERE point_code = ?").bind(pointCode),
  ]);
}

export async function getPoint(db: D1Database, pointCode: string): Promise<Point | null> {
  return await db
    .prepare("SELECT * FROM points WHERE point_code = ?")
    .bind(pointCode)
    .first<Point>();
}

export async function getLatestDate(db: D1Database, pointCode: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT MAX(date) AS d FROM amedas_daily WHERE point_code = ?")
    .bind(pointCode)
    .first<{ d: string | null }>();
  return row?.d ?? null;
}

export async function getEarliestDate(db: D1Database, pointCode: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT MIN(date) AS d FROM amedas_daily WHERE point_code = ?")
    .bind(pointCode)
    .first<{ d: string | null }>();
  return row?.d ?? null;
}

export async function getDaily(
  db: D1Database,
  pointCode: string,
  from: string,
  to: string,
): Promise<DailyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT date, point_code, temp_max, temp_min, temp_avg, precip_sum, wind_max, sunshine_h
       FROM amedas_daily
       WHERE point_code = ? AND date >= ? AND date <= ?
       ORDER BY date`,
    )
    .bind(pointCode, from, to)
    .all<DailyRow>();
  return results ?? [];
}

export async function upsertDaily(db: D1Database, rows: DailyRow[]): Promise<void> {
  if (rows.length === 0) return;
  const fetchedAt = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO amedas_daily
       (date, point_code, temp_max, temp_min, temp_avg, precip_sum, wind_max, sunshine_h, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const batch = rows.map((r) =>
    stmt.bind(
      r.date,
      r.point_code,
      r.temp_max,
      r.temp_min,
      r.temp_avg,
      r.precip_sum,
      r.wind_max,
      r.sunshine_h,
      fetchedAt,
    ),
  );
  await db.batch(batch);
}

export interface FillResult {
  point: string;
  filled: number;
  via: string;
}

/**
 * 差分補完。latest が null（未seed）の地点はスキップ。
 * diff <= 7 は bosai、> 7 は etrn（失敗時 bosai フォールバック）で補完し INSERT OR REPLACE。
 */
export async function fillGap(db: D1Database, point: Point): Promise<FillResult> {
  const latest = await getLatestDate(db, point.point_code);
  if (latest === null) return { point: point.point_code, filled: 0, via: "skip(no-seed)" };

  const yesterday = yesterdayJst();
  const dd = diffDays(yesterday, latest);
  if (dd <= 0) return { point: point.point_code, filled: 0, via: "skip(up-to-date)" };

  const from = addDays(latest, 1);
  const to = yesterday;

  let rows: DailyRow[];
  let via: string;
  if (dd <= 7) {
    rows = await fetchBosaiRange(point, from, to);
    via = "bosai";
  } else {
    try {
      rows = await fetchEtrnRange(point, from, to);
      via = "etrn";
    } catch (e) {
      console.error(`etrn failed for ${point.point_code}, fallback to bosai:`, e);
      rows = await fetchBosaiRange(point, from, to);
      via = "bosai(fallback)";
    }
  }

  await upsertDaily(db, rows);
  return { point: point.point_code, filled: rows.length, via };
}

/**
 * 直近 days 日を etrn で再取得して上書きする（reconcile）。
 * 差分 <= 7日 の補完は bosai の自前集計（10分値平均・UTC窓）で、JMA公式の日平均
 * （毎正時24値の平均）と僅かにずれ得る。etrn が公式値を公開した後にこの窓を
 * INSERT OR REPLACE で上書きし、bosai値を etrn 公式値へ揃える。
 * cron からのみ呼ぶ（毎APIアクセスでetrnを叩かないため）。etrn 失敗時は既存値を保持。
 */
export async function reconcileRecent(
  db: D1Database,
  point: Point,
  days = 10,
): Promise<number> {
  if (!point.etrn_prec_no || !point.etrn_block_no) return 0;
  const to = yesterdayJst();
  const from = addDays(to, -(days - 1));
  try {
    const rows = await fetchEtrnRange(point, from, to);
    await upsertDaily(db, rows);
    return rows.length;
  } catch (e) {
    console.error(`reconcile failed for ${point.point_code}:`, e);
    return 0;
  }
}

/**
 * 過去への遡及取得（backfill）。[from, to] の範囲を etrn で月単位に取得・保存する。
 * 新しい月から古い月へ進めるため、min(date) が連続的に過去へ伸びる（途中に穴ができない）。
 * Workers のサブリクエスト上限対策で 1リクエストあたり maxMonths 月で打ち切る
 * （残りは次回アクセス時に min が更新され続きから埋まる）。
 * 月ごとに INSERT OR REPLACE するため途中で失敗しても進捗は保存される。
 */
export async function backfillEtrn(
  db: D1Database,
  point: Point,
  from: string,
  to: string,
  maxMonths = 36,
): Promise<number> {
  if (!point.etrn_prec_no || !point.etrn_block_no) return 0;
  let total = 0;
  let used = 0;
  for (const { year, month } of eachMonth(from, to).reverse()) {
    if (used >= maxMonths) break;
    const mFrom = `${year}-${pad2(month)}-01`;
    const mTo = `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`;
    const lo = mFrom < from ? from : mFrom;
    const hi = mTo > to ? to : mTo;
    try {
      const rows = await fetchEtrnRange(point, lo, hi);
      await upsertDaily(db, rows);
      total += rows.length;
    } catch (e) {
      console.error(`backfill ${year}-${month} failed for ${point.point_code}:`, e);
    }
    used++;
  }
  return total;
}
