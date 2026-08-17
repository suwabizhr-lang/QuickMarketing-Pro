// LINE公式アカウントへブロードキャスト（友だち全員へ配信）。
// Messaging API: POST https://api.line.me/v2/bot/message/broadcast
// 必要: auto_config.channel_access_token（長期チャネルアクセストークン）
export async function publishLine({ conn, post }) {
  const token = (conn.auto_config?.channel_access_token || '').trim();
  if (!token) return { ok: false, status: 'error', detail: 'チャネルアクセストークンが未設定です' };
  const text = String(post.body || '').slice(0, 5000); // LINEテキスト上限に配慮
  if (!text) return { ok: false, status: 'error', detail: '本文が空です' };

  const r = await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ type: 'text', text }] }),
  });
  if (r.status === 200) return { ok: true, status: 'published', detail: 'LINEで友だちへ一斉配信しました' };
  let msg = `HTTP ${r.status}`;
  try { const j = await r.json(); if (j?.message) msg += `: ${j.message}`; } catch {}
  return { ok: false, status: 'error', detail: 'LINE配信に失敗: ' + msg };
}
