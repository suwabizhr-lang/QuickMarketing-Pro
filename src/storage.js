// 生成ファイルの永続化（Supabase Storage）。サーバ専用の secret key で Storage REST を叩く（RLSバイパス）。
// なぜ必要か: Render等のコンテナFSは再起動で消える。動画/画像/QR/BGM/応募写真をローカルにだけ置くと消える。
//
// バケット2本:
//   公開(PUBLIC_BUCKET, 既定 'assets')     … QR/生成動画/アップロード画像/BGM。URLを知れば誰でも閲覧OK（配布物）。
//   非公開(PRIVATE_BUCKET, 既定 'submissions') … 応募写真（個人情報）。署名URLでのみ閲覧。
//
// 環境変数:
//   SUPABASE_URL         例 https://xxxx.supabase.co
//   SUPABASE_SECRET_KEY  sb_secret_...（サーバ専用・絶対に公開しない。RLSバイパス）
//   SUPABASE_PUBLIC_BUCKET  省略時 'assets'
//   SUPABASE_PRIVATE_BUCKET 省略時 'submissions'
//
// storageEnabled() が false（未設定）のときは、呼び出し側はローカル data/assets 保存にフォールバック（後方互換）。
import { readFileSync, writeFileSync } from 'node:fs';

const URL = () => process.env.SUPABASE_URL || '';
const SECRET = () => process.env.SUPABASE_SECRET_KEY || '';
export const PUBLIC_BUCKET = () => process.env.SUPABASE_PUBLIC_BUCKET || 'assets';
export const PRIVATE_BUCKET = () => process.env.SUPABASE_PRIVATE_BUCKET || 'submissions';

export function storageEnabled() { return !!(URL() && SECRET()); }

const base = () => URL() + '/storage/v1';
const authHeaders = (extra) => ({ apikey: SECRET(), Authorization: 'Bearer ' + SECRET(), ...(extra || {}) });

// パスの安全化（パストラバーサル対策）。store別プレフィックス配下の英数字/._-/ のみ許可。
function safePath(p) {
  const s = String(p || '').replace(/^\/+/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) || s.includes('..')) return null;
  return s;
}

// バケット作成（冪等）。secret keyで作成。存在すれば無視。
async function ensureBucket(name, isPublic) {
  const res = await fetch(`${base()}/bucket`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: name, name, public: !!isPublic }),
  });
  // 409/400（既存）は無視
  if (!res.ok && res.status !== 409 && res.status !== 400) {
    console.error('[storage.ensureBucket]', name, res.status, (await res.text().catch(() => '')).slice(0, 150));
  }
}
export async function ensureBuckets() {
  if (!storageEnabled()) return;
  await ensureBucket(PUBLIC_BUCKET(), true);
  await ensureBucket(PRIVATE_BUCKET(), false);
}

// アップロード（upsert）。bucket, path, Buffer, contentType。成功で true。
async function upload(bucket, path, data, contentType) {
  const p = safePath(path);
  if (!p) return false;
  const res = await fetch(`${base()}/object/${bucket}/${encodeURI(p)}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true', 'cache-control': '3600' }),
    body: data,
  });
  if (!res.ok) { console.error('[storage.upload]', bucket, res.status, (await res.text().catch(() => '')).slice(0, 150)); return false; }
  return true;
}

// 公開バケットへ保存 → 公開URL（永続）を返す。失敗で null。
export async function uploadPublic(path, data, contentType) {
  if (!storageEnabled()) return null;
  const p = safePath(path);
  if (!p) return null;
  if (!(await upload(PUBLIC_BUCKET(), p, data, contentType))) return null;
  return `${base()}/object/public/${PUBLIC_BUCKET()}/${encodeURI(p)}`;
}

// 非公開バケットへ保存（URLは署名で都度発行）。成功で保存パス（bucket相対）を返す。
export async function uploadPrivate(path, data, contentType) {
  if (!storageEnabled()) return null;
  const p = safePath(path);
  if (!p) return null;
  if (!(await upload(PRIVATE_BUCKET(), p, data, contentType))) return null;
  return p;
}

// 署名URL（非公開バケット）。expiresIn 秒有効。失敗で null。
export async function signedUrl(path, expiresIn = 3600) {
  if (!storageEnabled()) return null;
  const p = safePath(path);
  if (!p) return null;
  const res = await fetch(`${base()}/object/sign/${PRIVATE_BUCKET()}/${encodeURI(p)}`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) { if (res.status !== 404) console.error('[storage.sign]', res.status); return null; }
  const j = await res.json().catch(() => null);
  if (!j || !j.signedURL) return null;
  const rel = j.signedURL.startsWith('/') ? j.signedURL : '/' + j.signedURL;
  return base() + rel;
}

// 公開バケットのオブジェクトを Buffer で取得（ffmpeg入力用）。パス or 公開URLどちらでも。
export async function downloadBuffer(pathOrUrl) {
  if (!storageEnabled()) return null;
  let url;
  if (/^https?:\/\//.test(pathOrUrl)) url = pathOrUrl;
  else { const p = safePath(pathOrUrl); if (!p) return null; url = `${base()}/object/public/${PUBLIC_BUCKET()}/${encodeURI(p)}`; }
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) { console.error('[storage.download]', res.status); return null; }
  return Buffer.from(await res.arrayBuffer());
}
// 公開バケットのオブジェクトをローカルファイルに保存（ffmpegはローカルパスを要求するため）。
export async function downloadToFile(pathOrUrl, localPath) {
  const buf = await downloadBuffer(pathOrUrl);
  if (!buf) return false;
  writeFileSync(localPath, buf);
  return true;
}
// ローカルファイルを公開バケットへアップロード（ffmpeg出力の永続化）。公開URLを返す。
export async function uploadFilePublic(localPath, destPath, contentType) {
  return uploadPublic(destPath, readFileSync(localPath), contentType);
}

// プレフィックス配下を一覧（name配列, bucket相対の相対名）。
async function listPrefix(bucket, prefix) {
  const res = await fetch(`${base()}/object/list/${bucket}`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) { console.error('[storage.list]', bucket, res.status); return []; }
  const arr = await res.json().catch(() => []);
  return (Array.isArray(arr) ? arr : []).map(o => o && o.name).filter(Boolean);
}
// 店舗削除時: 両バケットの <storeId>/ 配下を全削除。
export async function removeStorePrefix(storeId) {
  if (!storageEnabled()) return;
  const sid = safePath(storeId);
  if (!sid) return;
  for (const bucket of [PUBLIC_BUCKET(), PRIVATE_BUCKET()]) {
    const names = await listPrefix(bucket, sid);
    // list はプレフィックス直下の相対名を返すため、フルパスに戻す。再帰的にサブフォルダも辿る。
    const full = [];
    for (const n of names) {
      if (n && !n.includes('.')) { // フォルダっぽい → 1段掘る
        const sub = await listPrefix(bucket, `${sid}/${n}`);
        sub.forEach(s => full.push(`${sid}/${n}/${s}`));
      } else { full.push(`${sid}/${n}`); }
    }
    if (full.length === 0) continue;
    await fetch(`${base()}/object/${bucket}`, {
      method: 'DELETE', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: full }),
    }).catch(e => console.error('[storage.remove]', e.message));
  }
}
