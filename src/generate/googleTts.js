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

// トーン（話し方のニュアンス）プリセット → SSML prosody(rate/pitch)。
// Googleには感情タグ(怒り等)が無いため、速度とピッチで“それっぽく”寄せる。normalは素の声。
export const TONES = {
  normal:   { label: 'ふつう',       rate: null,   pitch: null },
  bright:   { label: '明るい',       rate: '112%', pitch: '+3st' },
  energetic:{ label: '元気・テンション高め', rate: '120%', pitch: '+5st' },
  calm:     { label: '落ち着き',     rate: '92%',  pitch: '-2st' },
  gentle:   { label: 'やさしい',     rate: '96%',  pitch: '+1st' },
  serious:  { label: '真面目・低め', rate: '95%',  pitch: '-4st' },
};
export function listTones() { return Object.entries(TONES).map(([key, v]) => ({ key, label: v.label })); }
// Chirp3-HD系はprosody(SSML)が効きにくい。tone指定時に自然なトーンを出すため、
// tone!=='normal'ならNeural2へ寄せる（同性の標準声）。
function voiceForTone(name, tone) {
  if (!tone || tone === 'normal') return name;
  if (/Chirp3-HD/.test(name)) {
    // 性別だけ維持してNeural2へ（女性→B、男性→C）
    const female = JA_VOICES.find(v => v.name === name)?.gender === 'FEMALE';
    return female ? 'ja-JP-Neural2-B' : 'ja-JP-Neural2-C';
  }
  return name;
}
function esc(s) { return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
// テキストをSSMLへ。tone→prosody。文末の「。！？」の後に軽いポーズを入れて自然に。
function toSsml(text, tone) {
  const t = TONES[tone] || TONES.normal;
  let body = esc(text).replace(/([。！？])/g, '$1<break time="180ms"/>');
  if (t.rate || t.pitch) {
    const attrs = [t.rate ? `rate="${t.rate}"` : '', t.pitch ? `pitch="${t.pitch}"` : ''].filter(Boolean).join(' ');
    body = `<prosody ${attrs}>${body}</prosody>`;
  }
  return `<speak>${body}</speak>`;
}

// テキスト→mp3。voice=UIキー(f-aoede等)/音声名。tone=話し方(normal/bright/energetic/calm/gentle/serious)。成功でtrue。
export async function synthToFile(text, outPath, { voice, speed = 1.0, tone = 'normal' } = {}) {
  if (!gTtsEnabled()) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  const useTone = tone && tone !== 'normal';
  const name = useTone ? voiceForTone(resolveVoiceName(voice), tone) : resolveVoiceName(voice);
  const rate = Math.max(0.25, Math.min(4.0, Number(speed) || 1.0)); // speakingRate 0.25〜4.0
  try {
    // tone指定時はSSML(prosodyで抑揚)。それ以外はプレーンtext(Chirp3-HDの自然さを活かす)。
    const input = useTone ? { ssml: toSsml(t.slice(0, 900), tone) } : { text: t.slice(0, 900) };
    const body = {
      input,
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
