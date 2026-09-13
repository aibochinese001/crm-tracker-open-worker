/**
 * 简易 API 客户端
 *
 * 用法（浏览器全局）：
 *   <script src="/js/lib/api-client.js"></script>
 *   const r = await ApiClient.get('/api/notification-logs');
 *
 * 所有方法都返回解析后的 JSON；HTTP 非 2xx 会抛出含 status / body 的 Error。
 * 自动带 Cookie（凭着站内 SameSite=Strict 的 token）。
 */
(function (root) {
  'use strict';

  async function request(method, url, body) {
    /** @type {RequestInit} */
    const init = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    let data = null;
    try {
      data = await res.json();
    } catch {
      // 非 JSON 响应，保留 null
    }
    if (res.status === 401) {
      try {
        if (typeof window !== 'undefined' && window.location && !String(window.location.pathname || '').match(/^\/?$/)) {
          window.location.href = '/';
        }
      } catch (_) { /* ignore */ }
      const err = new Error((data && data.message) || '未授权访问');
      // @ts-ignore
      err.status = 401;
      // @ts-ignore
      err.body = data;
      throw err;
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || ('HTTP ' + res.status));
      // @ts-ignore
      err.status = res.status;
      // @ts-ignore
      err.body = data;
      throw err;
    }
    return data;
  }

  /**
   * 简易查询字符串构造（None / undefined 字段过滤掉）。
   *
   * @param {Record<string, any>} params
   * @returns {string}
   */
  function qs(params) {
    if (!params) return '';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      usp.append(k, String(v));
    }
    const s = usp.toString();
    return s ? '?' + s : '';
  }

  root.ApiClient = {
    get: (url, params) => request('GET', url + qs(params)),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    delete: (url) => request('DELETE', url),
    qs
  };
})(typeof window !== 'undefined' ? window : globalThis);
