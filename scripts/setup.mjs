#!/usr/bin/env node
/**
 * 一键初始化脚本（npm run setup）
 *
 * 串起以下确定性步骤，agent/新部署者照单执行即可：
 *   1. 校验 wrangler 与登录态
 *   2. 创建/复用 KV namespace（SUBSCRIPTIONS_KV + SUBSCRIPTIONS_KV_PREVIEW）
 *   3. 创建/复用 D1 数据库（crm-saas-db）
 *   4. 抓取真实 ID 回填 wrangler.toml（占位符 → 真实值）
 *   5. 执行 schema.sql 初始化 D1 表结构
 *   6. 生成 SMTP_BRIDGE_SECRET 写入 .dev.vars（保留原内容追加）
 *
 * 幂等：重复执行不会重复创建资源（已存在则解析复用）。
 * 用法：node scripts/setup.mjs  （或 npm run setup）
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_TOML = join(ROOT, 'wrangler.toml');
const SCHEMA_SQL = join(ROOT, 'schema.sql');
const DEV_VARS = join(ROOT, '.dev.vars');
const D1_NAME = 'crm-saas-db';
const KV_BINDING = 'SUBSCRIPTIONS_KV';
const KV_PREVIEW_CANDIDATES = ['SUBSCRIPTIONS_KV_PREVIEW', 'SUBSCRIPTIONS_KV_preview'];

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function tryRun(cmd) {
  try { return run(cmd); } catch { return ''; }
}

function readWorkerName() {
  const content = readFileSync(WRANGLER_TOML, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:#.*)?$/);
    if (m) return m[1] || m[2] || m[3];
  }
  return null;
}

function listNamespaces() {
  const out = tryRun('npx wrangler kv namespace list');
  try { return JSON.parse(out); } catch { return []; }
}

function findNamespace(namespaces, title) {
  const workerName = readWorkerName();
  const expected = workerName ? [title, `${workerName}-${title}`] : [title];
  return namespaces.find((ns) => expected.includes(ns.title));
}

function ensureNamespace(title) {
  let namespaces = listNamespaces();
  let found = findNamespace(namespaces, title);
  if (found && found.id) return found;
  console.log(`[setup] KV namespace ${title} 不存在，创建中...`);
  run(`npx wrangler kv namespace create ${title}`);
  namespaces = listNamespaces();
  found = findNamespace(namespaces, title);
  if (!found || !found.id) throw new Error(`KV namespace ${title} 创建失败`);
  return found;
}

function listD1() {
  const out = tryRun('npx wrangler d1 list');
  try { return JSON.parse(out); } catch { return []; }
}

function findD1(databases, name) {
  return databases.find((d) => d.name === name || d.database_name === name);
}

function ensureD1() {
  let databases = listD1();
  let found = findD1(databases, D1_NAME);
  if (found && (found.uuid || found.database_id)) {
    console.log(`[setup] D1 ${D1_NAME} 已存在: ${found.uuid || found.database_id}`);
    return found.uuid || found.database_id;
  }
  console.log(`[setup] D1 ${D1_NAME} 不存在，创建中...`);
  run(`npx wrangler d1 create ${D1_NAME}`);
  databases = listD1();
  found = findD1(databases, D1_NAME);
  if (!found || !(found.uuid || found.database_id)) throw new Error(`D1 ${D1_NAME} 创建失败`);
  return found.uuid || found.database_id;
}

function applySchema() {
  if (!existsSync(SCHEMA_SQL)) {
    console.warn('[setup] 未找到 schema.sql，跳过 D1 表结构初始化');
    return;
  }
  console.log('[setup] 执行 schema.sql 初始化 D1 表结构...');
  tryRun(`npx wrangler d1 execute ${D1_NAME} --remote --file=${SCHEMA_SQL}`);
  console.log('[setup] schema.sql 执行完成（失败时请检查 D1 权限，表结构也会由代码首次访问自动建）');
}

function updateToml(kvProdId, kvPreviewId, d1Id) {
  let content = readFileSync(WRANGLER_TOML, 'utf8');

  // 替换 KV 占位符
  content = content.replace(/id = "REPLACE_WITH_KV_NAMESPACE_ID"/g, `id = "${kvProdId}"`);
  content = content.replace(/preview_id = "REPLACE_WITH_KV_PREVIEW_NAMESPACE_ID"/g, `preview_id = "${kvPreviewId}"`);
  content = content.replace(/preview_id = "REPLACE_WITH_KV_PREVIEW_ID"/g, `preview_id = "${kvPreviewId}"`);

  // 替换 D1 占位符
  content = content.replace(/database_id = "REPLACE_WITH_D1_DATABASE_ID"/g, `database_id = "${d1Id}"`);

  // 若旧式 KV 块仍残留真实 ID（非占位符），统一重写 KV 块
  if (content.includes('[[kv_namespaces]]')) {
    content = content.replace(
      /\[\[kv_namespaces\]\][\s\S]*?(?=\n\[|\n#|$)/g,
      `[[kv_namespaces]]\nbinding = "${KV_BINDING}"\nid = "${kvProdId}"\npreview_id = "${kvPreviewId}"`
    );
  }

  writeFileSync(WRANGLER_TOML, content, 'utf8');
  console.log('[setup] wrangler.toml 已回填真实 ID');
}

function ensureDevVars() {
  const secret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const line = `SMTP_BRIDGE_SECRET=${secret}`;
  if (existsSync(DEV_VARS)) {
    const existing = readFileSync(DEV_VARS, 'utf8');
    if (/SMTP_BRIDGE_SECRET=/.test(existing)) {
      console.log('[setup] .dev.vars 已含 SMTP_BRIDGE_SECRET，跳过');
      return;
    }
    appendFileSync(DEV_VARS, '\n' + line + '\n', 'utf8');
  } else {
    writeFileSync(DEV_VARS, line + '\n', 'utf8');
  }
  console.log('[setup] 已生成 SMTP_BRIDGE_SECRET 追加到 .dev.vars');
}

function checkWrangler() {
  try {
    run('npx wrangler whoami', { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    console.error('[setup] 未检测到 wrangler 登录态，请先运行 `npx wrangler login`');
    process.exit(1);
  }
}

function main() {
  console.log('[setup] 开始一键初始化...');
  checkWrangler();

  const prod = ensureNamespace(KV_BINDING);

  let preview = null;
  const namespaces = listNamespaces();
  for (const name of KV_PREVIEW_CANDIDATES) {
    preview = findNamespace(namespaces, name);
    if (preview && preview.id) break;
  }
  if (!preview || !preview.id) {
    preview = ensureNamespace('SUBSCRIPTIONS_KV_PREVIEW');
  }

  const d1Id = ensureD1();
  updateToml(prod.id, preview.id, d1Id);
  applySchema();
  ensureDevVars();

  console.log('\n[setup] ✅ 全部完成');
  console.log(`  KV SUBSCRIPTIONS_KV:         ${prod.id}`);
  console.log(`  KV SUBSCRIPTIONS_KV_PREVIEW: ${preview.id}`);
  console.log(`  D1 ${D1_NAME}:                 ${d1Id}`);
  console.log('  下一步：npm run deploy 部署，或 npx wrangler dev --local 本地开发');
}

try {
  main();
} catch (error) {
  console.error('[setup] 失败:', error.message || error);
  process.exit(1);
}
