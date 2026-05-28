/**
 * 离线页公用逻辑（构建时由插件注入；勿在业务侧单独引用）
 * 依赖：window.__OFFLINE_I18N__、window.__OFFLINE_DEFAULT_LOCALE__、window.__OFFLINE_DOMAIN_TEXT__
 * DOM：#logoWrap #typingText #copyDomainBtn #offline-heading #offline-body
 *      #contactBtn #reloadBtn #copyToast
 */
(function () {
  var SHORT_TO_FULL = {
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

  function normalizeLocaleKey(s) {
    if (!s || typeof s !== 'string') return '';
    s = s.trim().replace(/-/g, '_');
    if (s.indexOf('_') === -1) return SHORT_TO_FULL[s.toLowerCase()] || '';
    var i = s.indexOf('_');
    return s.slice(0, i).toLowerCase() + '_' + s.slice(i + 1).toUpperCase();
  }

  function getDefaultLocaleKey() {
    var d = window.__OFFLINE_DEFAULT_LOCALE__;
    return d && typeof d === 'string' ? d : 'zh_CN';
  }

  function resolveOfflineLocaleKey() {
    var fromUrl = '';
    try {
      fromUrl = new URLSearchParams(window.location.search).get('locale') || '';
    } catch (e) {}
    var fromStorage = '';
    try {
      var rawCommon = localStorage.getItem('common');
      if (rawCommon) {
        var parsed = JSON.parse(rawCommon);
        if (parsed && typeof parsed.locale === 'string') fromStorage = parsed.locale;
      }
    } catch (e) {}
    return normalizeLocaleKey(fromUrl) || normalizeLocaleKey(fromStorage) || getDefaultLocaleKey();
  }

  function applyOfflineLocale() {
    var M = window.__OFFLINE_I18N__ || {};
    var fallback = getDefaultLocaleKey();
    var loc = resolveOfflineLocaleKey();
    if (!M[loc]) loc = fallback;
    var t = M[loc] || M[fallback];
    if (!t) return;
    document.documentElement.setAttribute('lang', loc.replace('_', '-'));
    if (loc.indexOf('ar_') === 0) document.documentElement.setAttribute('dir', 'rtl');
    document.title = t.title;
    var el = document.getElementById('offline-heading');
    if (el) el.textContent = t.heading;
    el = document.getElementById('offline-body');
    if (el) el.textContent = t.body;
    el = document.getElementById('contactBtn');
    if (el) el.textContent = t.contact;
    el = document.getElementById('reloadBtn');
    if (el) el.textContent = t.reload;
    el = document.getElementById('copyDomainBtn');
    if (el) el.setAttribute('aria-label', t.copyAria);
    el = document.getElementById('copyToast');
    if (el) el.textContent = t.copySuccess;
    window.__offlineUiStrings = {
      copySuccess: t.copySuccess,
      copyFail: t.copyFail,
      contactOfflineHint: t.contactOfflineHint
    };
  }

  function startTypingAnimation() {
    var text = window.__OFFLINE_DOMAIN_TEXT__ || '';
    var el = document.getElementById('typingText');
    if (!el || !text) return;
    var i = 0;
    var isDeleting = false;
    var typeSpeed = 120;
    var deleteSpeed = 60;
    var pauseAfterType = 1800;
    var pauseAfterDelete = 400;

    function tick() {
      if (!isDeleting) {
        el.textContent = text.slice(0, i + 1);
        i++;
        if (i === text.length) {
          isDeleting = true;
          setTimeout(tick, pauseAfterType);
          return;
        }
        setTimeout(tick, typeSpeed);
      } else {
        el.textContent = text.slice(0, i - 1);
        i--;
        if (i === 0) {
          isDeleting = false;
          setTimeout(tick, pauseAfterDelete);
          return;
        }
        setTimeout(tick, deleteSpeed);
      }
    }

    setTimeout(tick, 600);
  }

  function bindCopyDomain() {
    var copyBtn = document.getElementById('copyDomainBtn');
    var toast = document.getElementById('copyToast');
    if (!copyBtn) return;
    var toastTimer = null;

    function showCopyToast() {
      if (toast) {
        if (window.__offlineUiStrings && window.__offlineUiStrings.copySuccess) {
          toast.textContent = window.__offlineUiStrings.copySuccess;
        }
        toast.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
          toast.classList.remove('show');
        }, 2000);
      }
    }

    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          ok ? resolve() : reject(new Error('copy failed'));
        } catch (err) {
          document.body.removeChild(ta);
          reject(err);
        }
      });
    }

    function handleCopy() {
      var text = (window.__OFFLINE_DOMAIN_TEXT__ || '').trim();
      if (!text) return;
      copyToClipboard(text)
        .then(showCopyToast)
        .catch(function () {
          var msg = (window.__offlineUiStrings && window.__offlineUiStrings.copyFail) || '';
          alert(msg);
        });
    }

    copyBtn.addEventListener('click', handleCopy);
    copyBtn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleCopy();
      }
    });
  }

  function bindContactBtn() {
    var contactBtn = document.getElementById('contactBtn');
    if (!contactBtn) return;
    contactBtn.addEventListener('click', function () {
      var customerServiceUrl = localStorage.getItem('customerServiceUrl');
      if (customerServiceUrl) {
        window.open(customerServiceUrl, '_blank');
      } else {
        var msg = (window.__offlineUiStrings && window.__offlineUiStrings.contactOfflineHint) || '';
        alert(msg);
      }
    });
  }

  function bindOnlineReload() {
    window.addEventListener('online', function () {
      location.reload();
    });
  }

  applyOfflineLocale();
  startTypingAnimation();
  bindCopyDomain();
  bindContactBtn();
  bindOnlineReload();
})();
