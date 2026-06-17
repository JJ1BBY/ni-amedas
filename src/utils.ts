// 日付ユーティリティ。日付は JST 暦日の 'YYYY-MM-DD' 文字列で統一して扱う。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Date の UTC 日付部分を YYYY-MM-DD に整形（呼び出し側で JST シフト済み前提） */
function toYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** JST での「今日」 YYYY-MM-DD */
export function todayJst(): string {
  return toYmd(new Date(Date.now() + JST_OFFSET_MS));
}

/** JST での「昨日」 YYYY-MM-DD（bosai は前日分まで確定のため補完の上限） */
export function yesterdayJst(): string {
  return addDays(todayJst(), -1);
}

/** YYYY-MM-DD に days を加算した YYYY-MM-DD */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toYmd(d);
}

/** a - b の日数（a, b は YYYY-MM-DD） */
export function diffDays(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  return Math.round((da - db) / 86_400_000);
}

/** YYYY-MM-DD -> YYYYMMDD */
export function compactYmd(ymd: string): string {
  return ymd.replace(/-/g, "");
}

/** from..to（両端含む）の各日を YYYY-MM-DD 配列で返す */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  while (diffDays(cur, to) <= 0) {
    out.push(cur);
    if (cur === to) break;
    cur = addDays(cur, 1);
  }
  return out;
}

/** from..to を跨ぐ各月 {year, month} を列挙 */
export function eachMonth(from: string, to: string): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ year: y, month: m });
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** 小数1桁に丸める */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 1〜2桁を2桁ゼロ埋め */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** その年月の末日（1始まり month） */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
