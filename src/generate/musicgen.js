// BGMのAI生成（Mureka API / インストゥルメンタル）。
//   生成:   POST https://api.mureka.ai/v1/instrumental/generate  body:{prompt, model}  → {id, status:"preparing"}
//   進捗:   GET  https://api.mureka.ai/v1/instrumental/query/{id} → status succeeded で choices[0].url(mp3, 1ヶ月有効)
// 認証: Authorization: Bearer <ELEVEN... ではなく MUREKA_API_KEY>
// 環境変数:
//   MUREKA_API_KEY     Murekaのシークレットキー。無ければ musicgenEnabled()=false（AI生成BGM無効）。
//   MUREKA_MUSIC_MODEL 省略時 'auto'（auto/mureka-7.5/mureka-6 など）
// 依存追加なし（fetchで直接叩き、完成mp3をDLしてファイルへ書く）。
import { writeFileSync } from 'node:fs';

const BASE = 'https://api.mureka.ai';
const KEY = () => process.env.MUREKA_API_KEY || '';
const MODEL = () => process.env.MUREKA_MUSIC_MODEL || 'auto';

export function musicgenEnabled() { return !!KEY(); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const authHeaders = () => ({ Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' });

// プロンプトからBGM(mp3)を生成して outPath へ保存。成功で true。
// 非同期API: 生成タスク投入→succeededまでポーリング→mp3をDL。
// lengthMs は 目安（Murekaは尺指定が任意のためプロンプトへ反映）。timeoutMs 内に完了しなければ false。
export async function musicgenToFile(prompt, outPath, { lengthMs = 20000, timeoutMs = 120000, pollMs = 4000 } = {}) {
  if (!musicgenEnabled()) return false;
  const secs = Math.max(3, Math.min(600, Math.round((Number(lengthMs) || 20000) / 1000)));
  // 歌詞なし・尺の目安をプロンプトへ明示（Murekaは尺の厳密指定が無いモデルがあるため）
  const p = `${String(prompt || '').trim() || '店舗広告向けの明るくキャッチーなインストゥルメンタル'}. 完全なインスト（ボーカル・ハミングなし）。約${secs}秒、ループしやすい構成。`;
  try {
    // 1) タスク投入
    const gen = await fetch(`${BASE}/v1/instrumental/generate`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ prompt: p, model: MODEL() }),
    });
    if (!gen.ok) { console.error('[musicgen:generate]', gen.status, (await gen.text().catch(() => '')).slice(0, 300)); return false; }
    const task = await gen.json();
    const taskId = task.id || task.task_id || task?.data?.task_id;
    if (!taskId) { console.error('[musicgen] no task id', JSON.stringify(task).slice(0, 200)); return false; }

    // 2) succeeded までポーリング
    const deadline = Date.now() + timeoutMs;
    let url = null;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const q = await fetch(`${BASE}/v1/instrumental/query/${taskId}`, { headers: authHeaders() });
      if (!q.ok) { console.error('[musicgen:query]', q.status); continue; }
      const info = await q.json();
      const d = info.data || info.resp_data || info; // ラッパー差異を吸収
      const status = d.status || info.status;
      if (status === 'succeeded') {
        const choices = d.choices || info.choices || [];
        url = choices[0]?.url || choices[0]?.mp3_url || null;
        break;
      }
      if (['failed', 'timeouted', 'cancelled'].includes(status)) {
        console.error('[musicgen] task', status, d.failed_reason || ''); return false;
      }
    }
    if (!url) { console.error('[musicgen] timeout / no url'); return false; }

    // 3) 完成mp3をDL
    const audio = await fetch(url);
    if (!audio.ok) { console.error('[musicgen:download]', audio.status); return false; }
    const buf = Buffer.from(await audio.arrayBuffer());
    if (buf.length < 1000) return false;
    writeFileSync(outPath, buf);
    return true;
  } catch (e) { console.error('[musicgen]', e.message); return false; }
}
