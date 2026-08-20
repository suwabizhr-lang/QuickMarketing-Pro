// AIナレーション（音声合成 / TTS）。OpenAI TTS (/v1/audio/speech, tts-1) でテキスト→mp3。
// 環境変数:
//   OPENAI_API_KEY  OpenAI APIキー（無ければ ttsEnabled()=false → ナレーション無しで動く＝後方互換）
//   OPENAI_TTS_MODEL  省略時 'tts-1'（tts-1-hd も可）
//   OPENAI_TTS_VOICE  省略時 'alloy'（alloy/echo/fable/onyx/nova/shimmer）
// 依存追加なし（fetchで直接叩き、mp3バイナリを受け取ってファイルへ書く）。
import { writeFileSync } from 'node:fs';

const KEY = () => process.env.OPENAI_API_KEY || '';
const MODEL = () => process.env.OPENAI_TTS_MODEL || 'tts-1';
const VOICE = () => process.env.OPENAI_TTS_VOICE || 'alloy';

export function ttsEnabled() { return !!KEY(); }

// テキストを音声(mp3)にして outPath へ保存。成功で true、無効/失敗で false。
export async function synthToFile(text, outPath, { voice, speed = 1.0 } = {}) {
  if (!ttsEnabled()) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL(), voice: voice || VOICE(), input: t.slice(0, 900), format: 'mp3', speed }),
    });
    if (!res.ok) { console.error('[tts]', res.status, (await res.text().catch(() => '')).slice(0, 150)); return false; }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, buf);
    return true;
  } catch (e) { console.error('[tts]', e.message); return false; }
}
