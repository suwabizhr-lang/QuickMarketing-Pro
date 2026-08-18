// テロップ（字幕）画像生成。日本語テキストを SVG→PNG 化して 9:16 透明レイヤーに焼く。
// sharp でレンダリング（フォントは Windows 標準の Yu Gothic / Meiryo を利用）。
// 可読性のため文字の下に半透明の帯を敷く。DevRevブランド配色（黒/白/黄）。
import sharp from 'sharp';

const W = 1080, H = 1920;

// XMLエスケープ
function esc(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// 全角/半角をざっくり考慮して、指定文字数で折り返す（日本語は句読点も考慮）
function wrap(text, maxCharsPerLine) {
  const chars = [...String(text)];
  const lines = [];
  let cur = '';
  for (const ch of chars) {
    cur += ch;
    if ([...cur].length >= maxCharsPerLine || ch === '\n') {
      lines.push(cur.replace(/\n/g, '').trim());
      cur = '';
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.filter(Boolean);
}

/**
 * テロップPNGバッファを作る（1080x1920 透明背景）。
 * @param {object} o
 * @param {string} o.text        表示テキスト
 * @param {'top'|'center'|'bottom'} [o.position]  縦位置
 * @param {number} [o.fontSize]   基準フォントサイズ(px)
 * @param {string} [o.color]      文字色
 * @param {string} [o.bandColor]  帯色（rgba可）
 * @param {'band'|'none'} [o.style] 帯あり/なし
 * @param {string} [o.accent]     アクセント下線色（ブランドカラー）
 * @returns {Promise<Buffer>}
 */
export async function telopPng({
  text, position = 'bottom', fontSize = 72, color = '#FFFFFF',
  bandColor = 'rgba(22,22,22,0.62)', style = 'band', accent = '#FFE600',
  width, height, // 比率対応: 動画のW/Hに合わせる（未指定は既定9:16 = モジュール定数）
} = {}) {
  const CW = width || W, CH = height || H; // 以降はこの CW/CH を使う（比率に追従）
  const maxCharsPerLine = Math.max(6, Math.floor((CW * 0.86) / (fontSize * 1.02)));
  const lines = wrap(text, maxCharsPerLine);
  const lineH = Math.round(fontSize * 1.35);
  const padY = Math.round(fontSize * 0.5);
  const blockH = lines.length * lineH + padY * 2;

  let top;
  if (position === 'top') top = Math.round(CH * 0.10);
  else if (position === 'center') top = Math.round((CH - blockH) / 2);
  else top = Math.round(CH - blockH - CH * 0.14); // bottom

  const band = style === 'band'
    ? `<rect x="0" y="${top}" width="${CW}" height="${blockH}" fill="${bandColor}"/>`
    : '';

  // アクセント下線（帯の上端に黄色ライン）
  const accentBar = style === 'band'
    ? `<rect x="0" y="${top}" width="${CW}" height="10" fill="${accent}"/>`
    : '';

  const texts = lines.map((ln, i) => {
    const y = top + padY + Math.round(lineH * (i + 0.78));
    return `<text x="${CW / 2}" y="${y}" font-size="${fontSize}" fill="${color}"
      text-anchor="middle" font-family="'Yu Gothic','Meiryo','Noto Sans JP',sans-serif"
      font-weight="800" paint-order="stroke" stroke="#000000" stroke-width="${style === 'band' ? 0 : 6}"
      stroke-linejoin="round">${esc(ln)}</text>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">
    ${band}${accentBar}${texts}</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
