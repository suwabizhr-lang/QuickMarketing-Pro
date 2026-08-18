// 広告動画テンプレート（型）の定義。将来の追加開発をここに集約する「単一の真実」。
// 新しい型/比率は、このファイルにエントリを足すだけで増える（ビルダー adVideo.js はここを読むだけ）。
//
// テンプレート = 広告の型。scenes に「各シーンでどんなテロップを出すか」を宣言的に持つ。
//   scene.kind: 'hook'(フック) | 'benefit'(ベネフィット) | 'proof'(実績/信頼) | 'cta'(行動喚起)
//   scene.position: テロップ表示位置（top/center/bottom）
//   scene.seconds: そのシーンの尺(秒)
//   scene.prompt: AIにこのシーンのテロップ文を作らせる指示（1行・短い惹句）
// aspect は将来 1:1 / 16:9 を足せるよう定義だけ持つ（現状ビルダーは 9:16 実装、他は追加予定）。

export const AD_VIDEO_ASPECTS = {
  '9:16': { label: 'リール/ストーリーズ（縦 9:16）', w: 1080, h: 1920, status: 'ready' },
  '1:1': { label: '正方形（1:1・フィード向け）', w: 1080, h: 1080, status: 'ready' },
  '16:9': { label: '横（16:9・YouTube/一般向け）', w: 1920, h: 1080, status: 'ready' },
};

export const AD_VIDEO_TEMPLATES = {
  standard: {
    label: '王道（フック→ベネフィット→実績→CTA）', order: 1,
    scenes: [
      { kind: 'hook', position: 'center', seconds: 3, prompt: '最初の2〜3秒で目を止める強いフック（数字・限定・意外性・ベネフィットのいずれか）。10〜16文字の短い惹句。' },
      { kind: 'benefit', position: 'bottom', seconds: 4, prompt: 'この店で売る具体的なメリット/特典を一言で。12〜20文字。' },
      { kind: 'proof', position: 'bottom', seconds: 4, prompt: '安心感・信頼の一言（実績/地域密着/査定無料など）。12〜20文字。' },
      { kind: 'cta', position: 'center', seconds: 5, prompt: '行動を促す一言（例: 今すぐ無料査定／QRから相談）。10〜16文字。' },
    ],
  },
  urgency: {
    label: '限定・緊急性（今だけ！）', order: 2,
    scenes: [
      { kind: 'hook', position: 'center', seconds: 3, prompt: '「今だけ/今週末まで」等の強い限定・緊急性のフック。10〜16文字。' },
      { kind: 'benefit', position: 'bottom', seconds: 4, prompt: '期間限定の特典/上乗せを具体的に一言。12〜20文字。' },
      { kind: 'proof', position: 'bottom', seconds: 3, prompt: '見送ると損する理由 or 安心材料を一言。12〜20文字。' },
      { kind: 'cta', position: 'center', seconds: 5, prompt: '今すぐ動く理由＋行動喚起。10〜16文字。' },
    ],
  },
  surprise: {
    label: '査定額の驚き（こんなに！）', order: 3,
    scenes: [
      { kind: 'hook', position: 'center', seconds: 3, prompt: '「え、これが◯◯円!?」のような査定額の驚きフック。10〜18文字。' },
      { kind: 'benefit', position: 'bottom', seconds: 4, prompt: '高く売れる理由/対象品目を一言。12〜20文字。' },
      { kind: 'proof', position: 'bottom', seconds: 4, prompt: '査定無料・その場で現金など安心の一言。12〜20文字。' },
      { kind: 'cta', position: 'center', seconds: 5, prompt: 'まずは査定だけでもOKと促すCTA。10〜16文字。' },
    ],
  },
};

export function listAdVideoTemplates() {
  return Object.entries(AD_VIDEO_TEMPLATES).sort((a, b) => a[1].order - b[1].order)
    .map(([key, t]) => ({ key, label: t.label, scenes: t.scenes.map(s => ({ kind: s.kind, seconds: s.seconds })) }));
}
export function listAdVideoAspects() {
  return Object.entries(AD_VIDEO_ASPECTS).map(([key, v]) => ({ key, label: v.label, status: v.status }));
}
export function getAdVideoTemplate(key) { return AD_VIDEO_TEMPLATES[key] || null; }
