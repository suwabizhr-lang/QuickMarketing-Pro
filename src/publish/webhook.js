// 汎用Webhook投稿。指定URLへ本文をPOSTする（WordPress中継/GAS/Zapier等に汎用）。
// 必要: auto_config.webhook_url（送信先） / 任意: auto_config.secret（X-Kaitori-Secretヘッダ）
export async function publishWebhook({ conn, post, store }) {
  const url = (conn.auto_config?.webhook_url || '').trim();
  if (!url) return { ok: false, status: 'error', detail: 'Webhook URL が未設定です' };
  const secret = (conn.auto_config?.secret || '').trim();
  const headers = { 'content-type': 'application/json' };
  if (secret) headers['X-Kaitori-Secret'] = secret;

  const r = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({
      store: store?.name || '', channel: post.channel,
      title: (post.body || '').split('\n')[0]?.slice(0, 80) || '',
      body: post.body || '',
    }),
  });
  if (r.ok) return { ok: true, status: 'published', detail: `Webhookへ送信しました (HTTP ${r.status})` };
  return { ok: false, status: 'error', detail: `Webhook送信に失敗: HTTP ${r.status}` };
}
