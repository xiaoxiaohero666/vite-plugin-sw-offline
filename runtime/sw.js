// ============================================
// Service Worker - 智能缓存策略
// ============================================
//
// 缓存策略概览：
//   1. 带 hash 静态资源（JS/CSS/字体）→ Cache First（永久缓存，hash 变则 URL 变）
//   2. 图片资源                       → Stale-While-Revalidate（先返回缓存，后台更新，最多500项）
//   3. 可缓存 API 接口                → Stale-While-Revalidate（先返回缓存，后台更新）
//   4. 无 hash 同源静态资源            → Network First（网络优先，缓存兜底）
//   5. 导航请求                       → Network First + 离线页面兜底
//
// ============================================

// ============================================
// 一、配置区（所有可调参数集中在此）
// ============================================

/** SW 构建版本号（构建时由 vite-plugin-sw-offline 注入，用于 vConsole 可见的状态上报） */
const SW_BUILD_VERSION = '__SW_VERSION__';

/** 缓存桶名称（固定，不需要手动版本号） */
const CACHE_NAMES = {
  STATIC: 'static-cache-v1',
  IMAGE: 'image-cache-v1',
  API: 'api-cache-v2'
};

/**
 * 缓存结构版本号 - 仅在大版本更新、需要清除所有旧缓存时手动递增
 * 普通构建无需修改（靠 content hash 自然淘汰旧资源）
 * 递增此值后，新 SW 激活时会自动清除所有旧缓存桶
 */
const CACHE_SCHEMA_VERSION = 1;
const CACHE_SCHEMA_KEY = '__sw_cache_schema__';

/** 离线页面路径 */
const OFFLINE_PAGE = '/offline.html';

/**
 * 离线页背景图（与离线页模板中 background-image 路径一致）
 * jpg 走 handleImageRequest，须预缓存进 IMAGE 桶，否则断网后 CSS 拉背景会 503。
 */
const OFFLINE_BACKGROUND = '/static/offline-bg.jpg';

/** 离线页 logo 路径（构建时由 vite-plugin-sw-offline 注入，与离线模板中 img 一致；空字符串表示不预缓存） */
const OFFLINE_LOGO_PATH = '__OFFLINE_LOGO_PATH__';

function hasOfflineLogoPrecache() {
  return (
    typeof OFFLINE_LOGO_PATH === 'string' &&
    OFFLINE_LOGO_PATH.length > 0 &&
    !OFFLINE_LOGO_PATH.startsWith('__')
  );
}

/** 与 img 请求 URL 一致的 logo Request，保证 cache.match/put 键一致 */
function offlineLogoRequest() {
  if (!hasOfflineLogoPrecache()) return null;
  const abs = new URL(OFFLINE_LOGO_PATH, self.location.origin).href;
  return new Request(abs, { cache: 'no-store', method: 'GET' });
}

/** 与文档请求 URL 一致的背景图 Request，保证 cache.match/put 键一致 */
function offlineBackgroundRequest() {
  return new Request(new URL(OFFLINE_BACKGROUND, self.location.origin).href, {
    cache: 'no-store',
    method: 'GET'
  });
}

/** 离线占位图（1x1 透明 PNG，用于图片加载失败时的兜底） */
const OFFLINE_IMAGE_PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/** 可缓存 API 路径白名单（构建时由 vite-plugin-sw-offline 注入；Stale-While-Revalidate） */
const CACHEABLE_API_PATHS = __CACHEABLE_API_PATHS__;

/** API 请求超时时间（毫秒，构建时由 vite-plugin-sw-offline 注入） */
const API_TIMEOUT = __SW_RT_API_TIMEOUT__;

/** 图片缓存过期时间（毫秒，构建时注入；当前 sw 逻辑未读取，预留） */
const IMAGE_CACHE_MAX_AGE = __SW_RT_IMAGE_CACHE_MAX_AGE__;

/** 图片缓存最大条目数（构建时注入） */
const IMAGE_CACHE_MAX_ITEMS = __SW_RT_IMAGE_CACHE_MAX_ITEMS__;

/** 静态资源缓存最大条目数（构建时注入） */
const STATIC_CACHE_MAX_ITEMS = __SW_RT_STATIC_CACHE_MAX_ITEMS__;

/**
 * 网络探测 URL（构建时由 vite-plugin-sw-offline 注入完整地址，例如 maintain/checkMaintain?productCode=…）
 * 用于 handleNavigationRequest 判断外网是否可达。
 * 未注入或仍为占位符时，降级为探测同源 sw.js（避免开发环境未配置时误用错误地址）
 */
const NETWORK_PROBE_URL = '__NETWORK_PROBE_URL__';

/** 网络探测超时时间（毫秒，构建时注入） */
const NETWORK_PROBE_TIMEOUT = __SW_RT_NETWORK_PROBE_TIMEOUT__;

/** 离线页文案（构建时注入 JSON，与 offline.html 同源） */
const OFFLINE_I18N = __OFFLINE_I18N_INJECT__;

/** 离线页默认语言（构建时由 vite-plugin-sw-offline 注入，与 defaultLocale 一致） */
const OFFLINE_DEFAULT_LOCALE = '__OFFLINE_DEFAULT_LOCALE__';

// ============================================
// 二、工具函数
// ============================================

/**
 * 带超时控制的 fetch
 * @param {Request} request - 请求对象
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(request, timeout) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('Request timeout'));
    }, timeout);

    fetch(request, { signal: controller.signal })
      .then((response) => {
        clearTimeout(timeoutId);
        resolve(response);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

/**
 * 判断 URL 是否带 content hash（Vite 构建产物）
 * 匹配类似: index-JKaBVbgN.js, vendor-vue.BBcDyYlz.js, uni.9345ee40.css
 * hash 使用 Base62 字符集 [a-zA-Z0-9]，长度通常为 8 位
 */
function isHashedAsset(url) {
  return /[-\.][a-zA-Z0-9]{8}\.(js|css|woff2?|ttf|eot)(\?.*)?$/.test(url.pathname);
}

/** 检查 URL 是否指向图片资源 */
function isImageRequest(url) {
  return /\.(png|jpe?g|gif|svg|webp|ico)$/i.test(url.pathname);
}

/** 检查 URL 是否命中可缓存的 API 路径 */
function isCacheableApi(url) {
  return CACHEABLE_API_PATHS.some(path => url.pathname.includes(path));
}

/**
 * 生成 API 缓存的 key
 * - GET 请求：pathname + search（含分页等查询参数）
 * - POST 请求：pathname + 请求体的简单 hash
 */
async function getApiCacheKey(request) {
  const url = new URL(request.url);
  let key = url.pathname;

  if (request.method === 'GET') {
    key += url.search;
  } else if (request.method === 'POST') {
    try {
      const body = await request.clone().text();
      let hash = 0;
      for (let i = 0; i < body.length; i++) {
        const char = body.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      key += `_POST_${hash}`;
    } catch (e) {
      console.warn('[SW] Failed to read POST body for cache key:', url.pathname, e.message);
      key += '_POST_nobody';
    }
  }

  return key;
}

/**
 * 限制缓存数量，淘汰最旧的条目（类 LRU）
 * 注意：此函数在各策略中以 fire-and-forget 方式调用，不影响请求响应速度
 */
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    const deleteCount = keys.length - maxItems;
    for (let i = 0; i < deleteCount; i++) {
      await cache.delete(keys[i]);
    }
    console.log('[SW] Trimmed cache', cacheName, '- removed', deleteCount, 'items');
  }
}

/**
 * 清理 API 缓存桶中不再属于 CACHEABLE_API_PATHS 白名单的旧条目
 * 场景：从白名单移除某接口后，下次 SW 激活时自动淘汰其残留缓存
 */
async function purgeStaleApiEntries() {
  try {
    const cache = await caches.open(CACHE_NAMES.API);
    const keys = await cache.keys();
    let purged = 0;
    for (const req of keys) {
      const url = new URL(req.url);
      const stillValid = CACHEABLE_API_PATHS.some(path => url.pathname.includes(path));
      if (!stillValid) {
        await cache.delete(req);
        purged++;
      }
    }
    if (purged > 0) {
      console.log('[SW] Purged', purged, 'stale API cache entries');
    }
  } catch (e) {
    console.warn('[SW] Failed to purge stale API entries:', e.message);
  }
}

function stringifyOfflineI18nForInlineScript() {
  try {
    return JSON.stringify(OFFLINE_I18N).replace(/</g, '\\u003c');
  } catch (e) {
    return '{}';
  }
}

/**
 * SW 内联兜底离线页 HTML（无 search-bar；语言逻辑与 offline.html 一致）
 */
function buildInlineOfflineFallbackHtml() {
  const messagesJson = stringifyOfflineI18nForInlineScript();
  const def = JSON.stringify(OFFLINE_DEFAULT_LOCALE);
  const script =
    '(function(){var M=' +
    messagesJson +
    ';var DEF=' +
    def +
    ';var SHORT={en:"en_US",zh:"zh_CN",ja:"ja_JP",ko:"ko_KR",ar:"ar_SA",hi:"hi_IN",pt:"pt_BR",ru:"ru_RU",th:"th_TH",tr:"tr_TR",vi:"vi_VN",es:"es_MX"};function norm(s){if(!s||typeof s!=="string")return "";s=s.trim().replace(/-/g,"_");if(s.indexOf("_")===-1)return SHORT[s.toLowerCase()]||"";var i=s.indexOf("_");return s.slice(0,i).toLowerCase()+"_"+s.slice(i+1).toUpperCase();}function resolveKey(){var u="";try{u=new URLSearchParams(location.search).get("locale")||"";}catch(e){}var st="";try{var raw=localStorage.getItem("common");if(raw){var o=JSON.parse(raw);if(o&&typeof o.locale==="string")st=o.locale;}}catch(e){}return norm(u)||norm(st)||DEF;}var key=resolveKey();if(!M[key])key=DEF;var t=M[key]||M[DEF];if(!t)return;document.documentElement.setAttribute("lang",key.replace("_","-"));if(key.indexOf("ar_")===0)document.documentElement.setAttribute("dir","rtl");document.title=t.title;var el=document.getElementById("oh");if(el)el.textContent=t.heading;el=document.getElementById("ob");if(el)el.textContent=t.body;el=document.getElementById("oc");if(el)el.textContent=t.contact;el=document.getElementById("or");if(el)el.textContent=t.reload;window.__offlineContactHint=t.contactOfflineHint;})();';
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">' +
    '<title></title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#131529;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 20px;color:#fff}' +
    '.c{text-align:center;max-width:400px;width:100%}' +
    'h1{font-size:22px;font-weight:600;margin-bottom:16px}' +
    'p{font-size:14px;color:rgba(255,255,255,0.6);margin-bottom:40px;line-height:1.8;padding:0 10px}' +
    '.btns{display:flex;justify-content:center;gap:16px}' +
    '.btn{flex:1;max-width:170px;display:inline-flex;align-items:center;justify-content:center;padding:14px 20px;font-size:15px;font-weight:500;border:none;border-radius:28px;cursor:pointer;text-decoration:none;-webkit-tap-highlight-color:transparent}' +
    '.btn:active{opacity:0.8}' +
    '.s{background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.85);border:1px solid rgba(255,255,255,0.12)}' +
    '.p{background:linear-gradient(180deg,#6591FD 0%,#3D75FF 100%);color:#fff;box-shadow:0 4px 16px rgba(74,124,255,0.3);border-radius:100px}' +
    '</style></head>' +
    '<body><div class="c">' +
    '<h1 id="oh"></h1>' +
    '<p id="ob"></p>' +
    '<div class="btns">' +
    '<a class="btn s" href="javascript:void(0)" id="oc" onclick="var u=localStorage.getItem(\'customerServiceUrl\');u?window.open(u,\'_blank\'):alert(window.__offlineContactHint||\'\')"></a>' +
    '<button class="btn p" type="button" id="or" onclick="location.reload()"></button>' +
    '</div></div>' +
    '<script>' +
    script +
    '</script>' +
    '<script>window.addEventListener("online",function(){location.reload()});</script>' +
    '</body></html>'
  );
}

/**
 * 返回离线页面
 * 优先从缓存读取完整的 offline.html，
 * 若缓存中也没有（极端情况），则返回一个内联兜底页面（文案与 offline.html 保持一致）
 */
async function getOfflineResponse() {
  const cache = await caches.open(CACHE_NAMES.STATIC);
  const offlineResponse = await cache.match(OFFLINE_PAGE);
  if (offlineResponse) {
    return offlineResponse;
  }
  // 内联兜底：仅在 offline.html 完全无法从缓存获取时才使用
  // 注意：文案和按钮需与 offline.html 保持一致，避免用户体验割裂
  console.warn('[SW] offline.html not in cache, using inline fallback');
  return new Response(buildInlineOfflineFallbackHtml(), {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

/**
 * 预缓存离线页 HTML（STATIC）+ 背景图（IMAGE），与 fetch 分发策略一致
 */
function precacheOfflineBundle() {
  const bgReq = offlineBackgroundRequest();
  const htmlP = caches.open(CACHE_NAMES.STATIC).then((cache) =>
    fetch(OFFLINE_PAGE, { cache: 'no-store' }).then((response) => {
      if (response.status === 200) {
        return cache.put(OFFLINE_PAGE, response.clone());
      }
    })
  );
  const bgP = caches.open(CACHE_NAMES.IMAGE).then((cache) =>
    fetch(bgReq).then((response) => {
      if (response.status === 200) {
        return cache.put(bgReq, response.clone());
      }
    })
  );
  const logoReq = offlineLogoRequest();
  const logoP = logoReq
    ? caches.open(CACHE_NAMES.IMAGE).then((cache) =>
        fetch(logoReq).then((response) => {
          if (response.status === 200) {
            return cache.put(logoReq, response.clone());
          }
        })
      )
    : Promise.resolve();
  return Promise.all([htmlP, bgP, logoP]);
}

/**
 * 自愈机制：确保 offline.html + 离线背景图已缓存
 * 以 fire-and-forget 方式调用，不阻塞任何请求
 */
function ensureOfflineBundleCached() {
  const bgReq = offlineBackgroundRequest();
  const logoReq = offlineLogoRequest();
  const checks = [
    caches.open(CACHE_NAMES.STATIC).then((c) => c.match(OFFLINE_PAGE)),
    caches.open(CACHE_NAMES.IMAGE).then((c) => c.match(bgReq))
  ];
  if (logoReq) {
    checks.push(caches.open(CACHE_NAMES.IMAGE).then((c) => c.match(logoReq)));
  }
  Promise.all(checks)
    .then((results) => {
      const htmlCached = results[0];
      const bgCached = results[1];
      const logoCached = logoReq ? results[2] : true;
      if (htmlCached && bgCached && logoCached) {
        return;
      }
      if (!htmlCached) {
        console.log('[SW] offline.html missing from cache, attempting to cache now');
      }
      if (!bgCached) {
        console.log('[SW] offline background missing from cache, attempting to cache now');
      }
      if (logoReq && !logoCached) {
        console.log('[SW] offline logo missing from cache, attempting to cache now');
      }
      return precacheOfflineBundle().then(() => {
        console.log('[SW] offline bundle cached successfully (self-healing)');
      });
    })
    .catch(() => {
      // 静默失败，下次导航还会再尝试
    });
}

// ============================================
// 三、生命周期事件
// ============================================

// --- 安装事件：预缓存离线页面 ---
self.addEventListener('install', (event) => {
  console.log('[SW] Installing | version:', SW_BUILD_VERSION, '| API paths:', CACHEABLE_API_PATHS.length);
  // self.clients.matchAll().then((clients) => {
  //   clients.forEach((client) => {
  //     client.postMessage({
  //       type: 'sw-status',
  //       event: 'install',
  //       version: SW_BUILD_VERSION,
  //       apiPathsCount: CACHEABLE_API_PATHS.length,
  //       cacheNames: CACHE_NAMES
  //     });
  //   });
  // });
  event.waitUntil(
    precacheOfflineBundle()
      .then(() => {
        console.log('[SW] Pre-cached offline bundle (html + background + logo if configured)');
      })
      .catch((err) => {
        console.warn('[SW] Failed to pre-cache offline bundle:', err && err.message);
      })
      .then(() => self.skipWaiting())
  );
});

// --- 激活事件：清理旧版本缓存 ---
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating | version:', SW_BUILD_VERSION, '| schema:', CACHE_SCHEMA_VERSION);

  event.waitUntil(
    caches.open(CACHE_NAMES.STATIC)
      .then((cache) => cache.match(CACHE_SCHEMA_KEY))
      .then((resp) => resp ? resp.text() : '0')
      .then((text) => parseInt(text, 10) || 0)
      .then((oldSchema) => {
        if (oldSchema < CACHE_SCHEMA_VERSION) {
          // schema 版本变化 → 大更新，清除所有缓存桶后重建
          console.log('[SW] Cache schema upgraded:', oldSchema, '->', CACHE_SCHEMA_VERSION, '| purging all caches');
          return caches.keys()
            .then((names) => Promise.all(names.map((n) => caches.delete(n))))
            .then(() => caches.open(CACHE_NAMES.STATIC))
            .then((cache) => {
              // 记录新 schema 版本号
              cache.put(CACHE_SCHEMA_KEY, new Response(String(CACHE_SCHEMA_VERSION)));
              return precacheOfflineBundle()
                .then(() => {
                  console.log('[SW] Re-cached offline bundle after schema upgrade');
                })
                .catch(() => {
                  console.warn('[SW] Failed to re-cache offline bundle after schema upgrade');
                });
            });
        }

        // schema 未变 → 常规更新，只清理不在白名单中的缓存桶
        const validCaches = Object.values(CACHE_NAMES);
        return caches.keys()
          .then((names) => {
            return Promise.all(
              names.map((name) => {
                if (!validCaches.includes(name)) {
                  console.log('[SW] Deleting old cache:', name);
                  return caches.delete(name);
                }
              })
            );
          })
          .then(() => {
            // 确保 schema 版本号已记录（首次安装时 oldSchema 为 0 但 CACHE_SCHEMA_VERSION 为 1 会走上面的分支）
            // 这里处理 oldSchema === CACHE_SCHEMA_VERSION 的情况，补写 schema key（防止丢失）
            return caches.open(CACHE_NAMES.STATIC).then((cache) => {
              cache.put(CACHE_SCHEMA_KEY, new Response(String(CACHE_SCHEMA_VERSION)));
            });
          })
          .then(() => {
            return precacheOfflineBundle()
              .then(() => {
                console.log('[SW] Refreshed offline bundle cache on activate');
              })
              .catch(() => {
                console.warn('[SW] Failed to refresh offline bundle on activate');
              });
          });
      })
      .then(() => {
        // 主动 trim STATIC 缓存，清理累积的旧 hashed 资源
        return trimCache(CACHE_NAMES.STATIC, STATIC_CACHE_MAX_ITEMS);
      })
      .then(() => {
        return purgeStaleApiEntries();
      })
      .then(() => {
        console.log('[SW] Claiming all clients');
        return self.clients.claim();
      })
  );
});

// ============================================
// 四、请求拦截 - 路由分发
// ============================================
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 只处理 GET 和 POST 请求
  if (request.method !== 'GET' && request.method !== 'POST') {
    return;
  }

  // 跳过 chrome-extension 等非 http(s) 请求
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // 0. 导航请求（用户直接访问页面）- 网络优先，失败直接返回离线页面
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  // 1. 带 hash 的静态资源（JS/CSS/字体）- 缓存优先
  if (isHashedAsset(url)) {
    event.respondWith(handleHashedAssetRequest(request));
    return;
  }

  // 2. 图片请求 - Stale-While-Revalidate（先返回缓存，后台更新）
  if (isImageRequest(url)) {
    event.respondWith(handleImageRequest(request));
    return;
  }

  // 3. 可缓存的 API 请求 - Stale-While-Revalidate
  if (isCacheableApi(url)) {
    event.respondWith(handleApiRequest(request));
    return;
  }

  // 4. 同源无 hash 静态资源 - 网络优先，缓存兜底
  if (url.origin === self.location.origin && request.method === 'GET') {
    event.respondWith(handleUnhashedStaticRequest(request));
    return;
  }

  // 5. 其他请求 - 直接网络
});

// ============================================
// 五、缓存策略实现
// ============================================

/**
 * 导航请求处理 - 网络优先 + 离线兜底
 * 关键：离线时不返回缓存的 index.html（因为里面的 JS/API 都会失败），
 * 而是直接返回自包含的 offline.html
 *
 * 探测策略：
 *   - 若构建注入了 NETWORK_PROBE_URL（完整 URL），则用它探测
 *   - 否则降级为探测同源 sw.js（开发或未配置时）
 *   - 带 AbortController 超时保护，防止请求无限挂起
 */
async function handleNavigationRequest(request) {
  const isProbeConfigured = NETWORK_PROBE_URL && !NETWORK_PROBE_URL.startsWith('__');

  const probeUrl = isProbeConfigured
    ? NETWORK_PROBE_URL
    : self.registration.scope + 'sw.js?ping=' + Date.now();

  // 第二步：带超时的网络探测
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NETWORK_PROBE_TIMEOUT);

    await fetch(probeUrl + (probeUrl.includes('?') ? '&' : '?') + '_t=' + Date.now(), {
      method: 'HEAD',
      cache: 'no-store',
      mode: 'no-cors',
      signal: controller.signal
    });

    clearTimeout(timeoutId);
  } catch (error) {
    // 网络探测失败（网络不通 / 超时 / 服务器不可达）→ 用户离线 → 返回离线页面
    console.log('[SW] Network probe failed, returning offline page:', request.url);
    return getOfflineResponse();
  }

  // 第三步：网络是通的，正常请求页面
  try {
    const response = await fetch(request);
    // 导航成功 → 趁网络可用，确保 offline.html 已缓存（自愈机制，fire-and-forget）
    ensureOfflineBundleCached();
    return response;
  } catch (error) {
    // 页面请求失败（理论上不应该到这里，因为网络探测已经通过了）
    console.log('[SW] Navigation fetch failed after probe success:', request.url);
    return getOfflineResponse();
  }
}

/** 带 hash 静态资源处理 - 缓存优先（Cache First） */
async function handleHashedAssetRequest(request) {
  const cache = await caches.open(CACHE_NAMES.STATIC);

  // 先查缓存
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  // 缓存未命中，请求网络
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      cache.put(request, response.clone());
      trimCache(CACHE_NAMES.STATIC, STATIC_CACHE_MAX_ITEMS);
    }
    return response;
  } catch (error) {
    return new Response('', { status: 503, statusText: 'Service Unavailable' });
  }
}

/**
 * 图片请求处理 - Stale-While-Revalidate
 *
 * 先返回缓存（秒开），同时后台请求网络更新缓存。
 * 这样即使同一 URL 的内容发生变化（如加密→非加密），最多差一次访问即可拿到最新版本。
 * SW 只负责缓存原始响应并原样透传，不得修改 body / 构造新 Response，
 * 否则跨域响应在部分 WebView 中会丢失 body 导致 net::ERR_FAILED。
 */
async function handleImageRequest(request) {
  const cache = await caches.open(CACHE_NAMES.IMAGE);
  const cachedResponse = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok || response.type === 'opaque') {
        cache.put(request, response.clone());
        trimCache(CACHE_NAMES.IMAGE, IMAGE_CACHE_MAX_ITEMS);
      }
      return response;
    })
    .catch((error) => {
      console.log('[SW] Image revalidate failed:', request.url, error.message);
      return null;
    });

  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetchPromise;
  if (networkResponse) {
    return networkResponse;
  }

  return new Response('', { status: 503, statusText: 'Service Unavailable' });
}

/** API 请求处理 - Stale-While-Revalidate（先返回缓存，后台静默更新；网络异常时缓存兜底） */
async function handleApiRequest(request) {
  const cache = await caches.open(CACHE_NAMES.API);
  const cacheKey = await getApiCacheKey(request);
  const cachedResponse = await cache.match(cacheKey);

  const fetchPromise = fetchWithTimeout(request.clone(), API_TIMEOUT)
    .then((response) => {
      if (response.status === 200) {
        cache.put(cacheKey, response.clone());
      }
      return response;
    })
    .catch((error) => {
      console.log('[SW] API fetch failed:', request.url, error.message);
      return null;
    });

  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetchPromise;

  if (networkResponse && networkResponse.status === 200) {
    return networkResponse;
  }

  // 网络返回非200或完全失败 → 再次尝试缓存（可能被并发请求写入）
  const retryCached = await cache.match(cacheKey);
  if (retryCached) {
    return retryCached;
  }

  if (networkResponse) {
    return networkResponse;
  }

  // 完全无网络也无缓存 → 透传原始请求让前端拦截器正常处理
  try {
    return await fetch(request);
  } catch (e) {
    return new Response(JSON.stringify({ code: 200, msg: '', data: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/** 无 hash 同源静态资源处理 - 网络优先（Network First），缓存兜底 */
async function handleUnhashedStaticRequest(request) {
  const cache = await caches.open(CACHE_NAMES.STATIC);

  try {
    const response = await fetch(request);
    if (response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // 网络失败，尝试缓存
    const cachedResponse = await cache.match(request);
    if (cachedResponse) {
      console.log('[SW] Unhashed static from cache (offline):', request.url);
      return cachedResponse;
    }
    // 没有缓存 - 根据请求的 Accept 头返回合适的格式
    const accept = request.headers.get('Accept') || '';
    if (accept.includes('application/json')) {
      return new Response(JSON.stringify({ error: 'Network error', offline: true }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Network error', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// ============================================
// 六、接收主线程消息（handler map 模式，便于扩展）
// ============================================

/** 消息处理器映射表：字符串消息 → 处理函数 */
const messageHandlers = {
  skipWaiting() {
    self.skipWaiting();
  },
  // getStatus() {
  //   self.clients.matchAll().then((clients) => {
  //     clients.forEach((client) => {
  //       client.postMessage({
  //         type: 'sw-status',
  //         event: 'active',
  //         version: SW_BUILD_VERSION,
  //         apiPathsCount: CACHEABLE_API_PATHS.length,
  //         apiPaths: CACHEABLE_API_PATHS,
  //         cacheNames: CACHE_NAMES
  //       });
  //     });
  //   });
  // },
  clearApiCache() {
    caches.delete(CACHE_NAMES.API).then(() => {
      console.log('[SW] API cache cleared');
    });
  },
  clearImageCache() {
    caches.delete(CACHE_NAMES.IMAGE).then(() => {
      console.log('[SW] Image cache cleared');
    });
  }
};

self.addEventListener('message', (event) => {
  const data = event.data;

  // 字符串消息：查找 handler map
  if (typeof data === 'string' && messageHandlers[data]) {
    messageHandlers[data]();
    return;
  }

  // 对象消息：按 type 分发
  if (data && data.type === 'clearCache' && data.cacheName) {
    caches.delete(data.cacheName).then(() => {
      console.log('[SW] Cache cleared:', data.cacheName);
    });
  }
});
