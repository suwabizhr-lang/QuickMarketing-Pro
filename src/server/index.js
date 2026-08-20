// 買取店マーケティングシステム サーバ骨格（MVP / Phase 1）。
// 認証なし・ローカルSQLite。設計書 §9 のAPI/画面に対応。
import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import * as db from '../db.js';
import { generateArticle, generateArticles, appendCta, listChannels, CHANNEL_PROFILES } from '../generate/article.js';
import { writeArticle, ACTIONS as ARTICLE_ACTIONS } from '../generate/articleWriter.js';
import { generateAdCopies, listAdFormats, AD_FORMATS } from '../generate/adCopy.js';
import { generateAdVideo, buildCaptions } from '../generate/adVideo.js';
import { getAdVideoTemplate } from '../generate/adVideoTemplates.js';
import { listAdVideoTemplates, listAdVideoAspects, listAdVideoTransitions } from '../generate/adVideoTemplates.js';
import { generateSlideshow } from '../generate/video.js';
import { extractSlideFrames } from '../generate/extractFrames.js';
import { qrDataUrl } from '../generate/qr.js';
import { listChannelDrivers, getChannelDriver, GENERATE_TO_DRIVER } from '../channels.js';
import { publishToChannel } from '../publish/index.js';
import { startScheduler, runScheduleNow } from '../scheduler.js';
import { registerAuth, ownerId, authEnabled } from '../auth.js';
import * as storage from '../storage.js';
import { sendSubmissionNotice, mailerEnabled } from '../mailer.js';
import { musicgenToFile, musicgenEnabled } from '../generate/musicgen.js';
import { synthToFile as gSynthToFile, gTtsEnabled, listJaVoices } from '../generate/googleTts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5300;
const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

app.use(express.json({ limit: '120mb' })); // 画像/動画(base64 dataURL)アップロードのため拡大
app.use(express.urlencoded({ extended: true, limit: '120mb' }));
app.use(express.static(join(__dirname, '..', '..', 'public')));
// 生成した動画/QRを配信
app.use('/assets', express.static(join(__dirname, '..', '..', 'data', 'assets')));

// 認証（Supabase）。/api/auth/config と保護ミドルウェアを登録。AUTH_REQUIRED=1 で有効。
// 静的配信の後・APIルートの前に置くこと（login.html等は認証不要で配信、/api/* は保護）。
registerAuth(app);

const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, code, msg) => res.status(code).json({ ok: false, error: msg });

// 店舗の所有チェック。認証ONのとき store.owner_id が現在ユーザーと一致しなければ false。
// 認証OFF（local）のときは常に true（後方互換・単一ユーザー）。
function ownsStore(req, store) {
  if (!authEnabled()) return true;
  return !!store && store.owner_id === ownerId(req);
}
// 店舗を取得しつつ所有権を確認。無ければ null、他人のものなら 'forbidden' を返す。
async function getOwnedStore(req, storeId) {
  const store = await db.getStore(storeId);
  if (!store) return { store: null };
  if (!ownsStore(req, store)) return { store: null, forbidden: true };
  return { store };
}
// storeId 文字列に対する所有チェック（true=自分の店舗 or 認証OFF）。存在しない store は false。
async function ownsStoreId(req, storeId) {
  if (!authEnabled()) return true;
  const s = await db.getStore(storeId);
  return !!s && s.owner_id === ownerId(req);
}
// ルートで使う共通ガード: 所有していなければ 403/404 を返し true(=中断すべき) を返す。
// 使い方: if (await guardStore(req, res, storeId)) return;
async function guardStore(req, res, storeId) {
  if (!authEnabled()) return false;
  const s = storeId ? await db.getStore(storeId) : null;
  if (!s) { bad(res, 400, 'store_id が不正です'); return true; }
  if (s.owner_id !== ownerId(req)) { bad(res, 403, 'この店舗にはアクセスできません'); return true; }
  return false;
}

// 背景色(hex)に対して読みやすい文字色を返す。明るい背景→黒、暗い背景→白。
// 店舗のブランドカラーが濃い色(青/紫等)でも文字が沈まないようにする。
function contrastText(hex) {
  const h = String(hex || '').replace('#', '').trim();
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return '#161616'; // 不正なら黒
  const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
  // 相対輝度（sRGB近似）。0.6を境に黒/白を切替。
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#161616' : '#ffffff';
}

// --- 業態マスタ ---
app.get('/api/business-types', async (req, res) => ok(res, { types: await db.listBusinessTypes() }));

// --- 店舗 ---
// 業態別の必須ライセンス検証（作成・更新で共用）。問題があればエラーメッセージ、無ければ null。
function validateLicenses(bt, licenses = {}) {
  for (const req_l of bt.required_licenses) {
    const v = licenses[req_l.key];
    if (!v) return `${req_l.label} は必須です（${req_l.hint || ''}）`;
    if (req_l.pattern && !new RegExp(req_l.pattern).test(String(v)))
      return `${req_l.label} の形式が不正です（${req_l.hint || req_l.pattern}）`;
  }
  return null;
}
// 自分（ログインユーザー）の店舗のみ。認証OFFなら全件（local運用）。1ユーザー複数店舗OK。
app.get('/api/stores', async (req, res) => ok(res, { stores: await db.listStores(ownerId(req)) }));
app.get('/api/store/:id', async (req, res) => {
  const { store, forbidden } = await getOwnedStore(req, req.params.id);
  if (forbidden) return bad(res, 403, 'この店舗にはアクセスできません');
  if (!store) return bad(res, 404, '店舗が見つかりません');
  ok(res, { store });
});
app.post('/api/store', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.business_type_id) return bad(res, 400, 'name と business_type_id は必須です');
  const bt = await db.getBusinessType(b.business_type_id);
  if (!bt) return bad(res, 400, '不明な業態です');
  const err = validateLicenses(bt, b.license_values || {});
  if (err) return bad(res, 400, err);
  // 所有者をログインユーザーに（認証OFFなら 'local'）。1ユーザーが複数店舗を作れる。
  ok(res, { store: await db.createStore({ ...b, owner_id: ownerId(req) }) });
});
// 店舗の修正（更新）
app.post('/api/store/:id', async (req, res) => {
  const { store: cur, forbidden } = await getOwnedStore(req, req.params.id);
  if (forbidden) return bad(res, 403, 'この店舗にはアクセスできません');
  if (!cur) return bad(res, 404, '店舗が見つかりません');
  const b = req.body || {};
  const btId = b.business_type_id || cur.business_type_id;
  const bt = await db.getBusinessType(btId);
  if (!bt) return bad(res, 400, '不明な業態です');
  // 更新後のライセンス値で検証
  const licenses = b.license_values ?? cur.license_values;
  const err = validateLicenses(bt, licenses);
  if (err) return bad(res, 400, err);
  ok(res, { store: await db.updateStore(cur.id, b) });
});
// 店舗ロゴのアップロード（動画のオープニング/CTAに合成）。base64 dataURL を受けて store.logo_url に保存。
app.post('/api/store/:id/logo', async (req, res) => {
  const { store, forbidden } = await getOwnedStore(req, req.params.id);
  if (forbidden) return bad(res, 403, 'この店舗にはアクセスできません');
  if (!store) return bad(res, 404, '店舗が見つかりません');
  const m = /^data:image\/(png|jpe?g|webp)\;base64,(.+)$/i.exec(req.body?.data_url || '');
  if (!m) return bad(res, 400, 'ロゴは png/jpeg/webp の dataURL で送ってください');
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return bad(res, 400, 'ロゴは5MBまでにしてください');
  const url = await saveAssetFile(`${store.id}/logo/logo-${randomUUID().slice(0, 6)}.${ext}`, buf, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
  const updated = await db.updateStore(store.id, { logo_url: url });
  ok(res, { store: updated, logo_url: url });
});

// 店舗の関連データ件数（削除ダイアログの表示用）
app.get('/api/store/:id/relations', async (req, res) => {
  const { store, forbidden } = await getOwnedStore(req, req.params.id);
  if (forbidden) return bad(res, 403, 'この店舗にはアクセスできません');
  if (!store) return bad(res, 404, '店舗が見つかりません');
  ok(res, { counts: await db.storeRelationCounts(req.params.id) });
});
// 店舗削除。既定は安全削除（関連が残っていれば拒否）。?cascade=1 で関連ごと全削除。
app.delete('/api/store/:id', async (req, res) => {
  const { store, forbidden } = await getOwnedStore(req, req.params.id);
  if (forbidden) return bad(res, 403, 'この店舗にはアクセスできません');
  if (!store) return bad(res, 404, '店舗が見つかりません');
  const cascade = req.query.cascade === '1' || req.query.cascade === 'true';
  if (cascade) {
    const r = await db.deleteStoreCascade(store.id);
    // 生成物ファイル(動画/画像/QR/応募写真)も店舗フォルダごと削除
    try { rmSync(join(__dirname, '..', '..', 'data', 'assets', store.id), { recursive: true, force: true }); } catch {}
    try { await storage.removeStorePrefix(store.id); } catch (e) { console.error('storage削除', e.message); } // Storageの店舗ファイルも削除
    return ok(res, { deleted: true, cascade: true, counts: r.counts });
  }
  const r = await db.deleteStoreIfEmpty(store.id);
  if (!r.deleted) return bad(res, 409, '関連データが残っているため削除できません。先に関連を削除するか「関連ごとすべて削除」を使ってください。');
  ok(res, { deleted: true, cascade: false, counts: r.counts });
});

// --- キャンペーン ---
app.get('/api/stores/:id/campaigns', async (req, res) => {
  if (await guardStore(req, res, req.params.id)) return;
  ok(res, { campaigns: await db.listCampaigns(req.params.id) });
});
// 一覧（全件 or ?store_id= で店舗絞り込み）。一覧ビューの「名前+日付」用に軽量に返す。
app.get('/api/campaigns', async (req, res) => {
  const myStores = await db.listStores(ownerId(req)); // 認証OFFなら全件
  const myIds = new Set(myStores.map(s => s.id));
  const nameOf = new Map(myStores.map(s => [s.id, s.name]));
  let rows;
  if (req.query.store_id) {
    if (authEnabled() && !myIds.has(req.query.store_id)) return bad(res, 403, 'この店舗にはアクセスできません');
    rows = await db.listCampaigns(req.query.store_id);
  } else {
    rows = (await db.listCampaigns(null)).filter(c => !authEnabled() || myIds.has(c.store_id));
  }
  ok(res, { campaigns: rows.map(c => ({ ...c, store_name: nameOf.get(c.store_id) || '' })) });
});
// 詳細（店舗名 / 使ったQRのslug / 紐づく記事・動画へのリンク）。ダイアログ表示用。
app.get('/api/campaign/:id', async (req, res) => {
  const c = await db.getCampaign(req.params.id);
  if (!c) return bad(res, 404, 'キャンペーンが見つかりません');
  if (await guardStore(req, res, c.store_id)) return;
  const store = await db.getStore(c.store_id);
  const form = c.lead_form_id ? await db.getLeadForm(c.lead_form_id) : null;
  const posts = (await db.listPostsByCampaign(c.id)).map(p => ({
    id: p.id, channel: p.channel, status: p.status,
    label: (CHANNEL_PROFILES[p.channel] || {}).label || p.channel,
  }));
  const videos = (await db.listAssetsByCampaign(c.id, 'gen_video')).map(a => ({ url: a.url, seconds: a.meta?.seconds }));
  ok(res, {
    campaign: c,
    store_name: store?.name || '',
    form: form ? { id: form.id, label: form.label, public_slug: form.public_slug, url: `${BASE}/f/${form.public_slug}` } : null,
    posts, videos,
  });
});
// 投稿画面用のまとめ: キャンペーンの各post本文 × 店舗の投稿先 × 最新の投稿状態。
app.get('/api/campaign/:id/publish-board', async (req, res) => {
  const c = await db.getCampaign(req.params.id);
  if (!c) return bad(res, 404, 'キャンペーンが見つかりません');
  if (await guardStore(req, res, c.store_id)) return;
  const posts = (await db.listPostsByCampaign(c.id)).map(p => ({
    id: p.id, channel: p.channel, body: p.body,
    label: (CHANNEL_PROFILES[p.channel] || {}).label || p.channel,
  }));
  // 投稿先（マスク済み表示情報）
  const conns = (await db.listConnections(c.store_id)).map(cn => {
    const d = getChannelDriver(cn.channel);
    return { id: cn.id, label: cn.label || d?.label || cn.channel, driver_label: d?.label || cn.channel,
      auto_status: d?.auto?.status || 'unsupported', auto_publish: cn.auto_publish };
  });
  // 投稿状態: post_id → { connection_id → {status, detail, created_at} }（最新）
  const pubs = await db.listPublicationsByCampaign(c.id);
  const byPost = {};
  for (const pp of pubs) {
    byPost[pp.post_id] = byPost[pp.post_id] || {};
    // listはcreated_at降順なので、未設定のときだけ入れれば最新が残る
    if (!byPost[pp.post_id][pp.connection_id]) byPost[pp.post_id][pp.connection_id] = { status: pp.status, detail: pp.detail, created_at: pp.created_at };
  }
  ok(res, { campaign: { id: c.id, title: c.title }, posts, connections: conns, publications: byPost });
});

// キャンペーン作成: store_id + lead_form_id（使うQR）を受ける。lead_form_id 必須。
app.post('/api/campaign', async (req, res) => {
  const b = req.body || {};
  if (!b.store_id || !b.title) return bad(res, 400, 'store_id と title は必須です');
  if (!b.lead_form_id) return bad(res, 400, '使用する QR/URL（lead_form_id）を選択してください');
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, '店舗が見つかりません');
  const form = await db.getLeadForm(b.lead_form_id);
  if (!form || form.store_id !== store.id) return bad(res, 400, 'QR/URL がこの店舗のものではありません');
  ok(res, { campaign: await db.createCampaign(b) });
});

// 買取フォームの既定フィールド（申込フォーム設定の初期値）
function defaultAssessmentFields() {
  return {
    photo_min: 5, photo_max: 10,
    contact_either_required: true, // 電話とメールのどちらか一方を必須にする（店舗ごとに切替可）
    contact: [
      { key: 'name', label: 'お名前', type: 'text', required: true },
      { key: 'tel', label: '電話番号', type: 'tel', required: false },
      { key: 'email', label: 'メールアドレス', type: 'email', required: false },
    ],
    item: [
      { key: 'item_name', label: '商品名', type: 'text', required: true },
      { key: 'year', label: '年式', type: 'text', required: false },
      { key: 'condition', label: '状態', type: 'select', required: true, options: ['新品', '開封済未使用', '中古', 'ジャンク'] },
      { key: 'used_years', label: '使用年数', type: 'text', required: false },
      { key: 'comment', label: 'コメント', type: 'textarea', required: false },
    ],
  };
}

// --- QR/URL作成（＝店舗の常設フォーム。キャンペーンには紐づかない。1店舗に複数可） ---
// 開いた時にその店舗のアクティブなキャンペーンを自動表示するので、campaign_id は渡さない。
app.post('/api/qr', async (req, res) => {
  const b = req.body || {};
  if (!b.store_id) return bad(res, 400, 'store_id は必須です');
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, '店舗が見つかりません');
  const bt = await db.getBusinessType(store.business_type_id);
  // 申込フォーム設定（store_setting.form_config）が無ければ既定を使う
  const cfg = await db.getSetting(store.id, 'form_config', defaultAssessmentFields());
  const form = await db.createLeadForm({
    store_id: b.store_id,
    label: (b.label || '査定フォーム').trim() || '査定フォーム', // QRの名前（店頭用/Web用 等）
    kind: b.kind || bt.form_kind_default,
    fields: cfg,
  });
  const url = `${BASE}/f/${form.public_slug}`;
  ok(res, { form, url, qr: await qrDataUrl(url) });
});
// 後方互換: 旧 /api/form も同じ挙動
app.post('/api/form', (req, res, next) => { req.url = '/api/qr'; app.handle(req, res, next); });
app.get('/api/stores/:id/forms', async (req, res) => {
  if (await guardStore(req, res, req.params.id)) return;
  const forms = await db.listLeadForms(req.params.id);
  // 一覧に公開URLとQR画像を添える（登録一覧カードでそのまま表示・再印刷できるように）
  const withUrl = await Promise.all(forms.map(async f => {
    const url = `${BASE}/f/${f.public_slug}`;
    return { ...f, url, qr: await qrDataUrl(url) };
  }));
  ok(res, { forms: withUrl });
});
// QR/URL（店舗常設フォーム）の更新（ラベル/項目定義）
app.post('/api/form/:id', async (req, res) => {
  const cur = await db.getLeadForm(req.params.id);
  if (!cur) return bad(res, 404, 'QR/URL（フォーム）が見つかりません');
  if (await guardStore(req, res, cur.store_id)) return;
  const b = req.body || {};
  const patch = {};
  if (typeof b.label === 'string') patch.label = b.label.trim() || cur.label;
  if (typeof b.kind === 'string') patch.kind = b.kind;
  if (b.fields && typeof b.fields === 'object') patch.fields = b.fields;
  ok(res, { form: await db.updateLeadForm(cur.id, patch) });
});

// --- 申込フォーム設定（項目定義） ---
app.get('/api/stores/:id/form-config', async (req, res) => {
  if (await guardStore(req, res, req.params.id)) return;
  const store = await db.getStore(req.params.id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  ok(res, { config: await db.getSetting(store.id, 'form_config', defaultAssessmentFields()) });
});
app.post('/api/form-config', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const def = defaultAssessmentFields();
  const cfg = { ...def, ...(b.config || {}) };
  // 連絡先・商品項目が未指定/空なら既定で補完（フォームから項目が消えるのを防ぐ）
  if (!Array.isArray(cfg.contact) || cfg.contact.length === 0) cfg.contact = def.contact;
  if (!Array.isArray(cfg.item) || cfg.item.length === 0) cfg.item = def.item;
  // 写真枚数の妥当性（0枚許可のため NaN のときだけ既定にフォールバック。|| だと 0 が 5 に化ける）
  const nmin = Number(cfg.photo_min); const nmax = Number(cfg.photo_max);
  cfg.photo_min = Math.max(0, Math.min(10, Number.isFinite(nmin) ? nmin : 5));
  cfg.photo_max = Math.max(cfg.photo_min, Math.min(10, Number.isFinite(nmax) ? nmax : 10));
  // 電話/メールのどちらか必須（未指定なら既定 true）
  cfg.contact_either_required = cfg.contact_either_required !== false;
  ok(res, { config: await db.setSetting(store.id, 'form_config', cfg) });
});

// --- 送信先設定（応募がどこに届くか：メール / LINE 等） ---
app.get('/api/stores/:id/delivery', async (req, res) => {
  if (await guardStore(req, res, req.params.id)) return;
  const store = await db.getStore(req.params.id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  ok(res, { delivery: await db.getSetting(store.id, 'delivery', { email: '', line_notify_token: '', webhook_url: '' }) });
});
app.post('/api/delivery', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const d = {
    email: (b.delivery?.email || '').trim(),
    line_notify_token: (b.delivery?.line_notify_token || '').trim(),
    webhook_url: (b.delivery?.webhook_url || '').trim(),
  };
  ok(res, { delivery: await db.setSetting(store.id, 'delivery', d) });
});

// --- 投稿先ドライバ定義（登録フォームの自動描画に使う） ---
app.get('/api/channel-drivers', async (req, res) => ok(res, { drivers: listChannelDrivers() }));

// --- 投稿先の接続（自動/手動の設定をJSONで保存） ---
// 一覧はトークン等の値をマスクして返す（画面表示・漏洩防止）。
function maskConfig(driverFields, cfg) {
  const out = {};
  for (const f of driverFields || []) {
    const v = cfg?.[f.key];
    if (v == null || v === '') { out[f.key] = ''; continue; }
    out[f.key] = f.type === 'password' ? '••••••（設定済み）' : v;
  }
  return out;
}
app.get('/api/stores/:id/connections', async (req, res) => {
  if (await guardStore(req, res, req.params.id)) return;
  if (!await db.getStore(req.params.id)) return bad(res, 400, 'store_id が不正です');
  const conns = (await db.listConnections(req.params.id)).map(c => {
    const d = getChannelDriver(c.channel);
    return {
      id: c.id, channel: c.channel, label: c.label, auto_publish: c.auto_publish,
      driver_label: d?.label || c.channel,
      auto_status: d?.auto?.status || 'unsupported',
      auto_config: maskConfig(d?.auto?.fields, c.auto_config),
      manual_config: maskConfig(d?.manual?.fields, c.manual_config),
    };
  });
  ok(res, { connections: conns });
});
app.post('/api/connection', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const d = getChannelDriver(b.channel);
  if (!d) return bad(res, 400, '不明な投稿先です');
  ok(res, { connection: await db.createConnection({
    store_id: store.id, channel: b.channel, label: (b.label || d.label),
    auto_config: b.auto_config || {}, manual_config: b.manual_config || {}, auto_publish: !!b.auto_publish,
  }) });
});
app.post('/api/connection/:id', async (req, res) => {
  const cur = await db.getConnection(req.params.id);
  if (!cur) return bad(res, 404, '接続が見つかりません');
  if (await guardStore(req, res, cur.store_id)) return;
  const b = req.body || {};
  // password項目はマスク値('••…')が送られてきたら既存値を維持（空文字は消去とみなす）
  const d = getChannelDriver(cur.channel);
  const merge = (fields, incoming, curCfg) => {
    if (!incoming) return curCfg;
    const out = { ...curCfg };
    for (const f of fields || []) {
      if (!(f.key in incoming)) continue;
      const v = incoming[f.key];
      if (f.type === 'password' && typeof v === 'string' && v.startsWith('••')) continue; // マスクは無視
      out[f.key] = v;
    }
    return out;
  };
  ok(res, { connection: await db.updateConnection(cur.id, {
    label: b.label,
    auto_config: merge(d?.auto?.fields, b.auto_config, cur.auto_config),
    manual_config: merge(d?.manual?.fields, b.manual_config, cur.manual_config),
    auto_publish: b.auto_publish,
  }) });
});
app.delete('/api/connection/:id', async (req, res) => {
  const cur = await db.getConnection(req.params.id);
  if (!cur) return bad(res, 404, '接続が見つかりません');
  if (await guardStore(req, res, cur.store_id)) return;
  await db.deleteConnection(req.params.id); ok(res, { deleted: true });
});

// ============ ブログ/HP用の記事ライン（キャンペーン投稿とは別） ============
// 文体プロファイル（店舗ごと）。お手本テキスト複数 + スタイル設定。生成時にAIへ「お手本」として渡す。
function defaultArticleStyle() {
  return {
    samples: [],                 // 過去記事など、お手本テキストの配列
    tone: 'polite',              // polite(です・ます) | casual(だ・である) | friendly(やわらかい)
    emoji: false,                // 絵文字を使うか
    hardness: 'normal',          // soft | normal | hard（硬さ）
    length: 'medium',            // short | medium | long（目安の長さ）
    notes: '',                   // 自由メモ（「専門用語は避ける」等）
  };
}
app.get('/api/stores/:id/article-style', async (req, res) => {
  if (await guardStore(req, res, req.params.id)) return;
  const store = await db.getStore(req.params.id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  ok(res, { style: await db.getSetting(store.id, 'article_style', defaultArticleStyle()) });
});
app.post('/api/article-style', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const def = defaultArticleStyle();
  const s = { ...def, ...(b.style || {}) };
  s.samples = Array.isArray(s.samples) ? s.samples.filter(x => typeof x === 'string' && x.trim()).slice(0, 20) : [];
  ok(res, { style: await db.setSetting(store.id, 'article_style', s) });
});

// 記事の生成 / 共同編集アクション。本文文字列を返す（保存はフロントが /api/article で行う）。
// ※ /api/article/:id より前に定義すること（"write" が :id に食われるのを防ぐ）。
// body: { store_id, action, theme?, current_body?, instruction? }
app.post('/api/article/write', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const action = ARTICLE_ACTIONS.includes(b.action) ? b.action : 'generate';
  if (action === 'custom' && !(b.instruction || '').trim()) return bad(res, 400, '指示を入力してください');
  if (['continue', 'polish', 'expand', 'shorten', 'restyle'].includes(action) && !(b.current_body || '').trim())
    return bad(res, 400, '対象の本文がありません');
  const style = await db.getSetting(store.id, 'article_style', {});
  const r = await writeArticle({ store, style, action, theme: b.theme, currentBody: b.current_body, instruction: b.instruction });
  ok(res, { body: r.body, source: r.source, warning: r.error || null });
});

// 記事 CRUD
app.get('/api/stores/:id/articles', async (req, res) => {
  if (await guardStore(req, res, req.params.id)) return;
  if (!await db.getStore(req.params.id)) return bad(res, 400, 'store_id が不正です');
  ok(res, { articles: await db.listArticles(req.params.id) });
});
app.get('/api/article/:id', async (req, res) => {
  const a = await db.getArticle(req.params.id);
  if (!a) return bad(res, 404, '記事が見つかりません');
  if (await guardStore(req, res, a.store_id)) return;
  ok(res, { article: a });
});
app.post('/api/article', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  ok(res, { article: await db.createArticle({ store_id: store.id, title: b.title, body: b.body, theme: b.theme, source: b.source || 'manual', status: b.status }) });
});
app.post('/api/article/:id', async (req, res) => {
  const cur = await db.getArticle(req.params.id);
  if (!cur) return bad(res, 404, '記事が見つかりません');
  if (await guardStore(req, res, cur.store_id)) return;
  const b = req.body || {};
  ok(res, { article: await db.updateArticle(cur.id, { title: b.title, body: b.body, theme: b.theme, status: b.status }) });
});
app.delete('/api/article/:id', async (req, res) => {
  const cur = await db.getArticle(req.params.id);
  if (!cur) return bad(res, 404, '記事が見つかりません');
  if (await guardStore(req, res, cur.store_id)) return;
  await db.deleteArticle(req.params.id); ok(res, { deleted: true });
});

// 記事の自動生成スケジュール CRUD
app.get('/api/stores/:id/schedules', async (req, res) => {
  if (await guardStore(req, res, req.params.id)) return;
  if (!await db.getStore(req.params.id)) return bad(res, 400, 'store_id が不正です');
  ok(res, { schedules: await db.listSchedules(req.params.id) });
});
app.post('/api/schedule', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  if (!(b.theme || '').trim()) return bad(res, 400, 'テーマは必須です');
  if (!/^\d{1,2}:\d{2}$/.test(b.at_time || '')) return bad(res, 400, '時刻は HH:MM 形式で入力してください');
  ok(res, { schedule: await db.createSchedule({
    store_id: store.id, theme: b.theme.trim(), frequency: b.frequency === 'weekly' ? 'weekly' : 'daily',
    at_time: b.at_time, weekday: b.frequency === 'weekly' ? Number(b.weekday) : null, enabled: b.enabled !== false,
  }) });
});
app.post('/api/schedule/:id', async (req, res) => {
  const cur = await db.getSchedule(req.params.id);
  if (!cur) return bad(res, 404, 'スケジュールが見つかりません');
  if (await guardStore(req, res, cur.store_id)) return;
  const b = req.body || {};
  ok(res, { schedule: await db.updateSchedule(cur.id, {
    theme: b.theme, frequency: b.frequency, at_time: b.at_time,
    weekday: b.weekday, enabled: b.enabled,
  }) });
});
app.delete('/api/schedule/:id', async (req, res) => {
  const cur = await db.getSchedule(req.params.id);
  if (!cur) return bad(res, 404, 'スケジュールが見つかりません');
  if (await guardStore(req, res, cur.store_id)) return;
  await db.deleteSchedule(req.params.id); ok(res, { deleted: true });
});
// 今すぐ生成（スケジュールを待たずに1回実行。生成物は記事一覧に入る）
app.post('/api/schedule/:id/run', async (req, res) => {
  const cur = await db.getSchedule(req.params.id);
  if (!cur) return bad(res, 404, 'スケジュールが見つかりません');
  if (await guardStore(req, res, cur.store_id)) return;
  try { await runScheduleNow(req.params.id); ok(res, { ran: true }); }
  catch (e) { bad(res, 500, '生成に失敗: ' + (e.message || e)); }
});

// ============ 広告クリエイティブ（文面）。各メディア専用フォーマットでコピペ用に生成 ============
app.get('/api/ad-formats', async (req, res) => ok(res, { formats: listAdFormats() }));
// body: { store_id, medias[], campaign_id?, form_slug?, extra? }
app.post('/api/generate/ad-copy', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  // medias 未指定は instagram 既定。明示的に空配列/不正のみなら弾く。
  const requested = b.medias === undefined ? ['instagram'] : (Array.isArray(b.medias) ? b.medias : []);
  const medias = requested.filter(m => AD_FORMATS[m]);
  if (!medias.length) return bad(res, 400, '媒体を1つ以上選んでください');
  const campaign = b.campaign_id ? await db.getCampaign(b.campaign_id) : null;
  const ctaUrl = b.form_slug ? `${BASE}/f/${b.form_slug}` : null;
  const style = await db.getSetting(store.id, 'article_style', {}); // 文体プロファイルを流用（任意）
  const results = await generateAdCopies({ store, campaign, medias, ctaUrl, style, extra: (b.extra || '').trim() });
  ok(res, { results: results.map(r => ({ media: r.media, label: (AD_FORMATS[r.media] || {}).label || r.media, body: r.body, source: r.source, warning: r.error || null })), url: ctaUrl });
});

// --- 広告動画（テンプレート型 + 既存スライドショーエンジンで合成） ---
app.get('/api/ad-video/templates', async (req, res) => ok(res, { templates: listAdVideoTemplates(), aspects: listAdVideoAspects(), transitions: listAdVideoTransitions(), aiBgm: musicgenEnabled() }));
// ナレーションの声一覧（Google TTS有効時のみ声を返す。無効なら空＝UIはOpenAIフォールバック）。
app.get('/api/tts/voices', async (req, res) => ok(res, { enabled: gTtsEnabled(), voices: gTtsEnabled() ? listJaVoices() : [] }));
// 声の試聴: 指定の声で短いサンプルを生成し、data URL(base64 mp3)で返す（その場再生用）。
app.post('/api/tts/preview', async (req, res) => {
  if (!gTtsEnabled()) return bad(res, 400, 'ナレーション音声が利用できません');
  const b = req.body || {};
  const sample = (b.text || 'こんにちは。ブランド品の買取なら当店へ。査定は無料です。').slice(0, 120);
  const tmp = join(tmpDir(), `preview-${randomUUID()}.mp3`);
  const okGen = await gSynthToFile(sample, tmp, { voice: b.voice, speed: NARR_SPEED_MAP[b.speed] ?? 1.05 });
  if (!okGen) return bad(res, 500, '試聴の生成に失敗しました');
  try {
    const dataUrl = 'data:audio/mpeg;base64,' + readFileSync(tmp).toString('base64');
    ok(res, { audio: dataUrl });
  } finally { try { rmSync(tmp, { force: true }); } catch {} }
});
// テロップ文言だけをAI生成して返す（ユーザーが編集してから動画化するため）。
app.post('/api/ad-video/captions', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const campaign = b.campaign_id ? await db.getCampaign(b.campaign_id) : null;
  const template = getAdVideoTemplate(b.template || 'standard') || getAdVideoTemplate('standard');
  const style = await db.getSetting(store.id, 'article_style', {});
  const captions = await buildCaptions({ store, campaign, template, style, extra: (b.extra || '').trim() });
  ok(res, { captions, scenes: template.scenes.map(s => s.kind) });
});
// 話速ラベル→倍率。
const NARR_SPEED_MAP = { slow: 0.9, normal: 1.05, fast: 1.25 };
// body: { store_id, template, aspect?, campaign_id?, form_slug?, extra?, image_urls[], per? , auto_bgm?, bgm_url?, narr_voice?, narr_speed? }
app.post('/api/generate/ad-video', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const campaign = b.campaign_id ? await db.getCampaign(b.campaign_id) : null;
  const ctaUrl = b.form_slug ? `${BASE}/f/${b.form_slug}` : null;
  const bt = await db.getBusinessType(store.business_type_id);
  const style = await db.getSetting(store.id, 'article_style', {});
  const images = [];
  if (Array.isArray(b.image_urls)) for (const u of b.image_urls) { const p = await resolveToLocal(u); if (p) images.push(p); }
  // 動画クリップ素材（リール用）。あればこちらが優先されリール生成。最大3本。
  const clips = [];
  if (Array.isArray(b.clip_urls)) for (const u of b.clip_urls.slice(0, 3)) { const p = await resolveToLocal(u); if (p) clips.push(p); }

  // BGM: bgm_mode='ai'ならMurekaで生成 / それ以外は指定URL→登録先頭。auto_bgm=falseで無音。
  const autoBgm = b.auto_bgm !== false;
  let bgmPath = null;
  if (autoBgm) {
    if (b.bgm_mode === 'ai' && musicgenEnabled()) {
      // 想定尺ぶん（クリップ合計 or 25秒）のBGMを生成。生成物はStorageにも保存し再利用可能に。
      const est = Array.isArray(b.clip_seconds_list) && b.clip_seconds_list.length
        ? b.clip_seconds_list.reduce((a, v) => a + (Number(v) || 6), 0) + 5 : 25;
      const tmpMp3 = join(tmpDir(), `aibgm-${randomUUID()}.mp3`);
      const prompt = (b.bgm_prompt || '').trim() || `${store.name}の店舗広告向け、明るくキャッチーなインストゥルメンタルBGM`;
      const okGen = await musicgenToFile(prompt, tmpMp3, { lengthMs: est * 1000 });
      if (okGen) {
        bgmPath = tmpMp3;
        try { const url = await saveAssetFile(`${store.id}/bgm/aibgm-${randomUUID().slice(0, 6)}.mp3`, readFileSync(tmpMp3), 'audio/mpeg'); await db.createAsset({ store_id: store.id, kind: 'bgm', url, meta: { name: 'AI生成BGM', ai: true } }); } catch {}
      }
    }
    if (!bgmPath && b.bgm_url) bgmPath = await resolveToLocal(b.bgm_url);
    if (!bgmPath) { const list = await db.listAssets(store.id, 'bgm'); if (list[0]) bgmPath = await resolveToLocal(list[0].url); }
  }

  // 各クリップ個別秒数（配列）/ 速度（配列）。単一数値も後方互換。
  const clipSeconds = Array.isArray(b.clip_seconds_list) && b.clip_seconds_list.length ? b.clip_seconds_list.map(Number) : (Number(b.clip_seconds) || 6);
  const clipSpeeds = Array.isArray(b.clip_speeds) ? b.clip_speeds.map(Number) : [];
  const colorGrade = typeof b.color_grade === 'string' ? b.color_grade : 'none';
  // ロゴ: use_logo=true かつ店舗にlogo_urlがあれば、ローカル解決してオーバーレイ。
  let logoPath = null;
  if (b.use_logo && store.logo_url) logoPath = await resolveToLocal(store.logo_url);

  try {
    const r = await generateAdVideo({
      store, campaign, templateKey: b.template || 'standard', aspect: b.aspect || '9:16',
      ctaUrl, ctaLabel: bt?.cta_default_label, style, extra: (b.extra || '').trim(),
      captions: Array.isArray(b.captions) ? b.captions : null, // ユーザー編集テロップ（あれば優先）
      images, clips, clipSeconds, clipSpeeds, colorGrade, logoPath,
      logoPos: b.logo_pos || 'top-right', logoSize: b.logo_size || 'medium',
      autoBgm, bgmPath,
      transition: b.transition || 'fade', opening: b.opening !== false,
      showTelop: b.show_telop !== false, narration: b.narration === true,
      narrVoice: b.narr_voice || null, // Google TTS声キー(f-aoede等)。そのまま伝播。
      narrSpeed: NARR_SPEED_MAP[b.narr_speed] ?? 1.05, // 話速(ゆっくり/標準/早口)
    });
    const rel = `${store.id}/videos/${randomUUID()}.mp4`;
    const url = await saveAssetFile(rel, readFileSync(r.path), 'video/mp4');
    try { rmSync(r.path, { force: true }); } catch {}
    const asset = await db.createAsset({ store_id: store.id, campaign_id: campaign?.id || null, kind: 'gen_video',
      url, meta: { seconds: r.seconds, slides: r.slides, bgm: r.bgm, narration: r.narration, ctaUrl, ad: true, template: r.template, aspect: r.aspect, transition: r.transition } });
    ok(res, { asset, videoUrl: asset.url, seconds: r.seconds, slides: r.slides, bgm: r.bgm, narration: r.narration, template: r.template, aspect: r.aspect, transition: r.transition, captions: r.captions });
  } catch (e) {
    bad(res, 500, '広告動画の生成に失敗しました: ' + (e.message || e));
  }
});

// --- 記事生成（複数チャネル同時対応） ---
app.get('/api/channels', async (req, res) => ok(res, { channels: listChannels() }));
app.post('/api/generate/article', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  const campaign = await db.getCampaign(b.campaign_id);
  if (!store || !campaign) return bad(res, 400, 'store_id / campaign_id が不正です');
  const bt = await db.getBusinessType(store.business_type_id);

  // channels[] を優先。旧 channel（単数）も後方互換で受ける。
  const channels = Array.isArray(b.channels) && b.channels.length ? b.channels : [b.channel || 'instagram'];
  const results = await generateArticles({ store, campaign, channels });

  const ctaUrl = b.form_slug ? `${BASE}/f/${b.form_slug}` : null;
  const posts = await Promise.all(results.map(async r => {
    const body = ctaUrl ? appendCta(r.body, { ctaLabel: bt.cta_default_label, url: ctaUrl }) : r.body;
    const post = await db.createPost({ store_id: store.id, campaign_id: campaign.id, channel: r.channel, body, status: 'draft' });
    return { channel: r.channel, label: (CHANNEL_PROFILES[r.channel] || {}).label || r.channel, post, source: r.source, warning: r.error || null };
  }));
  ok(res, { results: posts, url: ctaUrl });
});

// --- 記事の手直し保存 ---
app.post('/api/post/:id/body', async (req, res) => {
  const post = await db.getPost(req.params.id);
  if (!post) return bad(res, 404, 'post が見つかりません');
  if (await guardStore(req, res, post.store_id)) return;
  const body = (req.body || {}).body;
  if (typeof body !== 'string') return bad(res, 400, 'body(文字列) が必要です');
  ok(res, { post: await db.updatePostBody(post.id, body) });
});

// 共通: /assets/... の相対URLをローカル絶対パスへ（ローカル保存時のみ有効）
const toAbsAsset = (u) => join(__dirname, '..', '..', 'data', 'assets', String(u).replace(/^\/assets\//, ''));
const uploadsDir = (storeId) => join(__dirname, '..', '..', 'data', 'assets', storeId, 'uploads');
const bgmStoreDir = (storeId) => join(__dirname, '..', '..', 'data', 'assets', storeId, 'bgm');
const tmpDir = () => { const d = join(__dirname, '..', '..', 'data', 'tmp'); mkdirSync(d, { recursive: true }); return d; };

// 生成ファイル保存の共通ヘルパ。Storage有効なら公開バケットへ→公開URL、無効ならローカル保存→/assets/... 。
// relPath 例: `${storeId}/uploads/xxx.jpg`
async function saveAssetFile(relPath, buf, contentType) {
  if (storage.storageEnabled()) {
    const url = await storage.uploadPublic(relPath, buf, contentType);
    if (url) return url;
    // アップロード失敗時はローカルにフォールバック
  }
  const abs = join(__dirname, '..', '..', 'data', 'assets', relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return `/assets/${relPath}`;
}

// 動画生成の入力素材(url)を、ffmpegが読めるローカルファイルパスに解決する（async）。
// Storage URL(http...) は一時DL、/assets/... はローカルパス、既にローカル絶対パスならそのまま。
async function resolveToLocal(url) {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) {
    const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [, 'bin'])[1];
    const local = join(tmpDir(), `dl-${randomUUID()}.${ext}`);
    const okdl = await storage.downloadToFile(url, local);
    return okdl ? local : null;
  }
  if (String(url).startsWith('/assets/')) { const p = toAbsAsset(url); return existsSync(p) ? p : null; }
  return existsSync(url) ? url : null;
}

// --- 画像アップロード（base64 dataURL を受けて store 別に保存） ---
app.post('/api/asset/upload', async (req, res) => {
  const b = req.body || {};
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const dataUrl = b.data_url || '';
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
  if (!m) return bad(res, 400, '画像は png/jpeg/webp の dataURL で送ってください');
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 12 * 1024 * 1024) return bad(res, 400, '画像は12MBまでにしてください');
  const fname = `${randomUUID()}.${ext}`;
  const url = await saveAssetFile(`${store.id}/uploads/${fname}`, buf, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
  const asset = await db.createAsset({ store_id: store.id, kind: 'upload_image', url, meta: { bytes: buf.length } });
  ok(res, { asset, url: asset.url });
});

// --- 動画クリップのアップロード（リール素材。フレーム抽出せず動画そのものを保存） ---
app.post('/api/asset/clip-upload', async (req, res) => {
  const b = req.body || {};
  if (await guardStore(req, res, b.store_id)) return;
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const dataUrl = b.data_url || '';
  const m = /^data:video\/(mp4|quicktime|webm|x-m4v);base64,(.+)$/i.exec(dataUrl);
  if (!m) return bad(res, 400, '動画は mp4/mov/webm の dataURL で送ってください');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 100 * 1024 * 1024) return bad(res, 400, '動画は100MBまでにしてください');
  const fname = `${randomUUID()}.mp4`;
  const url = await saveAssetFile(`${store.id}/clips/${fname}`, buf, 'video/mp4');
  const asset = await db.createAsset({ store_id: store.id, kind: 'clip', url, meta: { bytes: buf.length } });
  ok(res, { asset, url: asset.url });
});

// --- 動画アップロード → フレーム抽出 → スライド用の静止画に変換 ---
// ユーザーが撮影した動画から看板/ロゴ/商品の静止画を切り出す（ユーザー素材からの生成=商標使用に当たらない）。
app.post('/api/asset/video-frames', async (req, res) => {
  const b = req.body || {};
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const dataUrl = b.data_url || '';
  const m = /^data:video\/(mp4|quicktime|webm|x-m4v);base64,(.+)$/i.exec(dataUrl);
  if (!m) return bad(res, 400, '動画は mp4/mov/webm の dataURL で送ってください');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 100 * 1024 * 1024) return bad(res, 400, '動画は100MBまでにしてください');
  const want = Math.max(1, Math.min(10, Number(b.want) || 3));

  const tdir = tmpDir();
  const videoPath = join(tdir, `src-${randomUUID()}.mp4`);
  writeFileSync(videoPath, buf);
  const workDir = join(tdir, `frames-${randomUUID()}`);

  try {
    const { frames, source } = await extractSlideFrames({ videoPath, workDir, want });
    // 抽出フレームを保存（Storage or ローカル）し asset(kind=extracted_still) 登録
    const out = [];
    for (const f of frames) {
      const fname = `${randomUUID()}.jpg`;
      const url = await saveAssetFile(`${store.id}/uploads/${fname}`, readFileSync(f), 'image/jpeg');
      const asset = await db.createAsset({ store_id: store.id, kind: 'extracted_still', url, meta: { from: 'video', pick: source } });
      out.push({ url: asset.url });
    }
    ok(res, { frames: out, source, note: source === 'vision' ? 'AIが看板/商品の写ったフレームを選定' : '等間隔で抽出（Claudeキー設定でAI選定に）' });
  } catch (e) {
    bad(res, 500, 'フレーム抽出に失敗しました: ' + (e.message || e));
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    try { rmSync(videoPath, { force: true }); } catch {}
  }
});

// --- BGM: アップロード / 一覧 ---
app.post('/api/bgm/upload', async (req, res) => {
  const b = req.body || {};
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  const dataUrl = b.data_url || '';
  const m = /^data:audio\/(mpeg|mp3|aac|wav|x-m4a|mp4);base64,(.+)$/i.exec(dataUrl);
  if (!m) return bad(res, 400, '音源は mp3/aac/wav/m4a の dataURL で送ってください');
  const extMap = { mpeg: 'mp3', mp3: 'mp3', aac: 'aac', wav: 'wav', 'x-m4a': 'm4a', mp4: 'm4a' };
  const ext = extMap[m[1].toLowerCase()] || 'mp3';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 20 * 1024 * 1024) return bad(res, 400, '音源は20MBまでにしてください');
  const fname = `${(b.name || 'bgm').replace(/[^\w.-]/g, '_')}-${randomUUID().slice(0, 6)}.${ext}`;
  const ctype = ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : 'audio/aac';
  const url = await saveAssetFile(`${store.id}/bgm/${fname}`, buf, ctype);
  const asset = await db.createAsset({ store_id: store.id, kind: 'bgm', url, meta: { name: b.name || fname } });
  ok(res, { asset });
});
app.get('/api/stores/:id/bgm', async (req, res) => {
  const store = await db.getStore(req.params.id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  ok(res, { bgm: (await db.listAssets(store.id, 'bgm')).map(a => ({ url: a.url, name: a.meta?.name || a.url })) });
});

// --- ②スライドショー動画生成（写真/抽出静止画スライド + Ken Burns + テロップ + 末尾QR + BGM） ---
app.post('/api/generate/video', async (req, res) => {
  const b = req.body || {};
  const store = await db.getStore(b.store_id);
  if (!store) return bad(res, 400, 'store_id が不正です');
  if (!b.form_slug) return bad(res, 400, 'form_slug（CTA先）が必要です');
  const ctaUrl = `${BASE}/f/${b.form_slug}`;
  const bt = await db.getBusinessType(store.business_type_id);
  const campaign = b.campaign_id ? await db.getCampaign(b.campaign_id) : null;

  // 入力画像を ffmpeg が読めるローカルパスに解決（Storage URLは一時DL）
  const images = [];
  if (Array.isArray(b.image_urls)) for (const u of b.image_urls) { const p = await resolveToLocal(u); if (p) images.push(p); }
  let captions = Array.isArray(b.captions) ? b.captions : [];
  if (captions.length === 0 && campaign) {
    captions = [campaign.title, campaign.detail, store.name].filter(Boolean);
  }

  // BGM: auto_bgm=false→無音 / bgm_url指定→それ / それ以外→store配下の先頭
  const autoBgm = b.auto_bgm !== false;
  let bgmPath = null;
  if (autoBgm) {
    if (b.bgm_url) bgmPath = await resolveToLocal(b.bgm_url);
    if (!bgmPath) { const list = await db.listAssets(store.id, 'bgm'); if (list[0]) bgmPath = await resolveToLocal(list[0].url); }
  }

  try {
    const { path, seconds, slides, bgm } = await generateSlideshow({
      storeId: store.id, brandColor: store.brand_color, ctaUrl,
      ctaLabel: bt?.cta_default_label || 'この店に今すぐ査定',
      images, captions, perSlide: Math.max(2, Math.min(8, Number(b.per_slide) || 4)),
      autoBgm, bgmPath,
    });
    // 出力動画を保存（Storage or ローカル）
    const rel = `${store.id}/videos/${randomUUID()}.mp4`;
    const url = await saveAssetFile(rel, readFileSync(path), 'video/mp4');
    try { rmSync(path, { force: true }); } catch {}
    const asset = await db.createAsset({ store_id: store.id, campaign_id: campaign?.id || null, kind: 'gen_video', url, meta: { seconds, slides, bgm, ctaUrl } });
    ok(res, { asset, videoUrl: asset.url, seconds, slides, bgm });
  } catch (e) {
    bad(res, 500, '動画生成に失敗しました: ' + (e.message || e));
  }
});

// --- 投稿先へ投稿（接続ごとに自動投稿を試みる。未対応/未接続はコピー扱い） ---
// body: { post_id, connection_id }
app.post('/api/publish-to', async (req, res) => {
  const b = req.body || {};
  const post = await db.getPost(b.post_id);
  if (!post) return bad(res, 400, 'post が見つかりません');
  if (await guardStore(req, res, post.store_id)) return;
  const conn = await db.getConnection(b.connection_id);
  if (!conn) return bad(res, 400, '投稿先が見つかりません');
  if (conn.store_id !== post.store_id) return bad(res, 400, '投稿先がこの店舗のものではありません');
  const store = await db.getStore(post.store_id);

  const result = await publishToChannel({ conn, post, store });
  // 自動投稿できたら post を published に更新（コピー扱いは copied のまま触らない）
  if (result.status === 'published') {
    await db.updatePostStatus(post.id, 'published', { external_ref: conn.channel, published_at: new Date().toISOString() });
  }
  // 投稿状態を記録（published/error。copyは自動対象外なので下の /mark-copied で手動記録する想定）
  await db.recordPublication({ post_id: post.id, connection_id: conn.id, status: result.status, detail: result.detail || null });
  ok(res, { result });
});
// 手動コピーした記録（自動非対応の投稿先へ人が貼った、を残す）
app.post('/api/publication/mark-copied', async (req, res) => {
  const b = req.body || {};
  const post = await db.getPost(b.post_id);
  const conn = await db.getConnection(b.connection_id);
  if (!post || !conn) return bad(res, 400, 'post または投稿先が不正です');
  if (await guardStore(req, res, post.store_id)) return;
  if (conn.store_id !== post.store_id) return bad(res, 400, '投稿先がこの店舗のものではありません');
  const rec = await db.recordPublication({ post_id: post.id, connection_id: conn.id, status: 'copied', detail: '手動コピー' });
  ok(res, { publication: rec });
});

// --- 配信（MVP: コピー扱い。公式API配信は後続フェーズ） ---
app.post('/api/publish', async (req, res) => {
  const b = req.body || {};
  const post = await db.getPost(b.post_id);
  if (!post) return bad(res, 400, 'post が見つかりません');
  if (await guardStore(req, res, post.store_id)) return;
  // MVP: 承認 → コピー方式（人が各SNSへ貼り付け）。公式API配信は Phase で追加。
  const updated = await db.updatePostStatus(post.id, 'copied', { published_at: new Date().toISOString() });
  ok(res, { post: updated, note: 'MVPでは承認＝コピー扱いです。本文をコピーして各SNSへ投稿してください。' });
});

// --- 公開フォーム（匿名アクセス） ---
app.get('/f/:slug', async (req, res) => {
  const form = await db.getLeadFormBySlug(req.params.slug);
  if (!form) return res.status(404).send('フォームが見つかりません');
  const store = await db.getStore(form.store_id);
  const bt = await db.getBusinessType(store.business_type_id);
  // QRは店舗常設。表示するキャンペーンは「その店舗のアクティブな最新」を自動選択（1枚刷れば貼り替え不要）。
  const campaign = await db.getActiveCampaign(store.id);
  // フォーム項目・写真枚数・either設定も店舗の最新設定を反映（発行時に固定しない）。
  const fields = await db.getSetting(store.id, 'form_config', form.fields || {});
  res.type('html').send(renderPublicForm({ form: { ...form, fields }, store, bt, campaign }));
});
app.post('/api/f/:slug/submit', async (req, res) => {
  const form = await db.getLeadFormBySlug(req.params.slug);
  if (!form) return bad(res, 404, 'フォームが見つかりません');
  const store = await db.getStore(form.store_id);
  const b = req.body || {};

  // フォーム項目は「店舗の最新設定」を優先（QRは店舗常設なので発行時のスナップショットに固定しない）。
  const cfg = await db.getSetting(store.id, 'form_config', form.fields || {});
  // 写真（dataURL配列）を保存して URL に変換
  const photoMin = Number(cfg.photo_min) || 0;
  const photos = Array.isArray(b.photos) ? b.photos : [];
  if (photoMin && photos.length < photoMin) return bad(res, 400, `写真は最低${photoMin}枚必要です`);
  // 電話/メールのどちらか必須（保険。クライアント検証と同じ）
  if (cfg.contact_either_required !== false) {
    const tel = (b.contact?.tel || '').trim();
    const email = (b.contact?.email || '').trim();
    if (!tel && !email) return bad(res, 400, '電話番号かメールアドレスのどちらか一方を入力してください');
  }
  const photoUrls = [];
  for (const p of photos.slice(0, Number(cfg.photo_max) || 10)) {
    const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(p || '');
    if (!m) continue;
    const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 12 * 1024 * 1024) continue;
    const fname = `${randomUUID()}.${ext}`;
    const rel = `${store.id}/submissions/${fname}`;
    if (storage.storageEnabled()) {
      // 応募写真=個人情報。非公開バケットへ。payloadには保存パスを記録し、閲覧時に署名URL化。
      const savedPath = await storage.uploadPrivate(rel, buf, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
      photoUrls.push(savedPath ? `storage:${savedPath}` : null);
    } else {
      const abs = join(__dirname, '..', '..', 'data', 'assets', rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, buf);
      photoUrls.push(`/assets/${rel}`);
    }
  }

  const payload = { contact: b.contact || {}, item: b.item || {}, photos: photoUrls.filter(Boolean) };
  const sub = await db.createSubmission({ lead_form_id: form.id, payload, utm: req.query || {} });

  // 送信先へ通知（メールはSMTP未設定のため記録のみ / LINE Notify / Webhook は送信）
  try { await notifyDelivery({ store, form, payload, submissionId: sub.id }); } catch (e) { console.error('notify error', e.message); }

  ok(res, { submission_id: sub.id, photos: photoUrls.length });
});
app.get('/api/forms/:id/submissions', async (req, res) => {
  const form = await db.getLeadForm(req.params.id);
  if (!form) return bad(res, 404, 'フォームが見つかりません');
  if (await guardStore(req, res, form.store_id)) return; // 応募は個人情報。店舗所有者のみ閲覧可。
  const subs = await db.listSubmissions(req.params.id);
  // 応募写真は非公開バケット。閲覧用に署名URL(1時間)へ変換（storage: プレフィックスのもの）。
  for (const s of subs) {
    const ph = s.payload?.photos;
    if (Array.isArray(ph)) {
      s.payload.photos = await Promise.all(ph.map(async u =>
        typeof u === 'string' && u.startsWith('storage:') ? (await storage.signedUrl(u.slice(8), 3600)) || u : u));
    }
  }
  ok(res, { submissions: subs });
});

// 応募通知: LINE Notify / Webhook に送る。メールは SMTP 未設定なのでサーバログに記録（将来 nodemailer）。
async function notifyDelivery({ store, form, payload, submissionId }) {
  const d = await db.getSetting(store.id, 'delivery', {});
  const base = process.env.PUBLIC_BASE_URL || BASE;
  const lines = [
    `【${store.name}】新しい査定申込`,
    `お名前: ${payload.contact?.name || ''} / TEL: ${payload.contact?.tel || ''} / Mail: ${payload.contact?.email || ''}`,
    `商品: ${payload.item?.item_name || ''}（状態:${payload.item?.condition || ''} 年式:${payload.item?.year || ''} 使用:${payload.item?.used_years || ''}）`,
    `コメント: ${payload.item?.comment || ''}`,
    `写真: ${(payload.photos || []).length}枚`,
    `詳細: ${base}/admin/submissions?form=${form.id}#${submissionId}`,
  ];
  const text = lines.join('\n');
  if (d.line_notify_token) {
    await fetch('https://notify-api.line.me/api/notify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${d.line_notify_token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ message: '\n' + text }),
    }).catch(() => {});
  }
  if (d.webhook_url) {
    await fetch(d.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store: store.name, payload, submissionId }) }).catch(() => {});
  }
  if (d.email) {
    if (mailerEnabled()) {
      const detailUrl = `${base}/admin/submissions?form=${form.id}#${submissionId}`;
      const okSent = await sendSubmissionNotice(d.email, {
        storeName: store.name, contact: payload.contact || {}, item: payload.item || {},
        photoCount: (payload.photos || []).length, detailUrl,
      });
      if (!okSent) console.error(`[メール通知] 送信失敗 to=${d.email}`);
    } else {
      // Resend未設定時は従来どおりログ記録（後方互換）
      console.log(`[メール送信先 ${d.email}] へ通知（RESEND_API_KEY未設定のため記録のみ）:\n${text}`);
    }
  }
}

// 公開フォームHTML（写真撮影+連絡先+商品情報。店舗別・キャンペーン反映・業態ライセンス表示）
function renderPublicForm({ form, store, bt, campaign }) {
  const cfg = form.fields || {};
  const contact = cfg.contact || [];
  const item = cfg.item || [];
  const pmin = Number(cfg.photo_min) || 0;
  const pmax = Number(cfg.photo_max) || 10;
  const eitherReq = cfg.contact_either_required !== false; // 電話/メールどちらか必須
  const licenseLines = bt.required_licenses
    .map(l => `${l.label}: ${store.license_values[l.key] || '（未登録）'}`).join(' / ');

  const renderField = (f, group) => {
    const name = `${group}.${f.key}`;
    // 電話/メールは「どちらか必須」時はHTML required を付けず、注記だけ出す（送信時にJS/サーバで検証）
    const isEither = eitherReq && group === 'contact' && (f.key === 'tel' || f.key === 'email');
    const note = isEither ? '（電話・メールのどちらか必須）' : (f.required ? ' *' : '');
    const req = f.required && !isEither ? 'required' : '';
    if (f.type === 'select') {
      const opts = (f.options || []).map(o => `<option value="${o}">${o}</option>`).join('');
      return `<label class="fld"><span>${f.label}${note}</span><select name="${name}" ${req}><option value="">選択してください</option>${opts}</select></label>`;
    }
    if (f.type === 'textarea') {
      return `<label class="fld"><span>${f.label}${note}</span><textarea name="${name}" rows="3" ${req}></textarea></label>`;
    }
    return `<label class="fld"><span>${f.label}${note}</span><input name="${name}" type="${f.type || 'text'}" ${req}></label>`;
  };
  const contactHtml = contact.map(f => renderField(f, 'contact')).join('');
  const itemHtml = item.map(f => renderField(f, 'item')).join('');

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${store.name}｜${bt.cta_default_label}</title>
<style>
:root{--bd:${store.brand_color || '#FFE600'};--bd-text:${contrastText(store.brand_color || '#FFE600')}}
body{font-family:system-ui,'Chip Text',sans-serif;margin:0;background:#F4F4F4;color:#161616}
.wrap{max-width:520px;margin:0 auto;padding:24px 16px}
.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 8px}h2{font-size:14px;margin:20px 0 6px;border-left:4px solid var(--bd);padding-left:8px}
.cp{background:var(--bd);color:var(--bd-text);padding:12px 14px;border-radius:12px;font-weight:700;margin:12px 0}
.fld{display:block;margin:12px 0}.fld span{display:block;font-size:13px;margin-bottom:4px}
.fld input,.fld select,.fld textarea{width:100%;box-sizing:border-box;padding:12px;border:1px solid #ddd;border-radius:10px;font-size:16px;font-family:inherit}
.photos{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.photos .ph{position:relative;width:72px;height:72px;border-radius:10px;overflow:hidden;background:#eee}
.photos .ph img{width:100%;height:100%;object-fit:cover}
.photos .ph button{position:absolute;top:-6px;right:-6px;width:22px;height:22px;padding:0;border-radius:9999px;background:#161616;color:#fff;font-size:12px}
.addph{display:inline-flex;align-items:center;justify-content:center;width:72px;height:72px;border:2px dashed #bbb;border-radius:10px;font-size:28px;color:#888;cursor:pointer}
.pcount{font-size:12px;color:#666}
button.submit{width:100%;padding:14px;border:0;border-radius:9999px;background:#161616;color:#fff;font-size:16px;font-weight:700;margin-top:16px;cursor:pointer}
.lic{font-size:11px;color:#888;margin-top:16px;line-height:1.6}
.done{text-align:center;padding:24px}
</style></head><body><div class="wrap"><div class="card">
<h1>${store.name}</h1>
${campaign ? `<div class="cp">🎁 ${campaign.title}${campaign.detail ? `<br><small style="font-weight:400">${campaign.detail}</small>` : ''}</div>` : ''}
<form id="f">
  <h2>お品物の写真（${pmin}〜${pmax}枚）</h2>
  <div class="pcount" id="pcount">0枚</div>
  <div class="photos" id="photos"></div>
  <label class="addph" id="addph">＋<input id="pfile" type="file" accept="image/*" capture="environment" multiple style="display:none"></label>
  <h2>お客様情報</h2>${contactHtml}
  <h2>商品情報</h2>${itemHtml}
  <button type="submit" class="submit">${bt.cta_default_label}</button>
</form>
<div class="lic">${store.area ? store.area + '｜' : ''}${store.tel ? 'TEL ' + store.tel + '｜' : ''}${licenseLines}</div>
</div></div>
<script>
const PMIN=${pmin}, PMAX=${pmax}, EITHER=${eitherReq};
const photos=[];
const $=id=>document.getElementById(id);
$('addph').addEventListener('click',()=>$('pfile').click());
$('pfile').addEventListener('change',async e=>{
  for(const f of [...e.target.files]){
    if(photos.length>=PMAX){alert('写真は最大'+PMAX+'枚です');break;}
    const url=await new Promise(r=>{const rd=new FileReader();rd.onload=()=>r(rd.result);rd.readAsDataURL(f);});
    photos.push(url);
  }
  e.target.value='';render();
});
function render(){
  $('photos').innerHTML=photos.map((u,i)=>'<div class="ph"><img src="'+u+'"><button type="button" onclick="rm('+i+')">×</button></div>').join('');
  $('pcount').textContent=photos.length+'枚'+(photos.length<PMIN?'（あと'+(PMIN-photos.length)+'枚必要）':'');
}
window.rm=i=>{photos.splice(i,1);render();};
function collect(prefix){const o={};document.querySelectorAll('[name^="'+prefix+'."]').forEach(el=>{o[el.name.split('.')[1]]=el.value;});return o;}
$('f').addEventListener('submit',async e=>{e.preventDefault();
  if(photos.length<PMIN){alert('写真を'+PMIN+'枚以上撮影/選択してください');return;}
  const contact=collect('contact');
  if(EITHER&&!(contact.tel||'').trim()&&!(contact.email||'').trim()){alert('電話番号かメールアドレスのどちらか一方を入力してください');return;}
  const body={contact,item:collect('item'),photos};
  const r=await fetch('/api/f/${form.public_slug}/submit'+location.search,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(r.ok){document.querySelector('.card').innerHTML='<div class="done"><h1>送信しました</h1><p>お問い合わせありがとうございます。店舗よりご連絡します。</p></div>';}
  else{const j=await r.json().catch(()=>({}));alert('送信に失敗しました: '+(j.error||''));}
});
render();
</script></body></html>`;
}

app.get('/api/health', async (req, res) => ok(res, { service: 'kaitori-marketing', base: BASE }));

// 起動: スキーマ適用（冪等）→ 業態マスタseed → listen → スケジューラ。
async function start() {
  await db.ensureSchema();
  try { await storage.ensureBuckets(); } catch (e) { console.error('Storageバケット作成', e.message); } // 公開/非公開バケット（冪等）
  if ((await db.listBusinessTypes()).length === 0) {
    await db.upsertBusinessType({
      id: 'kaitori', name: '買取店',
      required_licenses: [{ key: 'antique_dealer', label: '古物商許可番号', pattern: '^\\d{12}$', hint: '12桁の数字' }],
      cta_default_label: 'この店に今すぐ査定', form_kind_default: 'assessment',
    });
  }
  const server = app.listen(PORT, () => {
    console.log(`買取店マーケティングシステム 起動: ${BASE}`);
    console.log(`Claude: ${process.env.ANTHROPIC_API_KEY ? '有効' : '未設定（記事はテンプレ生成）'}`);
    console.log(`認証: ${authEnabled() ? 'ON（Supabase）' : 'OFF（local）'}`);
    startScheduler(); // 記事の自動生成スケジューラ（アプリ起動中のみ稼働）
  });
  // 二重起動（ショートカット再クリック等）は静かに終了。launch.vbs 側はブラウザだけ開く。
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.log(`ポート${PORT}は既に使用中です（起動済み）。終了します。`); process.exit(0); }
    else { console.error(e); process.exit(1); }
  });
}
start().catch(e => { console.error('起動失敗:', e); process.exit(1); });
