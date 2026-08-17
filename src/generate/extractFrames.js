// アップロードされた動画からフレーム(静止画)を抽出する。
// 用途: ユーザーが撮った店舗/商品の動画から、看板・ロゴ・商品ディテールの静止画を切り出して
//       スライド素材に転用する（ユーザーが渡した素材から生成するので商標使用に当たらない設計）。
// Claude Vision キーがあれば「良いフレーム」を選定、無ければ等間隔抽出にフォールバック。
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + '\n' + err.slice(-1200))));
    p.on('error', reject);
  });
}

// 動画から candidatePool 枚を等間隔で抽出（9:16にcoverせず素の縦横で抽出。後段でcover）
async function dumpFrames(videoPath, outDir, poolCount = 24) {
  mkdirSync(outDir, { recursive: true });
  // fpsフィルタで全体からpoolCount枚程度を均等に。長さ不明でも安全なよう scale で幅720に統一。
  await run([
    '-i', videoPath,
    '-vf', `thumbnail=n=10,scale=720:-1`, // シーン代表フレーム寄り
    '-frames:v', String(poolCount),
    '-vsync', 'vfr',
    '-y', join(outDir, 'f-%03d.jpg'),
  ]).catch(async () => {
    // thumbnail が使えない場合は素朴な等間隔抽出
    await run(['-i', videoPath, '-vf', 'fps=1,scale=720:-1', '-frames:v', String(poolCount), '-y', join(outDir, 'f-%03d.jpg')]);
  });
  return readdirSync(outDir).filter(n => /^f-\d+\.jpg$/.test(n)).sort().map(n => join(outDir, n));
}

// Claude Vision で「看板/ロゴ/商品が写った良いフレーム」を選定（キーがあれば）
async function pickWithVision(frames, want) {
  if (!process.env.ANTHROPIC_API_KEY || frames.length === 0) return null;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // コスト配慮: 最大16枚まで送る
    const sample = frames.slice(0, 16);
    const content = [{
      type: 'text',
      text: `これは買取店が撮影した動画から抽出した連番フレームです。SNS投稿スライドに使う静止画として最適な${want}枚を選んでください。
優先: 店舗の看板/ロゴがはっきり写る・商品がきれいに写る・ブレていない・明るい。
番号は0始まり（送った順）。JSONのみで返答: {"picks":[番号,...]}`,
    }];
    sample.forEach((f) => {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(f).toString('base64') } });
    });
    const msg = await client.messages.create({ model: MODEL, max_tokens: 300, messages: [{ role: 'user', content }] });
    const txt = (msg.content || []).map(b => b.type === 'text' ? b.text : '').join('');
    const m = /\{[\s\S]*\}/.exec(txt);
    if (!m) return null;
    const picks = JSON.parse(m[0]).picks;
    if (!Array.isArray(picks)) return null;
    const chosen = picks.map(i => sample[i]).filter(Boolean).slice(0, want);
    return chosen.length ? chosen : null;
  } catch { return null; }
}

// 等間隔で want 枚選ぶ
function pickEven(frames, want) {
  if (frames.length <= want) return frames;
  const step = frames.length / want;
  const out = [];
  for (let i = 0; i < want; i++) out.push(frames[Math.floor(i * step)]);
  return out;
}

/**
 * 動画からスライド用の静止画を want 枚抽出して、その絶対パス配列を返す。
 * @returns {Promise<{frames:string[], source:'vision'|'even'}>}
 */
export async function extractSlideFrames({ videoPath, workDir, want = 3 }) {
  const pool = await dumpFrames(videoPath, workDir, Math.max(12, want * 6));
  const vision = await pickWithVision(pool, want);
  if (vision) return { frames: vision, source: 'vision' };
  return { frames: pickEven(pool, want), source: 'even' };
}
