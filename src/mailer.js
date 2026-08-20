// メール送信（Resend）。応募通知を店舗オーナーのメールへ送る。
// 環境変数:
//   RESEND_API_KEY  Resend APIキー（re_...）。無ければメール機能は無効（何もしない＝ログのみ）。
//   MAIL_FROM       送信元（例: "買取店マーケ <noreply@quickmarketing-pro.com>"）。認証済みドメイン必須。
// 依存追加なし（fetchでResend REST APIを直接叩く）。
const APIKEY = () => process.env.RESEND_API_KEY || '';
const FROM = () => process.env.MAIL_FROM || '買取店マーケ <onboarding@resend.dev>';

export function mailerEnabled() { return !!APIKEY(); }

// 低レベル送信。成功で true。
export async function sendEmail(to, subject, html) {
  if (!mailerEnabled() || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + APIKEY(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [to], subject, html }),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); console.error('[mailer]', res.status, t.slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error('[mailer]', e.message); return false; }
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// 応募通知メールのHTML（店舗オーナー宛て）。DevRev配色: 黒/黄/白。
function submissionHtml({ storeName, contact, item, photoCount, detailUrl }) {
  const row = (k, v) => `<tr><td style="padding:6px 10px;color:#888;font-size:13px;white-space:nowrap">${esc(k)}</td><td style="padding:6px 10px;font-size:14px">${esc(v) || '—'}</td></tr>`;
  return `<!doctype html><html lang="ja"><body style="margin:0;background:#F4F4F4;font-family:'Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,sans-serif;color:#161616;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:#161616;border-radius:14px 14px 0 0;padding:20px 24px;">
      <div style="color:#FFE600;font-size:18px;font-weight:800;">新しい査定申込</div>
      <div style="color:#fff;font-size:13px;margin-top:4px;">${esc(storeName)}</div>
    </div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:20px 24px;">
      <table style="width:100%;border-collapse:collapse;">
        ${row('お名前', contact?.name)}
        ${row('電話番号', contact?.tel)}
        ${row('メール', contact?.email)}
        ${row('商品名', item?.item_name)}
        ${row('状態', item?.condition)}
        ${row('年式', item?.year)}
        ${row('使用年数', item?.used_years)}
        ${row('コメント', item?.comment)}
        ${row('写真', (photoCount || 0) + '枚')}
      </table>
      ${detailUrl ? `<div style="text-align:center;margin:20px 0 4px;"><a href="${esc(detailUrl)}" style="display:inline-block;background:#FFE600;color:#161616;text-decoration:none;font-weight:800;padding:11px 24px;border-radius:9999px;">申込の詳細を見る</a></div>` : ''}
      <p style="font-size:12px;color:#8a8a8a;margin-top:18px;">このメールは買取店マーケの応募通知です。</p>
    </div>
  </div></body></html>`;
}

// 応募通知を送る。成功で true。
export async function sendSubmissionNotice(to, { storeName, contact, item, photoCount, detailUrl }) {
  if (!mailerEnabled() || !to) return false;
  const subject = `【${storeName}】新しい査定申込（${contact?.name || 'お客様'}様）`;
  return sendEmail(to, subject, submissionHtml({ storeName, contact, item, photoCount, detailUrl }));
}
