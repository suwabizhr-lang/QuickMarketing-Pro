// 記事の自動生成スケジューラ。アプリ起動中に1分ごとにチェックし、時刻到来したスケジュールで下書きを生成。
// SaaS化時はサーバ側cron/ジョブに置換予定（ローカルMVPの簡易実装）。
import * as db from './db.js';
import { writeArticle } from './generate/articleWriter.js';

const pad = n => String(n).padStart(2, '0');
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 時刻文字列 "9:00" / "09:00" を分に正規化
function norm(t) { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? `${pad(+m[1])}:${m[2]}` : null; }

async function runOne(sc) {
  const store = await db.getStore(sc.store_id);
  if (!store) return;
  const style = await db.getSetting(store.id, 'article_style', {});
  const r = await writeArticle({ store, style, action: 'generate', theme: sc.theme });
  // タイトルは本文1行目（##や記号を除去）から拾う。無ければテーマ。
  const firstLine = String(r.body || '').split('\n').map(s => s.replace(/^#+\s*/, '').trim()).find(Boolean);
  const title = (firstLine && firstLine.length <= 60 ? firstLine : sc.theme) || '自動生成記事';
  await db.createArticle({ store_id: store.id, title, body: r.body, theme: sc.theme, source: 'schedule', status: 'draft' });
  await db.markScheduleRun(sc.id);
  console.log(`[スケジュール生成] 店舗:${store.name} テーマ:${sc.theme} → 記事を下書き保存`);
}

async function tick() {
  const now = new Date();
  const cur = hhmm(now);
  const today = ymd(now);
  let list;
  try { list = await db.listAllEnabledSchedules(); } catch { return; }
  for (const sc of list) {
    const at = norm(sc.at_time);
    if (!at || at !== cur) continue;                                   // 時刻一致（分単位）
    if (sc.frequency === 'weekly' && Number(sc.weekday) !== now.getDay()) continue; // 曜日一致
    if (sc.last_run_at && ymd(new Date(sc.last_run_at)) === today) continue;        // 同日重複防止
    try { await runOne(sc); } catch (e) { console.error('[スケジュール生成エラー]', e.message); }
  }
}

// 手動トリガー（「今すぐ生成」ボタン/検証用）。指定スケジュールを1回実行して生成した記事を返す。
export async function runScheduleNow(scheduleId) {
  const sc = await db.getSchedule(scheduleId);
  if (!sc) throw new Error('スケジュールが見つかりません');
  await runOne(sc);
  return true;
}

let timer = null;
export function startScheduler() {
  if (timer) return;
  // 1分ごと。起動直後にも1回走らせる（起動時ちょうどの時刻を拾う）。
  tick();
  timer = setInterval(tick, 60 * 1000);
  console.log('記事スケジューラ 起動（1分間隔で確認）');
}
export function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }
