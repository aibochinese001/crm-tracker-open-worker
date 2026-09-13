#!/usr/bin/env node
/**
 * 开源前敏感信息扫描器
 *
 * 用法：
 *   node scripts/formal_secret_scan.mjs          # 扫描全部文件（跳过 node_modules/.git/.wrangler/dist）
 *   node scripts/formal_secret_scan.mjs --ci     # CI 模式：有命中时退出码 1
 *
 * 规则：
 *   - STRONG_PATTERNS：sk- / Bearer / CLOUDFLARE_API_TOKEN 等强模式，对包括 test/ 在内的所有文件检查
 *   - PATTERNS：通用弱模式（password= / api_key= / secret= / token= 长值、base64、32 位 hex、邮箱），跳过 test/ 前缀
 *   - FAKE_EMAIL_DOMAINS：测试夹具邮箱域名白名单
 *   - 结果按「疑似泄露 / 需人工确认 / 测试夹具(已豁免)」分级输出
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CI = process.argv.includes('--ci');

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'coverage', '.codeflicker', '.codex', '.agents', '.claude', 'docs', '优化文档', '.github']);
const EXCLUDE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.svg']);
const EXCLUDE_FILES = new Set(['package-lock.json', 'package.json']);

const FAKE_EMAIL_DOMAINS = new Set([
  'test.com', 'example.com', 'example.org', 'qq.com', '163.com', '126.com', 'alipay.com',
  'agent.qq.com', 'co.com', 'b.com', 'c.com', 'd.com', 'y.com', 'w.com', 'shipping.com',
  'gmail.com', 'outlook.com', 'hotmail.com', 'foxmail.com', 'yourdomain.com', 'my-bark.example'
]);

const PATTERNS = [
  {
    name: 'sk- API Key',
    re: /sk-[A-Za-z0-9]{16,}/g,
    level: 'high'
  },
  {
    name: 'Bearer Token',
    re: /Bearer\s+[A-Za-z0-9._\-]{20,}/g,
    level: 'high'
  },
  {
    name: 'Cloudflare API Token 赋值',
    re: /CLOUDFLARE_API_TOKEN\s*=\s*["']?[A-Za-z0-9_\-]{20,}/g,
    level: 'high'
  },
  {
    name: 'api_key / apikey 长值',
    re: /\bapi[_-]?key\b\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/g,
    level: 'high'
  },
  {
    name: 'secret 长值',
    re: /\b(?:client_?secret|secret|api_secret)\b\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/gi,
    level: 'high'
  },
  {
    name: 'password 赋值',
    re: /\bpassword\s*[:=]\s*["'][^"']{8,}["']/gi,
    level: 'review'
  },
  {
    name: 'JWT_SECRET 赋值',
    re: /\bJWT_SECRET\s*[:=]\s*["'][^"']{8,}["']/gi,
    level: 'review'
  },
  {
    name: 'base64 疑似密钥（44+ 且同时含数字与字母）',
    re: /["']([A-Za-z0-9+/]{44,}={0,2})["']/g,
    level: 'review',
    validate: (m) => {
      // 排除随机令牌字符集常量（顺序字母表+数字表），非密钥
      const CHARSETS = [
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      ];
      if (CHARSETS.some((c) => m === c || m.startsWith(c))) return false;
      return /[A-Za-z]/.test(m) && /[0-9]/.test(m);
    }
  },
  {
    name: '32 位 hex（KV/资源 ID 疑似）',
    re: /["']([a-f0-9]{32})["']/gi,
    level: 'review'
  },
  {
    name: 'UUID（资源 ID 疑似）',
    re: /["']([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["']/gi,
    level: 'review'
  },
  {
    name: '邮箱',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    level: 'review',
    validate: (m) => {
      const domain = m.split('@')[1]?.toLowerCase() || '';
      return !FAKE_EMAIL_DOMAINS.has(domain);
    }
  }
];

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectFiles(full, out);
    } else {
      const ext = extname(entry).toLowerCase();
      if (EXCLUDE_EXT.has(ext)) continue;
      if (EXCLUDE_FILES.has(entry)) continue;
      out.push(full);
    }
  }
  return out;
}

const files = collectFiles(ROOT);
const findings = [];
let totalBytes = 0;

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const isTest = rel.startsWith('test/') || rel.startsWith('tests/');
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  totalBytes += content.length;
  for (const pat of PATTERNS) {
    if (isTest && pat.level !== 'high') continue; // 弱模式跳过测试夹具
    pat.re.lastIndex = 0;
    let m;
    while ((m = pat.re.exec(content)) !== null) {
      const matched = m[0];
      const payload = m[1] || matched;
      if (pat.validate && !pat.validate(payload)) continue;
      const line = content.slice(0, m.index).split('\n').length;
      findings.push({ file: rel, line, pattern: pat.name, level: pat.level, match: matched.slice(0, 80) });
      if (findings.length >= 200) break;
    }
    if (findings.length >= 200) break;
  }
  if (findings.length >= 200) break;
}

const high = findings.filter((f) => f.level === 'high');
const review = findings.filter((f) => f.level === 'review');

console.log(`[scan] 扫描文件数: ${files.length} | 字符数: ${totalBytes}`);
console.log(`[scan] 高置信疑似泄露: ${high.length} | 需人工确认: ${review.length}\n`);

for (const f of high) {
  console.log(`  [HIGH] ${f.file}:${f.line}  ${f.pattern}: ${f.match}`);
}
for (const f of review) {
  console.log(`  [REVIEW] ${f.file}:${f.line}  ${f.pattern}: ${f.match}`);
}

if (high.length === 0 && review.length === 0) {
  console.log('[scan] ✅ 未发现敏感信息，可以开源');
} else {
  console.log(`\n[scan] ⚠️ 共 ${high.length + review.length} 处命中，请逐一确认后再推送公开仓库`);
}

process.exit(CI && (high.length > 0 || review.length > 0) ? 1 : 0);
