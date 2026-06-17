-- 地点マスタ：bosai / etrn の異なるコード体系を吸収する。地点追加=1行INSERT。
CREATE TABLE IF NOT EXISTS points (
  point_code    TEXT PRIMARY KEY,   -- 正準コード（bosai 5桁を採用）
  name          TEXT NOT NULL,
  bosai_code    TEXT,               -- bosai API パス用
  etrn_prec_no  TEXT,               -- etrn prec_no
  etrn_block_no TEXT,               -- etrn block_no（4桁・別体系。先頭0保持のためTEXT）
  enabled       INTEGER NOT NULL DEFAULT 1
);

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

-- 初期地点：原村（検証済みの正しいコード）
INSERT OR REPLACE INTO points (point_code, name, bosai_code, etrn_prec_no, etrn_block_no, enabled)
VALUES ('48561', '原村', '48561', '48', '0414', 1);
