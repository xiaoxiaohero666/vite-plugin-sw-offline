// ============================================
// Service Worker 注册和缓存管理
// 从 index.html 提取，便于独立维护和调试
// ============================================

(function() {
  // ============================================
  // 缓存管理工具 - 无论 SW 是否支持都挂载到 window 上
  // 避免业务代码调用 window.swCache.xxx 时报错
  // （iOS WKWebView 等环境可能不支持 SW）
  // ============================================
  if (!('serviceWorker' in navigator)) {
    console.log('[App] Service Worker not supported');
    window.swCache = {
      clearApiCache: function() {},
      clearImageCache: function() {},
      clearAllCache: function() {},
      update: function() {}
    };
    return;
  }

  window.swCache = {
    /** 清除 API 缓存（用户登录/登出时调用） */
    clearApiCache: function() {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage('clearApiCache');
        console.log('[App] Requested to clear API cache');
      }
    },
    /** 清除图片缓存 */
    clearImageCache: function() {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage('clearImageCache');
        console.log('[App] Requested to clear image cache');
      }
    },
    /** 清除所有缓存 */
    clearAllCache: function() {
      if ('caches' in window) {
        caches.keys().then(function(names) {
          names.forEach(function(name) {
            caches.delete(name);
          });
          console.log('[App] All caches cleared');
        });
      }
    },
    /** 强制触发 SW 更新检查 */
    update: function() {
      navigator.serviceWorker.getRegistration().then(function(reg) {
        if (reg) {
          reg.update();
          console.log('[App] SW update triggered');
        }
      });
    }
  };

  // ============================================
  // SW 注册与更新管理
  // SW 只负责缓存策略，不触发 reload
  // 版本更新由 App.vue 的 config.json 机制负责
  // ============================================

  // SW 版本号（构建时由 vite-plugin-sw-offline 注入）
  // 作用：每次部署生成新 URL，强制 Telegram WebView 等环境更新 SW
  // 占位符未被替换时（开发模式），降级为无版本号
  var SW_VERSION = '__SW_VERSION__';
  var swUrl = SW_VERSION && !SW_VERSION.startsWith('__')
    ? '/sw.js?v=' + encodeURIComponent(SW_VERSION)
    : '/sw.js';

  console.log('[App] SW_VERSION:', SW_VERSION, '| swUrl:', swUrl);

  window.addEventListener('load', function() {
    navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' })
      .then(function(registration) {
        console.log('[App] SW registered, scope:', registration.scope);

        registration.addEventListener('updatefound', function() {
          var newWorker = registration.installing;
          console.log('[App] New SW found, state:', newWorker.state);

          newWorker.addEventListener('statechange', function() {
            console.log('[App] SW state changed:', newWorker.state);
          });
        });

        // 定期检查更新（每 5 分钟）
        setInterval(function() {
          registration.update();
        }, 5 * 60 * 1000);
      })
      .catch(function(error) {
        console.error('[App] SW registration failed:', error);
      });

    navigator.serviceWorker.addEventListener('controllerchange', function() {
      console.log('[App] SW controller changed');
    });
  });
})();
