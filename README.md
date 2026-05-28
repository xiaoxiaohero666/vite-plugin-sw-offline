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
- [离线页皮肤](#离线页皮肤)
- [自定义离线页](#自定义离线页)
- [包内文件结构](#包内文件结构)
- [发布到 npm](#发布到-npm)

## 功能概览

| 能力 | 说明 |
|------|------|
| **Service Worker** | 内置 `runtime/sw.js`：带 hash 静态资源、图片 SWR、可配置 API 白名单、导航离线兜底等 |
| **离线页** | 默认 `templates/default/offline.html`；内置多套皮肤（`offlineSkin`）；也支持自定义 HTML；可注入 Logo、域名 |
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
      // 离线页打字机展示的域名文案（可选；不传则注入 location.origin）
      // offlineDomain: 'https://www.example.com',
      // 离线页默认语言（可选；不传为 zh_CN；支持 en、en-US、en_US 等）
      // defaultLocale: 'en_US',
      // 内置皮肤（与 offlineTemplatePath 二选一，路径优先）
      // offlineSkin: 'aurora',
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
| `offlineDomain` | `string` | 离线页打字机 / 复制域名文案。未传或空串时，构建注入 `window.__OFFLINE_DOMAIN_TEXT__ = location.origin`（运行时取当前站点 origin）。 |
| `defaultLocale` | `string` | 离线页默认语言。未传或空串时为 `zh_CN`。支持简写（如 `en` → `en_US`）及 `zh-CN` / `zh_CN` 等形式；键须存在于 `offline-i18n.json`，否则回退 `zh_CN` 并打警告。 |
| `offlineSkin` | `string` | 使用包内置皮肤 id（如 `aurora` → `templates/skins/aurora/offline.html`）。与 `offlineTemplatePath` 同时配置时，**以路径为准**。 |
| `offlineTemplatePath` | `string` | 自定义离线页 HTML（绝对路径或相对 `process.cwd()`）。不存在则尝试 `offlineSkin`，再回退 default。 |
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
| `sw.js` | `__OFFLINE_DEFAULT_LOCALE__` | `defaultLocale`（规范化，默认 `zh_CN`） |
| `sw.js` | `__SW_RT_*__` | `serviceWorker` 各字段 |
| `sw-register.js` | `__SW_VERSION__` | `swVersion` |
| `offline.html` | `__OFFLINE_PAGE_STYLES__` | `templates/shared/offline-ui-motion.css`（入场、按钮、输入框等动效） |
| `offline.html` | `__OFFLINE_PAGE_SCRIPT__` | 引导变量 + `templates/shared/offline-common.js`（i18n、打字机、复制、客服）；其中 `__OFFLINE_DEFAULT_LOCALE__` 来自 `defaultLocale`（默认 `zh_CN`），`__OFFLINE_DOMAIN_TEXT__` 来自 `offlineDomain`，未配置则为 `location.origin` |
| `offline.html` | `__OFFLINE_LOGO__` | `offlineLogoPath` |
| `offline.html` | `__OFFLINE_DOMAIN__` | `offlineDomain` 字面量（仅旧模板占位符；未配置时为空，新模板请用 `__OFFLINE_PAGE_SCRIPT__`） |
| `offline.html` | `__OFFLINE_I18N_INJECT__` | 已废弃，自定义旧模板仍兼容 |
| `index.html` | `__SW_REGISTER_VERSION__` | `swVersion` |

## SW 缓存策略简述

详见 `runtime/sw.js` 顶部注释，概要：

1. 带 hash 的 JS/CSS/字体 → Cache First  
2. 图片 → Stale-While-Revalidate（条数上限可配）  
3. 白名单 API → Stale-While-Revalidate  
4. 无 hash 同源静态 → Network First  
5. 导航 → 先外网探测，失败则 `offline.html`  

### 离线页语言

文案来自 `templates/shared/offline-i18n.json`。运行时按以下优先级解析（高 → 低）：

1. URL 查询参数 `?locale=`（如 `?locale=en_US`）
2. `localStorage` 中 `common.locale`（JSON 字段 `locale`）
3. 插件配置 `defaultLocale`（未传则为 `zh_CN`）

SW 内联兜底离线页与完整 `offline.html` 使用相同规则。可用 `?locale=` 临时覆盖默认语言做验收。

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
  getOfflineSharedDir,
  buildOfflinePageScript,
  loadOfflineI18nMessages,
  getOfflineSkinsDir,
  listBuiltinOfflineSkins,
  getOfflineSkinTemplatePath,
  resolveOfflineTemplatePath,
  getDefaultCacheableApiPaths,
  getDefaultServiceWorker,
  resolveServiceWorker,
  normalizeOfflineLogoPath,
  normalizeOfflineLocaleKey,
  resolveDefaultLocale,
  getDefaultOfflineLocale,
  injectOfflineHtml
} from 'vite-plugin-sw-offline';
```

| 导出 | 用途 |
|------|------|
| `vitePluginSwOffline` | 插件工厂 |
| `getRuntimeDir()` | 包内 `runtime/` 绝对路径 |
| `getDefaultOfflineTemplatePath()` | 默认离线页模板路径 |
| `getDefaultOfflineBackgroundPath()` | 默认背景图路径 |
| `getOfflineSharedDir()` | 公用资源目录 `templates/shared` |
| `buildOfflinePageScript(options)` | 生成可注入的离线页脚本字符串 |
| `loadOfflineI18nMessages()` | 读取公用 i18n 对象 |
| `getOfflineSkinsDir()` | 内置皮肤根目录 `templates/skins` |
| `listBuiltinOfflineSkins()` | 当前包内可用皮肤 id 数组 |
| `getOfflineSkinTemplatePath(id)` | 某皮肤的 `offline.html` 绝对路径，不存在为 `null` |
| `resolveOfflineTemplatePath(options)` | 按插件规则解析最终模板路径 |
| `getDefaultCacheableApiPaths()` | 默认 API 白名单副本（空数组） |
| `getDefaultServiceWorker()` | `serviceWorker` 默认值 |
| `resolveServiceWorker(partial)` | 合并默认值 |
| `normalizeOfflineLogoPath(raw)` | Logo 路径规范化 |
| `normalizeOfflineLocaleKey(s)` | locale 简写 / 连字符规范化（如 `en` → `en_US`） |
| `resolveDefaultLocale(options)` | 按 `defaultLocale` 与 i18n 表解析最终默认键 |
| `getDefaultOfflineLocale()` | 常量 `zh_CN`（未配置插件时的内置默认） |
| `injectOfflineHtml(html, options)` | 仅注入离线页占位符 |

## 离线页皮肤

插件在包内提供多套离线页样式，通过 **`offlineSkin`** 选用，无需把 HTML 拷到业务仓库。

### 选用方式

```ts
vitePluginSwOffline({
  offlineSkin: 'aurora', // 内置皮肤 id
  offlineLogoPath: '/static/logos/your-logo.png',
  // offlineDomain: 'www.example.com', // 可选；省略则展示当前站点 location.origin
  // defaultLocale: 'en_US', // 可选；省略则为 zh_CN
  cacheableApiPaths: ['/user/getUserInfo.do'],
});
```

**优先级**（高 → 低）：

1. `offlineTemplatePath` — 业务自定义 HTML 绝对/相对路径  
2. `offlineSkin` — 包内 `templates/skins/<id>/offline.html`  
3. `templates/default/offline.html` — 默认深蓝 + 背景图

启动或构建时终端会打印实际使用的模板路径，例如：

```text
[vite-plugin-sw-offline] offline template (skin:aurora): .../templates/skins/aurora/offline.html
```

### 当前内置皮肤

| id | 风格 | 说明 |
|----|------|------|
| `aurora` | 深色 · 极光 | 紫青渐变、星点、毛玻璃域名条 |
| `sunset` | 深色 · 暮色 | 橙红暖色日落、圆角胶囊按钮 |
| `ocean` | 深色 · 深海 | 蓝青海浪光晕、简约直角卡片 |
| `neon` | 深色 · 赛博 | 霓虹描边、等宽域名、扫描线质感 |
| `minimal` | 浅色 · 极简 | 白灰网格底、清爽描边按钮 |
| `galaxy` | 深色 · 星空 | 旋转星云、闪烁星点、流星划过 |
| `matrix` | 深色 · 矩阵 | 数字雨网格、扫描线、绿色荧光 |
| `liquid` | 深色 · 流体 | 三色光斑模糊漂移（blob 动画） |
| `cybergrid` | 深色 · 赛博网格 | 3D 透视网格奔流、地平线光带脉冲 |
| `prism` | 深色 · 棱镜 | 旋转彩虹锥光、流光标题与渐变描边 |

以上皮肤均为 **纯 CSS 背景/动画**，不依赖 `offline-bg.jpg`；支持 `prefers-reduced-motion` 降级；域名条右侧为**复制图标**。

所有内置模板均注入公用 UI 动效（`templates/shared/offline-ui-motion.css`）：入场渐显、Logo 浮动、域名条光晕/扫光、标题微光、按钮脉冲与悬停反馈等；各皮肤另有独立背景动画与 `--offline-glow*` 主题色变量。

列出本机已安装包内全部皮肤 id：

```ts
import { listBuiltinOfflineSkins } from 'vite-plugin-sw-offline';

console.log(listBuiltinOfflineSkins());
// ['aurora', 'minimal', 'neon', 'ocean', 'sunset']
```

本地预览某套皮肤（无需跑 Vite）：在资源管理器中打开  
`node_modules/vite-plugin-sw-offline/templates/skins/<id>/preview.html`  
（仓库源码中路径为 `templates/skins/<id>/preview.html`）。

### 与背景图的关系

- **default** 模板使用 `url('/static/offline-bg.jpg')`，构建仍会复制包内 `assets/offline-bg.jpg` 到产出目录，并由 SW 预缓存。  
- **aurora** 等纯 CSS 皮肤可不引用该图；背景文件仍会复制，体积很小，一般可忽略。若需完全去掉，需改 SW 预缓存逻辑（见「自定义离线页」）。

## 自定义离线页

通过 `offlineTemplatePath` 指定业务侧 HTML（覆盖 `offlineSkin`）。**推荐**在 `</body>` 前使用与内置皮肤相同的占位符：

```html
<style>
__OFFLINE_PAGE_STYLES__
</style>
<script>
__OFFLINE_PAGE_SCRIPT__
</script>
```

插件会注入公用 UI 动效（`offline-ui-motion.css`）、`window.__OFFLINE_I18N__`、`window.__OFFLINE_DEFAULT_LOCALE__`、`window.__OFFLINE_DOMAIN_TEXT__` 及公用逻辑（`offline-common.js`）。`__OFFLINE_DEFAULT_LOCALE__` 由 `defaultLocale` 决定（默认 `zh_CN`）；`__OFFLINE_DOMAIN_TEXT__` 由 `offlineDomain` 决定：有配置则注入该字符串，未配置则注入表达式 `location.origin`（页面打开时即为当前站点，如 `https://example.com`）。皮肤样式块写在第一个 `<style>` 中即可，可通过 `:root` 覆盖 `--offline-glow` 等变量。文案维护在 **`templates/shared/offline-i18n.json`**（所有皮肤共用）。

自定义模板须保留以下 **DOM id**（仅结构/样式可自由调整）：

| id | 用途 |
|----|------|
| `logoWrap` | Logo 容器（`img` 使用 `__OFFLINE_LOGO__`） |
| `typingText` | 域名打字机 |
| `copyDomainBtn` | 复制域名按钮 |
| `offline-heading` / `offline-body` | 标题与说明 |
| `contactBtn` / `reloadBtn` | 客服 / 刷新 |
| `copyToast` | 复制成功提示 |

另支持旧占位符（不推荐新模板使用）：`__OFFLINE_LOGO__`、`__OFFLINE_DOMAIN__`、`__OFFLINE_I18N_INJECT__`。

使用 **default** 皮肤或自带背景图时，CSS 建议仍写 `/static/offline-bg.jpg`（与 SW 预缓存一致）。纯 CSS 背景的皮肤可省略该 URL。

## 包内文件结构

```
vite-plugin-sw-offline/
├── src/index.js          # 插件入口
├── runtime/
│   ├── sw.js             # Service Worker 主逻辑
│   ├── sw-register.js    # 注册与 window.swCache
│   └── sw-noop.js        # 空 SW（卸载用）
├── templates/
│   ├── shared/
│   │   ├── offline-i18n.json      # 多语言文案（所有皮肤共用）
│   │   ├── offline-common.js       # 公用交互脚本（构建时注入）
│   │   └── offline-ui-motion.css   # 公用 UI 动效（构建时注入）
│   ├── default/
│   │   └── offline.html         # 默认离线页（仅样式 + 结构）
│   └── skins/
│       ├── aurora/   # offlineSkin: 'aurora'
│       ├── sunset/   # offlineSkin: 'sunset'
│       ├── ocean/    # offlineSkin: 'ocean'
│       ├── neon/     # offlineSkin: 'neon'
│       ├── minimal/  # offlineSkin: 'minimal'
│       └── */preview.html  # 可选；改皮肤后运行 node scripts/build-offline-previews.js
├── assets/
│   └── offline-bg.jpg    # default 皮肤背景图
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
