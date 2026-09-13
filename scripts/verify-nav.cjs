// 静态校验：各页面导航栏与 /admin 客户列表页一致
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'views');
const EXPECTED_ITEMS = [
  { label: '仪表盘', href: '/admin/dashboard', icon: 'fa-chart-line' },
  { label: '客户列表', href: '/admin', icon: 'fa-list' },
  { label: '通知历史', href: '/admin/notify-logs', icon: 'fa-history' },
  { label: '管理后台', href: '/admin/users', icon: 'fa-users-cog' },
  { label: '提醒设置', href: '/me/notify', icon: 'fa-bell' },
  { label: '个人中心', href: '/me', icon: 'fa-user-circle' },
  { label: '退出登录', href: '/api/logout', icon: 'fa-sign-out-alt' },
];

const ACTIVE = {
  'adminPage.html': '客户列表',
  'dashboardPage.html': '仪表盘',
  'configPage.html': null,
  'notifyLogsPage.html': '通知历史',
  'usersPage.html': '管理后台',
  'adminOrdersPage.html': '管理后台',
  'plansPage.html': '管理后台',
  'userCenterPage.html': '个人中心',
  'myNotifyPage.html': '提醒设置',
};

const files = Object.keys(ACTIVE);
let failed = false;

function check(file, html) {
  const errors = [];
  // 提取桌面端 nav 与移动端 nav
  const desktopStart = html.indexOf('hidden md:flex items-center space-x-4 ml-auto');
  const mobileStart = html.indexOf('id="mobile-menu"');
  if (desktopStart < 0) errors.push('缺少桌面端菜单容器');
  if (mobileStart < 0) errors.push('缺少移动端菜单容器');

  for (const item of EXPECTED_ITEMS) {
    // 桌面端
    const hrefCount = countOccurrences(html, `href="${item.href}"`);
    if (hrefCount < 1) errors.push(`缺少菜单项 ${item.label} (${item.href})`);
    if (!html.includes(item.label)) errors.push(`缺少菜单文字 ${item.label}`);
    if (item.icon && !html.includes(item.icon)) errors.push(`缺少图标 ${item.icon}`);
  }
  // id 检查
  ['nav-dashboard', 'nav-notify-logs', 'nav-users', 'nav-notify-settings', 'nav-me',
   'm-nav-dashboard', 'm-nav-notify-logs', 'm-nav-users', 'm-nav-notify-settings', 'm-nav-me',
   'mobile-menu-btn', 'mobile-menu', 'systemTimeDisplay', 'mobileTimeDisplay'].forEach((id) => {
    if (!html.includes(`id="${id}"`)) errors.push(`缺少 id=${id}`);
  });
  // 个人中心默认 hidden
  if (!html.includes('id="nav-me" class="hidden') && !html.includes('id="nav-me" class="hidden text') ) {
    // 允许 class 顺序不同
    if (!/id="nav-me"[^>]*class="[^"]*hidden/.test(html)) errors.push('nav-me 未默认隐藏');
  }
  if (!/id="m-nav-me"[^>]*class="[^"]*hidden/.test(html)) errors.push('m-nav-me 未默认隐藏');
  // 角色感知 JS
  if (!html.includes("['nav-users', 'm-nav-users']")) errors.push('缺少角色感知 JS（隐藏管理后台）');
  if (!html.includes("['nav-me', 'm-nav-me']")) errors.push('缺少角色感知 JS（显示个人中心）');
  // 不允许残留旧系统配置导航
  if (/id="nav-config"/.test(html)) errors.push('残留 nav-config 引用');

  // 当前页高亮
  const active = ACTIVE[file];
  if (active) {
    const activeInDesktop = html.indexOf(`text-indigo-600 border-b-2 border-indigo-600`);
    const activeInMobile = html.indexOf(`text-indigo-600 bg-indigo-50`);
    if (activeInDesktop < 0 && activeInMobile < 0) errors.push(`页面 ${file} 没有任何高亮项`);
  }

  return errors;
}

function countOccurrences(str, sub) {
  let c = 0, i = 0;
  while ((i = str.indexOf(sub, i)) !== -1) { c++; i += sub.length; }
  return c;
}

for (const f of files) {
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  const errors = check(f, html);
  if (errors.length) {
    failed = true;
    console.log(`[FAIL] ${f}`);
    errors.forEach((e) => console.log(`   - ${e}`));
  } else {
    const active = ACTIVE[f];
    console.log(`[OK] ${f}${active ? `（高亮: ${active}）` : '（无高亮项）'}`);
  }
}

// 参考页自身检查
const ref = fs.readFileSync(path.join(dir, 'adminPage.html'), 'utf8');
for (const item of EXPECTED_ITEMS) {
  if (!ref.includes(item.label)) { failed = true; console.log(`[FAIL] adminPage 缺少 ${item.label}`); }
}

// login / payResult 应无统一导航（登录前/独立页）
for (const f of ['loginPage.html', 'payResultPage.html']) {
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  if (html.includes('id="mobile-menu-btn"')) { failed = true; console.log(`[FAIL] ${f} 不应有统一导航`); }
  else console.log(`[OK] ${f}（无导航，符合预期）`);
}

console.log(failed ? '\n校验失败' : '\n全部通过');
process.exit(failed ? 1 : 0);
