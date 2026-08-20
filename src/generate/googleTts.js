// AIナレーション（Google Cloud Text-to-Speech）。日本語ニューラル音声で自然な読み上げ。
// REST: POST https://texttospeech.googleapis.com/v1/text:synthesize?key=API_KEY
//   body: { input:{text}, voice:{languageCode,name}, audioConfig:{audioEncoding:'MP3', speakingRate} }
//   resp: { audioContent: base64 } → mp3にデコードして保存
// 環境変数:
//   GOOGLE_TTS_API_KEY  無ければ gTtsEnabled()=false（Google TTS無効）。
import { writeFileSync } from 'node:fs';

const KEY = () => process.env.GOOGLE_TTS_API_KEY || '';
export function gTtsEnabled() { return !!KEY(); }

// UIに出す日本語声のキュレーション（Chirp3-HD=最新/自然 中心 + Neural2）。
// key=UIの値, name=Google音声名, label=表示名, gender。
export const JA_VOICES = [
  { key: 'f-aoede',   name: 'ja-JP-Chirp3-HD-Aoede',      label: '女性・明るい（おすすめ）', gender: 'FEMALE' },
  { key: 'f-kore',    name: 'ja-JP-Chirp3-HD-Kore',       label: '女性・落ち着き',           gender: 'FEMALE' },
  { key: 'f-leda',    name: 'ja-JP-Chirp3-HD-Leda',       label: '女性・やわらか',           gender: 'FEMALE' },
  { key: 'f-zephyr',  name: 'ja-JP-Chirp3-HD-Zephyr',     label: '女性・元気',               gender: 'FEMALE' },
  { key: 'f-neural',  name: 'ja-JP-Neural2-B',            label: '女性・標準',               gender: 'FEMALE' },
  { key: 'm-charon',  name: 'ja-JP-Chirp3-HD-Charon',     label: '男性・落ち着き（おすすめ）', gender: 'MALE' },
  { key: 'm-puck',    name: 'ja-JP-Chirp3-HD-Puck',       label: '男性・明るい',             gender: 'MALE' },
  { key: 'm-fenrir',  name: 'ja-JP-Chirp3-HD-Fenrir',     label: '男性・力強い',             gender: 'MALE' },
  { key: 'm-orus',    name: 'ja-JP-Chirp3-HD-Orus',       label: '男性・やわらか',           gender: 'MALE' },
  { key: 'm-neural',  name: 'ja-JP-Neural2-C',            label: '男性・標準',               gender: 'MALE' },
];
const VOICE_BY_KEY = Object.fromEntries(JA_VOICES.map(v => [v.key, v.name]));
export function resolveVoiceName(key) { return VOICE_BY_KEY[key] || key || 'ja-JP-Chirp3-HD-Aoede'; }
export function listJaVoices() { return JA_VOICES.map(({ key, label, gender }) => ({ key, label, gender })); }

// テキスト→mp3。voiceはUIキー(f-aoede等)またはGoogle音声名。成功でtrue。
export async function synthToFile(text, outPath, { voice, speed = 1.0 } = {}) {
  if (!gTtsEnabled()) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  const name = resolveVoiceName(voice);
  // Chirp3-HDはspeakingRateのみ対応（pitch非対応）。0.25〜4.0にクランプ。
  const rate = Math.max(0.25, Math.min(4.0, Number(speed) || 1.0));
  try {
    const body = {
      input: { text: t.slice(0, 900) },
      voice: { languageCode: 'ja-JP', name },
      audioConfig: { audioEncoding: 'MP3', speakingRate: rate },
    };
    const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + KEY(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) { console.error('[gtts]', r.status, (await r.text().catch(() => '')).slice(0, 200)); return false; }
    const j = await r.json();
    if (!j.audioContent) return false;
    writeFileSync(outPath, Buffer.from(j.audioContent, 'base64'));
    return true;
  } catch (e) { console.error('[gtts]', e.message); return false; }
}
