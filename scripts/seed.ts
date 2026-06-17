// 初回データ投入スクリプト（ローカル / tsx 実行）。
// 対象地点・期間の etrn を月単位で取得・パースし、seed.sql（INSERT OR REPLACE 羅列）を生成する。
//
//   npx tsx scripts/seed.ts --point 48561 --from 2020-01-01 --to 2024-12-31
//   wrangler d1 execute amedas-db --remote --file=seed.sql
//
import { writeFileSync } from "node:fs";
import { fetchEtrnRange } from "../src/etrn";
import type { DailyRow, Point } from "../src/db";

// 地点レジストリ（schema.sql の points と対応。地点追加時はここにも追記）。
const REGISTRY: Record<string, { name: string; prec: string; block: string }> = {
  "48561": { name: "原村", prec: "48", block: "0414" },
};

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function sqlNum(n: number | null): string {
  return n === null ? "NULL" : String(n);
}

function toInsert(r: DailyRow, fetchedAt: string): string {
  return (
    `INSERT OR REPLACE INTO amedas_daily ` +
    `(date, point_code, temp_max, temp_min, temp_avg, precip_sum, wind_max, sunshine_h, fetched_at) ` +
    `VALUES (${sqlStr(r.date)}, ${sqlStr(r.point_code)}, ` +
    `${sqlNum(r.temp_max)}, ${sqlNum(r.temp_min)}, ${sqlNum(r.temp_avg)}, ` +
    `${sqlNum(r.precip_sum)}, ${sqlNum(r.wind_max)}, ${sqlNum(r.sunshine_h)}, ${sqlStr(fetchedAt)});`
  );
}

async function main(): Promise<void> {
  const pointCode = arg("point", "48561")!;
  const from = arg("from");
  const to = arg("to");
  const reg = REGISTRY[pointCode];
  const prec = arg("prec", reg?.prec);
  const block = arg("block", reg?.block);
  const out = arg("out", "seed.sql")!;

  if (!from || !to || !prec || !block) {
    console.error(
      "Usage: tsx scripts/seed.ts --point <code> --from YYYY-MM-DD --to YYYY-MM-DD [--prec N --block N --out seed.sql]",
    );
    process.exit(1);
  }

  const point: Point = {
    point_code: pointCode,
    name: reg?.name ?? pointCode,
    bosai_code: pointCode,
    etrn_prec_no: prec,
    etrn_block_no: block,
    enabled: 1,
  };

  console.error(`fetching etrn for ${point.name}(${pointCode}) ${from}..${to} ...`);
  const rows = await fetchEtrnRange(point, from, to);
  const fetchedAt = new Date().toISOString();
  const body = rows.map((r) => toInsert(r, fetchedAt)).join("\n");
  writeFileSync(out, body + "\n", "utf-8");
  console.error(`wrote ${rows.length} rows to ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
