# 插件独立仓库交接说明（给新工作区 / npm 仓库用）

> 从 `uniapp-vite` monorepo 拆出时的设计记忆。在新文件夹用 Cursor 时，可 `@HANDOFF.md` + `README.md` 恢复上下文。

## 包是什么

- **名称**：`vite-plugin-sw-offline`
- **职责**：单一 Vite 插件 — dev 中间件直出 `sw.js` / `offline.html` / `sw-register.js`；build 的 `closeBundle` 写入 dist，并注入占位符。
- **入口**：`src/index.js`（CommonJS），`main` 指向该文件。

## 与业务项目（uniapp-vite）的关系

业务仓只需：

```ts
// vite.config.ts
import { vitePluginSwOffline } from 'vite-plugin-sw-offline';
import { CACHEABLE_SW_API_PATHS } from './src/configs/sw-cacheable-api-paths.js';

vitePluginSwOffline({
  outDir: 'dist',
  offlineLogoPath: '...',
  offlineDomain: '...',
  cacheableApiPaths: CACHEABLE_SW_API_PATHS,
  robotsTxtContent: '...', // 可选
  // networkProbeUrl: () => buildSwNetworkProbeUrl(...), // 可选，见 README
});
```

```html
<!-- index.html -->
<script src="/sw-register.js?v=__SW_REGISTER_VERSION__"></script>
```

- **不要**在业务 `public/` 放 `sw.js`、`sw-register.js`、`offline.html`、`sw-noop.js`（插件会接管）。
- API 白名单建议放在业务仓 `sw-cacheable-api-paths.js`；插件默认白名单为空，须由业务传入 `cacheableApiPaths`。

## 已拍板的设计决策（避免重复争论）

|  topic | 结论 |
|--------|------|
| `swVersion` | **插件内自动生成**（实例化时 `Date.now()`），不必业务传；可选手动覆盖。用于 `sw.js?v=`、`sw-register.js?v=`、`index.html` 占位。 |
| `useApiGateway` / `productCode` | **已删除**，不再注入 SW；探测 URL 统一由业务 `networkProbeUrl`（字符串或回调）传入完整地址。 |
| `networkProbeUrl` | 支持 `string \| (ctx) => string`；空则不注入，SW 默认同源探测 `sw.js`。README 含 `buildSwNetworkProbeUrl` 参考实现（网关/非网关）。 |
| `serviceWorker` | 对象字段：`apiTimeout`、`imageCacheMaxItems` 等，对应 `sw.js` 里 `__SW_RT_*__` 占位符。 |
| 离线页背景 | **全屏 `body` + `background-size: cover` + `top center`**，无媒体查询窄栏方案。 |
| `define` 陷阱 | 业务 `vite.config` **不要**写 `define: { 'process.env': { APP_ENV, IS_APP } }` 整对象替换，会抹掉 `NODE_ENV`，导致 dev 下 `process.env.NODE_ENV === 'development'` 的 console 失效。应分别 `process.env.APP_ENV` / `IS_APP`。 |

## npm 发布状态

- 已发布：`vite-plugin-sw-offline`（npm 安装即可）
- 业务仓：`npm install vite-plugin-sw-offline -D`，在 `vite.config.ts` 中 `import { vitePluginSwOffline } from 'vite-plugin-sw-offline'`

## 包内目录

```
src/index.js
runtime/sw.js | sw-register.js | sw-noop.js
templates/default/offline.html
assets/offline-bg.jpg
README.md          # 用户文档（完整）
HANDOFF.md         # 本文件（AI/维护者上下文）
```

## 终端日志 vs 浏览器

- 插件 `console.log('[vite-plugin-sw-offline] ...')` → **跑 vite 的终端**
- `[SW]` / `[App]` → **浏览器控制台**（sw.js / sw-register.js）

## 后续可做（未做）

- ESM 入口 / `exports` 字段
- 将 `buildSwNetworkProbeUrl` 收到插件可选导出（目前只在 README 里给复制粘贴版）

