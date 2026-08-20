// WordPress自動投稿。REST API (/wp-json/wp/v2/posts) に Basic認証(ユーザー名 + アプリケーションパスワード)でPOST。
// 必要: auto_config.site_url / username / app_password / status(draft|publish)
// アプリケーションパスワードは WP管理画面 ユーザー>プロフィール>アプリケーションパスワード で発行（ログインPWとは別）。
export async function publishWordpress({ conn, post, store }) {
  const c = conn.auto_config || {};
  const site = (c.site_url || '').trim().replace(/\/+$/, '');
  const user = (c.username || '').trim();
  const apppw = (c.app_password || '').trim();
  if (!site || !user || !apppw) return { ok: false, status: 'error', detail: 'サイトURL・ユーザー名・アプリケーションパスワードが必要です' };

  const body = String(post.body || '');
  if (!body.trim()) return { ok: false, status: 'error', detail: '本文が空です' };
  // タイトルは本文1行目（##等の記号を除去、60字以内）。無ければ店名+日付。
  const firstLine = body.split('\n').map(s => s.replace(/^#+\s*/, '').trim()).find(Boolean);
  const title = (firstLine && firstLine.length <= 60 ? firstLine : `${store?.name || ''}のお知らせ`) || '記事';
  // 本文は改行を<br>に、段落を<p>に軽く整形（プレーンテキスト→簡易HTML）。
  const contentHtml = body.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');

  const status = c.status === 'publish' ? 'publish' : 'draft';
  const auth = 'Basic ' + Buffer.from(`${user}:${apppw}`).toString('base64');

  const res = await fetch(`${site}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: auth },
    body: JSON.stringify({ title, content: contentHtml, status }),
  });
  if (res.status === 201 || res.ok) {
    let link = '';
    try { const j = await res.json(); link = j?.link || ''; } catch {}
    return { ok: true, status: 'published', detail: `WordPressに${status === 'publish' ? '公開' : '下書き保存'}しました${link ? '（' + link + '）' : ''}` };
  }
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); if (j?.message) msg += `: ${j.message}`; } catch {}
  // よくある原因のヒント
  if (res.status === 401) msg += '（ユーザー名/アプリケーションパスワードを確認してください）';
  if (res.status === 404) msg += '（サイトURLが正しいか、REST APIが有効か確認してください）';
  return { ok: false, status: 'error', detail: 'WordPress投稿に失敗: ' + msg };
}

function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
