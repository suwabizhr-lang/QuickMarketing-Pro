// 認証ガード（クライアント側）。index.html の <head> で最初に読み込む。
// - サーバの /api/auth/config で認証ON/OFFとSupabase情報を取得。
// - 認証ONかつ未ログインなら login.html へリダイレクト。
// - ログイン済みなら、以降の fetch に自動で Authorization: Bearer <token> を付与（app.js の api() もこれ経由）。
// 認証OFF（ローカル素の動作）のときは何もしない（後方互換）。
(function () {
  'use strict';
  if (window.__authGuardLoaded) return;
  window.__authGuardLoaded = true;

  var SUPA = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  function redirectToLogin() {
    var here = location.pathname + location.search;
    location.replace('/login.html?next=' + encodeURIComponent(here));
  }

  window.__auth = { token: null, user: null, client: null, enabled: false };

  // 認証の準備完了を表す Promise。ready() 解決までは /api/* fetch を待たせる。
  var _resolveReady;
  var _ready = new Promise(function (res) { _resolveReady = res; });
  function markReady() { _resolveReady(); }

  // fetch を「同期的に」ラップ。/api/* は準備完了を待ってから Bearer を付けて送る。
  // /api/auth/config だけは待たない（初期化に必要）。公開フォーム送信(/api/f/.../submit)も来店者が使うので素通り。
  (function patchFetch() {
    var orig = window.fetch;
    window.fetch = function (input, init) {
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
      var isApi = url.indexOf('/api/') === 0 || url.indexOf(location.origin + '/api/') === 0;
      var isConfig = url.indexOf('/api/auth/config') >= 0;
      var isPublicSubmit = /\/api\/f\/[^/]+\/submit/.test(url);
      if (!isApi || isConfig || isPublicSubmit) return orig.call(this, input, init);
      var self = this;
      return _ready.then(function () {
        try {
          if (window.__auth.enabled && window.__auth.token) {
            init = init || {};
            var headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
            if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + window.__auth.token);
            init.headers = headers;
          }
        } catch (e) {}
        return orig.call(self, input, init);
      });
    };
  })();

  async function init() {
    var cfg;
    try { cfg = await (await fetch('/api/auth/config')).json(); } catch (e) { markReady(); return; /* 取得失敗時は素通り */ }
    if (!cfg || !cfg.required) { window.__auth.enabled = false; markReady(); return; } // 認証OFF＝素通り
    window.__auth.enabled = true;

    await loadScript(SUPA);
    var client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true, flowType: 'implicit' },
    });
    window.__auth.client = client;

    var { data } = await client.auth.getSession();
    var session = data && data.session;
    if (!session) { redirectToLogin(); return; } // 未ログイン→login（ready未解決＝APIは飛ばさない）
    window.__auth.token = session.access_token;
    window.__auth.user = session.user;
    markReady();

    client.auth.onAuthStateChange(function (_e, s) {
      window.__auth.token = s ? s.access_token : null;
      window.__auth.user = s ? s.user : null;
      if (!s) redirectToLogin();
    });

    window.__auth.logout = async function () {
      try { await client.auth.signOut(); } catch (e) {}
      redirectToLogin();
    };

    function wireLogout() {
      var btn = document.getElementById('logoutBtn');
      if (btn) { btn.style.display = ''; btn.addEventListener('click', function () { window.__auth.logout(); }); }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireLogout);
    else wireLogout();
  }

  init();
})();
