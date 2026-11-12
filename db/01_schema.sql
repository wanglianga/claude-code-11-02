-- 经营数据采集编排台 数据库结构
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 门店
CREATE TABLE IF NOT EXISTS stores (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'direct'  -- direct 直营 | franchise 加盟
);

-- 平台
CREATE TABLE IF NOT EXISTS platforms (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,           -- ALPHA / BETA / GAMMA
  name        TEXT NOT NULL,
  source_kind TEXT NOT NULL,                  -- web_export | download_center | api
  day_cutoff  TIME NOT NULL DEFAULT '00:00',  -- 日结切点：凌晨 cutoff 前的订单计入前一营业日
  enabled     BOOLEAN NOT NULL DEFAULT TRUE
);

-- 平台账号（同一门店在同一平台可有多个账号）
CREATE TABLE IF NOT EXISTS platform_accounts (
  id          SERIAL PRIMARY KEY,
  platform_id INT NOT NULL REFERENCES platforms(id),
  store_id    INT NOT NULL REFERENCES stores(id),
  username    TEXT NOT NULL,
  password    TEXT NOT NULL,                  -- 演示环境明文；生产应放密钥管理
  api_token   TEXT,                           -- API 类平台使用
  status      TEXT NOT NULL DEFAULT 'active', -- active | login_expired | disabled
  UNIQUE (platform_id, store_id, username)
);

-- 来源任务：门店 × 平台 × 账号 × 日期窗口（窗口以单日为单位）
CREATE TABLE IF NOT EXISTS source_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    INT NOT NULL REFERENCES stores(id),
  platform_id INT NOT NULL REFERENCES platforms(id),
  account_id  INT NOT NULL REFERENCES platform_accounts(id),
  biz_date    DATE NOT NULL,
  source_kind TEXT NOT NULL,                  -- web_export | download_center | api | manual
  status      TEXT NOT NULL DEFAULT 'pending',
  -- pending | queued | running | waiting_human | succeeded | failed
  last_error  TEXT,
  run_count   INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, platform_id, account_id, biz_date)
);
CREATE INDEX IF NOT EXISTS idx_tasks_date   ON source_tasks(biz_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON source_tasks(status);

-- 执行记录：每次任务执行（含重跑、崩溃重试）都有独立记录
CREATE TABLE IF NOT EXISTS task_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES source_tasks(id),
  attempt_no    INT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running', -- running | succeeded | failed | waiting_human | interrupted
  error_code    TEXT,
  error_message TEXT,
  worker_id     TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id);

-- 执行步骤留证
CREATE TABLE IF NOT EXISTS run_steps (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL REFERENCES task_runs(id),
  seq             INT NOT NULL,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ok',   -- ok | failed | info
  message         TEXT,
  screenshot_path TEXT,                          -- 相对 DATA_DIR 的路径
  meta            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps(run_id);

-- 采集到的原始文件（含人工上传），保留哈希与修订链
CREATE TABLE IF NOT EXISTS collected_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID REFERENCES source_tasks(id),
  run_id        UUID REFERENCES task_runs(id),
  store_id      INT NOT NULL REFERENCES stores(id),
  platform_id   INT NOT NULL REFERENCES platforms(id),
  account_id    INT NOT NULL REFERENCES platform_accounts(id),
  biz_date      DATE NOT NULL,
  origin        TEXT NOT NULL DEFAULT 'auto',   -- auto | manual
  file_name     TEXT NOT NULL,
  file_path     TEXT NOT NULL,                  -- 相对 DATA_DIR
  sha256        TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revision      INT NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'active', -- active | superseded | rejected | ignored_manual
  supersedes_id UUID REFERENCES collected_files(id),
  meta          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_key ON collected_files(store_id, platform_id, account_id, biz_date);
CREATE INDEX IF NOT EXISTS idx_files_hash ON collected_files(sha256);

-- 解析入库批次
CREATE TABLE IF NOT EXISTS parse_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id         UUID NOT NULL REFERENCES collected_files(id),
  parser_version  TEXT NOT NULL,
  mapping_version TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'success', -- success | failed
  rows_total      INT NOT NULL DEFAULT 0,
  rows_parsed     INT NOT NULL DEFAULT 0,
  rows_skipped    INT NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batches_file ON parse_batches(file_id);

-- 原始行（保留平台原字段）
CREATE TABLE IF NOT EXISTS raw_records (
  id          BIGSERIAL PRIMARY KEY,
  batch_id    UUID NOT NULL REFERENCES parse_batches(id),
  row_no      INT NOT NULL,
  record_type TEXT,
  raw         JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_batch ON raw_records(batch_id);

-- 统一日经营事实（每门店×平台×账号×日期×指标 一行，可溯源到文件与批次）
CREATE TABLE IF NOT EXISTS daily_facts (
  id          BIGSERIAL PRIMARY KEY,
  store_id    INT NOT NULL REFERENCES stores(id),
  platform_id INT NOT NULL REFERENCES platforms(id),
  account_id  INT NOT NULL REFERENCES platform_accounts(id),
  biz_date    DATE NOT NULL,
  metric      TEXT NOT NULL,  -- orders | gross_sales | refunds | refund_amount | subsidy | cancels | soldout_items
  value       NUMERIC(14,2) NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'auto',    -- auto | manual
  file_id     UUID REFERENCES collected_files(id),
  batch_id    UUID REFERENCES parse_batches(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, platform_id, account_id, biz_date, metric)
);
CREATE INDEX IF NOT EXISTS idx_facts_day ON daily_facts(biz_date);

-- 字段映射异常
CREATE TABLE IF NOT EXISTS mapping_issues (
  id          BIGSERIAL PRIMARY KEY,
  file_id     UUID REFERENCES collected_files(id),
  batch_id    UUID REFERENCES parse_batches(id),
  issue_type  TEXT NOT NULL,   -- unknown_type | unknown_reason | bad_number | missing_column | cross_day_row | summary_mismatch
  field       TEXT,
  message     TEXT NOT NULL,
  raw         JSONB,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | resolved
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 人工接管（验证码/短信/人工确认/登录失效）
CREATE TABLE IF NOT EXISTS interventions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID REFERENCES source_tasks(id),
  run_id         UUID REFERENCES task_runs(id),
  kind           TEXT NOT NULL,   -- captcha | sms | manual_confirm | login_expired
  status         TEXT NOT NULL DEFAULT 'open', -- open | resolved | cancelled
  note           TEXT,
  screenshot_path TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  resolved_by    TEXT
);
