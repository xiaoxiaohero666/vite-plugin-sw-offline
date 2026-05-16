/**
 * vite-plugin-sw-offline：单一 Vite 插件（dev 直出 SW / 离线页；build 写入 dist 并注入）
 */

const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PKG_ROOT, 'runtime');
const DEFAULT_OFFLINE_HTML = path.join(PKG_ROOT, 'templates', 'default', 'offline.html');
const DEFAULT_OFFLINE_I18N_JSON = path.join(PKG_ROOT, 'templates', 'default', 'offline-i18n.json');
/** 默认离线页背景（与模板、runtime/sw.js 中 /static/offline-bg.jpg 一致） */
const DEFAULT_OFFLINE_BG_JPG = path.join(PKG_ROOT, 'assets', 'offline-bg.jpg');

const LOG = '[vite-plugin-sw-offline]';

/** 由本包提供、不再从业务项目 public/ 读取的文件名 */
const PACKAGE_SW_ASSET_NAMES = new Set(['sw.js', 'sw-register.js', 'offline.html', 'sw-noop.js']);

function resolveOfflineTemplatePath(swConfig) {
  const custom = swConfig && swConfig.offlineTemplatePath;
  if (custom && typeof custom === 'string') {
    const abs = path.isAbsolute(custom) ? custom : path.resolve(process.cwd(), custom);
    if (fs.existsSync(abs)) {
      return abs;
    }
    console.warn(LOG, 'offlineTemplatePath not found, using default:', abs);
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

function loadOfflineI18nMessages() {
  try {
    const raw = fs.readFileSync(DEFAULT_OFFLINE_I18N_JSON, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn(LOG, 'offline-i18n.json missing or invalid:', e.message);
    return {};
  }
}

function injectOfflineI18nPlaceholder(content) {
  const messages = loadOfflineI18nMessages();
  const raw = JSON.stringify(messages);
  const safe = raw.replace(/</g, '\\u003c');
  return content.replace(/__OFFLINE_I18N_INJECT__/g, safe);
}

function injectOfflineHtml(content, swConfig) {
  content = injectOfflineI18nPlaceholder(content);
  const logo = normalizeOfflineLogoPath((swConfig && swConfig.offlineLogoPath) || '');
  if (logo) {
    content = content.replace(/__OFFLINE_LOGO__/g, logo);
  }
  if (swConfig && swConfig.offlineDomain) {
    content = content.replace(/__OFFLINE_DOMAIN__/g, swConfig.offlineDomain);
  }
  return content;
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

/** 包内默认离线背景图路径 */
function getDefaultOfflineBackgroundPath() {
  return DEFAULT_OFFLINE_BG_JPG;
}

module.exports = {
  vitePluginSwOffline,
  getRuntimeDir,
  getDefaultOfflineTemplatePath,
  getDefaultOfflineBackgroundPath,
  getDefaultCacheableApiPaths: () => DEFAULT_CACHEABLE_API_PATHS.slice(),
  getDefaultServiceWorker: () => ({ ...DEFAULT_SERVICE_WORKER }),
  resolveServiceWorker,
  normalizeOfflineLogoPath,
  injectOfflineHtml
};
