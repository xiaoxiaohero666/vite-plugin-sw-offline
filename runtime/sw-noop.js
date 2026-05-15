// ============================================
// No-Op Service Worker（空操作 SW）
// 用途：当需要移除 SW 时，部署此文件内容替换原 sw.js
// 效果：清理所有缓存，注销 SW，刷新所有页面
// ============================================

self.addEventListener('install', () => {
  console.log('[SW-NOOP] Installing no-op service worker');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW-NOOP] Activating and cleaning up');
  event.waitUntil(
    Promise.all([
      // 1. 清理所有缓存
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((name) => {
            console.log('[SW-NOOP] Deleting cache:', name);
            return caches.delete(name);
          })
        );
      }),
      // 2. 注销自己
      self.registration.unregister().then(() => {
        console.log('[SW-NOOP] Unregistered');
      })
    ]).then(() => {
      // 3. 刷新所有打开的页面
      return self.clients.matchAll({ type: 'window' });
    }).then((clients) => {
      clients.forEach((client) => {
        client.navigate(client.url);
      });
    })
  );
});

// 不拦截任何请求，让它们直接穿透到浏览器
// 注意：这里故意不添加 fetch 事件监听器
