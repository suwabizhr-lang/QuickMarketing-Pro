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
import { synthToFile, ttsEnabled } from './tts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const W = 1080, H = 1920, FPS = 30; // 既定は 9:16。generateSlideshow の width/height で上書き可。
const assetsRoot = join(__dirname, '..', '..', 'data', 'assets');

// 色補正プリセット → ffmpeg eq/その他フィルタ断片。none は空（補正なし）。
export const COLOR_GRADES = {
  none: '',
  bright: 'eq=brightness=0.08:contrast=1.06',
  vivid: 'eq=saturation=1.35:contrast=1.08',
  warm: 'eq=saturation=1.12,colorbalance=rm=0.10:gm=0.03:bm=-0.08',
  cool: 'eq=saturation=1.08,colorbalance=rm=-0.08:gm=0.0:bm=0.12',
  cinema: 'eq=contrast=1.18:saturation=0.9:gamma=0.95',
};
function gradeFilter(grade) { return COLOR_GRADES[grade] || ''; }

// ロゴ位置プリセット → overlay の x,y 式（mは余白px）。
export const LOGO_POSITIONS = {
  'top-right': 'top-right', 'top-left': 'top-left', 'bottom-right': 'bottom-right',
  'bottom-left': 'bottom-left', 'top-center': 'top-center', 'bottom-center': 'bottom-center',
};
function logoXY(pos, mx, my) {
  switch (pos) {
    case 'top-left': return { x: `${mx}`, y: `${my}` };
    case 'bottom-right': return { x: `main_w-overlay_w-${mx}`, y: `main_h-overlay_h-${my}` };
    case 'bottom-left': return { x: `${mx}`, y: `main_h-overlay_h-${my}` };
    case 'top-center': return { x: `(main_w-overlay_w)/2`, y: `${my}` };
    case 'bottom-center': return { x: `(main_w-overlay_w)/2`, y: `main_h-overlay_h-${my}` };
    default: return { x: `main_w-overlay_w-${mx}`, y: `${my}` }; // top-right（既定）
  }
}
// ロゴサイズプリセット → 幅px（短辺基準の割合）。
function logoWidth(size, w, h) {
  const base = Math.min(w, h);
  const ratio = size === 'small' ? 0.14 : size === 'large' ? 0.30 : 0.22; // 既定 medium
  return Math.round(base * ratio);
}
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

// 動画クリップ1本をスライド化: 頭から dur 秒トリム → w×h に中央cover → テロップ焼き込み → 無音セグメントmp4。
// リール/TikTok向け。元音は消す（BGMに差し替える前提）。
async function buildClipSlide({ clipPath, telopText, position, dur, tmp, idx, w = W, h = H, showTelop = true, speed = 1, grade = 'none', logoPath = null, logoPos = 'top-right', logoSize = 'medium' }) {
  const seg = join(tmp, `clip${idx}.mp4`);
  const sp = Math.max(0.5, Math.min(2, Number(speed) || 1));
  const srcDur = dur * sp; // 速度spなら素材は dur*sp 秒使うと出力 dur 秒になる
  const speedF = sp !== 1 ? `,setpts=PTS/${sp}` : '';
  const gradeF = gradeFilter(grade) ? ',' + gradeFilter(grade) : '';
  // 映像整形: scale cover→中央crop→fps/SAR統一→(速度)→(色補正)→尺不足はtpad→dur秒にtrim。
  const cover = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${FPS}${speedF}${gradeF},tpad=stop_mode=clone:stop_duration=${dur},trim=duration=${dur},format=yuv420p`;

  // オーバーレイ入力（テロップ・ロゴ）を組み立て
  const inputs = ['-t', String(srcDur), '-i', clipPath];
  const overlays = []; // {label, x, y}
  let inIdx = 1;
  if (showTelop && (telopText || '').trim()) {
    const telop = join(tmp, `telopc${idx}.png`);
    writeFileSync(telop, await telopPng({ text: telopText, position: position || 'bottom', width: w, height: h }));
    inputs.push('-i', telop); overlays.push({ idx: inIdx, x: '0', y: '0' }); inIdx++;
  }
  if (logoPath) {
    const mx = Math.round(w * 0.04), my = Math.round(h * 0.03);
    const { x, y } = logoXY(logoPos, mx, my);
    inputs.push('-i', logoPath); overlays.push({ idx: inIdx, x, y, logo: true, size: logoWidth(logoSize, w, h) }); inIdx++;
  }

  // filter: [0]cover→[base]、overlayを順に重ねる。ロゴは事前にscale。
  let fc = `[0:v]${cover}[base]`;
  let prev = 'base';
  overlays.forEach((ov, k) => {
    const out = k === overlays.length - 1 ? 'v' : `ov${k}`;
    if (ov.logo) {
      fc += `;[${ov.idx}:v]scale=${ov.size}:-1[lg${k}];[${prev}][lg${k}]overlay=${ov.x}:${ov.y},format=yuv420p[${out}]`;
    } else {
      fc += `;[${prev}][${ov.idx}:v]overlay=${ov.x}:${ov.y},format=yuv420p[${out}]`;
    }
    prev = out;
  });
  if (overlays.length === 0) fc = `[0:v]${cover}[v]`;

  await run([...inputs, '-filter_complex', fc, '-map', '[v]', '-an', '-r', String(FPS), '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', seg]);
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

// オープニングのブランド面（ブランドカラー背景 + 店名を中央大きめに）。掴みの「誰の広告か」を明示。
async function buildOpening({ storeName, brandColor, dur, tmp, w = W, h = H }) {
  const seg = join(tmp, 'seg_open.mp4');
  const telop = join(tmp, 'telop_open.png');
  // ブランドカラーが濃いと黒文字が沈むので、telopは白文字＋黒縁(style:none)で視認性を確保
  writeFileSync(telop, await telopPng({ text: storeName || '', position: 'center', style: 'none', fontSize: Math.round(Math.min(w, h) * 0.09), width: w, height: h }));
  const args = [
    '-f', 'lavfi', '-t', String(dur), '-i', `color=c=${(brandColor || '#FFE600').replace('#', '')}:s=${w}x${h}`,
    '-i', telop,
    '-filter_complex', `[0:v][1:v]overlay=0:0,format=yuv420p[v]`,
    '-map', '[v]', '-r', String(FPS), '-t', String(dur),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', seg,
  ];
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
  transition = 'fade',   // スライド間xfadeの種類（fade/dissolve/slideleft/wipeleft/...）
  openingText = null,    // 指定時、冒頭にブランド面(店名)カットを差し込む
  clips = [], clipSeconds = 6, // 動画クリップ素材（絶対パス配列）。clipSecondsは数値 or 配列(各クリップ個別秒数)
  clipSpeeds = [],       // 各クリップの再生速度（0.5〜2倍）。省略時は等速
  colorGrade = 'none',   // 色補正プリセット（none/bright/vivid/warm/cool/cinema）
  logoPath = null,       // 店舗ロゴ（各クリップに合成）
  logoPos = 'top-right', logoSize = 'medium', // ロゴ位置(6択)・サイズ(small/medium/large)
  showTelop = true,      // テロップ文言を映像に焼くか
  narration = false,     // 各セグメントの文言をAI音声(TTS)で読み上げBGMに重ねるか
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
    const narrTexts = []; // 各セグメントのナレーション文言（無い区間は null）
    const ctaDur = 5;
    const pushSeg = (seg, d, narr = null) => { segs.push(seg); durs.push(d); narrTexts.push(narr); };

    // オープニングのブランド面（先頭）
    if (openingText) {
      const openDur = 2;
      pushSeg(await buildOpening({ storeName: openingText, brandColor, dur: openDur, tmp, w, h }), openDur, null);
    }

    if (clips.length > 0) {
      // 動画クリップあり（リール/TikTok向け）: 各クリップを縦化＋テロップ焼き込み＋個別秒数/速度/色補正/ロゴ。
      const clampSec = v => Math.max(2, Math.min(15, Number(v) || 6));
      for (let i = 0; i < clips.length; i++) {
        const cs = Array.isArray(clipSeconds) ? clampSec(clipSeconds[i] ?? clipSeconds[0] ?? 6) : clampSec(clipSeconds);
        pushSeg(await buildClipSlide({
          clipPath: clips[i], telopText: captions[i] || '', position: 'bottom', dur: cs, tmp, idx: i, w, h, showTelop,
          speed: clipSpeeds[i], grade: colorGrade, logoPath, logoPos, logoSize,
        }), cs, captions[i] || null);
      }
    } else if (images.length > 0) {
      // 写真あり: 写真ごとに1スライド。テロップは対応する captions[i]（無ければ空）。
      for (let i = 0; i < images.length; i++) {
        const framePng = join(tmp, `frame${i}.png`);
        await coverToFrame(images[i], framePng, w, h);
        pushSeg(await buildSlide({
          imgPath: framePng, telopText: showTelop ? (captions[i] || '') : '', position: 'bottom', dur: perSlide, tmp, idx: i, w, h,
        }), perSlide, captions[i] || null);
      }
    } else if (captions.length > 0) {
      // 写真ゼロ・テロップ複数: テロップ1行ごとに単色スライドを作る（3行なら3スライド）。
      for (let i = 0; i < captions.length; i++) {
        const d = Math.max(3, perSlide);
        pushSeg(await buildSlide({
          imgPath: null, brandColor, telopText: showTelop ? (captions[i] || '') : '', position: 'center', dur: d, tmp, idx: i, w, h,
        }), d, captions[i] || null);
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

    // BGM: 明示指定 > 自動探索。autoBgm=false なら無音。
    const bgm = autoBgm ? (bgmPath || findBgm()) : null;
    const rawSeconds = durs.reduce((a, b) => a + b, 0);

    // 演出: スライド間クロスフェード(xfade)。XF秒だけ前後を重ねる。重なる分だけ総尺が縮む。
    const XF = 0.5;
    const n = segs.length;
    const useXfade = n >= 2;
    const bodySeconds = useXfade ? Math.max(1, rawSeconds - XF * (n - 1)) : rawSeconds;

    // 映像フィルタ（xfadeチェーン）を組み立てる。BGM有無で map を切り替える。
    const vInputs = segs.flatMap(s => ['-i', s]);
    let videoFilter = '';
    const segStart = []; // 各セグメントの最終動画上での開始時刻（xfade重なりを考慮）
    if (useXfade) {
      // 各入力を fps 揃え＆フォーマット統一 → 順に xfade。offset は「累積表示尺 − 累積XF」。
      let chain = segs.map((_, i) => `[${i}:v]format=yuv420p,settb=AVTB,fps=${FPS}[v${i}]`).join(';') + ';';
      const tr = transition || 'fade';
      let prev = 'v0';
      let offset = durs[0] - XF; // 最初のxfade開始位置
      segStart[0] = 0;
      for (let i = 1; i < n; i++) {
        const out = i === n - 1 ? 'vout' : `x${i}`;
        chain += `[${prev}][v${i}]xfade=transition=${tr}:duration=${XF}:offset=${offset.toFixed(3)}[${out}];`;
        segStart[i] = offset; // セグメントiは概ねこの時刻から表示される
        prev = out;
        offset += durs[i] - XF;
      }
      videoFilter = chain.replace(/;$/, '');
    }

    // ナレーション音声（AI TTS）。各セグメントの文言を音声化し、segStart[i] から配置。無効時は空。
    // 単一セグメント(useXfade=false)でも鳴るよう、その場合は先頭0秒に配置する。
    let narrClips = []; // { file, startSec }
    if (narration && ttsEnabled()) {
      for (let i = 0; i < n; i++) {
        const t = (narrTexts[i] || '').trim();
        if (!t) continue;
        const mp3 = join(tmp, `narr${i}.mp3`);
        const okSyn = await synthToFile(t, mp3, { speed: 1.05 });
        if (okSyn) narrClips.push({ file: mp3, startSec: useXfade ? (segStart[i] || 0) : 0 });
      }
    }
    const hasNarr = narrClips.length > 0;

    if (useXfade && (bgm || hasNarr)) {
      // オーディオ入力: [n]以降に BGM → ナレーション群 の順で -i する。
      const audioInputs = [];
      let ai = n; // 次の入力インデックス
      let bgmIdx = -1;
      if (bgm) { audioInputs.push('-i', bgm); bgmIdx = ai; ai++; }
      const narrIdx = [];
      for (const nc of narrClips) { audioInputs.push('-i', nc.file); narrIdx.push({ idx: ai, startSec: nc.startSec }); ai++; }

      // オーディオフィルタ: BGMは音量下げ（ナレがある時は控えめ0.22、無ければ0.6）＋末尾フェードアウト。
      // ナレは各 adelay で配置し amix。最後に全部を amix。
      const aChains = [];
      const mixLabels = [];
      if (bgm) {
        const bgmVol = hasNarr ? 0.22 : 0.6;
        aChains.push(`[${bgmIdx}:a]afade=t=out:st=${Math.max(0, bodySeconds - 2)}:d=2,volume=${bgmVol}[abgm]`);
        mixLabels.push('[abgm]');
      }
      narrIdx.forEach((nn, k) => {
        const delayMs = Math.round(nn.startSec * 1000);
        aChains.push(`[${nn.idx}:a]adelay=${delayMs}|${delayMs},volume=1.6[an${k}]`);
        mixLabels.push(`[an${k}]`);
      });
      const mix = mixLabels.length > 1
        ? `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0,volume=${mixLabels.length}[a]`
        : `${mixLabels[0]}anull[a]`;
      const aFilter = aChains.concat(mix).join(';');

      await run([
        ...vInputs, ...audioInputs,
        '-filter_complex', `${videoFilter};${aFilter}`,
        '-map', '[vout]', '-map', '[a]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', bodySeconds.toFixed(3),
        '-movflags', '+faststart', '-y', outPath,
      ]);
    } else if (useXfade) {
      await run([
        ...vInputs,
        '-filter_complex', videoFilter,
        '-map', '[vout]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', bodySeconds.toFixed(3),
        '-movflags', '+faststart', '-y', outPath,
      ]);
    } else {
      // セグメント1枚: xfade不要。単体を再エンコード（+BGM +ナレーション）。
      const listPath = join(tmp, 'list.txt');
      writeFileSync(listPath, segs.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
      if (bgm || hasNarr) {
        // 入力: [0]=concat映像, その後 BGM → ナレーション群
        const audioInputs = [];
        let ai = 1, bgmIdx = -1;
        if (bgm) { audioInputs.push('-i', bgm); bgmIdx = ai; ai++; }
        const narrIdx = [];
        for (const nc of narrClips) { audioInputs.push('-i', nc.file); narrIdx.push({ idx: ai, startSec: nc.startSec }); ai++; }
        const aChains = [], mixLabels = [];
        if (bgm) {
          const bgmVol = hasNarr ? 0.22 : 0.6;
          aChains.push(`[${bgmIdx}:a]afade=t=out:st=${Math.max(0, bodySeconds - 2)}:d=2,volume=${bgmVol}[abgm]`);
          mixLabels.push('[abgm]');
        }
        narrIdx.forEach((nn, k) => {
          const delayMs = Math.round(nn.startSec * 1000);
          aChains.push(`[${nn.idx}:a]adelay=${delayMs}|${delayMs},volume=1.6[an${k}]`);
          mixLabels.push(`[an${k}]`);
        });
        const mix = mixLabels.length > 1
          ? `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0,volume=${mixLabels.length}[a]`
          : `${mixLabels[0]}anull[a]`;
        await run([
          '-f', 'concat', '-safe', '0', '-i', listPath, ...audioInputs,
          '-filter_complex', aChains.concat(mix).join(';'),
          '-map', '0:v', '-map', '[a]',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', bodySeconds.toFixed(3),
          '-movflags', '+faststart', '-y', outPath,
        ]);
      } else {
        await run([
          '-f', 'concat', '-safe', '0', '-i', listPath,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outPath,
        ]);
      }
    }

    return { path: outPath, seconds: Math.round(bodySeconds), slides: slideCount, bgm: !!bgm, narration: hasNarr };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}
