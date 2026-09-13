import { getConfig } from '../data/config.js';
import { verifyJWT } from '../core/auth.js';
import { getCookieValue } from './utils.js';
import * as usersRepo from '../data/users.repo.js';
import { loginPage, adminPage, configPage, dashboardPage, notifyLogsPage, usersPage, userCenterPage, plansPage, payResultPage, myNotifyPage, adminOrdersPage } from '../views/pages.js';

async function handleAdminRequest(request, env) {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname;

    console.log('[管理页面] 访问路径:', pathname);

    const token = getCookieValue(request.headers.get('Cookie'), 'token');
    console.log('[管理页面] Token存在:', !!token);

    const config = await getConfig(env);
    const payload = token ? await verifyJWT(token, config.JWT_SECRET) : null;

    console.log('[管理页面] 用户验证结果:', !!payload);

    if (!payload) {
      console.log('[管理页面] 用户未登录，重定向到登录页面');
      return new Response('', {
        status: 302,
        headers: { 'Location': '/' }
      });
    }

    // 解析完整用户（拿 role；D1 用户查表，kv-admin 兜底视为 admin）
    let role = payload.role || 'user';
    let fullUser = null;
    if (payload.uid && payload.uid !== 'kv-admin') {
      fullUser = await usersRepo.getRowById(env, payload.uid);
      if (!fullUser || fullUser.status !== 'active') {
        // 账号被删除或禁用：清 cookie 回登录页
        return new Response('', {
          status: 302,
          headers: { 'Location': '/', 'Set-Cookie': 'token=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0' }
        });
      }
      role = fullUser.role;
    } else {
      role = 'admin';
    }
    const isAdmin = role === 'admin';

    // 支付结果页：所有登录用户可访问（支付回跳入口）
    if (pathname === '/pay/result') {
      return new Response(payResultPage, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // 提醒设置页：所有登录用户可访问（admin 也在这里配自己的 SMTP/模板，数据按 owner 隔离）
    if (pathname === '/me/notify' || pathname === '/notify-settings') {
      return new Response(myNotifyPage, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // 普通用户：个人中心 + 客户列表 + 仪表盘 + 通知历史可用（数据均按 owner 隔离）；
    // 管理子页（用户/套餐/系统配置）一律回个人中心
    if (!isAdmin) {
      if (pathname === '/me' || pathname === '/user-center') {
        return new Response(userCenterPage, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      if (pathname === '/admin/dashboard') {
        return new Response(dashboardPage(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      if (pathname === '/admin/notify-logs') {
        return new Response(notifyLogsPage, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      // 普通用户的提醒设置（自己的通知渠道，用户隔离）
      if (pathname === '/me/notify' || pathname === '/notify-settings') {
        return new Response(myNotifyPage, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      const ADMIN_ONLY_PAGES = ['/admin/users', '/admin/plans', '/admin/config'];
      if (ADMIN_ONLY_PAGES.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
        return new Response('', {
          status: 302,
          headers: { 'Location': '/me' }
        });
      }
      // 其余 /admin 路径 = 客户列表，放行
      return new Response(adminPage, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (pathname === '/admin/config') {
      return new Response(configPage, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (pathname === '/admin/dashboard') {
      return new Response(dashboardPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (pathname === '/admin/notify-logs') {
      return new Response(notifyLogsPage, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (pathname === '/admin/users') {
      return new Response(usersPage, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (pathname === '/admin/plans') {
      return new Response(plansPage, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (pathname === '/admin/orders') {
      return new Response(adminOrdersPage, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response(adminPage, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  } catch (error) {
    console.error('[管理页面] 处理请求时出错:', error);
    return new Response('服务器内部错误', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

function handleLoginPage() {
  return new Response(loginPage, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

export { handleAdminRequest, handleLoginPage };
