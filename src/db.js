// データ層。Supabase(Postgres) 版。全関数 async（呼び出し側は await）。
// スキーマは db/schema.sql（起動時に ensureSchema() で冪等適用）。
// JSON列は TEXT に文字列で保存（J.parse/J.str で読み書き。SQLite版と同じ挙動）。
// boolean的用途(active/auto_publish/enabled)は INTEGER(0/1)。日時は TEXT(ISO文字列)。
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const connectionString = process.env.DATABASE_URL || '';
if (!connectionString) {
  console.error('[db] DATABASE_URL が未設定です。Supabase の接続文字列を .env に設定してください。');
}
// Supabase は SSL 必須。self-signed 対策で rejectUnauthorized:false。
const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
});

// クエリヘルパ。q(sql, [params]) -> { rows }
async function q(sql, params = []) { return pool.query(sql, params); }
const one = async (sql, params) => (await q(sql, params)).rows[0] ?? null;
const all = async (sql, params) => (await q(sql, params)).rows;

const now = () => new Date().toISOString();
const uid = () => randomUUID();
const J = {
  parse: (s, fb) => { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? fb); } catch { return fb; } },
  str: (o) => JSON.stringify(o ?? null),
};
const numify = (r) => (r == null ? 0 : Number(r)); // COUNT(*) は bigint→文字列で返るため

// スキーマ適用（冪等）。サーバ起動前に await する。
export async function ensureSchema() {
  const sql = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// --- business_type ---
export async function upsertBusinessType(bt) {
  await q(`INSERT INTO business_type (id,name,required_licenses,cta_default_label,form_kind_default)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, required_licenses=excluded.required_licenses,
      cta_default_label=excluded.cta_default_label, form_kind_default=excluded.form_kind_default`,
    [bt.id, bt.name, J.str(bt.required_licenses ?? []), bt.cta_default_label ?? '詳しくはこちら', bt.form_kind_default ?? 'contact']);
  return getBusinessType(bt.id);
}
export async function getBusinessType(id) {
  const r = await one('SELECT * FROM business_type WHERE id=$1', [id]);
  if (!r) return null;
  return { ...r, required_licenses: J.parse(r.required_licenses, []) };
}
export async function listBusinessTypes() {
  return (await all('SELECT * FROM business_type ORDER BY id')).map(r => ({ ...r, required_licenses: J.parse(r.required_licenses, []) }));
}
// 業種を使っている店舗数（削除ガード用）。
export async function countStoresByBusinessType(id) {
  const r = await one('SELECT COUNT(*)::int AS n FROM store WHERE business_type_id=$1', [id]);
  return r?.n ?? 0;
}
export async function deleteBusinessType(id) {
  await q('DELETE FROM business_type WHERE id=$1', [id]);
}

// --- option_set（管理者が編集する汎用の選択肢マスタ） ---
export async function listOptions(category) {
  const rows = category
    ? await all('SELECT * FROM option_set WHERE category=$1 ORDER BY sort_order, label', [category])
    : await all('SELECT * FROM option_set ORDER BY category, sort_order, label');
  return rows;
}
export async function upsertOption(o) {
  const id = o.id || uid();
  await q(`INSERT INTO option_set (id,category,key,label,sort_order,created_at) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT(id) DO UPDATE SET category=excluded.category, key=excluded.key, label=excluded.label, sort_order=excluded.sort_order`,
    [id, o.category, o.key, o.label, Number(o.sort_order) || 0, now()]);
  return one('SELECT * FROM option_set WHERE id=$1', [id]);
}
export async function deleteOption(id) {
  await q('DELETE FROM option_set WHERE id=$1', [id]);
}

// --- store ---
export async function createStore(s) {
  const id = uid();
  await q(`INSERT INTO store (id,owner_id,business_type_id,name,license_values,address,tel,area,logo_url,brand_color,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, s.owner_id ?? null, s.business_type_id, s.name, J.str(s.license_values ?? {}),
     s.address ?? null, s.tel ?? null, s.area ?? null, s.logo_url ?? null, s.brand_color ?? '#FFE600', now()]);
  return getStore(id);
}
export async function getStore(id) {
  const r = await one('SELECT * FROM store WHERE id=$1', [id]);
  if (!r) return null;
  return { ...r, license_values: J.parse(r.license_values, {}) };
}
export async function updateStore(id, s) {
  const cur = await getStore(id);
  if (!cur) return null;
  const next = {
    name: s.name ?? cur.name,
    business_type_id: s.business_type_id ?? cur.business_type_id,
    license_values: s.license_values ?? cur.license_values,
    address: s.address ?? cur.address,
    tel: s.tel ?? cur.tel,
    area: s.area ?? cur.area,
    logo_url: s.logo_url ?? cur.logo_url,
    brand_color: s.brand_color ?? cur.brand_color,
  };
  await q(`UPDATE store SET name=$1, business_type_id=$2, license_values=$3, address=$4, tel=$5, area=$6, logo_url=$7, brand_color=$8 WHERE id=$9`,
    [next.name, next.business_type_id, J.str(next.license_values), next.address, next.tel, next.area, next.logo_url, next.brand_color, id]);
  return getStore(id);
}
export async function listStores(owner) {
  const rows = owner
    ? await all('SELECT * FROM store WHERE owner_id=$1 ORDER BY created_at DESC', [owner])
    : await all('SELECT * FROM store ORDER BY created_at DESC');
  return rows.map(r => ({ ...r, license_values: J.parse(r.license_values, {}) }));
}
export async function storeRelationCounts(storeId) {
  const c = async t => numify((await one(`SELECT COUNT(*) n FROM ${t} WHERE store_id=$1`, [storeId])).n);
  const submissions = numify((await one(
    `SELECT COUNT(*) n FROM lead_submission ls JOIN lead_form lf ON lf.id=ls.lead_form_id WHERE lf.store_id=$1`, [storeId])).n);
  return {
    campaigns: await c('campaign'), forms: await c('lead_form'), posts: await c('post'),
    assets: await c('asset'), submissions, articles: await c('article'),
  };
}
export async function deleteStoreIfEmpty(storeId) {
  const n = await storeRelationCounts(storeId);
  const total = n.campaigns + n.forms + n.posts + n.assets + n.submissions + (n.articles || 0);
  if (total > 0) return { deleted: false, counts: n };
  await q('DELETE FROM store_setting WHERE store_id=$1', [storeId]);
  await q('DELETE FROM store WHERE id=$1', [storeId]);
  return { deleted: true, counts: n };
}
export async function deleteStoreCascade(storeId) {
  const counts = await storeRelationCounts(storeId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM lead_submission WHERE lead_form_id IN (SELECT id FROM lead_form WHERE store_id=$1)`, [storeId]);
    await client.query(`DELETE FROM post_publication WHERE post_id IN (SELECT id FROM post WHERE store_id=$1)`, [storeId]);
    await client.query('DELETE FROM post WHERE store_id=$1', [storeId]);
    await client.query('DELETE FROM asset WHERE store_id=$1', [storeId]);
    await client.query('DELETE FROM campaign WHERE store_id=$1', [storeId]);
    await client.query('DELETE FROM lead_form WHERE store_id=$1', [storeId]);
    await client.query('DELETE FROM channel_connection WHERE store_id=$1', [storeId]);
    await client.query('DELETE FROM article WHERE store_id=$1', [storeId]);
    await client.query('DELETE FROM article_schedule WHERE store_id=$1', [storeId]);
    await client.query('DELETE FROM store_setting WHERE store_id=$1', [storeId]);
    await client.query('DELETE FROM store WHERE id=$1', [storeId]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return { deleted: true, counts };
}

// --- campaign ---
export async function createCampaign(c) {
  const id = uid();
  await q(`INSERT INTO campaign (id,store_id,lead_form_id,title,detail,discount_type,valid_from,valid_to,active,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, c.store_id, c.lead_form_id ?? null, c.title, c.detail ?? null, c.discount_type ?? null,
     c.valid_from ?? null, c.valid_to ?? null, c.active === false ? 0 : 1, now()]);
  return getCampaign(id);
}
export async function getCampaign(id) { return one('SELECT * FROM campaign WHERE id=$1', [id]); }
export async function listCampaigns(storeId) {
  return storeId
    ? all('SELECT * FROM campaign WHERE store_id=$1 ORDER BY created_at DESC', [storeId])
    : all('SELECT * FROM campaign ORDER BY created_at DESC');
}
export async function getActiveCampaign(storeId) {
  const today = new Date().toISOString().slice(0, 10);
  return one(`SELECT * FROM campaign WHERE store_id=$1 AND active=1
      AND (valid_to IS NULL OR valid_to >= $2)
      ORDER BY created_at DESC LIMIT 1`, [storeId, today]);
}

// --- lead_form ---
export async function createLeadForm(f) {
  const id = uid();
  const slug = f.public_slug || Math.random().toString(36).slice(2, 8);
  await q(`INSERT INTO lead_form (id,store_id,label,kind,fields,public_slug,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, f.store_id, f.label ?? 'お問い合わせフォーム', f.kind ?? 'contact', J.str(f.fields ?? {}), slug, now()]);
  return getLeadForm(id);
}
export async function getLeadForm(id) {
  const r = await one('SELECT * FROM lead_form WHERE id=$1', [id]);
  if (!r) return null;
  return { ...r, fields: J.parse(r.fields, {}) };
}
export async function getLeadFormBySlug(slug) {
  const r = await one('SELECT * FROM lead_form WHERE public_slug=$1', [slug]);
  if (!r) return null;
  return { ...r, fields: J.parse(r.fields, {}) };
}
export async function updateLeadForm(id, f) {
  const cur = await getLeadForm(id);
  if (!cur) return null;
  await q('UPDATE lead_form SET label=$1, kind=$2, fields=$3 WHERE id=$4',
    [f.label ?? cur.label, f.kind ?? cur.kind, J.str(f.fields ?? cur.fields), id]);
  return getLeadForm(id);
}
export async function listLeadForms(storeId) {
  return (await all('SELECT * FROM lead_form WHERE store_id=$1 ORDER BY created_at DESC', [storeId]))
    .map(r => ({ ...r, fields: J.parse(r.fields, {}) }));
}

// --- lead_submission ---
export async function createSubmission(s) {
  const id = uid();
  await q(`INSERT INTO lead_submission (id,lead_form_id,payload,utm,created_at) VALUES ($1,$2,$3,$4,$5)`,
    [id, s.lead_form_id, J.str(s.payload ?? {}), J.str(s.utm ?? {}), now()]);
  return one('SELECT * FROM lead_submission WHERE id=$1', [id]);
}
export async function listSubmissions(leadFormId) {
  return (await all('SELECT * FROM lead_submission WHERE lead_form_id=$1 ORDER BY created_at DESC', [leadFormId]))
    .map(r => ({ ...r, payload: J.parse(r.payload, {}), utm: J.parse(r.utm, {}) }));
}

// --- post ---
export async function createPost(p) {
  const id = uid();
  await q(`INSERT INTO post (id,store_id,campaign_id,channel,body,video_asset_id,status,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, p.store_id, p.campaign_id ?? null, p.channel, p.body ?? null, p.video_asset_id ?? null, p.status ?? 'draft', now()]);
  return getPost(id);
}
export async function getPost(id) { return one('SELECT * FROM post WHERE id=$1', [id]); }
export async function updatePostStatus(id, status, extra = {}) {
  await q('UPDATE post SET status=$1, external_ref=COALESCE($2,external_ref), published_at=COALESCE($3,published_at) WHERE id=$4',
    [status, extra.external_ref ?? null, extra.published_at ?? null, id]);
  return getPost(id);
}
export async function updatePostBody(id, body) {
  await q('UPDATE post SET body=$1 WHERE id=$2', [body, id]);
  return getPost(id);
}
export async function listPosts(storeId) {
  return all('SELECT * FROM post WHERE store_id=$1 ORDER BY created_at DESC', [storeId]);
}
export async function listPostsByCampaign(campaignId) {
  return all('SELECT * FROM post WHERE campaign_id=$1 ORDER BY created_at DESC', [campaignId]);
}

// --- asset ---
export async function createAsset(a) {
  const id = uid();
  await q(`INSERT INTO asset (id,store_id,campaign_id,kind,url,meta,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, a.store_id, a.campaign_id ?? null, a.kind, a.url, J.str(a.meta ?? {}), now()]);
  return getAsset(id);
}
export async function getAsset(id) {
  const r = await one('SELECT * FROM asset WHERE id=$1', [id]);
  if (!r) return null;
  return { ...r, meta: J.parse(r.meta, {}) };
}
export async function listAssets(storeId, kind) {
  const rows = kind
    ? await all('SELECT * FROM asset WHERE store_id=$1 AND kind=$2 ORDER BY created_at DESC', [storeId, kind])
    : await all('SELECT * FROM asset WHERE store_id=$1 ORDER BY created_at DESC', [storeId]);
  return rows.map(r => ({ ...r, meta: J.parse(r.meta, {}) }));
}
export async function listAssetsByCampaign(campaignId, kind) {
  const rows = kind
    ? await all('SELECT * FROM asset WHERE campaign_id=$1 AND kind=$2 ORDER BY created_at DESC', [campaignId, kind])
    : await all('SELECT * FROM asset WHERE campaign_id=$1 ORDER BY created_at DESC', [campaignId]);
  return rows.map(r => ({ ...r, meta: J.parse(r.meta, {}) }));
}

// --- channel_connection ---
function mapConn(r) {
  if (!r) return null;
  return { id: r.id, store_id: r.store_id, channel: r.channel, label: r.label || '',
    auto_config: J.parse(r.auto_config, {}), manual_config: J.parse(r.manual_config, {}),
    auto_publish: !!r.auto_publish, created_at: r.created_at };
}
export async function createConnection(c) {
  const id = uid();
  await q(`INSERT INTO channel_connection (id,store_id,channel,label,auto_config,manual_config,auto_publish,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, c.store_id, c.channel, c.label ?? null, J.str(c.auto_config ?? {}), J.str(c.manual_config ?? {}), c.auto_publish ? 1 : 0, now()]);
  return getConnection(id);
}
export async function getConnection(id) { return mapConn(await one('SELECT * FROM channel_connection WHERE id=$1', [id])); }
export async function listConnections(storeId) {
  return (await all('SELECT * FROM channel_connection WHERE store_id=$1 ORDER BY created_at', [storeId])).map(mapConn);
}
export async function updateConnection(id, c) {
  const cur = await getConnection(id);
  if (!cur) return null;
  await q(`UPDATE channel_connection SET label=$1, auto_config=$2, manual_config=$3, auto_publish=$4 WHERE id=$5`,
    [c.label ?? cur.label, J.str(c.auto_config ?? cur.auto_config), J.str(c.manual_config ?? cur.manual_config),
     (c.auto_publish ?? cur.auto_publish) ? 1 : 0, id]);
  return getConnection(id);
}
export async function deleteConnection(id) { await q('DELETE FROM channel_connection WHERE id=$1', [id]); return { deleted: true }; }

// --- post_publication ---
export async function recordPublication(p) {
  const id = uid();
  await q(`INSERT INTO post_publication (id,post_id,connection_id,status,detail,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, p.post_id, p.connection_id, p.status, p.detail ?? null, now()]);
  return one('SELECT * FROM post_publication WHERE id=$1', [id]);
}
export async function listPublicationsByCampaign(campaignId) {
  return all(`SELECT pp.* FROM post_publication pp
    JOIN post p ON p.id = pp.post_id
    WHERE p.campaign_id = $1
    ORDER BY pp.created_at DESC`, [campaignId]);
}
export async function listPublicationsByPost(postId) {
  return all('SELECT * FROM post_publication WHERE post_id=$1 ORDER BY created_at DESC', [postId]);
}

// --- article ---
export async function createArticle(a) {
  const id = uid(); const t = now();
  await q(`INSERT INTO article (id,store_id,title,body,theme,source,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, a.store_id, a.title ?? null, a.body ?? '', a.theme ?? null, a.source ?? 'manual', a.status ?? 'draft', t, t]);
  return getArticle(id);
}
export async function getArticle(id) { return one('SELECT * FROM article WHERE id=$1', [id]); }
export async function listArticles(storeId) {
  return all('SELECT * FROM article WHERE store_id=$1 ORDER BY updated_at DESC', [storeId]);
}
export async function updateArticle(id, a) {
  const cur = await getArticle(id);
  if (!cur) return null;
  await q(`UPDATE article SET title=$1, body=$2, theme=$3, status=$4, updated_at=$5 WHERE id=$6`,
    [a.title ?? cur.title, a.body ?? cur.body, a.theme ?? cur.theme, a.status ?? cur.status, now(), id]);
  return getArticle(id);
}
export async function deleteArticle(id) { await q('DELETE FROM article WHERE id=$1', [id]); return { deleted: true }; }

// --- article_schedule ---
export async function createSchedule(s) {
  const id = uid();
  await q(`INSERT INTO article_schedule (id,store_id,theme,frequency,at_time,weekday,enabled,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, s.store_id, s.theme, s.frequency ?? 'daily', s.at_time ?? '09:00',
     s.weekday ?? null, s.enabled === false ? 0 : 1, now()]);
  return getSchedule(id);
}
export async function getSchedule(id) {
  const r = await one('SELECT * FROM article_schedule WHERE id=$1', [id]);
  return r ? { ...r, enabled: !!r.enabled } : null;
}
export async function listSchedules(storeId) {
  return (await all('SELECT * FROM article_schedule WHERE store_id=$1 ORDER BY created_at', [storeId])).map(r => ({ ...r, enabled: !!r.enabled }));
}
export async function listAllEnabledSchedules() {
  return (await all('SELECT * FROM article_schedule WHERE enabled=1')).map(r => ({ ...r, enabled: true }));
}
export async function updateSchedule(id, s) {
  const cur = await getSchedule(id);
  if (!cur) return null;
  await q(`UPDATE article_schedule SET theme=$1, frequency=$2, at_time=$3, weekday=$4, enabled=$5 WHERE id=$6`,
    [s.theme ?? cur.theme, s.frequency ?? cur.frequency, s.at_time ?? cur.at_time,
     s.weekday ?? cur.weekday, (s.enabled ?? cur.enabled) ? 1 : 0, id]);
  return getSchedule(id);
}
export async function markScheduleRun(id) { await q('UPDATE article_schedule SET last_run_at=$1 WHERE id=$2', [now(), id]); }
export async function deleteSchedule(id) { await q('DELETE FROM article_schedule WHERE id=$1', [id]); return { deleted: true }; }

// --- store_setting (KV, JSON) ---
export async function getSetting(storeId, key, fallback = null) {
  const r = await one('SELECT value FROM store_setting WHERE store_id=$1 AND key=$2', [storeId, key]);
  return r ? J.parse(r.value, fallback) : fallback;
}
export async function setSetting(storeId, key, value) {
  await q(`INSERT INTO store_setting (store_id,key,value) VALUES ($1,$2,$3)
    ON CONFLICT(store_id,key) DO UPDATE SET value=excluded.value`, [storeId, key, J.str(value)]);
  return getSetting(storeId, key);
}

export default pool;
