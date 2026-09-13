-- CRM SaaS D1 schema v1
-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  plan_id TEXT,
  plan_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 会员套餐表
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  max_subscriptions INTEGER NOT NULL DEFAULT -1,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 订单表
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired')),
  out_trade_no TEXT UNIQUE,
  epay_trade_no TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  notify_raw TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_out_trade_no ON orders(out_trade_no);

-- 客户订阅表（原 KV sub:<id> 迁移）
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_owner ON subscriptions(owner_user_id);

-- 通知日志（原 KV notification_logs）
CREATE TABLE IF NOT EXISTS notification_logs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  channel TEXT NOT NULL,
  target TEXT,
  title TEXT,
  content TEXT,
  status TEXT NOT NULL,
  error TEXT,
  sub_id TEXT,
  sub_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_owner ON notification_logs(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_created ON notification_logs(created_at);

-- 调度日志（原 KV scheduler_logs）
CREATE TABLE IF NOT EXISTS scheduler_logs (
  id TEXT PRIMARY KEY,
  run_at INTEGER NOT NULL,
  checked INTEGER,
  fired INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
);

-- 系统设置（原 KV config 拆分存储）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 提醒规则（每客户一条记录，rules 为 JSON 数组）
CREATE TABLE IF NOT EXISTS reminder_rules (
  sub_id TEXT PRIMARY KEY,
  rules TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 迁移标记表
CREATE TABLE IF NOT EXISTS migrate_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 登录失败锁定计数
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
);

-- 注册 IP 限流
CREATE TABLE IF NOT EXISTS register_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
