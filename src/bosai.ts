// bosai API 取得・日次集計（差分 <= 7日の補完）。
// URL: https://www.jma.go.jp/bosai/amedas/data/point/{bosai_code}/{YYYYMMDD}_{HH}.json
import type { DailyRow, Point } from "./db";
import { compactYmd, eachDate, round1 } from "./utils";

const HOURS = ["00", "03", "06", "09", "12", "15", "18", "21"];

/** 各観測値は [値, 品質フラグ] の配列。null は欠測。 */
type Pair = [number | null, number] | undefined;

interface BosaiEntry {
  temp?: Pair;
  precipitation10m?: Pair;
  wind?: Pair;
  sun10m?: Pair;
}

function val(pair: Pair): number | null {
  if (!pair) return null;
  return pair[0] ?? null;
}

export async function fetchBosaiRange(point: Point, from: string, to: string): Promise<DailyRow[]> {
  if (!point.bosai_code) return [];
  const rows: DailyRow[] = [];
  for (const date of eachDate(from, to)) {
    const row = await fetchBosaiDay(point.point_code, point.bosai_code, date);
    if (row) rows.push(row);
  }
  return rows;
}

async function fetchBosaiDay(
  pointCode: string,
  bosaiCode: string,
  date: string,
): Promise<DailyRow | null> {
  const ymd = compactYmd(date);
  const temps: number[] = [];
  let precip = 0;
  let precipSeen = false;
  let windMax = -Infinity;
  let windSeen = false;
  let sun = 0;
  let sunSeen = false;

  for (const hh of HOURS) {
    const url = `https://www.jma.go.jp/bosai/amedas/data/point/${bosaiCode}/${ymd}_${hh}.json`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) continue; // 404（古い日/未生成）はスキップ
    const json = (await res.json()) as Record<string, BosaiEntry>;
    for (const entry of Object.values(json)) {
      const t = val(entry.temp);
      if (t !== null) temps.push(t);
      const p = val(entry.precipitation10m);
      if (p !== null) {
        precip += p;
        precipSeen = true;
      }
      const w = val(entry.wind);
      if (w !== null) {
        windMax = Math.max(windMax, w);
        windSeen = true;
      }
      const s = val(entry.sun10m); // sun10m は「分」単位（10=その10分が全て日照）
      if (s !== null) {
        sun += s;
        sunSeen = true;
      }
    }
  }

  if (temps.length === 0 && !precipSeen && !windSeen && !sunSeen) return null;

  return {
    date,
    point_code: pointCode,
    temp_max: temps.length ? round1(Math.max(...temps)) : null,
    temp_min: temps.length ? round1(Math.min(...temps)) : null,
    temp_avg: temps.length ? round1(temps.reduce((a, b) => a + b, 0) / temps.length) : null,
    precip_sum: precipSeen ? round1(precip) : null,
    wind_max: windSeen ? round1(windMax) : null,
    sunshine_h: sunSeen ? round1(sun / 60) : null, // 分→時間
  };
}
