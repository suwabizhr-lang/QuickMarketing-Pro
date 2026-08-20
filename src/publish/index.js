// 投稿ディスパッチャ。接続(channel_connection)の種別ごとに自動投稿を試みる。
// 戻り値: { ok, status:'published'|'copy'|'error', detail } を必ず返す（例外は投げない）。
//   published … 自動投稿できた
//   copy      … 自動不可（手動でコピー投稿してください）
//   error     … 自動投稿を試みたが失敗
import { getChannelDriver } from '../channels.js';
import { publishLine } from './line.js';
import { publishWebhook } from './webhook.js';
import { publishWordpress } from './wordpress.js';

// driver.key → 実装ハンドラ。ここに足すだけで自動投稿対応が増える。
const HANDLERS = {
  line: publishLine,
  webhook: publishWebhook,
  wordpress: publishWordpress,
};

// conn: channel_connection 行（auto_config等を含む生の値） / post: { channel, body } / store
export async function publishToChannel({ conn, post, store }) {
  const driver = getChannelDriver(conn.channel);
  if (!driver) return { ok: false, status: 'error', detail: '不明な投稿先です' };
  if (!driver.auto?.supported || driver.auto?.status !== 'ready') {
    return { ok: false, status: 'copy', detail: `${driver.label} は自動投稿に未対応です。本文をコピーして投稿してください。` };
  }
  const handler = HANDLERS[conn.channel];
  if (!handler) return { ok: false, status: 'copy', detail: `${driver.label} の自動投稿は準備中です。` };
  try {
    return await handler({ conn, post, store });
  } catch (e) {
    return { ok: false, status: 'error', detail: (e && e.message) || String(e) };
  }
}
