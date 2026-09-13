// @ts-check
/**
 * D1 数据库访问层 + 存量 KV 数据自动迁移
 *
 * 设计：
 * - 首次访问时自动建表（CREATE TABLE IF NOT EXISTS，幂等）并迁移 KV 存量数据
 * - 迁移完成后写入 migrate_meta.done=1，后续不再检查（模块级 Promise 缓存）
 * - repo 层全部经由此文件的 d1() 获取绑定
 */

/** 已建表标记（进程级缓存，Worker 实例存活期间只执行一次） */
let initPromise = null;

/** 测试专用：重置初始化缓存（vitest isolatedStorage 清库后需要重建） */
export function _resetDbInitCache() {
  initPromise = null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  plan_id TEXT,
  plan_expires_at INTEGER,
  notify_config TEXT,
  bound_email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
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
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_owner ON subscriptions(owner_user_id);
CREATE TABLE IF NOT EXISTS reminder_rules (
  sub_id TEXT PRIMARY KEY,
  rules TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
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
  rule_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_logs_owner ON notification_logs(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_created ON notification_logs(created_at);
CREATE TABLE IF NOT EXISTS scheduler_logs (
  id TEXT PRIMARY KEY,
  run_at INTEGER NOT NULL,
  checked INTEGER,
  fired INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_email_templates_owner ON email_templates(owner_user_id);
CREATE TABLE IF NOT EXISTS migrate_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS register_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * 获取 D1 绑定并确保初始化完成（建表 + KV 存量迁移）。
 *
 * 探测策略：initPromise 命中后仍做一次 migrate_meta 轻量探测——
 * vitest-pool-workers 的 isolatedStorage 会按用例清空 D1，探测失败即重建。
 * 生产环境该探测走同一连接，开销 <1ms。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace }} env
 * @returns {Promise<D1Database|null>} D1 不可用时返回 null（调用方降级走 KV）
 */
export async function getDB(env) {
  if (!env.DB) return null;
  if (initPromise) {
    // 快速健康探测：schema 存活即复用缓存
    try {
      await env.DB.prepare('SELECT 1 FROM migrate_meta LIMIT 1').run();
      return env.DB;
    } catch {
      initPromise = null; // schema 丢失（测试隔离/外部清库），重新初始化
    }
  }
  if (!initPromise) {
    initPromise = initialize(env).catch((err) => {
      // 初始化失败则重置，下次请求重试
      initPromise = null;
      throw err;
    });
  }
  try {
    await initPromise;
    return env.DB;
  } catch (err) {
    console.error('[db] 初始化失败，本次请求降级 KV:', err.message);
    return null;
  }
}

async function initialize(env) {
  // D1 的 exec() 对多语句支持不稳（遇到 "incomplete input"），改为逐条执行
  const statements = SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    try {
      await env.DB.prepare(stmt).run();
    } catch (err) {
      // 已存在的索引/表忽略，其他错误抛出
      if (!String(err.message).includes('already exists')) {
        throw err;
      }
    }
  }
  // 检查迁移标记
  const meta = await env.DB.prepare("SELECT value FROM migrate_meta WHERE key = 'kv_to_d1_done'").first();
  if (meta && meta.value === '1') return;
  await migrateKVToD1(env);
  await env.DB.prepare(
    "INSERT INTO migrate_meta (key, value) VALUES ('kv_to_d1_done', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
}

/**
 * KV 存量数据迁移到 D1：
 * - config → settings（多行）
 * - sub:{id} + sub_index → subscriptions（owner = admin 用户）
 * - reminder_rules:{subId} → reminder_rules
 * - notify_log:* → notification_logs
 * - sched_log:* → scheduler_logs
 * 同时确保存在 admin 用户（从 KV config 的 ADMIN_USERNAME/ADMIN_PASSWORD 创建）。
 *
 * @param {{ DB: D1Database, SUBSCRIPTIONS_KV?: KVNamespace }} env
 */
async function migrateKVToD1(env) {
  const now = Date.now();
  console.log('[db] 开始 KV→D1 迁移...');

  // 1. config → settings
  if (env.SUBSCRIPTIONS_KV) {
    const rawConfig = await env.SUBSCRIPTIONS_KV.get('config');
    if (rawConfig) {
      try {
        const configObj = JSON.parse(rawConfig);
        const stmts = Object.entries(configObj).map(([k, v]) =>
          env.DB.prepare(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO NOTHING"
          ).bind(k, JSON.stringify(v), now)
        );
        if (stmts.length > 0) await env.DB.batch(stmts);
        console.log('[db] config 已迁移到 settings, 键数:', stmts.length);
      } catch (e) {
        console.error('[db] config 迁移失败:', e.message);
      }
    }
  }

  // 2. 确保 admin 用户存在
  let adminId = null;
  const existingAdmin = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first();
  if (existingAdmin) {
    adminId = existingAdmin.id;
  } else {
    let adminUsername = 'admin';
    let adminPassword = null;
    if (env.SUBSCRIPTIONS_KV) {
      const rawConfig = await env.SUBSCRIPTIONS_KV.get('config');
      if (rawConfig) {
        try {
          const c = JSON.parse(rawConfig);
          if (c.ADMIN_USERNAME) adminUsername = String(c.ADMIN_USERNAME);
          if (c.ADMIN_PASSWORD) adminPassword = String(c.ADMIN_PASSWORD);
        } catch { /* ignore */ }
      }
    }
    const { hashPassword } = await import('../core/password.js');
    const { hash, salt } = adminPassword
      ? await hashPassword(adminPassword)
      : await hashPassword('admin' + Math.random().toString(36).slice(2, 10));
    adminId = 'u_' + crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, username, password_hash, salt, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'admin', 'active', ?5, ?5)"
    ).bind(adminId, adminUsername, hash, salt, now).run();
    console.log('[db] admin 用户已创建:', adminUsername);
  }

  // 3. subscriptions：KV sub:{id} → D1
  if (env.SUBSCRIPTIONS_KV) {
    let ids = [];
    const rawIndex = await env.SUBSCRIPTIONS_KV.get('sub_index');
    if (rawIndex) {
      try {
        const parsed = JSON.parse(rawIndex);
        if (Array.isArray(parsed)) ids = parsed.filter((x) => typeof x === 'string');
      } catch { /* ignore */ }
    }
    const stmts = [];
    for (const id of ids) {
      const raw = await env.SUBSCRIPTIONS_KV.get('sub:' + id);
      if (!raw) continue;
      try {
        const sub = JSON.parse(raw);
        stmts.push(
          env.DB.prepare(
            "INSERT INTO subscriptions (id, owner_user_id, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(id) DO NOTHING"
          ).bind(id, adminId, JSON.stringify(sub), now)
        );
      } catch { /* 跳过坏数据 */ }
    }
    if (stmts.length > 0) await env.DB.batch(stmts);
    console.log('[db] subscriptions 已迁移:', stmts.length, '条');

    // 4. reminder_rules
    const ruleStmts = [];
    for (const id of ids) {
      const raw = await env.SUBSCRIPTIONS_KV.get('reminder_rules:' + id);
      if (!raw) continue;
      ruleStmts.push(
        env.DB.prepare(
          "INSERT INTO reminder_rules (sub_id, rules, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(sub_id) DO NOTHING"
        ).bind(id, raw, now)
      );
    }
    if (ruleStmts.length > 0) await env.DB.batch(ruleStmts);
    console.log('[db] reminder_rules 已迁移:', ruleStmts.length, '条');

    // 5. notification_logs（list 前缀扫描）
    const notifyKeys = [];
    let cursor = undefined;
    do {
      const page = await env.SUBSCRIPTIONS_KV.list({ prefix: 'notify_log:', cursor });
      notifyKeys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    const notifyStmts = [];
    for (const key of notifyKeys.slice(0, 500)) { // 上限 500 条，防首请求超时
      const raw = await env.SUBSCRIPTIONS_KV.get(key);
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw);
        notifyStmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO notification_logs (id, owner_user_id, channel, target, title, content, status, error, sub_id, sub_name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
          ).bind(
            entry.key || key,
            adminId,
            String(entry.channel || 'unknown'),
            entry.target || null,
            entry.title || null,
            entry.content || null,
            String(entry.status || 'unknown'),
            entry.error || null,
            entry.subId || null,
            entry.subName || null,
            entry.timestamp ? new Date(entry.timestamp).getTime() : now
          )
        );
      } catch { /* skip */ }
    }
    if (notifyStmts.length > 0) await env.DB.batch(notifyStmts);
    console.log('[db] notification_logs 已迁移:', notifyStmts.length, '条');

    // 6. scheduler_logs
    const schedKeys = [];
    cursor = undefined;
    do {
      const page = await env.SUBSCRIPTIONS_KV.list({ prefix: 'sched_log:', cursor });
      schedKeys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    const schedStmts = [];
    for (const key of schedKeys.slice(0, 200)) {
      const raw = await env.SUBSCRIPTIONS_KV.get(key);
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw);
        schedStmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO scheduler_logs (id, run_at, checked, fired, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
          ).bind(
            entry.key || key,
            entry.timestamp ? new Date(entry.timestamp).getTime() : now,
            entry.checked ?? null,
            entry.fired ?? null,
            raw.slice(0, 4000),
            now
          )
        );
      } catch { /* skip */ }
    }
    if (schedStmts.length > 0) await env.DB.batch(schedStmts);
    console.log('[db] scheduler_logs 已迁移:', schedStmts.length, '条');
  }

  console.log('[db] KV→D1 迁移完成');
}
