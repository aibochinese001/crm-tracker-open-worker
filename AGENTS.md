# AGENTS.md —— AI 自动部署指南

本文件是给 **AI 编码/部署 Agent** 看的确定性操作手册。照单执行，不要靠猜。

## 项目速览

- **类型**：Cloudflare Workers（Hono + JS，无构建步骤，运行时 `nodejs_compat`）
- **入口**：`src/index.js`（fetch + scheduled，Cron 每小时）
- **存储**：D1（主存储 `crm-saas-db`）+ KV（`SUBSCRIPTIONS_KV`，迁移窗口兜底）
- **静态资源**：`public/` 由 `[assets]` 托管（PWA）
- **测试**：Vitest + `@cloudflare/vitest-pool-workers`（真实 workerd 运行时）

## 快速部署（一次性命令，按序执行）

```bash
# 1. 安装依赖
npm install

# 2. 登录（弹浏览器授权）
npx wrangler login

# 3. 一键初始化：创建/复用 KV + D1、抓 ID 回填 wrangler.toml、执行 schema.sql、生成 .dev.vars
npm run setup

# 4. 部署到 workers.dev
npm run deploy

# 或合并执行（等价于 3+4）
npm run deploy:safe
```

部署成功后终端会打印：`https://subscription-manager.<你的子域>.workers.dev`

> 首次访问会自动建 D1 表并迁移 KV 存量数据（幂等，无需手动建表）。

## Token 权限清单（Cloudflare API Token 至少需要）

| 权限 | 级别 | 用途 |
|------|------|------|
| Workers Scripts | Edit | 上传/覆盖 Worker |
| Workers KV Storage | Edit | 创建/绑定 KV namespace |
| D1 | Edit | 创建数据库 / 执行 schema |
| Account Settings | Read | 读取账号信息（可选） |
| Workers Routes | Edit | 若后续绑定自定义域名 |

最小 Token 建议只勾前 3 项，作用域锁到本账号。

## Secrets 清单（`npx wrangler secret put <NAME>`）

| 变量 | 必填 | 用途 | 获取方式 | 不填时的降级行为 |
|------|------|------|----------|------------------|
| `SMTP_BRIDGE_SECRET` | 否* | SMTP 桥 HMAC 鉴权密钥 | `npm run setup` 自动生成，或 `openssl rand -hex 32` | 客户专属邮件不发送，其余通知渠道（TG/Bark/微信等）不受影响 |
| `SMTP_BRIDGE_URL` | 否 | 覆盖 SMTP 桥地址 | 你的桥服务地址 | 使用代码内占位地址（部署前必须替换为真实值，否则邮件失败） |

> *：不配 `SMTP_BRIDGE_SECRET` 时功能降级而非崩溃，其余功能全部可用。

**注意**：大部分业务配置（通知渠道 Token、时区、支付参数等）存储在 KV `config` Key 里，部署后通过管理后台「系统配置」页面填写，**不需要**用 wrangler secret。

## 本地开发

```bash
npx wrangler dev --config wrangler.dev.toml --local
# http://127.0.0.1:8787  默认 admin / password（部署后立即改）
```

## 提交前必做检查（Agent 必须执行）

```bash
node scripts/formal_secret_scan.mjs   # 敏感信息扫描，必须 0 命中
npm run lint                          # tsc --noEmit 类型检查（JSDoc）
npm test                              # Vitest 单元/集成测试
npm run verify:nav                    # 页面导航一致性校验（如有）
```

任何一项失败都**不要**推送公开仓库。

## 常见报错对照表

| 报错 | 原因 | 修复 |
|------|------|------|
| `Authentication error [code: 10000]` | Token 权限不足或未登录 | `npx wrangler login`；检查 Token 权限是否含 Workers Edit + KV Edit + D1 Edit |
| `KV namespace ... not found` | 未运行 setup | `npm run setup` |
| `D1 database ... not found` | D1 未创建或 ID 未回填 | `npm run setup`（自动创建 crm-saas-db 并回填 wrangler.toml） |
| `A request to the Cloudflare API failed` | 网络 / Token 过期 | 重试；必要时删除 `.wrangler/` 后重试 |
| `Could not find schema.sql` | 文件缺失 | 确认 `schema.sql` 在项目根目录 |
| `Error: You must be logged in` | 未登录 | `npx wrangler login` |
| `esbuild: No matching version` / 依赖版本冲突 | 依赖未对齐 | `npm install` 后重试 |
| 部署成功但访问 404 | assets 未命中且路由未匹配 | 确认 `[assets] directory = "./public"` 存在，静态文件放 public/ |
| 测试中 `isolatedStorage` 清库 | 正常测试隔离行为 | 用例内调用 `_resetDbInitCache()` 重建表 |

## 部署架构（Cron 调度）

```text
Cron "0 * * * *"（每小时整点）
  → ensureMigrations（KV 迁移，幂等）
  → checkExpiringSubscriptions（到期/提醒规则检查 + 多渠道通知 + 去重）
  → downgradeExpiredMemberships（SaaS 会员过期降级）
```
