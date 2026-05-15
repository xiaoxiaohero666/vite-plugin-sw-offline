# vite-plugin-sw-offline

面向 **Vite H5 / uni-app H5** 的 **单一 Vite 插件**：开发环境通过中间件直出 Service Worker、离线页与配套资源；生产构建结束时写入产出目录，并与 `public/` 复制策略协同。

## 目录

- [功能概览](#功能概览)
- [安装与 Peer 依赖](#安装与-peer-依赖)
- [快速接入](#快速接入)
- [版本号（swVersion）](#版本号swversion)
- [维护接口探测（networkProbeUrl）](#维护接口探测networkprobeurl)
- [开发 vs 生产](#开发-vs-生产)
- [public 目录约定](#public-目录约定)
- [配置项](#配置项)
- [构建时注入占位符](#构建时注入占位符)
- [SW 缓存策略简述](#sw-缓存策略简述)
- [页面侧 API（window.swCache）](#页面侧-apiwindowswcache)
- [程序化导出](#程序化导出)
- [自定义离线页](#自定义离线页)
- [包内文件结构](#包内文件结构)
- [发布到 npm](#发布到-npm)

## 功能概览

| 能力 | 说明 |
|------|------|
| **Service Worker** | 内置 `runtime/sw.js`：带 hash 静态资源、图片 SWR、可配置 API 白名单、导航离线兜底等 |
| **离线页** | 默认 `templates/default/offline.html`，支持自定义模板；可注入 Logo、域名 |
| **默认背景图** | 包内 `assets/offline-bg.jpg` → 产出 `static/offline-bg.jpg`，与离线页 CSS 一致 |
| **注册脚本** | `sw-register.js` 注册 SW 并挂载 `window.swCache`；`sw-noop.js` 用于卸载场景 |
| **uni-app** | 识别 CLI `vite build --outDir xxx`，写入实际产出目录 |

构建 / 开发时由插件**替换源码占位符**（API 白名单、探测 URL、超时、版本号等），无需在业务 `public/` 维护 `sw.js`。

## 安装与 Peer 依赖

```bash
npm install vite-plugin-sw-offline -D
# pnpm add vite-plugin-sw-offline -D
# yarn add vite-plugin-sw-offline -D
```

需已安装 **Vite 5 或 6**：

```bash
npm install vite -D
```

本包为 **CommonJS**（`main` → `src/index.js`），在 Vite 的 ESM 配置文件中可直接 `import` 使用。

## 快速接入

### 1. `vite.config.ts`

```ts
import { defineConfig } from 'vite';
import { vitePluginSwOffline } from 'vite-plugin-sw-offline';

export default defineConfig({
  plugins: [
    vitePluginSwOffline({
      // 未传 CLI --outDir 时的构建产出目录（默认 dist）
      outDir: 'dist',
      // 离线页 Logo，注入 __OFFLINE_LOGO__ 并参与 SW 预缓存
      offlineLogoPath: '/static/logos/your-logo.png',
      // 离线页打字机展示的域名文案
      offlineDomain: 'https://www.example.com',
      // 可走 SWR 的 API 路径白名单（pathname 包含即匹配）；不传则为空
      cacheableApiPaths: ['/user/getUserInfo.do', '/config/queryConfig.do'],
      // 导航前外网探测 URL，空则探测同源 /sw.js；见「维护接口探测」
      // networkProbeUrl: () => 'https://api.example.com/wh/maintain/checkMaintain?productCode=demo',
      // SW 超时、缓存条数等，对应 sw.js 内 __SW_RT_*__ 占位符
      // serviceWorker: { apiTimeout: 45000, networkProbeTimeout: 15000 },
    })
  ]
});
```

**不必传 `swVersion`**，插件会自动生成（见下节）。

### 2. `index.html`

在入口 HTML 引入注册脚本，并保留版本占位（构建时由插件替换）：

```html
<!-- 构建时 __SW_REGISTER_VERSION__ 会替换为 swVersion，用于破坏 SW 脚本缓存 -->
<script src="/sw-register.js?v=__SW_REGISTER_VERSION__"></script>
```

### 3. 业务白名单（推荐）

将可缓存 API 路径集中在业务仓库（便于 Code Review），例如：

```js
// src/configs/sw-cacheable-api-paths.js
export const CACHEABLE_SW_API_PATHS = [
  '/config/queryConfig.do',
  '/user/getUserInfo.do'
];
```

在 `vite.config.ts` 中引入并传入：

```ts
import { CACHEABLE_SW_API_PATHS } from './src/configs/sw-cacheable-api-paths.js';

// vitePluginSwOffline({ ... }) 内
// 可缓存 API 路径白名单，与独立配置文件保持一致便于 Code Review
cacheableApiPaths: CACHEABLE_SW_API_PATHS,
```

不传则 API 白名单为空（不缓存任何 API，**生产务必显式配置自己的列表**）。

## 版本号（swVersion）

用于 **缓存破坏**：让 Telegram WebView 等环境在每次部署后拉到新的 `sw.js` / `sw-register.js`。

| 注入位置 | 效果 |
|----------|------|
| `sw-register.js` | `navigator.serviceWorker.register('/sw.js?v=' + 版本)` |
| `index.html` | `<script src="/sw-register.js?v=版本">` |
| `sw.js` | `SW_BUILD_VERSION` 常量（主要用于 SW 控制台日志） |

**默认行为（推荐）**

- 不传 `swVersion` 时，插件在**实例化时**生成一次 `Date.now()` 字符串。
- 同一次 `vite dev` 或同一次 `vite build` 内版本不变；重新启动 dev / 重新 build 会换新版本。
- 终端会打印：`[vite-plugin-sw-offline] swVersion (auto): 1739...`

**手动覆盖（可选）**

```js
vitePluginSwOffline({
  swVersion: process.env.CI_COMMIT_SHA || String(Date.now())
})
```

## 维护接口探测（networkProbeUrl）

导航请求前，SW 会先探测外网是否可达；失败则返回 `offline.html`。

| 配置 | 行为 |
|------|------|
| **未配置** / 空字符串 / 回调返回 `''` | 不注入 `NETWORK_PROBE_URL`，SW **探测同源 `/sw.js`**（适合纯本地调试） |
| **完整 URL 字符串** | 写入 `sw.js`，导航时用该地址做 HEAD 探测 |
| **`(ctx) => string` 回调** | 每次生成 `sw.js` 时调用（dev 中间件、build 写盘各一次） |

回调参数 **`ctx`**：

| 字段 | 含义 |
|------|------|
| `command` | `serve`（dev）或 `build` |
| `mode` | Vite 的 `mode`（如 `development`、`production`、`test`） |
| `phase` | `serve` 或 `build` |

### 网关模式说明（参考函数）

以下针对可选参考函数 `buildSwNetworkProbeUrl(def, productCode)` 中的 **`def`**（环境配置对象）：

| `def.useApiGateway` | 行为 |
|---------------------|------|
| `true` / `'true'` | 从 `baseURL`、`baseURLs` 首条、`maintainURL` 中取第一个合法绝对 URL，拼 `api.{主域}/wh/maintain/checkMaintain?productCode=...` |
| `false` | 仅用 `maintainURL` + `/maintain/checkMaintain?productCode=...` |
| 未设置 | 先试 `baseURL` 的 `origin + /wh`，否则 `maintainURL`，再拼 tail |

### 参考实现：`buildSwNetworkProbeUrl`

复制到 `vite.config.js` 或独立模块，按项目 env / 品牌名调整：

```js
function buildSwNetworkProbeUrl(def, productCode) {
  const PRODUCT_CODE = productCode != null ? String(productCode).trim() : '';
  const hasProductCode = PRODUCT_CODE.length > 0;
  if (!def || !hasProductCode) return '';

  const isGateway = def.useApiGateway === true || def.useApiGateway === 'true';

  if (isGateway && hasProductCode) {
    let ref = null;
    for (const raw of [def.baseURL, def.baseURLs && String(def.baseURLs).split(',')[0].trim(), def.maintainURL]) {
      if (!raw) continue;
      try {
        const u = new URL(raw);
        if (u.hostname && (u.protocol === 'http:' || u.protocol === 'https:')) {
          ref = u;
          break;
        }
      } catch {
        /* continue */
      }
    }
    if (!ref) return '';
    const hostname = ref.hostname;
    const parts = hostname.split('.');
    const baseDomain = parts.length >= 3 ? parts.slice(-2).join('.') : hostname;
    return `${ref.protocol}//api.${baseDomain}/wh/maintain/checkMaintain?productCode=${encodeURIComponent(PRODUCT_CODE)}`;
  }

  const tail = `/maintain/checkMaintain?productCode=${encodeURIComponent(PRODUCT_CODE)}`;
  const trim = (s) => (s && String(s).replace(/\/$/, '')) || '';

  let whBase = '';
  if (def.useApiGateway === false) {
    whBase = trim(def.maintainURL);
  } else {
    if (def.baseURL) {
      try {
        const u = new URL(def.baseURL);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          whBase = `${u.origin}/wh`;
        }
      } catch {
        /* 相对路径 baseURL */
      }
    }
    if (!whBase) whBase = trim(def.maintainURL);
  }
  return whBase ? trim(whBase) + tail : '';
}
```

### 回调接入示例

```ts
import configEnv from './src/configs/env/xxx/yyy.js';
import SERIES from './src/configs/series/...';

// defineConfig plugins 内
vitePluginSwOffline({
  networkProbeUrl: () => buildSwNetworkProbeUrl(configEnv.default, SERIES.name),
  // networkProbeUrl: 'https://api.example.com/wh/maintain/checkMaintain?productCode=demo',
});
```

## 开发 vs 生产

| 行为 | `vite dev` | `vite build` |
|------|------------|--------------|
| `/sw.js`、`/offline.html`、`/sw-register.js`、`/sw-noop.js` | 中间件直出（已注入） | 写入产出目录根目录 |
| `/static/offline-bg.jpg` | 读包内资源直出 | 复制到 `产出目录/static/` |
| `index.html` 中 `__SW_REGISTER_VERSION__` | `transformIndexHtml` 替换 | 同上 + `closeBundle` 再写一次 `index.html` |
| `public/` 其余文件 | Vite 默认 | `closeBundle` 复制（排除插件接管的 SW 文件名） |
| 终端日志 | 启动时 `swVersion (auto)`、dev 中间件说明等 | `sw.js -> dist/...`、`copy-public target` 等 |

**说明**：业务代码里的 `console.log` 出现在**浏览器控制台**；插件 `console.log` 出现在**运行 Vite 的终端**。

## public 目录约定

构建时复制 `public/` → 产出目录，但以下文件**由插件生成**，放在 `public/` 也不会覆盖：

- `sw.js`
- `sw-register.js`
- `offline.html`
- `sw-noop.js`

若配置 `robotsTxtContent`，构建复制 `robots.txt` 时用该内容覆盖。

## 配置项

除特别说明外均可选。

| 选项 | 类型 | 说明 |
|------|------|------|
| `outDir` | `string` | 未传 CLI `--outDir` 时的产出目录，默认 `dist`。仅解析路径，不写入 SW。 |
| `fallbackOutDir` | `string` | 与 `outDir` 同义备选，内部会剔除。 |
| `swVersion` | `string` | 见 [版本号](#版本号swversion)。未传则自动生成。 |
| `networkProbeUrl` | `string \| (ctx) => string` | 见 [维护接口探测](#维护接口探测networkprobeurl)。 |
| `offlineLogoPath` | `string` | 离线页 `__OFFLINE_LOGO__` 与 SW 预缓存 Logo；支持 `https://`、根路径 `/`、`?v=`。 |
| `offlineDomain` | `string` | 离线页打字机文案 `__OFFLINE_DOMAIN__`。 |
| `offlineTemplatePath` | `string` | 自定义离线页 HTML（绝对路径或相对 `process.cwd()`）。不存在则回退默认模板。 |
| `cacheableApiPaths` | `string[]` | API 路径白名单（pathname 包含即走 SWR）。不传则为空列表。 |
| `robotsTxtContent` | `string` | 非空时覆盖产出目录 `robots.txt`。 |
| `serviceWorker` | `object` | SW 数值参数，见下表。 |

### `serviceWorker` 子项

非法或小于最小值时回退默认。

| 字段 | 默认 | 最小 | 含义 |
|------|------|------|------|
| `apiTimeout` | `30000` | `1000` | 可缓存 API 的 fetch 超时（ms） |
| `imageCacheMaxAge` | 30 天 | `1` | 预留，当前 SW 可能未读取 |
| `imageCacheMaxItems` | `500` | `1` | 图片缓存桶上限 |
| `staticCacheMaxItems` | `200` | `1` | 静态缓存桶上限 |
| `networkProbeTimeout` | `15000` | `1000` | 导航前网络探测超时（ms） |

预览合并结果：

```ts
import { getDefaultServiceWorker, resolveServiceWorker } from 'vite-plugin-sw-offline';

resolveServiceWorker({ serviceWorker: { apiTimeout: 5000 } });
```

## 构建时注入占位符

| 文件 | 占位符 | 来源 |
|------|--------|------|
| `sw.js` | `__CACHEABLE_API_PATHS__` | `cacheableApiPaths` |
| `sw.js` | `__NETWORK_PROBE_URL__` | `networkProbeUrl` |
| `sw.js` | `__SW_VERSION__` | `swVersion`（自动或手动） |
| `sw.js` | `__OFFLINE_LOGO_PATH__` | `offlineLogoPath`（规范化） |
| `sw.js` | `__SW_RT_*__` | `serviceWorker` 各字段 |
| `sw-register.js` | `__SW_VERSION__` | `swVersion` |
| `offline.html` | `__OFFLINE_LOGO__` | `offlineLogoPath` |
| `offline.html` | `__OFFLINE_DOMAIN__` | `offlineDomain` |
| `index.html` | `__SW_REGISTER_VERSION__` | `swVersion` |

## SW 缓存策略简述

详见 `runtime/sw.js` 顶部注释，概要：

1. 带 hash 的 JS/CSS/字体 → Cache First  
2. 图片 → Stale-While-Revalidate（条数上限可配）  
3. 白名单 API → Stale-While-Revalidate  
4. 无 hash 同源静态 → Network First  
5. 导航 → 先外网探测，失败则 `offline.html`  

## 页面侧 API（window.swCache）

由 `sw-register.js` 挂载（不支持 SW 的环境为空函数，避免报错）：

| 方法 | 说明 |
|------|------|
| `clearApiCache()` | 通知 SW 清除 API 缓存（如登录/登出） |
| `clearImageCache()` | 清除图片缓存 |
| `clearAllCache()` | 清除所有 Cache Storage |
| `update()` | `registration.update()` 检查 SW 更新 |

应用版本更新仍由业务自身机制（如 `config.json`）负责；本插件只负责 SW 脚本与缓存策略。

## 程序化导出

```ts
import {
  vitePluginSwOffline,
  getRuntimeDir,
  getDefaultOfflineTemplatePath,
  getDefaultOfflineBackgroundPath,
  getDefaultCacheableApiPaths,
  getDefaultServiceWorker,
  resolveServiceWorker,
  normalizeOfflineLogoPath,
  injectOfflineHtml
} from 'vite-plugin-sw-offline';
```

| 导出 | 用途 |
|------|------|
| `vitePluginSwOffline` | 插件工厂 |
| `getRuntimeDir()` | 包内 `runtime/` 绝对路径 |
| `getDefaultOfflineTemplatePath()` | 默认离线页模板路径 |
| `getDefaultOfflineBackgroundPath()` | 默认背景图路径 |
| `getDefaultCacheableApiPaths()` | 默认 API 白名单副本（空数组） |
| `getDefaultServiceWorker()` | `serviceWorker` 默认值 |
| `resolveServiceWorker(partial)` | 合并默认值 |
| `normalizeOfflineLogoPath(raw)` | Logo 路径规范化 |
| `injectOfflineHtml(html, options)` | 仅注入离线页占位符 |

## 自定义离线页

通过 `offlineTemplatePath` 指定 HTML，占位符与默认模板相同：

- `__OFFLINE_LOGO__`
- `__OFFLINE_DOMAIN__`

背景图路径建议仍使用 `/static/offline-bg.jpg`（与 SW 预缓存一致），或自行改模板并同步调整 SW 预缓存逻辑。

## 包内文件结构

```
vite-plugin-sw-offline/
├── src/index.js          # 插件入口
├── runtime/
│   ├── sw.js             # Service Worker 主逻辑
│   ├── sw-register.js    # 注册与 window.swCache
│   └── sw-noop.js        # 空 SW（卸载用）
├── templates/default/
│   └── offline.html      # 默认离线页
├── assets/
│   └── offline-bg.jpg    # 默认背景图
└── README.md
```

## 发布到 npm

### 1. 检查 `package.json`

- `name` 在 npm 上唯一（可用 `@scope/vite-plugin-sw-offline`）
- 删除 `"private": true`
- `files` 含 `src`、`runtime`、`templates`、`assets`、`README.md`
- 建议补 `repository`、`bugs`、`homepage`

### 2. 登录与预演

```bash
npm login
npm pack --dry-run
```

### 3. 发布

```bash
npm publish
# 作用域包首次公开：npm publish --access public
```

### 4. 升级版本

```bash
npm version patch
npm publish
```

---

如有问题或需求（ESM 入口、`exports` 字段等），欢迎提 Issue 或 PR。
