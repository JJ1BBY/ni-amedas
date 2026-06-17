// Worker エントリポイント：API ルーティング + 外部cron用の収集エンドポイント。
// 静的アセット（public/）は [assets] バインディングが処理し、未マッチ要求のみ本handlerに来る。
import {
  addPoint,
  backfillEtrn,
  deletePoint,
  fillGap,
  getDaily,
  getEarliestDate,
  getPoint,
  getPoints,
} from "./db";
import type { Point } from "./db";
import { addDays, todayJst, yesterdayJst } from "./utils";

export interface Env {
  DB: D1Database;
  CRON_TOKEN?: string;
}

const DEFAULT_POINT = "48561";
const DEFAULT_RANGE_DAYS = 30;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case "/api/points":
          if (req.method === "POST") return await handleAddPoint(req, env, url);
          if (req.method === "DELETE") return await handleDeletePoint(req, env, url);
          return await handlePoints(env);
        case "/api/daily":
          return await handleDaily(env, url);
        case "/api/resolve":
          return await handleResolve(url);
        case "/cron/collect":
          return await handleCron(req, env, url);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e) {
      console.error(e);
      return json({ error: errMsg(e) }, 500);
    }
  },
};

async function handlePoints(env: Env): Promise<Response> {
  const points = await getPoints(env.DB, true);
  return json(points.map((p) => ({ point_code: p.point_code, name: p.name })));
}

async function handleDaily(env: Env, url: URL): Promise<Response> {
  const pointCode = url.searchParams.get("point") ?? DEFAULT_POINT;
  const to = url.searchParams.get("to") ?? todayJst();
  const from = url.searchParams.get("from") ?? addDays(to, -DEFAULT_RANGE_DAYS);

  const point = await getPoint(env.DB, pointCode);
  if (!point) return json({ error: `unknown point ${pointCode}` }, 404);

  // 前方補完: MAX(date)→昨日（失敗してもDBの既存分は返す）
  try {
    await fillGap(env.DB, point);
  } catch (e) {
    console.error("fillGap error:", e);
  }

  // 後方補完(backfill): from が既存の最古日より前なら etrn で過去を取得
  try {
    const yesterday = yesterdayJst();
    const effTo = to < yesterday ? to : yesterday;
    const earliest = await getEarliestDate(env.DB, pointCode);
    if (earliest === null) {
      await backfillEtrn(env.DB, point, from, effTo);
    } else if (from < earliest) {
      await backfillEtrn(env.DB, point, from, addDays(earliest, -1));
    }
  } catch (e) {
    console.error("backfill error:", e);
  }

  const rows = await getDaily(env.DB, pointCode, from, to);
  return json(rows);
}

async function handleAddPoint(req: Request, env: Env, url: URL): Promise<Response> {
  // CRON_TOKEN が設定されていれば認証必須（本番）。未設定ならローカル開発として許可。
  const token = url.searchParams.get("token") ?? req.headers.get("x-cron-token");
  if (env.CRON_TOKEN && token !== env.CRON_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const pointCode = str(body?.point_code);
  const name = str(body?.name);
  if (!pointCode || !name) {
    return json({ error: "point_code と name は必須です" }, 400);
  }

  const point: Point = {
    point_code: pointCode,
    name,
    bosai_code: str(body?.bosai_code) ?? pointCode,
    etrn_prec_no: str(body?.etrn_prec_no),
    etrn_block_no: str(body?.etrn_block_no),
    enabled: 1,
  };
  await addPoint(env.DB, point);
  // データは初回閲覧時の backfill が from に応じて取得する（ここでは登録のみ）。
  return json({ added: pointCode, name });
}

async function handleDeletePoint(req: Request, env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? req.headers.get("x-cron-token");
  if (env.CRON_TOKEN && token !== env.CRON_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  const pointCode = url.searchParams.get("point");
  if (!pointCode) return json({ error: "point は必須です" }, 400);
  await deletePoint(env.DB, pointCode);
  return json({ deleted: pointCode });
}

interface AmedasTableEntry {
  kjName?: string;
  knName?: string;
}

/**
 * 地点を解決する。優先順位:
 *   1. prec + block（etrn URL由来）→ etrn地点選択ページで名称を引き、amedastableでbosai_codeを引く
 *   2. bosai（bosai地点コード）→ 名称を引く
 *   3. name（手入力）→ bosai_codeを引く
 * 県プレフィックス（bosaiコード先頭2桁 == etrn prec_no）で同名の他県地点を除外する。
 */
async function handleResolve(url: URL): Promise<Response> {
  const bosai = url.searchParams.get("bosai");
  const prec = url.searchParams.get("prec");
  const block = url.searchParams.get("block");
  let name = url.searchParams.get("name");

  // etrn URL由来: prec+block から地点名を取得
  if (!name && !bosai && prec && block) {
    name = await etrnStationName(prec, block);
    if (!name) return json({ name: null, matches: [], note: "etrn地点選択ページに該当block_noが見つかりません" });
  }
  if (!name && !bosai) return json({ name: null, matches: [] });

  const res = await fetch("https://www.jma.go.jp/bosai/amedas/const/amedastable.json", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) return json({ error: `amedastable HTTP ${res.status}` }, 502);
  const table = (await res.json()) as Record<string, AmedasTableEntry>;

  type Match = { bosai_code: string; name: string; kana: string };
  const exact: Match[] = [];
  const partial: Match[] = [];
  for (const [code, v] of Object.entries(table)) {
    if (prec && !code.startsWith(prec)) continue; // 県で絞る（同名地点の誤マッチ防止）
    const entry: Match = { bosai_code: code, name: v.kjName ?? "", kana: v.knName ?? "" };
    if (bosai) {
      if (code === bosai) exact.push(entry);
    } else if (name) {
      if (v.kjName === name) exact.push(entry);
      else if (v.kjName?.includes(name)) partial.push(entry);
    }
  }
  return json({ name, matches: [...exact, ...partial].slice(0, 20) });
}

/** etrnの都道府県地点選択ページから block_no に対応する地点名を取得する。 */
async function etrnStationName(prec: string, block: string): Promise<string | null> {
  const url =
    `https://www.data.jma.go.jp/stats/etrn/select/prefecture.php` +
    `?prec_no=${encodeURIComponent(prec)}&block_no=&year=&month=&day=&view=`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;
  const html = await res.text();
  // viewPoint('a','0414','原村','ハラムラ', ...) の第3引数が漢字名
  const safeBlock = block.replace(/[^\w]/g, ""); // 正規表現に埋め込むため英数字以外を除去
  const m = html.match(new RegExp(`viewPoint\\('[as]','${safeBlock}','([^']*)'`));
  return m ? m[1] : null;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

async function handleCron(req: Request, env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? req.headers.get("x-cron-token");
  if (!env.CRON_TOKEN || token !== env.CRON_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }

  const points = await getPoints(env.DB, true);
  const results = [];
  for (const p of points) {
    try {
      results.push(await fillGap(env.DB, p));
    } catch (e) {
      results.push({ point: p.point_code, error: errMsg(e) });
    }
  }
  return json({ ran: new Date().toISOString(), results });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
