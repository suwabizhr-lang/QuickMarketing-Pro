// Supabase 認証（サーバ側）。index.js から registerAuth(app) で登録。
// 方式（パシャっと出品と同じ）: ブラウザが Supabase でログイン → JWT取得 → API呼び出しに Authorization: Bearer <token>。
//   サーバは Supabase の /auth/v1/user にトークンを投げて検証（HS256/RS256どちらでも確実）。
// 環境変数:
//   SUPABASE_URL       例 https://xxxx.supabase.co
//   SUPABASE_ANON_KEY  公開して良い anon キー（ブラウザにも渡す）
//   AUTH_REQUIRED      '1' で認証必須（未設定/0 は認証オフ＝ローカル素の動作・後方互換）
const SUPABASE_URL = () => process.env.SUPABASE_URL || '';
const SUPABASE_ANON = () => process.env.SUPABASE_ANON_KEY || '';

export function authEnabled() {
  return !!(SUPABASE_URL() && SUPABASE_ANON() && process.env.AUTH_REQUIRED === '1');
}

// 現在のリクエストの「所有者ID」。認証ONなら Supabase user id、認証OFFなら 'local'（単一ユーザー扱い）。
// 店舗のデータ分離（store.owner_id）に使う。認証ONで未ログインなら null。
export function ownerId(req) {
  if (!authEnabled()) return 'local';
  return (req && req.user && req.user.id) ? req.user.id : null;
}

// 管理者判定。ADMIN_EMAILS(カンマ区切り) か ADMIN_USER_IDS に一致する人だけ管理画面に入れる。
// 認証OFF(ローカル)は単一ユーザー＝常に管理者扱い（開発用）。
export function isAdmin(req) {
  if (!authEnabled()) return true;
  const u = req && req.user;
  if (!u) return false;
  const emails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const ids = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const email = (u.email || '').toLowerCase();
  if (emails.length && email && emails.includes(email)) return true;
  if (ids.length && u.id && ids.includes(u.id)) return true;
  return false;
}

// トークン検証（Supabase Auth に問い合わせ）。有効なら user を返す。
async function verifyToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(SUPABASE_URL() + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON(), Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return null;
    const u = await res.json();
    return u && u.id ? u : null;
  } catch {
    return null;
  }
}

function getBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? m[1] : null;
}

export function registerAuth(app) {
  // ブラウザに Supabase 接続情報を渡す（anon キーは公開前提。認証ON/OFFも伝える）。
  app.get('/api/auth/config', (req, res) => {
    res.json({ url: SUPABASE_URL(), anonKey: SUPABASE_ANON(), required: authEnabled() });
  });

  // 保護 API 用ミドルウェア（authEnabled のときだけ検証）。未ログインは 401。
  // 注意: app.use('/api', ...) のため req.path は '/api' を除いた形（例 '/stores'）。
  app.use('/api', async (req, res, next) => {
    if (!authEnabled()) return next();
    // 認証自体のエンドポイントと、公開してよいものを除外。
    const openPaths = ['/auth/config', '/health'];
    if (openPaths.includes(req.path)) return next();
    // 公開フォームの応募送信は来店者（未ログインの一般客）が使うので通す（/api/f/<slug>/submit）。
    if (/^\/f\/[^/]+\/submit$/.test(req.path)) return next();
    const user = await verifyToken(getBearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'ログインが必要です', authRequired: true });
    req.user = user;
    next();
  });
}
