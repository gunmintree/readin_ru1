(function () {
  'use strict';

  const CHECK_INTERVAL_MS = 5000;
  const CHECK_TIMEOUT_MS = 4000;
  const CACHE_PREFIX = 'readin-gochuk-';
  const EXPECTED_CHECK_VALUE = 'readin-focus-rhythm-online';
  const AUTH_STORAGE_KEY = 'readin-gochuk-auth-v1';
  const AUTH_STORAGE_VALUE = 'approved';
  const EXPECTED_PASSWORD_HASH = '17e34c2fb28381de4d873ded166ccc79ae058d5df2bf1f83f8977c3b0efccbc3';

  function setOnlineLockState(online, checking) {
    const lock = document.querySelector('[data-online-lock]');
    if (!lock) return;

    const title = lock.querySelector('[data-online-lock-title]');
    const message = lock.querySelector('[data-online-lock-message]');
    lock.hidden = online;

    if (online) return;
    if (checking) {
      title.textContent = '온라인 연결 확인 중';
      message.textContent = '잠시만 기다려 주세요.';
    } else {
      title.textContent = '인터넷 연결이 필요합니다';
      message.textContent = '연결 상태를 확인하면 자동으로 다시 시작됩니다.';
    }
  }

  function hasStoredAuthentication() {
    try {
      return localStorage.getItem(AUTH_STORAGE_KEY) === AUTH_STORAGE_VALUE;
    } catch (_) {
      return false;
    }
  }

  function storeAuthentication() {
    try {
      localStorage.setItem(AUTH_STORAGE_KEY, AUTH_STORAGE_VALUE);
      return localStorage.getItem(AUTH_STORAGE_KEY) === AUTH_STORAGE_VALUE;
    } catch (_) {
      return false;
    }
  }

  function setAuthenticationLockState(authenticated) {
    const lock = document.querySelector('[data-auth-lock]');
    if (!lock) return;
    lock.hidden = authenticated;
    if (!authenticated) {
      const input = lock.querySelector('[data-auth-password]');
      if (input) setTimeout(() => input.focus(), 0);
    }
  }

  async function sha256(value) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Web Crypto is unavailable');
    }
    const bytes = new TextEncoder().encode(value);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function setupAuthentication(onAuthenticated) {
    const form = document.querySelector('[data-auth-form]');
    if (!form) return;

    const input = form.querySelector('[data-auth-password]');
    const button = form.querySelector('[data-auth-submit]');
    const error = form.querySelector('[data-auth-error]');

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!input || !button || button.disabled) return;

      button.disabled = true;
      error.hidden = true;

      try {
        const passwordHash = await sha256(input.value);
        if (passwordHash !== EXPECTED_PASSWORD_HASH) {
          error.textContent = '비밀번호가 올바르지 않습니다.';
          error.hidden = false;
          input.select();
          return;
        }

        if (!storeAuthentication()) {
          error.textContent = '브라우저에 인증 정보를 저장할 수 없습니다.';
          error.hidden = false;
          return;
        }

        input.value = '';
        setAuthenticationLockState(true);
        onAuthenticated();
      } catch (_) {
        error.textContent = '이 브라우저에서는 인증을 처리할 수 없습니다.';
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
  }

  async function removeLegacyOfflineData() {
    if ('serviceWorker' in navigator) {
      try {
        const currentScope = new URL('./', location.href).href;
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          registrations
            .filter(registration => registration.scope === currentScope)
            .map(registration => registration.unregister())
        );
      } catch (_) {}
    }

    if ('caches' in window) {
      try {
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames
            .filter(name => name.startsWith(CACHE_PREFIX))
            .map(name => caches.delete(name))
        );
      } catch (_) {}
    }
  }

  async function canReachDeployment() {
    if (location.protocol === 'file:' || !navigator.onLine) return false;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

    try {
      const checkUrl = new URL('online-check.json', location.href);
      checkUrl.searchParams.set('_', Date.now().toString());
      const response = await fetch(checkUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal
      });
      if (!response.ok) return false;
      const data = await response.json();
      return data.onlineCheck === EXPECTED_CHECK_VALUE;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  function start(options) {
    const settings = options || {};
    let lastOnlineState = null;
    let lastReadyState = false;
    let online = false;
    let authenticated = hasStoredAuthentication();
    let checking = false;

    function updateReadyState() {
      const ready = online && authenticated;
      if (ready === lastReadyState) return;
      lastReadyState = ready;
      window.dispatchEvent(new CustomEvent('app-ready-state', {
        detail: { ready }
      }));
      if (ready && typeof settings.onReady === 'function') settings.onReady();
    }

    setupAuthentication(() => {
      authenticated = true;
      window.dispatchEvent(new CustomEvent('app-auth-state', {
        detail: { authenticated: true }
      }));
      updateReadyState();
    });
    setAuthenticationLockState(authenticated);

    async function check() {
      if (checking) return;
      checking = true;
      online = await canReachDeployment();
      checking = false;
      setOnlineLockState(online, false);

      if (online !== lastOnlineState) {
        lastOnlineState = online;
        window.dispatchEvent(new CustomEvent('app-online-state', {
          detail: { online }
        }));
        if (online && typeof settings.onOnline === 'function') settings.onOnline();
        if (!online && typeof settings.onOffline === 'function') settings.onOffline();
      }
      updateReadyState();
    }

    setOnlineLockState(false, true);
    removeLegacyOfflineData().finally(check);
    setInterval(check, CHECK_INTERVAL_MS);
    window.addEventListener('online', check);
    window.addEventListener('offline', check);
    window.addEventListener('storage', event => {
      if (event.key !== AUTH_STORAGE_KEY) return;
      authenticated = hasStoredAuthentication();
      setAuthenticationLockState(authenticated);
      updateReadyState();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) check();
    });
  }

  window.OnlineGuard = { start };
})();
