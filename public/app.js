// 単一地点の日別データ表示。/api/points でセレクタを動的生成し、/api/daily を取得して描画。
// 地点・日付の変更で即再取得。地点追加フォームから POST /api/points で地点登録も可能。
const $ = (id) => document.getElementById(id);
const els = {
  point: $("point"),
  from: $("from"),
  to: $("to"),
  load: $("load"),
  del: $("del"),
  download: $("download"),
  copyJson: $("copyJson"),
  copyCsv: $("copyCsv"),
  status: $("status"),
  range: $("range"),
  chart: $("chart"),
  tbody: $("table").querySelector("tbody"),
  // 地点追加
  npUrl: $("np_url"),
  npParse: $("np_parse"),
  npCode: $("np_code"),
  npName: $("np_name"),
  npBosai: $("np_bosai"),
  npPrec: $("np_prec"),
  npBlock: $("np_block"),
  npAdd: $("np_add"),
  npStatus: $("np_status"),
};

const ymd = (d) => d.toISOString().slice(0, 10);
const fmt = (v) => (v === null || v === undefined ? "—" : v);

// 直近に取得・表示した内容（CSV出力に使う）
let current = { rows: [], point: "", from: "", to: "" };
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

// URLクエリ（?point=&from=&to=）の読み書き。共有・ブックマーク用。
function readUrlParams() {
  const q = new URLSearchParams(location.search);
  return { point: q.get("point"), from: q.get("from"), to: q.get("to") };
}
function syncUrl(point, from, to) {
  const q = new URLSearchParams({ point, from, to });
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

async function loadPoints(selected) {
  const res = await fetch("/api/points");
  const points = await res.json();
  els.point.innerHTML = points
    .map((p) => `<option value="${p.point_code}">${p.name}（${p.point_code}）</option>`)
    .join("");
  if (selected) els.point.value = selected;
}

async function loadDaily() {
  const point = els.point.value;
  const from = els.from.value;
  const to = els.to.value;
  if (!point || !from || !to) return;
  syncUrl(point, from, to);
  els.load.disabled = true;
  els.status.textContent = "取得中…（未取得の期間は気象庁から自動補完します）";
  try {
    const url = `/api/daily?point=${encodeURIComponent(point)}&from=${from}&to=${to}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error(rows.error || "unexpected response");
    current = { rows, point, from, to };
    render(rows);
    els.range.textContent = `${from} 〜 ${to}（${rows.length}日）`;
    els.status.textContent = rows.length ? "" : "この期間のデータはありません";
  } catch (e) {
    els.status.textContent = `エラー: ${e.message}`;
    renderTable([]);
    els.chart.innerHTML = "";
    els.range.textContent = "";
  } finally {
    els.load.disabled = false;
  }
}

// 貼り付けたURLから prec_no / block_no / bosai_code を抽出する。
function parseStationUrl(raw) {
  const out = {};
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return out;
  }
  const prec = u.searchParams.get("prec_no");
  const block = u.searchParams.get("block_no");
  if (prec) out.prec = prec;
  if (block) out.block = block;
  // bosai 地点JSON: /bosai/amedas/data/point/{code}/...  地図UI: #amdno={code}
  const path = u.pathname.match(/\/amedas\/data\/point\/(\d+)/);
  if (path) out.bosai = path[1];
  const amd = (u.hash + u.search).match(/amdno=(\d+)/);
  if (amd) out.bosai = amd[1];
  return out;
}

async function onParse() {
  const p = parseStationUrl(els.npUrl.value);
  if (!p.prec && !p.block && !p.bosai) {
    els.npStatus.textContent =
      "URLから prec_no / block_no / bosai_code を取得できませんでした。URLをご確認ください。";
    return;
  }
  // 解析は毎回URLから全項目を再導出する（前回の解析結果を残さない）
  els.npPrec.value = p.prec || "";
  els.npBlock.value = p.block || "";
  els.npBosai.value = p.bosai || "";
  els.npName.value = "";
  els.npCode.value = "";

  els.npParse.disabled = true;
  els.npStatus.textContent = "地点名と bosai_code を解決中…";
  try {
    // 解決クエリ: etrn(prec+block)優先、無ければ bosai
    let q = "";
    if (els.npPrec.value && els.npBlock.value) {
      q = `prec=${encodeURIComponent(els.npPrec.value)}&block=${encodeURIComponent(els.npBlock.value)}`;
    } else if (els.npBosai.value) {
      q = `bosai=${encodeURIComponent(els.npBosai.value)}`;
    }
    if (q) {
      const d = await (await fetch(`/api/resolve?${q}`)).json();
      if (d.matches && d.matches[0]) {
        els.npBosai.value = d.matches[0].bosai_code;
        els.npName.value = d.matches[0].name;
        if (d.matches.length > 1)
          els.npStatus.textContent = `※名称候補が${d.matches.length}件。bosai_code を確認してください。`;
      } else if (d.name) {
        els.npName.value = d.name; // etrnの名称は取れたが amedastable 未マッチ
      }
    }
    els.npCode.value = els.npBosai.value || els.npBlock.value || "";
    if (!els.npStatus.textContent.includes("候補")) {
      els.npStatus.textContent =
        `解析結果 → コード=${els.npCode.value || "?"} / 名称=${els.npName.value || "?"} / ` +
        `bosai=${els.npBosai.value || "-"} / prec=${els.npPrec.value || "-"} / block=${els.npBlock.value || "-"}。確認して「登録」。`;
    }
    if (!els.npBosai.value) {
      els.npStatus.textContent += " ※bosai_code未取得（日次自動更新には必要・過去取得は可）。";
    }
  } catch (e) {
    els.npStatus.textContent = `解決エラー: ${e.message}`;
  } finally {
    els.npParse.disabled = false;
  }
}

async function addPoint() {
  const payload = {
    point_code: els.npCode.value.trim(),
    name: els.npName.value.trim(),
    bosai_code: els.npBosai.value.trim(),
    etrn_prec_no: els.npPrec.value.trim(),
    etrn_block_no: els.npBlock.value.trim(),
  };
  if (!payload.point_code || !payload.name) {
    els.npStatus.textContent = "地点コードと名称は必須です";
    return;
  }
  els.npAdd.disabled = true;
  els.npStatus.textContent = "登録中…";
  try {
    // 登録は token 不要（誰でも追加可）
    const res = await fetch("/api/points", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    els.npStatus.textContent = `「${data.name}」を登録しました。選択して開始日を指定すると過去データを取得します。`;
    await loadPoints(payload.point_code);
    loadDaily();
  } catch (e) {
    els.npStatus.textContent = `エラー: ${e.message}`;
  } finally {
    els.npAdd.disabled = false;
  }
}

async function deletePoint() {
  const code = els.point.value;
  if (!code) return;
  const label = els.point.options[els.point.selectedIndex]?.text || code;
  if (!confirm(`地点「${label}」と、その日別データを削除します。よろしいですか？`)) return;

  els.del.disabled = true;
  try {
    const reqDelete = (tok) =>
      fetch(`/api/points?point=${encodeURIComponent(code)}${tok ? `&token=${encodeURIComponent(tok)}` : ""}`, {
        method: "DELETE",
      });
    let res = await reqDelete("");
    if (res.status === 401) {
      const tok = prompt("削除用トークン(CRON_TOKEN)を入力してください");
      if (tok === null) return;
      res = await reqDelete(tok.trim());
    }
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    els.status.textContent = `「${label}」を削除しました`;
    await loadPoints();
    loadDaily();
  } catch (e) {
    els.status.textContent = `削除エラー: ${e.message}`;
  } finally {
    els.del.disabled = false;
  }
}

function downloadCsv() {
  const { rows, point, from, to } = current;
  if (!rows.length) {
    els.status.textContent = "ダウンロードするデータがありません";
    return;
  }
  const header = [
    "日付",
    "地点コード",
    "最高気温(℃)",
    "最低気温(℃)",
    "平均気温(℃)",
    "降水量合計(mm)",
    "最大風速(m/s)",
    "日照時間(h)",
  ];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [r.date, r.point_code, r.temp_max, r.temp_min, r.temp_avg, r.precip_sum, r.wind_max, r.sunshine_h]
        .map(cell)
        .join(","),
    );
  }
  // ExcelでUTF-8を正しく読むため BOM を付与
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `amedas_${point}_${from}_${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// 現在の地点・期間に対応するエンドポイントURLをクリップボードにコピーする。
async function copyEndpoint(kind) {
  const point = els.point.value;
  const from = els.from.value;
  const to = els.to.value;
  if (!point || !from || !to) {
    els.status.textContent = "地点・期間を指定してください";
    return;
  }
  const path = kind === "csv" ? "/api/daily.csv" : "/api/daily";
  const url = `${location.origin}${path}?point=${encodeURIComponent(point)}&from=${from}&to=${to}`;
  try {
    await navigator.clipboard.writeText(url);
    els.status.textContent = `${kind.toUpperCase()} APIのURLをコピーしました: ${url}`;
  } catch {
    // クリップボード不可時はURLを表示（手動コピー用）
    els.status.textContent = `${kind.toUpperCase()} API URL: ${url}`;
  }
}

function render(rows) {
  renderTable(rows);
  renderChart(rows);
}

function renderTable(rows) {
  els.tbody.innerHTML = rows
    .map(
      (r) =>
        `<tr><td>${r.date}</td><td>${fmt(r.temp_max)}</td><td>${fmt(r.temp_min)}</td>` +
        `<td>${fmt(r.temp_avg)}</td><td>${fmt(r.precip_sum)}</td>` +
        `<td>${fmt(r.wind_max)}</td><td>${fmt(r.sunshine_h)}</td></tr>`,
    )
    .join("");
}

function renderChart(rows) {
  const W = 1000;
  const H = 280;
  const pad = { l: 36, r: 12, t: 12, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  if (rows.length === 0) {
    els.chart.innerHTML = "";
    return;
  }

  const temps = rows.flatMap((r) => [r.temp_max, r.temp_min].filter((v) => v !== null));
  const tMax = temps.length ? Math.max(...temps) : 1;
  const tMin = temps.length ? Math.min(...temps) : 0;
  const tRange = tMax - tMin || 1;
  const pMax = Math.max(1, ...rows.map((r) => r.precip_sum ?? 0));

  const x = (i) => pad.l + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const yT = (v) => pad.t + (1 - (v - tMin) / tRange) * ih;
  const yP = (v) => pad.t + (1 - v / pMax) * ih;

  const line = (key, color) => {
    const pts = rows
      .map((r, i) => (r[key] === null ? null : `${x(i)},${yT(r[key])}`))
      .filter(Boolean)
      .join(" ");
    return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}" />`;
  };

  const bars = rows
    .map((r, i) => {
      const v = r.precip_sum ?? 0;
      if (v <= 0) return "";
      const bw = Math.max(1, iw / rows.length - 1);
      return `<rect x="${x(i) - bw / 2}" y="${yP(v)}" width="${bw}" height="${pad.t + ih - yP(v)}" fill="var(--rain)" opacity="0.45" />`;
    })
    .join("");

  const ticks = [tMin, (tMin + tMax) / 2, tMax]
    .map(
      (v) =>
        `<text x="4" y="${yT(v) + 3}" fill="var(--muted)" font-size="10">${v.toFixed(0)}</text>` +
        `<line x1="${pad.l}" y1="${yT(v)}" x2="${W - pad.r}" y2="${yT(v)}" stroke="var(--line)" stroke-width="0.5" />`,
    )
    .join("");

  els.chart.innerHTML =
    ticks + bars + line("temp_max", "var(--warm)") + line("temp_min", "var(--accent)");
}

function init() {
  const today = new Date();
  const past = new Date();
  past.setDate(today.getDate() - 30);
  // URLクエリがあれば優先、無ければ既定（直近30日）
  const params = readUrlParams();
  els.to.value = isYmd(params.to) ? params.to : ymd(today);
  els.from.value = isYmd(params.from) ? params.from : ymd(past);

  // 日付・地点の変更で即再取得（「表示」ボタンを押さなくても反映）
  els.load.addEventListener("click", loadDaily);
  els.download.addEventListener("click", downloadCsv);
  els.copyJson.addEventListener("click", () => copyEndpoint("json"));
  els.copyCsv.addEventListener("click", () => copyEndpoint("csv"));
  els.del.addEventListener("click", deletePoint);
  els.point.addEventListener("change", loadDaily);
  els.from.addEventListener("change", loadDaily);
  els.to.addEventListener("change", loadDaily);
  els.npParse.addEventListener("click", onParse);
  els.npAdd.addEventListener("click", addPoint);

  loadPoints(params.point || undefined)
    .then(loadDaily)
    .catch((e) => (els.status.textContent = `初期化エラー: ${e.message}`));
}

init();
