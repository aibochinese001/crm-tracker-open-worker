# public/

Workers Assets 静态资源目录。客户端 JS / CSS / 独立 HTML 页面放在这里，
由 wrangler 自动打包并通过 ASSETS binding 服务到根路径下：

- `public/js/lib/*.js`  → 浏览器访问 `/js/lib/<name>.js`
- `public/js/pages/*.js` → 浏览器访问 `/js/pages/<name>.js`
- `public/css/*.css`    → 浏览器访问 `/css/<name>.css`

注意事项：

- 既有页面（`adminPage.html` / `configPage.html` 等）由 `src/views/` 下的
  text-import 提供，浏览器侧无须改动。新功能的客户端 JS 优先放进本目录，
  避免污染已有 HTML。
- 不要把敏感信息放进 `public/`（公网可读）。
