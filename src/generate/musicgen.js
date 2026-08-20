// BGMのAI生成（ElevenLabs Music API）。POST https://api.elevenlabs.io/v1/music
// 環境変数:
//   ELEVENLABS_API_KEY  ElevenLabs APIキー（xi-api-key）。無ければ musicgenEnabled()=false（AI生成BGM無効）。
//   ELEVENLABS_MUSIC_MODEL  省略時 'music_v1'
// 依存追加なし（fetchで直接叩き、mp3バイナリをファイルへ書く）。
import { writeFileSync } from 'node:fs';

const KEY = () => process.env.ELEVENLABS_API_KEY || '';
const MODEL = () => process.env.ELEVENLABS_MUSIC_MODEL || 'music_v1';

export function musicgenEnabled() { return !!KEY(); }

// プロンプトからBGM(mp3)を生成して outPath へ保存。lengthMs は 3000〜600000。成功で true。
export async function musicgenToFile(prompt, outPath, { lengthMs = 20000 } = {}) {
  if (!musicgenEnabled()) return false;
  const p = String(prompt || '').trim() || 'アップテンポで明るい、店舗広告向けのインストゥルメンタルBGM';
  const ms = Math.max(3000, Math.min(600000, Math.round(Number(lengthMs) || 20000)));
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/music', {
      method: 'POST',
      headers: { 'xi-api-key': KEY(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: p, music_length_ms: ms, model_id: MODEL(), force_instrumental: true, output_format: 'mp3_44100_128' }),
    });
    if (!res.ok) { console.error('[musicgen]', res.status, (await res.text().catch(() => '')).slice(0, 200)); return false; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return false; // 明らかに失敗
    writeFileSync(outPath, buf);
    return true;
  } catch (e) { console.error('[musicgen]', e.message); return false; }
}
