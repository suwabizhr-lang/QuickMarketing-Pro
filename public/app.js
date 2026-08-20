// フロント。横メニュー3ビュー(生成/一覧/登録) + ヘッダーの作業店舗セレクタ常設。
// 店舗もQR/URLも複数登録可。キャンペーンは「使うQR(lead_form_id)」を選んで作成。
const $ = id => document.getElementById(id);
// state.store=作業対象の店舗 / state.campaign=直近作成CP / state.forms=その店舗のQR一覧 / state.images=動画素材
const state = { store: null, campaign: null, forms: [], images: [] };

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function fileToDataUrl(f) { return new Promise((rs, rj) => { const r = new FileReader(); r.onload = () => rs(r.result); r.onerror = rj; r.readAsDataURL(f); }); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtDate(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('ja-JP'); }

let CHANNELS = [];
let TYPES = [];
let DRIVERS = []; // 投稿先ドライバ定義（自動/手動フォームの描画に使う）
let AD_FORMATS = []; // 広告フォーマット定義

// ===== 初期化 =====
(async function init() {
  try {
    const bt = await api('/api/business-types'); TYPES = bt.types;
    $('s_bt').innerHTML = TYPES.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    renderLicenses();
    $('s_bt').addEventListener('change', renderLicenses);

    const c = await api('/api/channels'); CHANNELS = c.channels;
    $('ch_boxes').innerHTML = CHANNELS.map(ch =>
      `<label class="chk"><input type="checkbox" value="${ch.key}" ${ch.key === 'instagram' || ch.key === 'x' ? 'checked' : ''}> ${escapeHtml(ch.label)}</label>`).join('');

    const dv = await api('/api/channel-drivers'); DRIVERS = dv.drivers;
    $('cn_driver').innerHTML = DRIVERS.map(d => {
      const tag = d.auto?.status === 'ready' ? '（自動投稿◎）' : d.auto?.status === 'planned' ? '（自動は準備中）' : '（手動のみ）';
      return `<option value="${d.key}">${escapeHtml(d.label)}${tag}</option>`;
    }).join('');
    $('cn_driver').addEventListener('change', renderConnectionForm);
    renderConnectionForm();

    $('sc_freq').addEventListener('change', () => { $('sc_wdaybox').style.display = $('sc_freq').value === 'weekly' ? 'block' : 'none'; });
    $('avd_logo').addEventListener('change', () => { $('avd_logobox').style.display = $('avd_logo').checked ? 'flex' : 'none'; });

    const af = await api('/api/ad-formats'); AD_FORMATS = af.formats;
    $('ad_medias').innerHTML = AD_FORMATS.map(f =>
      `<label class="chk"><input type="checkbox" value="${f.key}" ${f.key === 'instagram' ? 'checked' : ''}> ${escapeHtml(f.label)}</label>`).join('');

    // 広告動画: テンプレート(型)と比率
    const avt = await api('/api/ad-video/templates');
    $('avd_template').innerHTML = avt.templates.map(t => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join('');
    $('avd_aspect').innerHTML = avt.aspects.map(a =>
      `<option value="${a.key}" ${a.status !== 'ready' ? 'disabled' : ''}>${escapeHtml(a.label)}${a.status !== 'ready' ? '（準備中）' : ''}</option>`).join('');
    $('avd_transition').innerHTML = (avt.transitions || []).map(t => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join('');

    $('pb_campaign').addEventListener('change', () => loadPublishBoard($('pb_campaign').value));

    $('nav').addEventListener('change', () => setView($('nav').value));
    $('storeSel').addEventListener('change', onPickStore);

    await loadStores();
    // 前回選んでいた店舗を復元（保存されていて、まだ存在すれば）
    const saved = localStorage.getItem('kaitori.store');
    if (saved && (state.stores || []).some(s => s.id === saved)) {
      $('storeSel').value = saved;
      await onPickStore();
    }
    setView('gen'); // 初期はキャンペーン生成
  } catch (e) { console.error(e); }
})();

// ===== ビュー切替 =====
function setView(name) {
  ['reg', 'gen', 'post', 'list', 'article', 'ad'].forEach(v => $('view-' + v).classList.toggle('on', v === name));
  $('nav').value = name;
  if (name === 'reg') { renderRegStores(); renderRegForms(); }
  if (name === 'gen') refreshGenView();
  if (name === 'post') refreshPostView();
  if (name === 'list') loadCampaignList();
  if (name === 'article') refreshArticleView();
  if (name === 'ad') refreshAdView();
}

// ===== 店舗セレクタ（ヘッダー・全ビュー共有） =====
async function loadStores() {
  const { stores } = await api('/api/stores');
  state.stores = stores;
  const cur = state.store?.id || '';
  $('storeSel').innerHTML = `<option value="">（店舗を選択）</option>` +
    stores.map(s => `<option value="${s.id}">${escapeHtml(s.name)}${s.area ? '（' + escapeHtml(s.area) + '）' : ''}</option>`).join('');
  if (cur && stores.some(s => s.id === cur)) $('storeSel').value = cur;
}

async function onPickStore() {
  const id = $('storeSel').value;
  if (!id) { state.store = null; state.forms = []; localStorage.removeItem('kaitori.store'); $('s_delbox').style.display = 'none'; afterStoreChange(); return; }
  try {
    const { store } = await api('/api/store/' + id);
    state.store = store;
    localStorage.setItem('kaitori.store', store.id); // 作業対象を記憶（次回自動復元）
    fillStoreForm(store);
    $('s_save').textContent = 'この店舗を更新';
    $('s_delbox').style.display = 'inline';
    $('s_out').style.display = 'block'; $('s_out').textContent = `✏ 「${store.name}」を選択中（登録ビューで編集して更新できます）`;
    await Promise.all([loadForms(), loadBgm(), loadFormConfig(), loadDelivery()]);
    afterStoreChange();
  } catch (e) { alert('店舗の読込エラー: ' + e.message); }
}

// 店舗が変わった/選ばれた後に各ビューを再描画
function afterStoreChange() {
  renderRegForms();
  loadConnections();
  refreshGenView();
  fillCampaignFormSelect();
  if ($('view-list').classList.contains('on')) loadCampaignList();
  if ($('view-article').classList.contains('on')) refreshArticleView();
  if ($('view-ad').classList.contains('on')) refreshAdView();
  if ($('view-post').classList.contains('on')) refreshPostView();
}

// ===== 登録ビュー：店舗 =====
function fillStoreForm(store) {
  $('s_bt').value = store.business_type_id; renderLicenses();
  $('s_name').value = store.name || '';
  $('s_area').value = store.area || '';
  $('s_tel').value = store.tel || '';
  $('s_color').value = store.brand_color || '#FFE600';
  const bt = TYPES.find(t => t.id === store.business_type_id);
  (bt?.required_licenses || []).forEach(l => { const el = $('lic_' + l.key); if (el) el.value = (store.license_values || {})[l.key] || ''; });
}
function newStore() {
  state.store = null; state.forms = [];
  localStorage.removeItem('kaitori.store');
  $('storeSel').value = '';
  $('s_name').value = ''; $('s_area').value = ''; $('s_tel').value = ''; $('s_color').value = '#FFE600';
  renderLicenses();
  $('s_save').textContent = '店舗を作成';
  $('s_delbox').style.display = 'none';
  $('s_out').style.display = 'none';
  setView('reg');
  afterStoreChange();
}
// 店舗削除。cascade=false は安全削除（関連が残っていれば拒否）、true は関連ごと全削除（確認あり）。
async function deleteStore(cascade) {
  if (!requireStore()) return;
  const id = state.store.id, nm = state.store.name;
  try {
    const { counts } = await api(`/api/store/${id}/relations`);
    const total = counts.campaigns + counts.forms + counts.posts + counts.assets + counts.submissions;
    if (!cascade) {
      if (total > 0) {
        alert(`「${nm}」には関連データが残っているため削除できません。\n` +
          `キャンペーン${counts.campaigns} / QR${counts.forms} / 記事${counts.posts} / 動画・画像${counts.assets} / 応募${counts.submissions}\n` +
          `関連ごと消す場合は「関連ごとすべて削除」を使ってください。`);
        return;
      }
      if (!confirm(`「${nm}」を削除します。よろしいですか？`)) return;
    } else {
      const msg = total > 0
        ? `「${nm}」と関連データをすべて削除します。元に戻せません。\n` +
          `キャンペーン${counts.campaigns} / QR${counts.forms} / 記事${counts.posts} / 動画・画像${counts.assets} / 応募${counts.submissions}\n本当に削除しますか？`
        : `「${nm}」を削除します。よろしいですか？`;
      if (!confirm(msg)) return;
    }
    await api(`/api/store/${id}${cascade ? '?cascade=1' : ''}`, 'DELETE');
    localStorage.removeItem('kaitori.store');
    state.store = null; state.forms = [];
    await loadStores();
    newStore();               // フォームを初期化（削除ボックスも隠れる）
    renderRegStores();
    alert(`「${nm}」を削除しました。`);
  } catch (e) { alert('削除エラー: ' + e.message); }
}

// ===== 投稿先（チャネル接続） =====
const curDriver = () => DRIVERS.find(d => d.key === $('cn_driver').value);
// 選択中ドライバの自動/手動フォームを自動描画（値を持たせたいときは cfgAuto/cfgManual を渡す）
function renderConnectionForm(cfgAuto = {}, cfgManual = {}) {
  const d = curDriver(); if (!d) return;
  const fieldHtml = (f, group) => {
    const id = `cn_${group}_${f.key}`;
    const val = escapeHtml((group === 'auto' ? cfgAuto : cfgManual)[f.key] || '');
    const req = f.required ? ' *' : '';
    if (f.type === 'select') {
      const opts = (f.options || []).map(o => `<option value="${o}" ${val === o ? 'selected' : ''}>${o}</option>`).join('');
      return `<label>${escapeHtml(f.label)}${req}</label><select id="${id}"><option value="">選択</option>${opts}</select>`;
    }
    if (f.type === 'textarea') return `<label>${escapeHtml(f.label)}${req}</label><textarea id="${id}" rows="2">${val}</textarea>`;
    const t = f.type === 'password' ? 'password' : (f.type === 'url' ? 'url' : 'text');
    return `<label>${escapeHtml(f.label)}${req}${f.hint ? ` <span class="muted">(${escapeHtml(f.hint)})</span>` : ''}</label><input id="${id}" type="${t}" value="${val}">`;
  };
  const autoFields = d.auto?.fields || [];
  const manualFields = d.manual?.fields || [];
  const statusTxt = d.auto?.status === 'ready' ? '自動投稿できます' : d.auto?.status === 'planned' ? '自動投稿は準備中です（今は手動でご利用ください）' : '自動投稿は非対応です（手動のみ）';
  $('cn_autobox').innerHTML = `<h3>自動投稿用（${escapeHtml(statusTxt)}）</h3>` +
    (d.auto?.note ? `<p class="muted">${escapeHtml(d.auto.note)}</p>` : '') +
    (autoFields.length ? autoFields.map(f => fieldHtml(f, 'auto')).join('') : '<p class="muted">この投稿先に自動投稿用の入力はありません。</p>');
  $('cn_manualbox').innerHTML = `<h3>手動投稿用</h3>` +
    (manualFields.length ? manualFields.map(f => fieldHtml(f, 'manual')).join('') : '<p class="muted">手動投稿用の入力はありません。</p>');
  // 自動非対応ならトグルは無効化
  $('cn_auto').disabled = d.auto?.status !== 'ready';
  if (d.auto?.status !== 'ready') $('cn_auto').checked = false;
}
function collectConnectionForm() {
  const d = curDriver();
  const grab = (f, group) => { const el = $(`cn_${group}_${f.key}`); return el ? el.value.trim() : ''; };
  const auto = {}; (d.auto?.fields || []).forEach(f => auto[f.key] = grab(f, 'auto'));
  const manual = {}; (d.manual?.fields || []).forEach(f => manual[f.key] = grab(f, 'manual'));
  return { auto, manual };
}
async function saveConnection() {
  if (!requireStore()) return;
  const d = curDriver(); if (!d) return;
  const { auto, manual } = collectConnectionForm();
  try {
    const editId = $('cn_out').dataset.editId;
    if (editId) {
      await api('/api/connection/' + editId, 'POST', { label: $('cn_label').value.trim(), auto_config: auto, manual_config: manual, auto_publish: $('cn_auto').checked });
      delete $('cn_out').dataset.editId;
    } else {
      await api('/api/connection', 'POST', { store_id: state.store.id, channel: d.key, label: $('cn_label').value.trim(), auto_config: auto, manual_config: manual, auto_publish: $('cn_auto').checked });
    }
    $('cn_out').style.display = 'block'; $('cn_out').textContent = `✅ 投稿先を保存しました（${d.label}）`;
    resetConnectionForm();
    await loadConnections();
  } catch (e) { alert('投稿先の保存エラー: ' + e.message); }
}
function resetConnectionForm() {
  $('cn_label').value = ''; $('cn_auto').checked = false;
  delete $('cn_out').dataset.editId;
  renderConnectionForm();
}
async function loadConnections() {
  if (!state.store) { $('cn_list').innerHTML = '<li class="muted">店舗を選択すると表示します。</li>'; return; }
  try {
    const { connections } = await api(`/api/stores/${state.store.id}/connections`);
    state.connections = connections;
    $('cn_list').innerHTML = connections.length ? connections.map(c => {
      const badge = c.auto_status === 'ready' ? (c.auto_publish ? '自動投稿ON' : '自動投稿OFF') : (c.auto_status === 'planned' ? '自動は準備中' : '手動のみ');
      return `<li><div class="main"><b>${escapeHtml(c.label || c.driver_label)}</b>
        <div class="sub">${escapeHtml(c.driver_label)}｜<span class="pill">${badge}</span></div></div>
        <button class="sm ghost" onclick="editConnection('${c.id}')">編集</button>
        <button class="sm" style="background:#c0392b" onclick="deleteConnection('${c.id}')">削除</button></li>`;
    }).join('') : '<li class="muted">まだ投稿先がありません。上で登録してください。</li>';
  } catch { $('cn_list').innerHTML = '<li class="muted">読込エラー</li>'; }
}
function editConnection(id) {
  const c = (state.connections || []).find(x => x.id === id); if (!c) return;
  $('cn_driver').value = c.channel;
  $('cn_label').value = c.label || '';
  renderConnectionForm(c.auto_config, c.manual_config); // マスク値はそのまま表示（保存時はサーバが既存維持）
  $('cn_auto').checked = !!c.auto_publish;
  $('cn_out').dataset.editId = id;
  $('cn_out').style.display = 'block'; $('cn_out').textContent = `✏ 「${c.label || c.driver_label}」を編集中`;
  $('cn_driver').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function deleteConnection(id) {
  const c = (state.connections || []).find(x => x.id === id);
  if (!confirm(`投稿先「${c?.label || c?.driver_label || ''}」を削除しますか？`)) return;
  try { await api('/api/connection/' + id, 'DELETE'); await loadConnections(); }
  catch (e) { alert('削除エラー: ' + e.message); }
}

function renderLicenses() {
  const bt = TYPES.find(t => t.id === $('s_bt').value);
  $('s_licenses').innerHTML = (bt?.required_licenses || []).map(l =>
    `<label>${escapeHtml(l.label)}${l.hint ? `（${escapeHtml(l.hint)}）` : ''} *</label><input id="lic_${l.key}" placeholder="${escapeHtml(l.hint || '')}">`).join('');
}
// 店舗ロゴのアップロード（動画に合成）。店舗が保存済みである必要あり。
async function uploadLogo() {
  if (!state.store) { alert('先に店舗を作成/選択してください'); $('s_logo').value = ''; return; }
  const f = $('s_logo').files?.[0]; if (!f) return;
  $('s_logo_out').textContent = 'アップロード中…';
  try {
    const r = await api(`/api/store/${state.store.id}/logo`, 'POST', { data_url: await fileToDataUrl(f) });
    state.store.logo_url = r.logo_url;
    $('s_logo_out').innerHTML = ` ✅ 登録しました`;
  } catch (e) { $('s_logo_out').textContent = ''; alert('ロゴのアップロード失敗: ' + e.message); }
  finally { $('s_logo').value = ''; }
}
async function saveStore() {
  try {
    const btId = $('s_bt').value;
    const licenses = {};
    (TYPES.find(t => t.id === btId)?.required_licenses || []).forEach(l => { licenses[l.key] = ($('lic_' + l.key)?.value || '').trim(); });
    const payload = {
      business_type_id: btId, name: $('s_name').value.trim(), area: $('s_area').value.trim(),
      tel: $('s_tel').value.trim(), brand_color: $('s_color').value, license_values: licenses,
    };
    if (!payload.name) { alert('店名を入力してください'); return; }
    let store, isNew;
    if (state.store) {
      isNew = false;
      store = (await api('/api/store/' + state.store.id, 'POST', payload)).store;
    } else {
      isNew = true;
      store = (await api('/api/store', 'POST', payload)).store;
    }
    // 一覧を最新化（保存された店舗が一覧に載る）
    await loadStores();

    if (isNew) {
      // B: 新規作成は「登録」操作。フォームを次の入力用にクリアし、作業対象は未選択に戻す。
      newStore();
      $('s_out').style.display = 'block';
      $('s_out').innerHTML = `✅ <b>「${escapeHtml(store.name)}」を登録しました。</b>下の「現在の登録一覧」に追加されています。続けて別の店舗も登録できます。`;
    } else {
      // 更新は編集を継続（作業対象のまま）。
      state.store = store;
      localStorage.setItem('kaitori.store', store.id);
      $('storeSel').value = store.id;
      $('s_save').textContent = 'この店舗を更新';
      $('s_delbox').style.display = 'inline';
      $('s_out').style.display = 'block';
      $('s_out').innerHTML = `✅ <b>「${escapeHtml(store.name)}」を更新して保存しました。</b>`;
      await Promise.all([loadForms(), loadBgm()]);
    }
    // A: 保存された店舗を一覧でハイライト＋スクロールして「保存された」ことを見せる
    renderRegStores(store.id);
    afterStoreChange();
    const li = document.querySelector(`#reg_stores li[data-store="${store.id}"]`);
    if (li) li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { alert('店舗の保存エラー: ' + e.message); }
}

// ===== 登録ビュー：QR/URL（店舗常設・複数可） =====
async function loadForms() {
  if (!state.store) { state.forms = []; return; }
  try { const { forms } = await api(`/api/stores/${state.store.id}/forms`); state.forms = forms; }
  catch { state.forms = []; }
}
async function createQr() {
  if (!requireStore()) return;
  try {
    const r = await api('/api/qr', 'POST', { store_id: state.store.id, label: $('q_label').value.trim() });
    $('q_label').value = '';
    $('q_out').style.display = 'block';
    $('q_out').innerHTML = `✅ 発行しました（${escapeHtml(r.form.label)}）<br><a class="link" href="${r.url}" target="_blank">${r.url}</a><br><img class="qr" src="${r.qr}"><br>
      <span class="muted">来店者はここから写真を撮って申込できます。開くと最新のアクティブなキャンペーンを自動表示します。</span>`;
    await loadForms(); renderRegForms(); fillCampaignFormSelect();
  } catch (e) { alert('QR作成エラー: ' + e.message); }
}

// ===== 登録ビュー：フォーム設定・送信先 =====
async function saveFormConfig() {
  if (!requireStore()) return;
  try {
    const { config } = await api(`/api/stores/${state.store.id}/form-config`);
    config.photo_min = Number($('fc_min').value) || 5;
    config.photo_max = Number($('fc_max').value) || 10;
    config.contact_either_required = $('fc_either').checked;
    await api('/api/form-config', 'POST', { store_id: state.store.id, config });
    $('fc_out').style.display = 'block'; $('fc_out').textContent = `✅ 保存しました（写真 ${config.photo_min}〜${config.photo_max}枚 / 電話・メール${config.contact_either_required ? 'どちらか必須' : '任意'}）`;
  } catch (e) { alert('フォーム設定エラー: ' + e.message); }
}
async function saveDelivery() {
  if (!requireStore()) return;
  try {
    await api('/api/delivery', 'POST', { store_id: state.store.id, delivery: {
      email: $('dv_email').value.trim(), line_notify_token: $('dv_line').value.trim(), webhook_url: $('dv_webhook').value.trim(),
    }});
    $('dv_out').style.display = 'block'; $('dv_out').textContent = '✅ 送信先を保存しました';
  } catch (e) { alert('送信先保存エラー: ' + e.message); }
}
async function loadFormConfig() {
  try { const { config } = await api(`/api/stores/${state.store.id}/form-config`); $('fc_min').value = config.photo_min ?? 5; $('fc_max').value = config.photo_max ?? 10; $('fc_either').checked = config.contact_either_required !== false; } catch {}
}
async function loadDelivery() {
  try { const { delivery } = await api(`/api/stores/${state.store.id}/delivery`); $('dv_email').value = delivery.email || ''; $('dv_line').value = delivery.line_notify_token || ''; $('dv_webhook').value = delivery.webhook_url || ''; } catch {}
}

// ===== 登録ビュー：現在の登録一覧 =====
function renderRegStores(highlightId) {
  const stores = state.stores || [];
  $('reg_stores').innerHTML = stores.length ? stores.map(s => `
    <li data-store="${s.id}"${s.id === highlightId ? ' class="hl"' : ''}><div class="main"><b>${escapeHtml(s.name)}</b><div class="sub">${escapeHtml(s.area || '')}${s.tel ? '｜' + escapeHtml(s.tel) : ''}</div></div>
      <button class="sm ghost" onclick="selectStore('${s.id}')">選択して編集</button></li>`).join('')
    : '<li class="muted">まだ店舗がありません。上のカードで登録してください。</li>';
  if (highlightId) setTimeout(() => { const li = document.querySelector(`#reg_stores li[data-store="${highlightId}"]`); if (li) li.classList.remove('hl'); }, 2200);
}
function selectStore(id) { $('storeSel').value = id; onPickStore(); setView('reg'); }
function renderRegForms() {
  if (!state.store) { $('reg_forms').innerHTML = '<li class="muted">ヘッダーで店舗を選択すると表示します。</li>'; return; }
  const forms = state.forms || [];
  $('reg_forms').innerHTML = forms.length ? forms.map(f => `
    <li><img class="qrs" src="${f.qr}" alt="QR">
      <div class="main"><b>${escapeHtml(f.label)}</b>
        <div class="sub"><a class="link" href="${f.url}" target="_blank">${f.url}</a></div>
        <div class="sub">${fmtDate(f.created_at)}</div></div>
      <a class="pill" href="${f.qr}" download="qr-${escapeHtml(f.label)}.png">QR保存</a></li>`).join('')
    : '<li class="muted">まだQR/URLがありません。上のカードで発行してください。</li>';
}

// ===== キャンペーン生成ビュー =====
function refreshGenView() {
  const has = !!state.store;
  $('gen_guard').style.display = has ? 'none' : 'block';
  fillCampaignFormSelect();
}
// 使うQRのプルダウンを、選択中店舗のQR一覧で埋める
function fillCampaignFormSelect() {
  const sel = $('c_form'); if (!sel) return;
  if (!state.store) { sel.innerHTML = '<option value="">（先に店舗を選択）</option>'; return; }
  const forms = state.forms || [];
  sel.innerHTML = forms.length
    ? forms.map(f => `<option value="${f.id}">${escapeHtml(f.label)}（/f/${f.public_slug}）</option>`).join('')
    : '<option value="">（QRがありません。登録ビューで発行してください）</option>';
}
async function createCampaign() {
  if (!requireStore()) return;
  const leadFormId = $('c_form').value;
  if (!leadFormId) return alert('使用する QR/URL を選択してください（登録ビューで発行できます）');
  try {
    const { campaign } = await api('/api/campaign', 'POST', {
      store_id: state.store.id, lead_form_id: leadFormId,
      title: $('c_title').value.trim(), detail: $('c_detail').value.trim(),
      discount_type: $('c_type').value, valid_to: $('c_to').value || null,
    });
    state.campaign = campaign;
    state.selectedForm = (state.forms || []).find(f => f.id === leadFormId) || null;
    $('c_out').style.display = 'block'; $('c_out').textContent = `✅ キャンペーン作成: ${campaign.title}`;
    enableGenStep(2); enableGenStep(3);
    state.images = []; renderThumbs();
  } catch (e) { alert('キャンペーン作成エラー: ' + e.message); }
}
function enableGenStep(n) { const el = $('gstep' + n); if (el) { el.style.opacity = 1; el.style.pointerEvents = 'auto'; } }

// ===== 記事（複数SNS同時＋手直し） =====
async function genArticles() {
  if (!state.campaign) return alert('先にキャンペーンを作成してください');
  const channels = [...document.querySelectorAll('#ch_boxes input:checked')].map(i => i.value);
  if (!channels.length) return alert('投稿先を1つ以上選んでください');
  try {
    $('a_out').innerHTML = '<div class="muted">生成中…</div>';
    const r = await api('/api/generate/article', 'POST', {
      store_id: state.store.id, campaign_id: state.campaign.id, channels,
      form_slug: state.selectedForm?.public_slug,
    });
    const conns = state.connections || [];
    $('a_out').innerHTML = r.results.map(x => {
      const src = x.source === 'claude' ? 'AI生成' : 'テンプレ生成';
      // 登録済み投稿先ごとに「投稿」ボタン（自動対応=即投稿, それ以外=コピー用途）
      const postBtns = conns.length
        ? conns.map(c => {
            const auto = c.auto_status === 'ready' && c.auto_publish;
            const cls = auto ? 'y' : 'ghost';
            const cap = auto ? 'へ投稿' : 'へ（コピー）';
            return `<button class="sm ${cls}" onclick="publishTo(this,'${c.id}')">${escapeHtml(c.label || c.driver_label)}${cap}</button>`;
          }).join(' ')
        : '<span class="muted">投稿先が未登録です（登録ビューで追加できます）</span>';
      return `<div class="art" data-post="${x.post.id}">
        <b>${escapeHtml(x.label)}</b> <span class="pill">${src}</span>
        <textarea>${escapeHtml(x.post.body)}</textarea>
        <div style="margin-bottom:6px"><button class="sm" onclick="saveArticle(this)">手直しを保存</button>
        <button class="sm ghost" onclick="copyArticle(this)">コピー</button></div>
        <div class="muted" style="margin-bottom:4px">投稿先へ送信:</div>
        <div class="postbtns">${postBtns}</div>
        <div class="pub-out muted"></div>
      </div>`;
    }).join('');
  } catch (e) { $('a_out').innerHTML = '<div class="out">記事生成エラー: ' + e.message + '</div>'; }
}
async function saveArticle(btn) {
  const card = btn.closest('.art'); const id = card.dataset.post; const body = card.querySelector('textarea').value;
  try { await api(`/api/post/${id}/body`, 'POST', { body }); btn.textContent = '保存しました✓'; setTimeout(() => btn.textContent = '手直しを保存', 1500); }
  catch (e) { alert('保存エラー: ' + e.message); }
}
function copyArticle(btn) { const t = btn.closest('.art').querySelector('textarea').value; navigator.clipboard.writeText(t).then(() => { btn.textContent = 'コピー済✓'; setTimeout(() => btn.textContent = 'コピー', 1500); }); }

// 記事カードから登録済み投稿先へ投稿。自動対応なら即投稿、copyなら本文をコピー、errorは理由表示。
async function publishTo(btn, connectionId) {
  const card = btn.closest('.art');
  const postId = card.dataset.post;
  const body = card.querySelector('textarea').value;
  const out = card.querySelector('.pub-out');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '送信中…';
  try {
    // 手直し内容を先に保存してから投稿（表示中の本文で投稿する）
    await api(`/api/post/${postId}/body`, 'POST', { body });
    const { result } = await api('/api/publish-to', 'POST', { post_id: postId, connection_id: connectionId });
    if (result.status === 'published') {
      out.style.color = '#137333'; out.textContent = '✅ ' + result.detail;
    } else if (result.status === 'copy') {
      await navigator.clipboard.writeText(body).catch(() => {});
      out.style.color = '#8a6d00'; out.textContent = '📋 ' + result.detail + '（本文をコピーしました。手動で投稿してください）';
    } else {
      out.style.color = '#c0392b'; out.textContent = '⚠ ' + result.detail;
    }
  } catch (e) {
    out.style.color = '#c0392b'; out.textContent = '⚠ 投稿エラー: ' + e.message;
  } finally { btn.disabled = false; btn.textContent = label; }
}

// ===== 動画 =====
async function uploadImages() {
  if (!requireStore()) return;
  const files = [...($('v_files').files || [])];
  for (const f of files) {
    try { const res = await api('/api/asset/upload', 'POST', { store_id: state.store.id, data_url: await fileToDataUrl(f) }); state.images.push(res.url); }
    catch (e) { alert('画像アップロード失敗: ' + e.message); }
  }
  $('v_files').value = ''; renderThumbs();
}
async function extractFromVideo() {
  if (!requireStore()) return;
  const f = $('v_video').files?.[0]; if (!f) return;
  try {
    $('v_thumbs').insertAdjacentHTML('beforeend', '<span class="muted" id="v_ext">動画から静止画を抽出中…</span>');
    const res = await api('/api/asset/video-frames', 'POST', { store_id: state.store.id, data_url: await fileToDataUrl(f), want: Number($('v_want').value) || 3 });
    res.frames.forEach(fr => state.images.push(fr.url));
    alert(res.note);
  } catch (e) { alert('動画抽出エラー: ' + e.message); }
  finally { $('v_video').value = ''; document.getElementById('v_ext')?.remove(); renderThumbs(); }
}
function renderThumbs() {
  $('v_thumbs').innerHTML = state.images.map((u, i) =>
    `<span class="t"><img src="${u}"><button onclick="removeImg(${i})">×</button></span>`).join('');
}
function removeImg(i) { state.images.splice(i, 1); renderThumbs(); }

async function loadBgm() {
  try {
    const { bgm } = await api(`/api/stores/${state.store.id}/bgm`);
    $('v_bgm').innerHTML = `<option value="">（自動 / 先頭の音源）</option>` + bgm.map(b => `<option value="${b.url}">${escapeHtml(b.name)}</option>`).join('');
  } catch {}
}
async function uploadBgm() {
  if (!requireStore()) return;
  const f = $('v_bgm_file').files?.[0]; if (!f) return;
  try { await api('/api/bgm/upload', 'POST', { store_id: state.store.id, data_url: await fileToDataUrl(f), name: f.name }); await loadBgm(); alert('BGMを追加しました'); }
  catch (e) { alert('BGMアップロード失敗: ' + e.message); }
  finally { $('v_bgm_file').value = ''; }
}
async function genVideo() {
  if (!state.campaign) return alert('先にキャンペーンを作成してください');
  try {
    $('v_out').style.display = 'block'; $('v_out').textContent = '動画生成中…（写真ありは数十秒かかる場合があります）';
    const caps = $('v_caps').value.split('\n').map(s => s.trim()).filter(Boolean);
    const r = await api('/api/generate/video', 'POST', {
      store_id: state.store.id, form_slug: state.selectedForm?.public_slug, campaign_id: state.campaign.id,
      image_urls: state.images, captions: caps, per_slide: Number($('v_sec').value) || 4,
      auto_bgm: $('v_bgm_on').checked, bgm_url: $('v_bgm').value || null,
    });
    $('v_out').innerHTML = `✅ ${r.seconds}秒 / スライド${r.slides}枚 / BGM${r.bgm ? 'あり' : 'なし'}<br>
      <video src="${r.videoUrl}" controls playsinline></video><br>
      <a class="pill" href="${r.videoUrl}" download>動画をダウンロード</a>`;
  } catch (e) { $('v_out').textContent = '動画生成エラー: ' + e.message; }
}

// ===== キャンペーン一覧ビュー =====
async function loadCampaignList() {
  try {
    const q = state.store ? `?store_id=${state.store.id}` : '';
    const { campaigns } = await api('/api/campaigns' + q);
    $('camp_list').innerHTML = campaigns.length ? campaigns.map(c => `
      <li><div class="main"><b><a href="#" class="link" onclick="openCampaign('${c.id}');return false">${escapeHtml(c.title)}</a></b>
        <div class="sub">${escapeHtml(c.store_name || '')}｜作成 ${fmtDate(c.created_at)}${c.valid_to ? '｜〜' + escapeHtml(c.valid_to) : ''}${c.active ? '' : '｜停止中'}</div></div></li>`).join('')
      : '<li class="muted">キャンペーンがありません。</li>';
  } catch (e) { $('camp_list').innerHTML = '<li class="out">一覧取得エラー: ' + e.message + '</li>'; }
}
async function openCampaign(id) {
  try {
    const d = await api('/api/campaign/' + id);
    const c = d.campaign;
    $('dlg_title').textContent = c.title;
    const posts = (d.posts || []).map(p => `<span class="pill">${escapeHtml(p.label)}（${escapeHtml(p.status)}）</span>`).join('') || '<span class="muted">なし</span>';
    const videos = (d.videos || []).map((v, i) => `<a class="link" href="${v.url}" target="_blank">動画${i + 1}${v.seconds ? '（' + v.seconds + '秒）' : ''}</a>`).join(' / ') || '<span class="muted">なし</span>';
    $('dlg_body').innerHTML = `
      <div class="kv"><span>店舗</span>：${escapeHtml(d.store_name || '')}</div>
      <div class="kv"><span>種別</span>：${escapeHtml(c.discount_type || '')}</div>
      <div class="kv"><span>詳細</span>：${escapeHtml(c.detail || '（なし）')}</div>
      <div class="kv"><span>有効期限</span>：${escapeHtml(c.valid_to || '無期限')}</div>
      <div class="kv"><span>使うQR</span>：${d.form ? `<a class="link" href="${d.form.url}" target="_blank">${escapeHtml(d.form.label)}</a>` : '<span class="muted">なし</span>'}</div>
      <div class="kv"><span>記事</span>：${posts}</div>
      <div class="kv"><span>動画</span>：${videos}</div>
      <p class="muted" style="margin-top:12px">記事本文・動画は上のリンクから確認してください。</p>`;
    $('campDlg').showModal();
  } catch (e) { alert('詳細取得エラー: ' + e.message); }
}

// ===== 記事（ブログ/HP）ビュー =====
function refreshArticleView() {
  const has = !!state.store;
  $('art_guard').style.display = has ? 'none' : 'block';
  if (has) { loadStyle(); loadArticles(); loadSchedules(); }
  else {
    $('ar_list').innerHTML = '<li class="muted">店舗を選択すると表示します。</li>';
    $('sc_list').innerHTML = '<li class="muted">店舗を選択すると表示します。</li>';
  }
}

// --- 文体プロファイル ---
function sampleRowHtml(val = '') {
  return `<div class="art" style="padding:8px"><textarea rows="3" class="st-sample" placeholder="過去記事などをそのまま貼り付け">${escapeHtml(val)}</textarea>
    <div><button class="sm ghost" onclick="this.closest('.art').remove()">この お手本を削除</button></div></div>`;
}
function addSample(val = '') { $('st_samples').insertAdjacentHTML('beforeend', sampleRowHtml(val)); }
async function loadStyle() {
  try {
    const { style } = await api(`/api/stores/${state.store.id}/article-style`);
    $('st_tone').value = style.tone || 'polite';
    $('st_hardness').value = style.hardness || 'normal';
    $('st_length').value = style.length || 'medium';
    $('st_emoji').checked = !!style.emoji;
    $('st_notes').value = style.notes || '';
    $('st_samples').innerHTML = '';
    (style.samples || []).forEach(s => addSample(s));
    if (!(style.samples || []).length) addSample(); // 空欄を1つ用意
  } catch {}
}
async function saveStyle() {
  if (!requireStore()) return;
  const samples = [...document.querySelectorAll('#st_samples .st-sample')].map(t => t.value.trim()).filter(Boolean);
  try {
    await api('/api/article-style', 'POST', { store_id: state.store.id, style: {
      tone: $('st_tone').value, hardness: $('st_hardness').value, length: $('st_length').value,
      emoji: $('st_emoji').checked, notes: $('st_notes').value.trim(), samples,
    }});
    $('st_out').style.display = 'block'; $('st_out').textContent = `✅ 文体プロファイルを保存しました（お手本 ${samples.length} 件）`;
  } catch (e) { alert('文体プロファイル保存エラー: ' + e.message); }
}

// --- 記事エディタ（AIと共同編集） ---
async function artAction(action) {
  if (!requireStore()) return;
  const body = $('ar_body').value;
  const theme = $('ar_theme').value.trim();
  const instruction = $('ar_instr').value.trim();
  // クライアント側の軽い前提チェック（サーバでも検証済み）
  if (['continue', 'polish', 'expand', 'shorten', 'restyle'].includes(action) && !body.trim()) return alert('先に本文を用意してください（手入力かAI生成）');
  if (action === 'custom' && !instruction) return alert('自由指示を入力してください');
  if (action === 'generate' && !theme) return alert('テーマを入力してください');
  $('ar_out').style.display = 'block'; $('ar_out').textContent = 'AIが作成中…';
  try {
    const r = await api('/api/article/write', 'POST', { store_id: state.store.id, action, theme, current_body: body, instruction });
    // generate/continue以外は全文置換。continueは追記。generateは本文が空なら差し込み、あれば置換。
    if (action === 'continue') $('ar_body').value = (body ? body + '\n\n' : '') + r.body;
    else $('ar_body').value = r.body;
    const src = r.source === 'claude' ? 'AI生成' : '簡易生成（APIキー未設定）';
    $('ar_out').textContent = `✅ 反映しました（${src}）` + (r.warning ? ` / 注意: ${r.warning}` : '');
    if (action === 'custom') $('ar_instr').value = '';
  } catch (e) { $('ar_out').textContent = '⚠ ' + e.message; }
}
async function saveArticleDoc() {
  if (!requireStore()) return;
  const payload = { title: $('ar_title').value.trim(), body: $('ar_body').value, theme: $('ar_theme').value.trim() };
  if (!payload.body.trim()) return alert('本文が空です');
  try {
    if (state.articleId) {
      await api('/api/article/' + state.articleId, 'POST', payload);
    } else {
      const { article } = await api('/api/article', 'POST', { store_id: state.store.id, ...payload, source: 'manual' });
      state.articleId = article.id;
    }
    $('ar_out').style.display = 'block'; $('ar_out').style.color = '#137333'; $('ar_out').textContent = '✅ 記事を保存しました';
    await loadArticles();
  } catch (e) { alert('記事保存エラー: ' + e.message); }
}
function newArticleDoc() {
  state.articleId = null;
  $('ar_title').value = ''; $('ar_body').value = ''; $('ar_theme').value = ''; $('ar_instr').value = '';
  $('ar_out').style.display = 'none';
}
function copyArticleBody() { navigator.clipboard.writeText($('ar_body').value).then(() => { $('ar_out').style.display = 'block'; $('ar_out').textContent = '📋 本文をコピーしました'; }); }

async function loadArticles() {
  if (!state.store) return;
  try {
    const { articles } = await api(`/api/stores/${state.store.id}/articles`);
    state.articles = articles;
    $('ar_list').innerHTML = articles.length ? articles.map(a => `
      <li data-art="${a.id}"><div class="main"><b><a href="#" class="link" onclick="openArticle('${a.id}');return false">${escapeHtml(a.title || '(無題)')}</a></b>
        <div class="sub">${escapeHtml(a.theme || '')}${a.theme ? '｜' : ''}${escapeHtml(a.status)}｜${fmtDate(a.updated_at)}</div></div>
        <button class="sm ghost" onclick="openArticle('${a.id}')">開く</button>
        <button class="sm" style="background:#c0392b" onclick="deleteArticleDoc('${a.id}')">削除</button></li>`).join('')
      : '<li class="muted">まだ記事がありません。上のエディタで作成してください。</li>';
  } catch { $('ar_list').innerHTML = '<li class="muted">読込エラー</li>'; }
}
function openArticle(id) {
  const a = (state.articles || []).find(x => x.id === id); if (!a) return;
  state.articleId = a.id;
  $('ar_title').value = a.title || ''; $('ar_body').value = a.body || ''; $('ar_theme').value = a.theme || '';
  $('ar_out').style.display = 'block'; $('ar_out').style.color = ''; $('ar_out').textContent = `✏ 「${a.title || '(無題)'}」を編集中`;
  document.querySelector('#view-article .step:nth-child(2)')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function deleteArticleDoc(id) {
  const a = (state.articles || []).find(x => x.id === id);
  if (!confirm(`記事「${a?.title || '(無題)'}」を削除しますか？`)) return;
  try { await api('/api/article/' + id, 'DELETE'); if (state.articleId === id) newArticleDoc(); await loadArticles(); }
  catch (e) { alert('削除エラー: ' + e.message); }
}

// --- 自動生成スケジュール ---
const WD = ['日', '月', '火', '水', '木', '金', '土'];
async function saveSchedule() {
  if (!requireStore()) return;
  const theme = $('sc_theme').value.trim();
  if (!theme) return alert('テーマを入力してください');
  const freq = $('sc_freq').value;
  try {
    await api('/api/schedule', 'POST', {
      store_id: state.store.id, theme, frequency: freq,
      at_time: $('sc_time').value, weekday: freq === 'weekly' ? Number($('sc_weekday').value) : null, enabled: true,
    });
    $('sc_theme').value = '';
    $('sc_out').style.display = 'block'; $('sc_out').textContent = '✅ スケジュールを追加しました（アプリ起動中に自動生成されます）';
    await loadSchedules();
  } catch (e) { alert('スケジュール追加エラー: ' + e.message); }
}
async function loadSchedules() {
  if (!state.store) return;
  try {
    const { schedules } = await api(`/api/stores/${state.store.id}/schedules`);
    state.schedules = schedules;
    $('sc_list').innerHTML = schedules.length ? schedules.map(s => {
      const when = s.frequency === 'weekly' ? `毎週${WD[s.weekday] || '?'}曜 ${s.at_time}` : `毎日 ${s.at_time}`;
      const last = s.last_run_at ? `｜前回 ${fmtDate(s.last_run_at)}` : '';
      return `<li data-sc="${s.id}"><div class="main"><b>${escapeHtml(s.theme)}</b>
        <div class="sub">${when}${last}｜<span class="pill">${s.enabled ? '有効' : '停止中'}</span></div></div>
        <button class="sm y" onclick="runScheduleNow(this,'${s.id}')">今すぐ生成</button>
        <button class="sm ghost" onclick="toggleSchedule('${s.id}',${s.enabled ? 'false' : 'true'})">${s.enabled ? '停止' : '再開'}</button>
        <button class="sm" style="background:#c0392b" onclick="deleteSchedule('${s.id}')">削除</button></li>`;
    }).join('') : '<li class="muted">まだスケジュールがありません。上で追加できます。</li>';
  } catch { $('sc_list').innerHTML = '<li class="muted">読込エラー</li>'; }
}
async function runScheduleNow(btn, id) {
  btn.disabled = true; const t = btn.textContent; btn.textContent = '生成中…';
  try {
    await api('/api/schedule/' + id + '/run', 'POST');
    await loadSchedules(); await loadArticles();
    $('sc_out').style.display = 'block'; $('sc_out').style.color = '#137333'; $('sc_out').textContent = '✅ 記事を生成しました（「保存した記事」を確認してください）';
  } catch (e) { alert('生成エラー: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = t; }
}
async function toggleSchedule(id, enabled) {
  try { await api('/api/schedule/' + id, 'POST', { enabled }); await loadSchedules(); }
  catch (e) { alert('更新エラー: ' + e.message); }
}
async function deleteSchedule(id) {
  const s = (state.schedules || []).find(x => x.id === id);
  if (!confirm(`スケジュール「${s?.theme || ''}」を削除しますか？`)) return;
  try { await api('/api/schedule/' + id, 'DELETE'); await loadSchedules(); }
  catch (e) { alert('削除エラー: ' + e.message); }
}

// ===== 広告ビュー =====
async function refreshAdView() {
  const has = !!state.store;
  $('ad_guard').style.display = has ? 'none' : 'block';
  // CTAに使うQR（店舗の常設フォーム）
  const forms = state.forms || [];
  $('ad_form').innerHTML = '<option value="">（なし）</option>' +
    forms.map(f => `<option value="${f.public_slug}">${escapeHtml(f.label)}</option>`).join('');
  // 動画側のCTA用QR（同じforms）
  $('avd_form').innerHTML = '<option value="">（なし）</option>' +
    forms.map(f => `<option value="${f.public_slug}">${escapeHtml(f.label)}</option>`).join('');
  // キャンペーン（訴求の元）— 文面/動画で共用
  let campOptions = '<option value="">（選択しない）</option>';
  if (has) {
    try {
      const { campaigns } = await api(`/api/stores/${state.store.id}/campaigns`);
      campOptions += campaigns.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('');
    } catch {}
  }
  $('ad_campaign').innerHTML = campOptions;
  $('avd_campaign').innerHTML = campOptions;
  state.adImages = state.adImages || [];
  renderAdThumbs();
  if (has) loadAdBgm();
}
async function genAdCopy() {
  if (!requireStore()) return;
  const medias = [...document.querySelectorAll('#ad_medias input:checked')].map(i => i.value);
  if (!medias.length) return alert('配信メディアを1つ以上選んでください');
  $('ad_out').innerHTML = '<div class="muted">広告文を生成中…</div>';
  try {
    const r = await api('/api/generate/ad-copy', 'POST', {
      store_id: state.store.id, medias,
      campaign_id: $('ad_campaign').value || null,
      form_slug: $('ad_form').value || null,
      extra: $('ad_extra').value.trim(),
    });
    $('ad_out').innerHTML = r.results.map(x => {
      const src = x.source === 'claude' ? 'AI生成' : '簡易生成（APIキー未設定）';
      return `<div class="art" data-ad="${x.media}">
        <b>${escapeHtml(x.label)}</b> <span class="pill">${src}</span>${x.warning ? ` <span class="muted">${escapeHtml(x.warning)}</span>` : ''}
        <textarea rows="10">${escapeHtml(x.body)}</textarea>
        <div><button class="sm y" onclick="copyAd(this)">コピー</button></div>
      </div>`;
    }).join('');
  } catch (e) { $('ad_out').innerHTML = '<div class="out">広告生成エラー: ' + e.message + '</div>'; }
}
function copyAd(btn) { const t = btn.closest('.art').querySelector('textarea').value; navigator.clipboard.writeText(t).then(() => { btn.textContent = 'コピー済✓'; setTimeout(() => btn.textContent = 'コピー', 1500); }); }

// --- 広告動画 ---
async function avdUploadImages() {
  if (!requireStore()) { $('avd_files').value = ''; return; }
  state.adImages = state.adImages || [];
  if (state.adImages.length >= MAX_IMAGES) { alert(`写真は最大${MAX_IMAGES}枚までです（追加できません）`); $('avd_files').value = ''; return; }
  const files = [...($('avd_files').files || [])];
  const room = MAX_IMAGES - state.adImages.length;
  if (files.length > room) alert(`残り${room}枚まで追加できます。先頭${room}枚のみ取り込みます。`);
  for (const f of files.slice(0, room)) {
    try { const res = await api('/api/asset/upload', 'POST', { store_id: state.store.id, data_url: await fileToDataUrl(f) }); state.adImages.push(res.url); }
    catch (e) { alert('画像アップロード失敗: ' + e.message); }
  }
  $('avd_files').value = ''; renderAdThumbs();
}
// 広告用BGM: 一覧読込 + アップロード（既存の /api/bgm/upload と /api/stores/:id/bgm を流用）
async function loadAdBgm() {
  if (!state.store) return;
  try {
    const { bgm } = await api(`/api/stores/${state.store.id}/bgm`);
    $('avd_bgm').innerHTML = `<option value="">（自動 / 先頭の音源）</option>` + (bgm || []).map(b => `<option value="${b.url}">${escapeHtml(b.name)}</option>`).join('');
  } catch {}
}
async function avdUploadBgm() {
  if (!requireStore()) { $('avd_bgm_file').value = ''; return; }
  const f = $('avd_bgm_file').files?.[0]; if (!f) return;
  try { await api('/api/bgm/upload', 'POST', { store_id: state.store.id, data_url: await fileToDataUrl(f), name: f.name }); await loadAdBgm(); alert('BGMを追加しました'); }
  catch (e) { alert('BGMアップロード失敗: ' + e.message); }
  finally { $('avd_bgm_file').value = ''; }
}
function renderAdThumbs() {
  $('avd_thumbs').innerHTML = (state.adImages || []).map((u, i) =>
    `<span class="t"><img src="${u}"><button onclick="removeAdImg(${i})">×</button></span>`).join('');
}
function removeAdImg(i) { state.adImages.splice(i, 1); renderAdThumbs(); }
const SCENE_LABEL = { hook: 'フック（つかみ）', benefit: 'ベネフィット', proof: '実績・信頼', cta: '行動喚起（CTA）' };
// テロップ文言をAI生成して編集欄に表示（ユーザーが手直しできる）。
async function genCaptions() {
  if (!requireStore()) return;
  $('avd_capstate').textContent = '生成中…';
  try {
    const r = await api('/api/ad-video/captions', 'POST', {
      store_id: state.store.id, template: $('avd_template').value,
      campaign_id: $('avd_campaign').value || null, extra: $('avd_extra').value.trim(),
    });
    renderCaptions(r.scenes || [], r.captions || []);
    $('avd_capstate').textContent = '✅ 生成しました（自由に編集できます）';
  } catch (e) { $('avd_capstate').textContent = '⚠ ' + e.message; }
}
function renderCaptions(scenes, captions) {
  const rows = (scenes.length ? scenes : ['hook', 'benefit', 'proof', 'cta']).map((kind, i) =>
    `<label style="font-size:12px;color:#888">${escapeHtml(SCENE_LABEL[kind] || kind)}</label>
     <input class="avd-cap" data-i="${i}" value="${escapeHtml(captions[i] || '')}" placeholder="この文言がテロップ＆ナレーションになります">`).join('');
  $('avd_captions').innerHTML = rows;
}
// 動画クリップ（リール素材）のアップロード。最大3本。
const MAX_CLIPS = 3, MAX_IMAGES = 10;
async function avdUploadClips() {
  if (!requireStore()) { $('avd_clips').value = ''; return; }
  state.adClips = state.adClips || [];
  if (state.adClips.length >= MAX_CLIPS) { alert(`動画クリップは最大${MAX_CLIPS}本までです（追加できません）`); $('avd_clips').value = ''; return; }
  const files = [...($('avd_clips').files || [])];
  const room = MAX_CLIPS - state.adClips.length;
  if (files.length > room) alert(`残り${room}本まで追加できます。先頭${room}本のみ取り込みます。`);
  for (const f of files.slice(0, room)) {
    try {
      $('avd_cliplist').insertAdjacentHTML('beforeend', '<span class="muted" id="avd_up">アップロード中…</span>');
      const res = await api('/api/asset/clip-upload', 'POST', { store_id: state.store.id, data_url: await fileToDataUrl(f) });
      state.adClips.push({ url: res.url, name: f.name });
    } catch (e) { alert('動画アップロード失敗: ' + e.message); }
    finally { document.getElementById('avd_up')?.remove(); }
  }
  $('avd_clips').value = ''; renderAdClips();
}
function renderAdClips() {
  $('avd_cliplist').innerHTML = (state.adClips || []).map((c, i) =>
    `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;flex-wrap:wrap">
      <span class="pill">🎬 ${escapeHtml(c.name || 'clip' + (i + 1))}</span>
      <label style="font-size:12px">秒 <input class="avd-clipsec" data-i="${i}" type="number" min="2" max="15" value="${c.sec || 6}" style="width:56px"></label>
      <label style="font-size:12px">速度 <select class="avd-clipspd" data-i="${i}" style="width:70px">
        <option value="0.5"${c.spd==0.5?' selected':''}>0.5x</option>
        <option value="1"${(!c.spd||c.spd==1)?' selected':''}>1x</option>
        <option value="1.5"${c.spd==1.5?' selected':''}>1.5x</option>
        <option value="2"${c.spd==2?' selected':''}>2x</option>
      </select></label>
      <button class="sm ghost" style="padding:0 8px" onclick="removeAdClip(${i})">×</button>
    </div>`).join('');
}
function removeAdClip(i) { state.adClips.splice(i, 1); renderAdClips(); }
async function genAdVideo() {
  if (!requireStore()) return;
  const clipUrls = (state.adClips || []).map(c => c.url);
  // 各クリップの個別秒数・速度を収集（クリップ数ぶん）
  const secList = [...document.querySelectorAll('.avd-clipsec')].sort((a,b)=>a.dataset.i-b.dataset.i).map(el => Number(el.value) || 6);
  const spdList = [...document.querySelectorAll('.avd-clipspd')].sort((a,b)=>a.dataset.i-b.dataset.i).map(el => Number(el.value) || 1);
  $('avd_out').style.display = 'block'; $('avd_out').style.color = ''; $('avd_out').textContent = '広告動画を生成中…（動画クリップありは1分ほどかかる場合があります）';
  try {
    const r = await api('/api/generate/ad-video', 'POST', {
      store_id: state.store.id, template: $('avd_template').value, aspect: $('avd_aspect').value || '9:16',
      campaign_id: $('avd_campaign').value || null, form_slug: $('avd_form').value || null,
      extra: $('avd_extra').value.trim(), image_urls: state.adImages || [], clip_urls: clipUrls,
      clip_seconds: Number($('avd_clipsec').value) || 6,
      clip_seconds_list: clipUrls.length ? secList : undefined,
      clip_speeds: clipUrls.length ? spdList : undefined,
      color_grade: $('avd_grade').value || 'none',
      use_logo: $('avd_logo').checked, logo_pos: $('avd_logopos').value || 'top-right', logo_size: $('avd_logosize').value || 'medium',
      captions: [...document.querySelectorAll('.avd-cap')].sort((a,b)=>a.dataset.i-b.dataset.i).map(el => el.value.trim()).filter(x=>x).length
        ? [...document.querySelectorAll('.avd-cap')].sort((a,b)=>a.dataset.i-b.dataset.i).map(el => el.value.trim()) : undefined,
      auto_bgm: $('avd_bgm_on').checked, bgm_url: $('avd_bgm').value || null,
      transition: $('avd_transition').value || 'fade', opening: $('avd_opening').checked,
      show_telop: $('avd_telop').checked, narration: $('avd_narration').checked,
    });
    const caps = (r.captions || []).map(escapeHtml).join(' ／ ');
    $('avd_out').innerHTML = `✅ ${r.seconds}秒 / スライド${r.slides}枚 / 比率${escapeHtml(r.aspect)} / BGM${r.bgm ? 'あり' : 'なし'}<br>
      <span class="muted">テロップ: ${caps}</span><br>
      <video src="${r.videoUrl}" controls playsinline></video><br>
      <a class="pill" href="${r.videoUrl}" download>動画をダウンロード</a>`;
  } catch (e) { $('avd_out').style.color = '#c0392b'; $('avd_out').textContent = '広告動画生成エラー: ' + e.message; }
}

// ===== 投稿ビュー（生成済み文言 × 投稿先 のまとめ・投稿状態記録） =====
async function refreshPostView() {
  if (!state.store) {
    $('pb_campaign').innerHTML = '<option value="">（先に店舗を選択）</option>';
    $('pb_board').innerHTML = ''; $('pb_hint').style.display = 'block';
    $('pb_hint').textContent = 'ヘッダーで作業対象の店舗を選んでください。';
    return;
  }
  $('pb_hint').style.display = 'none';
  try {
    const { campaigns } = await api(`/api/stores/${state.store.id}/campaigns`);
    const keep = $('pb_campaign').value;
    $('pb_campaign').innerHTML = '<option value="">（選択してください）</option>' +
      campaigns.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('');
    if (keep && campaigns.some(c => c.id === keep)) { $('pb_campaign').value = keep; loadPublishBoard(keep); }
    else $('pb_board').innerHTML = '';
  } catch { $('pb_campaign').innerHTML = '<option value="">（読込エラー）</option>'; }
}
const PUB_BADGE = {
  published: { t: '投稿済み', c: '#137333' },
  copied: { t: 'コピー済み', c: '#8a6d00' },
  error: { t: '失敗', c: '#c0392b' },
};
async function loadPublishBoard(campaignId) {
  if (!campaignId) { $('pb_board').innerHTML = ''; return; }
  $('pb_board').innerHTML = '<div class="muted">読込中…</div>';
  try {
    const d = await api(`/api/campaign/${campaignId}/publish-board`);
    state.pbData = d;
    if (!d.posts.length) { $('pb_board').innerHTML = '<div class="notice">このキャンペーンの投稿文がまだありません。「キャンペーン生成」で記事を生成してください。</div>'; return; }
    if (!d.connections.length) { $('pb_board').innerHTML = '<div class="notice">投稿先が未登録です。「登録」ビューで投稿先を追加してください。</div>'; return; }
    $('pb_board').innerHTML = d.posts.map(p => renderPostBlock(p, d)).join('');
  } catch (e) { $('pb_board').innerHTML = '<div class="out">読込エラー: ' + e.message + '</div>'; }
}
function renderPostBlock(post, d) {
  const pub = (d.publications || {})[post.id] || {};
  const btns = d.connections.map(cn => {
    const st = pub[cn.id];
    const badge = st && PUB_BADGE[st.status] ? ` <span style="color:${PUB_BADGE[st.status].c};font-size:12px">${PUB_BADGE[st.status].t}${st.created_at ? '（' + fmtDate(st.created_at) + '）' : ''}</span>` : '';
    const auto = cn.auto_status === 'ready' && cn.auto_publish;
    const cap = auto ? 'へ投稿' : 'へ（コピー）';
    const cls = auto ? 'y' : 'ghost';
    return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
      <button class="sm ${cls}" onclick="pbPublish(this,'${post.id}','${cn.id}',${auto})">${escapeHtml(cn.label)}${cap}</button>
      ${badge}</div>`;
  }).join('');
  return `<div class="art" data-post="${post.id}">
    <b>${escapeHtml(post.label)}</b>
    <textarea>${escapeHtml(post.body || '')}</textarea>
    <div style="margin:6px 0"><button class="sm" onclick="pbSaveBody(this,'${post.id}')">手直しを保存</button>
    <button class="sm ghost" onclick="copyArticle(this)">本文コピー</button></div>
    <div class="muted" style="margin-bottom:4px">投稿先:</div>
    ${btns}
    <div class="pub-out muted"></div>
  </div>`;
}
async function pbSaveBody(btn, postId) {
  const body = btn.closest('.art').querySelector('textarea').value;
  try { await api(`/api/post/${postId}/body`, 'POST', { body }); btn.textContent = '保存しました✓'; setTimeout(() => btn.textContent = '手直しを保存', 1500); }
  catch (e) { alert('保存エラー: ' + e.message); }
}
// 自動対応=即投稿して記録 / 手動=コピーして「コピー済み」を記録
async function pbPublish(btn, postId, connId, auto) {
  const card = btn.closest('.art');
  const body = card.querySelector('textarea').value;
  const out = card.querySelector('.pub-out');
  const t = btn.textContent; btn.disabled = true; btn.textContent = '処理中…';
  try {
    await api(`/api/post/${postId}/body`, 'POST', { body }); // 表示中の本文で送る/貼る
    if (auto) {
      const { result } = await api('/api/publish-to', 'POST', { post_id: postId, connection_id: connId });
      if (result.status === 'published') { out.style.color = '#137333'; out.textContent = '✅ ' + result.detail; }
      else { out.style.color = '#c0392b'; out.textContent = '⚠ ' + result.detail; }
    } else {
      await navigator.clipboard.writeText(body).catch(() => {});
      await api('/api/publication/mark-copied', 'POST', { post_id: postId, connection_id: connId });
      out.style.color = '#8a6d00'; out.textContent = '📋 本文をコピーしました。各SNSに貼って投稿してください（コピー済みとして記録）';
    }
    await loadPublishBoard($('pb_campaign').value); // バッジ更新
  } catch (e) { out.style.color = '#c0392b'; out.textContent = '⚠ ' + e.message; }
  finally { btn.disabled = false; btn.textContent = t; }
}

// ===== 共通 =====
function requireStore() { if (!state.store) { alert('先にヘッダーで作業対象の店舗を選択してください'); return false; } return true; }
