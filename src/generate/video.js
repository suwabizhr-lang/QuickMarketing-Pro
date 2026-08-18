// ②スライドショー型ショート動画生成。
// 写真スライド + Ken Burns(ゆっくりズーム/パン) + 日本語テロップ焼き込み + 末尾CTAカット(QR) + BGM(任意) を
// 9:16 縦型(1080x1920 / H.264)で ffmpeg 合成する。
// 写真が無い場合はブランドカラーの単色スライドにフォールバック（最小ループ担保）。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { qrPngBuffer } from './qr.js';
import { telopPng } from './telop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const W = 1080, H = 1920, FPS = 30; // 既定は 9:16。generateSlideshow の width/height で上書き可。
const assetsRoot = join(__dirname, '..', '..', 'data', 'assets');
const bgmDir = join(__dirname, '..', '..', 'assets', 'bgm'); // フリー音源を置く場所（任意）

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + '\n' + err.slice(-1500))));
    p.on('error', reject);
  });
}

// BGM が置かれていれば最初の1本のパスを返す（mp3/m4a/aac/wav）
function findBgm() {
  try {
    if (!existsSync(bgmDir)) return null;
    const f = readdirSync(bgmDir).find(n => /\.(mp3|m4a|aac|wav)$/i.test(n));
    return f ? join(bgmDir, f) : null;
  } catch { return null; }
}

// 写真を指定比率にカバー配置した中間 PNG を作る（Ken Burns の入力を安定させるため事前に整形）
async function coverToFrame(srcPath, outPath, w = W, h = H) {
  await sharp(srcPath)
    .resize(w, h, { fit: 'cover', position: 'centre' })
    .png()
    .toFile(outPath);
}

// 1枚のスライド（写真 or 単色）に Ken Burns + テロップを乗せた無音セグメントmp4を作る
async function buildSlide({ imgPath, brandColor, telopText, position, dur, tmp, idx, w = W, h = H }) {
  const seg = join(tmp, `seg${idx}.mp4`);
  const telop = join(tmp, `telop${idx}.png`);
  writeFileSync(telop, await telopPng({ text: telopText || '', position: position || 'bottom', width: w, height: h }));

  const frames = Math.max(1, Math.round(dur * FPS));
  // Ken Burns: ゆっくり 1.0→1.12 ズームイン。中心固定。
  const zoompan = `zoompan=z='min(zoom+0.0012,1.12)':d=${frames}:s=${w}x${h}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=${FPS}`;

  const args = [];
  if (imgPath) {
    args.push('-loop', '1', '-t', String(dur), '-i', imgPath);
  } else {
    // 単色フォールバック
    args.push('-f', 'lavfi', '-t', String(dur), '-i', `color=c=${brandColor.replace('#', '')}:s=${w}x${h}`);
  }
  args.push('-i', telop); // [1] テロップ
  args.push(
    '-filter_complex',
    (imgPath
      ? `[0:v]${zoompan},format=yuv420p[bg];`
      : `[0:v]format=yuv420p[bg];`) +
    `[bg][1:v]overlay=0:0:format=auto,format=yuv420p[v]`,
    '-map', '[v]', '-r', String(FPS), '-t', String(dur),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', seg,
  );
  await run(args);
  return seg;
}

// 末尾CTAカット（白背景に中央QR + 上部テロップ）。ctaUrl が空なら QR を省きテロップのみ。
async function buildCta({ ctaUrl, ctaLabel, dur, tmp, w = W, h = H }) {
  const seg = join(tmp, 'seg_cta.mp4');
  const telop = join(tmp, 'telop_cta.png');
  writeFileSync(telop, await telopPng({ text: ctaLabel || 'この店に今すぐ査定', position: 'top', style: 'band', width: w, height: h }));
  const url = (ctaUrl || '').trim();
  // QRサイズは短辺の約6割（比率が変わっても収まるように）
  const qrSize = Math.round(Math.min(w, h) * 0.63);

  let args;
  if (url) {
    const qrPath = join(tmp, 'qr.png');
    writeFileSync(qrPath, await qrPngBuffer(url, { width: qrSize }));
    args = [
      '-f', 'lavfi', '-t', String(dur), '-i', `color=c=white:s=${w}x${h}`,
      '-loop', '1', '-t', String(dur), '-i', qrPath,
      '-i', telop,
      '-filter_complex',
        `[0:v][1:v]overlay=(W-w)/2:(H-h)/2+120[bgqr];` +
        `[bgqr][2:v]overlay=0:0,format=yuv420p[v]`,
      '-map', '[v]', '-r', String(FPS), '-t', String(dur),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', seg,
    ];
  } else {
    // QRなし: 白背景 + テロップのみ
    args = [
      '-f', 'lavfi', '-t', String(dur), '-i', `color=c=white:s=${w}x${h}`,
      '-i', telop,
      '-filter_complex', `[0:v][1:v]overlay=0:0,format=yuv420p[v]`,
      '-map', '[v]', '-r', String(FPS), '-t', String(dur),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', seg,
    ];
  }
  await run(args);
  return seg;
}

/**
 * スライドショー生成。
 * @param {object} o
 * @param {string} o.storeId
 * @param {string} [o.brandColor]
 * @param {string} o.ctaUrl
 * @param {string} [o.ctaLabel]
 * @param {string[]} [o.images]     写真の絶対パス配列（無ければ単色スライド）
 * @param {string[]} [o.captions]   各写真のテロップ（省略時はキャンペーン文言などを呼び出し側で渡す）
 * @param {number} [o.perSlide]     1枚あたり秒数
 * @param {boolean} [o.autoBgm]     BGM自動ミックスを行うか（既定 true）
 * @param {string} [o.bgmPath]      使用するBGM絶対パス（指定時はこれを優先）
 * @returns {Promise<{path:string, seconds:number, slides:number, bgm:boolean}>}
 */
export async function generateSlideshow({
  storeId, brandColor = '#FFE600', ctaUrl, ctaLabel = 'この店に今すぐ査定',
  images = [], captions = [], perSlide = 4, autoBgm = true, bgmPath = null,
  width = W, height = H, // 比率対応: 9:16=1080x1920 / 1:1=1080x1080 / 16:9=1920x1080
}) {
  const w = width || W, h = height || H;
  const outDir = join(assetsRoot, storeId);
  mkdirSync(outDir, { recursive: true });
  const tmp = join(outDir, 'tmp-' + Date.now());
  mkdirSync(tmp, { recursive: true });
  const outPath = join(outDir, `slideshow-${Date.now()}.mp4`);

  try {
    const segs = [];
    const durs = [];
    const ctaDur = 5;
    const pushSeg = (seg, d) => { segs.push(seg); durs.push(d); };

    if (images.length > 0) {
      // 写真あり: 写真ごとに1スライド。テロップは対応する captions[i]（無ければ空）。
      for (let i = 0; i < images.length; i++) {
        const framePng = join(tmp, `frame${i}.png`);
        await coverToFrame(images[i], framePng, w, h);
        pushSeg(await buildSlide({
          imgPath: framePng, telopText: captions[i] || '', position: 'bottom', dur: perSlide, tmp, idx: i, w, h,
        }), perSlide);
      }
    } else if (captions.length > 0) {
      // 写真ゼロ・テロップ複数: テロップ1行ごとに単色スライドを作る（3行なら3スライド）。
      for (let i = 0; i < captions.length; i++) {
        const d = Math.max(3, perSlide);
        pushSeg(await buildSlide({
          imgPath: null, brandColor, telopText: captions[i] || '', position: 'center', dur: d, tmp, idx: i, w, h,
        }), d);
      }
    } else {
      // 何も無い: 単色スライド1枚
      const d = Math.max(6, perSlide * 3);
      pushSeg(await buildSlide({
        imgPath: null, brandColor, telopText: '', position: 'center', dur: d, tmp, idx: 0, w, h,
      }), d);
    }

    const slideCount = segs.length; // CTA前のスライド数

    // 末尾CTAカット
    pushSeg(await buildCta({ ctaUrl, ctaLabel, dur: ctaDur, tmp, w, h }), ctaDur);

    // concat リスト
    const listPath = join(tmp, 'list.txt');
    writeFileSync(listPath, segs.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

    // BGM: 明示指定 > 自動探索。autoBgm=false なら無音。
    const bgm = autoBgm ? (bgmPath || findBgm()) : null;
    const bodySeconds = durs.reduce((a, b) => a + b, 0);

    if (bgm) {
      // 映像を concat しつつ BGM をミックス（映像尺に合わせて途中フェードアウト）
      await run([
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-i', bgm,
        '-filter_complex',
          `[1:a]afade=t=out:st=${Math.max(0, bodySeconds - 2)}:d=2,volume=0.6[a]`,
        '-map', '0:v', '-map', '[a]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
        '-movflags', '+faststart', '-y', outPath,
      ]);
    } else {
      // 無音で連結（再エンコードして faststart 付与）
      await run([
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outPath,
      ]);
    }

    return { path: outPath, seconds: bodySeconds, slides: slideCount, bgm: !!bgm };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}
