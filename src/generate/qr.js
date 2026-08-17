// QRコード生成。フォーム公開URLをPNGにする。
import QRCode from 'qrcode';

export async function qrPngBuffer(url, { width = 480 } = {}) {
  return QRCode.toBuffer(url, { type: 'png', width, margin: 2,
    color: { dark: '#161616', light: '#FFFFFF' } }); // DevRevブランド配色
}

export async function qrDataUrl(url, opts = {}) {
  return QRCode.toDataURL(url, { margin: 2, width: opts.width || 320,
    color: { dark: '#161616', light: '#FFFFFF' } });
}
