// etrn HTML スクレイピング・パース（差分 > 7日の補完 / 初回 seed）。
// URL: https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php
//   ?prec_no={prec}&block_no={block}&year={Y}&month={M}&day=&view=p1
// 列は固定indexにせず、グループ見出し行の colspan から動的に位置を解決する（多地点対応）。
import type { DailyRow, Point } from "./db";
import { eachMonth, pad2 } from "./utils";

type Field = "precip_sum" | "temp_avg" | "temp_max" | "temp_min" | "wind_max" | "sunshine_h";

// グループ見出し（部分一致）＋グループ内での小列オフセット。
const FIELD_SPECS: { group: string; field: Field; offset: number }[] = [
  { group: "降水量", field: "precip_sum", offset: 0 }, // 合計
  { group: "気温", field: "temp_avg", offset: 0 }, // 平均
  { group: "気温", field: "temp_max", offset: 1 }, // 最高
  { group: "気温", field: "temp_min", offset: 2 }, // 最低
  { group: "風向・風速", field: "wind_max", offset: 1 }, // 平均風速=0, 最大風速の風速値=1
  { group: "日照時間", field: "sunshine_h", offset: 0 },
];

export async function fetchEtrnRange(point: Point, from: string, to: string): Promise<DailyRow[]> {
  if (!point.etrn_prec_no || !point.etrn_block_no) {
    throw new Error(`etrn codes missing for point ${point.point_code}`);
  }
  const all: DailyRow[] = [];
  for (const { year, month } of eachMonth(from, to)) {
    const html = await fetchEtrnMonth(point.etrn_prec_no, point.etrn_block_no, year, month);
    const idx = resolveIndices(html);
    if (idx.temp_max === undefined && idx.precip_sum === undefined) {
      throw new Error(`etrn parse failed (no columns) for ${point.point_code} ${year}-${month}`);
    }
    for (const r of parseDataRows(html, idx, point.point_code, year, month)) {
      if (r.date >= from && r.date <= to) all.push(r);
    }
  }
  return all;
}

async function fetchEtrnMonth(
  prec: string,
  block: string,
  year: number,
  month: number,
): Promise<string> {
  const url =
    `https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php` +
    `?prec_no=${prec}&block_no=${block}&year=${year}&month=${month}&day=&view=p1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`etrn HTTP ${res.status} for ${url}`);
  return await res.text();
}

/** グループ見出し行の colspan を読み、各フィールドの絶対列indexを解決する。 */
function resolveIndices(html: string): Partial<Record<Field, number>> {
  const headerRow = findGroupHeaderRow(html);
  const starts = new Map<string, number>(); // グループ見出しテキスト -> 開始leaf index
  if (headerRow) {
    let leaf = 0;
    for (const m of headerRow.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)) {
      const colspan = parseInt(m[1].match(/colspan\s*=\s*["']?(\d+)/i)?.[1] ?? "1", 10);
      starts.set(stripTags(m[2]), leaf);
      leaf += colspan;
    }
  }

  const idx: Partial<Record<Field, number>> = {};
  for (const { group, field, offset } of FIELD_SPECS) {
    for (const [label, start] of starts) {
      if (label.includes(group)) {
        idx[field] = start + offset;
        break;
      }
    }
  }
  return idx;
}

/**
 * グループ見出し行を特定する。daily_a1.php のヘッダは複数行で、アイコンの alt 属性にも
 * 「降水量」等が現れるため、raw文字列ではなく <th> セルのテキストで判定する。
 */
function findGroupHeaderRow(html: string): string | null {
  for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const ths = [...m[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((x) => stripTags(x[1]));
    if (ths.some((t) => t.includes("降水量")) && ths.some((t) => t.includes("気温"))) {
      return m[1];
    }
  }
  return null;
}

function parseDataRows(
  html: string,
  idx: Partial<Record<Field, number>>,
  pointCode: string,
  year: number,
  month: number,
): DailyRow[] {
  const rows: DailyRow[] = [];
  for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((x) => stripTags(x[1]));
    if (tds.length < 8) continue;
    const day = parseInt(tds[0], 10);
    if (!Number.isInteger(day) || day < 1 || day > 31 || String(day) !== tds[0].trim()) continue;

    rows.push({
      date: `${year}-${pad2(month)}-${pad2(day)}`,
      point_code: pointCode,
      temp_max: num(tds[idx.temp_max ?? -1]),
      temp_min: num(tds[idx.temp_min ?? -1]),
      temp_avg: num(tds[idx.temp_avg ?? -1]),
      precip_sum: num(tds[idx.precip_sum ?? -1]),
      wind_max: num(tds[idx.wind_max ?? -1]),
      sunshine_h: num(tds[idx.sunshine_h ?? -1]),
    });
  }
  return rows;
}

/** HTMLタグ除去＋空白正規化。 */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 欠測（///, ×, 空, -- 等）は null。括弧付き等の数値は数字部のみ採用。負値も許容。 */
function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const cleaned = s.replace(/[^\d.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? v : null;
}
