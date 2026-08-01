/**
 * vite-plugin-sw-offline：单一 Vite 插件（dev 直出 SW / 离线页；build 写入 dist 并注入）
 */

const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PKG_ROOT, 'runtime');
const DEFAULT_OFFLINE_HTML = path.join(PKG_ROOT, 'templates', 'default', 'offline.html');
const OFFLINE_SHARED_DIR = path.join(PKG_ROOT, 'templates', 'shared');
const OFFLINE_I18N_JSON = path.join(OFFLINE_SHARED_DIR, 'offline-i18n.json');
const LEGACY_OFFLINE_I18N_JSON = path.join(PKG_ROOT, 'templates', 'default', 'offline-i18n.json');
const OFFLINE_COMMON_JS = path.join(OFFLINE_SHARED_DIR, 'offline-common.js');
const OFFLINE_UI_MOTION_CSS = path.join(OFFLINE_SHARED_DIR, 'offline-ui-motion.css');
const OFFLINE_SKINS_DIR = path.join(PKG_ROOT, 'templates', 'skins');
/** 默认离线页背景（与 default 模板、runtime/sw.js 中 /static/offline-bg.jpg 一致） */
const DEFAULT_OFFLINE_BG_JPG = path.join(PKG_ROOT, 'assets', 'offline-bg.jpg');

const LOG = '[vite-plugin-sw-offline]';

/** 由本包提供、不再从业务项目 public/ 读取的文件名 */
const PACKAGE_SW_ASSET_NAMES = new Set(['sw.js', 'sw-register.js', 'offline.html', 'sw-noop.js']);

/**
 * 包内置皮肤 id 列表（`templates/skins/<id>/offline.html` 存在即视为可用）
 * @returns {string[]}
 */
function listBuiltinOfflineSkins() {
  if (!fs.existsSync(OFFLINE_SKINS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(OFFLINE_SKINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(OFFLINE_SKINS_DIR, name, 'offline.html')))
    .sort();
}

/**
 * 内置皮肤模板绝对路径；不存在则返回 null
 * @param {string} skinId
 * @returns {string | null}
 */
function getOfflineSkinTemplatePath(skinId) {
  if (!skinId || typeof skinId !== 'string') {
    return null;
  }
  const id = skinId.trim();
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
    return null;
  }
  const abs = path.join(OFFLINE_SKINS_DIR, id, 'offline.html');
  return fs.existsSync(abs) ? abs : null;
}

/**
 * 解析离线页 HTML 路径：offlineTemplatePath > offlineSkin > default
 * @param {Object} [swConfig]
 * @returns {string}
 */
function resolveOfflineTemplatePath(swConfig) {
  const custom = swConfig && swConfig.offlineTemplatePath;
  if (custom && typeof custom === 'string') {
    const abs = path.isAbsolute(custom) ? custom : path.resolve(process.cwd(), custom);
    if (fs.existsSync(abs)) {
      return abs;
    }
    console.warn(LOG, 'offlineTemplatePath not found:', abs);
  }

  const skin = swConfig && swConfig.offlineSkin;
  if (skin && typeof skin === 'string') {
    const skinPath = getOfflineSkinTemplatePath(skin);
    if (skinPath) {
      return skinPath;
    }
    const builtIn = listBuiltinOfflineSkins();
    console.warn(
      LOG,
      `offlineSkin "${skin}" not found. Built-in: ${builtIn.length ? builtIn.join(', ') : '(none)'}.`
    );
  }

  if (custom && typeof custom === 'string') {
    console.warn(LOG, 'falling back to default offline template');
  }

  return DEFAULT_OFFLINE_HTML;
}

/**
 * 离线页 logo 写成站点根路径，避免当前页在子路径时相对路径解析错；保留 query（如 ?v=1）
 */
function normalizeOfflineLogoPath(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const q = trimmed.indexOf('?');
  const pathOnly = q === -1 ? trimmed : trimmed.slice(0, q);
  const query = q === -1 ? '' : trimmed.slice(q);
  const withSlash = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  return withSlash + query;
}

function resolveOfflineI18nJsonPath() {
  if (fs.existsSync(OFFLINE_I18N_JSON)) {
    return OFFLINE_I18N_JSON;
  }
  if (fs.existsSync(LEGACY_OFFLINE_I18N_JSON)) {
    return LEGACY_OFFLINE_I18N_JSON;
  }
  return OFFLINE_I18N_JSON;
}

function loadOfflineI18nMessages() {
  try {
    const raw = fs.readFileSync(resolveOfflineI18nJsonPath(), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn(LOG, 'offline-i18n.json missing or invalid:', e.message);
    return {};
  }
}

function loadOfflineCommonScript() {
  try {
    return fs.readFileSync(OFFLINE_COMMON_JS, 'utf-8');
  } catch (e) {
    console.warn(LOG, 'offline-common.js missing:', e.message);
    return '';
  }
}

function loadOfflineUiMotionStyles() {
  try {
    return fs.readFileSync(OFFLINE_UI_MOTION_CSS, 'utf-8');
  } catch (e) {
    console.warn(LOG, 'offline-ui-motion.css missing:', e.message);
    return '';
  }
}

function buildOfflinePageStyles() {
  return loadOfflineUiMotionStyles();
}

/**
 * 解析 offlineDomain：未传或空串则返回 null（运行时用 location.origin）
 * @param {Object} [swConfig]
 * @returns {string | null}
 */
function resolveOfflineDomainText(swConfig) {
  const raw = swConfig && swConfig.offlineDomain;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * 解析 offlineReloadInterval：未传回退默认 3000；0 关闭自动刷新；非法或负数回退默认
 * @param {Object} [swConfig]
 * @returns {number}
 */
function resolveOfflineReloadInterval(swConfig) {
  const raw = swConfig && swConfig.offlineReloadInterval;
  if (raw == null || raw === '') {
    return DEFAULT_OFFLINE_RELOAD_INTERVAL;
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(
      LOG,
      `offlineReloadInterval "${raw}" invalid, fallback to ${DEFAULT_OFFLINE_RELOAD_INTERVAL}`
    );
    return DEFAULT_OFFLINE_RELOAD_INTERVAL;
  }
  return Math.floor(n);
}

function injectOfflinePageStyles(content) {
  if (!content.includes('__OFFLINE_PAGE_STYLES__')) {
    return content;
  }
  return content.replace(/__OFFLINE_PAGE_STYLES__/g, buildOfflinePageStyles());
}

/** 离线页引导 + 公用脚本（注入 __OFFLINE_PAGE_SCRIPT__） */
function buildOfflinePageScript(swConfig) {
  const messages = loadOfflineI18nMessages();
  const i18nSafe = JSON.stringify(messages).replace(/</g, '\\u003c');
  const domain = resolveOfflineDomainText(swConfig);
  const domainLine =
    domain != null
      ? 'window.__OFFLINE_DOMAIN_TEXT__ = ' + JSON.stringify(domain) + ';\n'
      : 'window.__OFFLINE_DOMAIN_TEXT__ = location.origin;\n';
  const defaultLocale = resolveDefaultLocale(swConfig);
  const reloadInterval = resolveOfflineReloadInterval(swConfig);
  const common = loadOfflineCommonScript();
  return (
    'window.__OFFLINE_I18N__ = ' +
    i18nSafe +
    ';\n' +
    'window.__OFFLINE_DEFAULT_LOCALE__ = ' +
    JSON.stringify(defaultLocale) +
    ';\n' +
    'window.__OFFLINE_RELOAD_INTERVAL__ = ' +
    String(reloadInterval) +
    ';\n' +
    domainLine +
    common
  );
}

function injectOfflinePageScript(content, swConfig) {
  if (!content.includes('__OFFLINE_PAGE_SCRIPT__')) {
    return content;
  }
  return content.replace(/__OFFLINE_PAGE_SCRIPT__/g, buildOfflinePageScript(swConfig));
}

/** @deprecated 自定义模板若仍使用 __OFFLINE_I18N_INJECT__ 时兼容 */
function injectOfflineI18nPlaceholder(content) {
  const messages = loadOfflineI18nMessages();
  const raw = JSON.stringify(messages);
  const safe = raw.replace(/</g, '\\u003c');
  return content.replace(/__OFFLINE_I18N_INJECT__/g, safe);
}

function injectOfflineHtml(content, swConfig) {
  content = injectOfflinePageStyles(content);
  content = injectOfflinePageScript(content, swConfig);
  if (content.includes('__OFFLINE_I18N_INJECT__')) {
    content = injectOfflineI18nPlaceholder(content);
  }
  const logo = normalizeOfflineLogoPath((swConfig && swConfig.offlineLogoPath) || '');
  if (logo) {
    content = content.replace(/__OFFLINE_LOGO__/g, logo);
  }
  const domain = resolveOfflineDomainText(swConfig);
  if (content.includes('__OFFLINE_DOMAIN__')) {
    content = content.replace(/__OFFLINE_DOMAIN__/g, domain != null ? domain : '');
  }
  return content;
}

/** 未传入 defaultLocale 时离线页默认语言 */
const DEFAULT_OFFLINE_LOCALE = 'zh_CN';

/** 离线页自动刷新间隔（ms）；0 表示关闭 */
const DEFAULT_OFFLINE_RELOAD_INTERVAL = 3000;

const OFFLINE_LOCALE_SHORT = {
  en: 'en_US',
  zh: 'zh_CN',
  ja: 'ja_JP',
  ko: 'ko_KR',
  ar: 'ar_SA',
  hi: 'hi_IN',
  pt: 'pt_BR',
  ru: 'ru_RU',
  th: 'th_TH',
  tr: 'tr_TR',
  vi: 'vi_VN',
  es: 'es_MX'
};

/**
 * 规范化 locale 键（如 zh、zh-CN、zh_CN → zh_CN）
 * @param {string} s
 * @returns {string}
 */
function normalizeOfflineLocaleKey(s) {
  if (!s || typeof s !== 'string') return '';
  let t = s.trim().replace(/-/g, '_');
  if (t.indexOf('_') === -1) return OFFLINE_LOCALE_SHORT[t.toLowerCase()] || '';
  const i = t.indexOf('_');
  return t.slice(0, i).toLowerCase() + '_' + t.slice(i + 1).toUpperCase();
}

/**
 * 解析 defaultLocale：未传或空 → zh_CN；支持 zh / zh-CN / zh_CN；未知键回退 zh_CN
 * @param {Object} [swConfig]
 * @returns {string}
 */
function resolveDefaultLocale(swConfig) {
  const messages = loadOfflineI18nMessages();
  const raw = swConfig && swConfig.defaultLocale;
  if (raw == null || String(raw).trim() === '') {
    return DEFAULT_OFFLINE_LOCALE;
  }
  const normalized = normalizeOfflineLocaleKey(String(raw));
  if (normalized && messages[normalized]) {
    return normalized;
  }
  if (normalized) {
    console.warn(
      LOG,
      `defaultLocale "${raw}" not in offline-i18n.json, fallback to ${DEFAULT_OFFLINE_LOCALE}`
    );
  }
  return DEFAULT_OFFLINE_LOCALE;
}

/** 未传入 cacheableApiPaths 时使用的默认白名单（空列表，由业务显式配置） */
const DEFAULT_CACHEABLE_API_PATHS = [];

function resolveCacheableApiPaths(swConfig) {
  const p = swConfig && swConfig.cacheableApiPaths;
  if (Array.isArray(p) && p.length > 0) {
    return p.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  }
  return DEFAULT_CACHEABLE_API_PATHS.slice();
}

function readRuntimeFile(name) {
  return fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf-8');
}

/** Service Worker 通用数值默认（与 runtime/sw.js 占位符一致） */
const DEFAULT_SERVICE_WORKER = {
  /** fetchWithTimeout 用于可缓存 API */
  apiTimeout: 30000,
  /** 预留：图片缓存 TTL 语义，当前 sw 未读此常量 */
  imageCacheMaxAge: 30 * 24 * 60 * 60 * 1000,
  imageCacheMaxItems: 500,
  staticCacheMaxItems: 200,
  networkProbeTimeout: 15000
};

/**
 * 合并 serviceWorker 与默认值（非法或过小则回退默认）
 */
function resolveServiceWorker(swConfig) {
  const raw =
    swConfig && swConfig.serviceWorker && typeof swConfig.serviceWorker === 'object'
      ? { ...swConfig.serviceWorker }
      : {};
  const pick = (key, min) => {
    const v = raw[key];
    const d = DEFAULT_SERVICE_WORKER[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
      return d;
    }
    return Math.floor(v);
  };
  return {
    apiTimeout: pick('apiTimeout', 1000),
    imageCacheMaxAge: pick('imageCacheMaxAge', 1),
    imageCacheMaxItems: pick('imageCacheMaxItems', 1),
    staticCacheMaxItems: pick('staticCacheMaxItems', 1),
    networkProbeTimeout: pick('networkProbeTimeout', 1000)
  };
}

function injectServiceWorkerPlaceholders(content, swConfig) {
  const rt = resolveServiceWorker(swConfig);
  return content
    .replace('__SW_RT_API_TIMEOUT__', String(rt.apiTimeout))
    .replace('__SW_RT_IMAGE_CACHE_MAX_AGE__', String(rt.imageCacheMaxAge))
    .replace('__SW_RT_IMAGE_CACHE_MAX_ITEMS__', String(rt.imageCacheMaxItems))
    .replace('__SW_RT_STATIC_CACHE_MAX_ITEMS__', String(rt.staticCacheMaxItems))
    .replace('__SW_RT_NETWORK_PROBE_TIMEOUT__', String(rt.networkProbeTimeout));
}

function applySwJsPlaceholders(content, swConfig) {
  content = injectOfflineI18nPlaceholder(content);
  content = injectServiceWorkerPlaceholders(content, swConfig);
  const apiPathsJson = JSON.stringify(resolveCacheableApiPaths(swConfig));
  content = content.replace(
    'const CACHEABLE_API_PATHS = __CACHEABLE_API_PATHS__;',
    'const CACHEABLE_API_PATHS = ' + apiPathsJson + ';'
  );
  const probeUrl = swConfig.networkProbeUrl;
  if (probeUrl) {
    content = content.replace(
      "const NETWORK_PROBE_URL = '__NETWORK_PROBE_URL__';",
      'const NETWORK_PROBE_URL = ' + JSON.stringify(String(probeUrl)) + ';'
    );
  }
  if (swConfig.swVersion) {
    content = content.replace(
      "const SW_BUILD_VERSION = '__SW_VERSION__';",
      'const SW_BUILD_VERSION = ' + JSON.stringify(String(swConfig.swVersion)) + ';'
    );
  }
  const logoForSw = normalizeOfflineLogoPath((swConfig && swConfig.offlineLogoPath) || '');
  content = content.replace(
    "const OFFLINE_LOGO_PATH = '__OFFLINE_LOGO_PATH__';",
    'const OFFLINE_LOGO_PATH = ' + JSON.stringify(logoForSw) + ';'
  );
  content = content.replace(
    "const OFFLINE_DEFAULT_LOCALE = '__OFFLINE_DEFAULT_LOCALE__';",
    'const OFFLINE_DEFAULT_LOCALE = ' + JSON.stringify(resolveDefaultLocale(swConfig)) + ';'
  );
  return content;
}

function injectSwRegisterVersion(content, swVersion) {
  if (!swVersion) return content;
  return content.replace(
    "var SW_VERSION = '__SW_VERSION__';",
    'var SW_VERSION = ' + JSON.stringify(String(swVersion)) + ';'
  );
}

/**
 * 解析 `networkProbeUrl`：支持字符串，或 `(ctx) => string` 在生成 sw.js 时调用。
 * 未传、非函数非字符串、或解析结果为空 → 返回 ''（不注入，SW 内走默认同源探测）。
 */
function resolveNetworkProbeUrlForInject(swConfig, probeCtx) {
  const raw = swConfig && swConfig.networkProbeUrl;
  if (raw == null) return '';
  if (typeof raw === 'function') {
    try {
      const out = raw.call(swConfig, probeCtx || {});
      return out == null || out === '' ? '' : String(out).trim();
    } catch (e) {
      console.warn(LOG, 'networkProbeUrl() failed:', e.message);
      return '';
    }
  }
  if (typeof raw === 'string') return raw.trim();
  if (raw != null) {
    console.warn(LOG, 'networkProbeUrl must be string or function, got:', typeof raw);
  }
  return '';
}

/** 生成注入 sw.js 用的配置：把 networkProbeUrl 回调解析为最终字符串，避免把函数带进其它逻辑 */
function swConfigForSwJsEmit(swConfig, probeCtx) {
  const url = resolveNetworkProbeUrlForInject(swConfig, probeCtx);
  return { ...swConfig, networkProbeUrl: url };
}

function loadInjectedSwJs(swConfig, probeCtx) {
  return applySwJsPlaceholders(readRuntimeFile('sw.js'), swConfigForSwJsEmit(swConfig, probeCtx));
}

function loadInjectedSwRegister(swConfig) {
  return injectSwRegisterVersion(readRuntimeFile('sw-register.js'), swConfig.swVersion);
}

function loadInjectedOfflineHtml(swConfig) {
  const raw = fs.readFileSync(resolveOfflineTemplatePath(swConfig), 'utf-8');
  return injectOfflineHtml(raw, swConfig);
}

/** 将包内默认背景图写入 dist/static/offline-bg.jpg（与 SW 预缓存路径一致） */
function copyDefaultOfflineBackground(targetDir, realOutDirLabel) {
  if (!fs.existsSync(DEFAULT_OFFLINE_BG_JPG)) {
    console.warn(LOG, 'package assets/offline-bg.jpg missing, skip static/offline-bg.jpg');
    return;
  }
  const staticDir = path.join(targetDir, 'static');
  fs.mkdirSync(staticDir, { recursive: true });
  const dest = path.join(staticDir, 'offline-bg.jpg');
  fs.copyFileSync(DEFAULT_OFFLINE_BG_JPG, dest);
  console.log(LOG, `static/offline-bg.jpg -> ${realOutDirLabel}/static/offline-bg.jpg (from package)`);
}

/**
 * SW 注册/脚本 URL 缓存破坏用版本号：未传 `options.swVersion` 时，在插件实例化时生成一次（同一次 dev/build 内不变）。
 */
function resolveSwVersion(options) {
  const v = options && options.swVersion;
  if (v != null && String(v).trim() !== '') {
    return String(v).trim();
  }
  return String(Date.now());
}

/**
 * 单一 Vite 插件：开发服直出 SW / 离线页 / 默认背景图；构建写入 dist 并注入占位符（兼容 uni --outDir）。
 * 选项字段见下方 DEFAULT_* 与各 replace；`outDir` / `fallbackOutDir` 仅用于解析产出目录，不会写入 SW。
 *
 * @param {Object} [options]
 */
function vitePluginSwOffline(options = {}) {
  const fallbackOutDir = options.outDir || options.fallbackOutDir || 'dist';
  const swVersion = resolveSwVersion(options);
  const swConfig = { ...options, swVersion };
  delete swConfig.outDir;
  delete swConfig.fallbackOutDir;

  /** @type {{ command: string, mode: string }} */
  let probeCtx = { command: 'serve', mode: 'development' };

  const serveMap = {
    '/sw.js': 'application/javascript',
    '/sw-noop.js': 'application/javascript',
    '/sw-register.js': 'application/javascript',
    '/offline.html': 'text/html; charset=utf-8'
  };

  return {
    name: 'vite-plugin-sw-offline',
    enforce: 'pre',
    configResolved(config) {
      probeCtx = { command: config.command, mode: config.mode };
      if (!options.swVersion || String(options.swVersion).trim() === '') {
        console.log(LOG, 'swVersion (auto):', swVersion);
      }
      const offlineTpl = resolveOfflineTemplatePath(swConfig);
      const skinLabel =
        swConfig.offlineSkin && getOfflineSkinTemplatePath(swConfig.offlineSkin)
          ? `skin:${swConfig.offlineSkin}`
          : swConfig.offlineTemplatePath
            ? 'custom path'
            : 'default';
      console.log(LOG, 'offline template (' + skinLabel + '):', offlineTpl);
    },
    configureServer(server) {
      let devReadyLogged = false;
      const logDevReady = () => {
        if (devReadyLogged) return;
        devReadyLogged = true;
        const ctx = { ...probeCtx, phase: 'serve' };
        const probe = resolveNetworkProbeUrlForInject(swConfig, ctx);
        console.log(
          LOG,
          'dev: middleware serving /sw.js, /sw-register.js, /offline.html, /sw-noop.js, /static/offline-bg.jpg'
        );
        if (probe) {
          console.log(LOG, 'dev: networkProbeUrl injected ->', probe);
        } else {
          console.log(LOG, 'dev: networkProbeUrl empty, SW will probe same-origin sw.js');
        }
      };
      if (server.httpServer) {
        if (server.httpServer.listening) {
          logDevReady();
        } else {
          server.httpServer.once('listening', logDevReady);
        }
      } else {
        logDevReady();
      }

      server.middlewares.use((req, res, next) => {
        const urlPath = req.url.split('?')[0];
        if (req.method === 'GET' && urlPath === '/static/offline-bg.jpg') {
          try {
            if (fs.existsSync(DEFAULT_OFFLINE_BG_JPG)) {
              res.setHeader('Content-Type', 'image/jpeg');
              res.setHeader('Cache-Control', 'no-store');
              res.end(fs.readFileSync(DEFAULT_OFFLINE_BG_JPG));
              return;
            }
            console.warn(LOG, 'default offline-bg.jpg missing in package');
          } catch (e) {
            console.warn(LOG, 'serve offline-bg.jpg failed:', e.message);
          }
        }

        const contentType = serveMap[urlPath];
        if (!contentType) {
          next();
          return;
        }

        let content;
        try {
          if (urlPath === '/offline.html') {
            content = loadInjectedOfflineHtml(swConfig);
          } else if (urlPath === '/sw.js') {
            content = loadInjectedSwJs(swConfig, { ...probeCtx, phase: 'serve' });
          } else if (urlPath === '/sw-register.js') {
            content = loadInjectedSwRegister(swConfig);
          } else {
            content = readRuntimeFile(urlPath.slice(1));
          }
        } catch (e) {
          console.warn(LOG, 'serve failed for', urlPath, e.message);
          next();
          return;
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');
        res.end(content);
      });
    },
    transformIndexHtml(html) {
      if (swConfig.swVersion) {
        return html.replace(/__SW_REGISTER_VERSION__/g, swConfig.swVersion);
      }
      return html;
    },
    closeBundle() {
      const args = process.argv;
      const outDirIdx = args.indexOf('--outDir');
      const cliOutDir = outDirIdx !== -1 && args[outDirIdx + 1] ? args[outDirIdx + 1] : null;
      const realOutDir = cliOutDir || fallbackOutDir;

      const publicDir = path.resolve(process.cwd(), 'public');
      const targetDir = path.resolve(process.cwd(), realOutDir);
      console.log(LOG, 'copy-public target:', realOutDir);

      if (fs.existsSync(publicDir) && fs.existsSync(targetDir)) {
        const files = fs.readdirSync(publicDir);
        files.forEach((file) => {
          if (PACKAGE_SW_ASSET_NAMES.has(file)) {
            return;
          }
          const srcFile = path.join(publicDir, file);
          const destFile = path.join(targetDir, file);
          if (!fs.statSync(srcFile).isFile()) {
            return;
          }
          if (file === 'robots.txt' && swConfig.robotsTxtContent) {
            fs.writeFileSync(destFile, swConfig.robotsTxtContent, 'utf-8');
            console.log(LOG, `${file} -> ${realOutDir}/${file} (robots override)`);
          } else {
            fs.copyFileSync(srcFile, destFile);
            console.log(LOG, `${file} -> ${realOutDir}/${file}`);
          }
        });
      } else {
        console.warn(LOG, 'copy-public skipped: public or target missing', targetDir);
      }

      if (fs.existsSync(targetDir)) {
        fs.writeFileSync(path.join(targetDir, 'sw.js'), loadInjectedSwJs(swConfig, { ...probeCtx, phase: 'build' }), 'utf-8');
        console.log(LOG, `sw.js -> ${realOutDir}/sw.js (injected)`);

        fs.writeFileSync(
          path.join(targetDir, 'sw-register.js'),
          loadInjectedSwRegister(swConfig),
          'utf-8'
        );
        console.log(LOG, `sw-register.js -> ${realOutDir}/sw-register.js`);

        fs.writeFileSync(path.join(targetDir, 'offline.html'), loadInjectedOfflineHtml(swConfig), 'utf-8');
        console.log(LOG, `offline.html -> ${realOutDir}/offline.html`);

        fs.writeFileSync(path.join(targetDir, 'sw-noop.js'), readRuntimeFile('sw-noop.js'), 'utf-8');
        console.log(LOG, `sw-noop.js -> ${realOutDir}/sw-noop.js`);

        copyDefaultOfflineBackground(targetDir, realOutDir);
      }

      if (swConfig.swVersion) {
        const indexHtml = path.join(targetDir, 'index.html');
        if (fs.existsSync(indexHtml)) {
          let html = fs.readFileSync(indexHtml, 'utf-8');
          html = html.replace(/__SW_REGISTER_VERSION__/g, swConfig.swVersion);
          fs.writeFileSync(indexHtml, html, 'utf-8');
          console.log(LOG, 'index.html: injected sw-register version', swConfig.swVersion);
        }
      }
    }
  };
}

/** 包内 runtime 目录（供文档或高级用法） */
function getRuntimeDir() {
  return RUNTIME_DIR;
}

/** 默认离线页模板路径 */
function getDefaultOfflineTemplatePath() {
  return DEFAULT_OFFLINE_HTML;
}

/** 离线页公用资源目录（i18n、common.js） */
function getOfflineSharedDir() {
  return OFFLINE_SHARED_DIR;
}

/** 内置皮肤目录（`templates/skins`） */
function getOfflineSkinsDir() {
  return OFFLINE_SKINS_DIR;
}

/** 包内默认离线背景图路径 */
function getDefaultOfflineBackgroundPath() {
  return DEFAULT_OFFLINE_BG_JPG;
}

module.exports = {
  vitePluginSwOffline,
  getRuntimeDir,
  getDefaultOfflineTemplatePath,
  getDefaultOfflineBackgroundPath,
  getOfflineSharedDir,
  buildOfflinePageScript,
  buildOfflinePageStyles,
  loadOfflineI18nMessages,
  getOfflineSkinsDir,
  listBuiltinOfflineSkins,
  getOfflineSkinTemplatePath,
  resolveOfflineTemplatePath,
  getDefaultCacheableApiPaths: () => DEFAULT_CACHEABLE_API_PATHS.slice(),
  getDefaultServiceWorker: () => ({ ...DEFAULT_SERVICE_WORKER }),
  resolveServiceWorker,
  normalizeOfflineLogoPath,
  normalizeOfflineLocaleKey,
  resolveDefaultLocale,
  getDefaultOfflineLocale: () => DEFAULT_OFFLINE_LOCALE,
  resolveOfflineReloadInterval,
  getDefaultOfflineReloadInterval: () => DEFAULT_OFFLINE_RELOAD_INTERVAL,
  injectOfflineHtml
};
