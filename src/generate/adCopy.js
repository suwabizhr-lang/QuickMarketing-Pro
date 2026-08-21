// 広告クリエイティブ（文面）生成。各メディアの「広告枠」に最適化し、そのままコピペできる形で出力する。
// 通常投稿(article.js)とは別。広告なので訴求・フック・CTAを強める。自動出稿はしない（人が管理画面へ貼る）。
import { generateText, aiEnabled } from './ai.js';

const hasKey = () => aiEnabled();

// 各メディアの広告フォーマット定義。fields = 出力に含める構成要素（コピペしやすいよう見出し付きで返す）。
export const AD_FORMATS = {
  instagram: {
    label: 'Instagram広告', order: 1,
    spec: {
      primaryTextMax: 125,   // 「メインテキスト」推奨（1行目で切れないよう短め）
      captionMax: 2200,      // キャプション全体
      hashtags: 8,
      headlineMax: 40,
    },
    guide: 'ビジュアル前提。1行目で強いフック（数字・限定・ベネフィット）。絵文字を効果的に。共感→ベネフィット→CTA。ハッシュタグは末尾にまとめる。',
    parts: ['メインテキスト', 'キャプション（本文）', 'ハッシュタグ', '見出し(任意)'],
  },
  facebook: {
    label: 'Facebook広告', order: 2,
    spec: { primaryTextMax: 125, captionMax: 1500, hashtags: 3, headlineMax: 40, descriptionMax: 30 },
    guide: 'やや年齢層高め・信頼感。メインテキストは冒頭で価値提示。見出しは短く明快、説明文で補足。地域密着の安心感。',
    parts: ['メインテキスト', '見出し', '説明文', '本文'],
  },
  line: {
    label: 'LINE広告', order: 3,
    spec: { titleMax: 20, descMax: 90, hashtags: 0 },
    guide: 'LINE広告(Talk Head View/Smart Channel想定)。タイトルは短く強く、説明文は端的。友だち向けのやわらかさと即時性。',
    parts: ['タイトル', '説明文', '本文(配信用)'],
  },
  x: {
    label: 'X広告', order: 4,
    spec: { postMax: 130, hashtags: 2 },
    guide: '1ポスト完結。最初の一撃で惹きつけ、核となるベネフィットとCTAのみ。冗長禁止。過度な煽りは避ける。',
    parts: ['ポスト本文', 'ハッシュタグ'],
  },
};

export function listAdFormats() {
  return Object.entries(AD_FORMATS).sort((a, b) => a[1].order - b[1].order).map(([key, v]) => ({ key, label: v.label, spec: v.spec }));
}

const TONE_TXT = { polite: 'です・ます調', casual: 'だ・である調', friendly: 'やわらかく親しみやすい口語' };

function styleHint(style) {
  if (!style) return '';
  const bits = [];
  if (style.tone) bits.push(TONE_TXT[style.tone] || '');
  if (style.emoji === false) bits.push('絵文字は控えめ');
  if (style.notes && style.notes.trim()) bits.push(style.notes.trim());
  return bits.filter(Boolean).length ? `\n# 文体の希望\n- ${bits.filter(Boolean).join(' / ')}` : '';
}

function buildPrompt({ store, campaign, media, ctaUrl, style, extra, bizType }) {
  const f = AD_FORMATS[media] || AD_FORMATS.instagram;
  const specLines = Object.entries(f.spec).map(([k, v]) => `  - ${k}: ${v}`).join('\n');
  const biz = (bizType || '').trim();
  return `あなたは反応率の高い広告を書くプロのコピーライターです。事業者の【${f.label}】として、そのままコピペして入稿できる広告文を作成してください。

# 事業者
- 名称: ${store.name}
- エリア: ${store.area || '（未設定）'}
${biz ? `- 業種: ${biz}` : '- 業種: （指定なし。特定業種を勝手に想定しない）'}

# 訴求（キャンペーン）
- タイトル: ${campaign?.title || (extra ? '（追加の指示に沿って訴求）' : 'おすすめ・キャンペーン')}
- 詳細: ${campaign?.detail || '（なし）'}
- 有効期限: ${campaign?.valid_to || '（未設定）'}
${extra ? `- 追加の指示（最優先で反映）: ${extra}` : ''}

# この媒体の広告ガイド
${f.guide}
# 文字数の目安（できるだけ厳守）
${specLines}
${styleHint(style)}

# 重要な制約
- 業種は上記のとおり。特定業種（例: 買取・査定など）を勝手に想定せず、与えられた情報と追加指示だけに忠実に。業種不明なら中立的で汎用的な表現にする。

# 出力ルール（重要）
- 次の構成要素を、それぞれ見出しを付けて出力してください: ${f.parts.map(p => `【${p}】`).join(' ')}
- 各要素はそのままコピペして各枠に貼れる形に。余計な説明や前置きは書かない。
- 誇大表現・断定的な効果保証は避ける（景表法配慮）。
${ctaUrl ? `- CTA先URL: ${ctaUrl} を本文/説明文の適切な位置に自然に含める。` : '- URLの記載は不要（枠側で設定するため）。'}
${f.spec.hashtags ? `- ハッシュタグは${f.spec.hashtags}個ほど（業種・訴求に合ったもの）。` : '- ハッシュタグは不要。'}`;
}

// キー未設定時の簡易フォールバック（媒体別に最低限コピペできる雛形）。業種非依存の中立表現。
function fallback({ store, campaign, media, ctaUrl }) {
  const nm = store.name; const area = store.area ? `（${store.area}）` : '';
  const title = campaign?.title || 'お知らせ';
  const detail = campaign?.detail || 'ぜひこの機会にご利用ください';
  const url = ctaUrl ? `\n▼詳しくはこちら\n${ctaUrl}` : '';
  const tag = (store.area || '').replace(/\s/g, '');
  switch (media) {
    case 'x':
      return `【ポスト本文】\n${title}｜${nm}${area}。${detail}${url}${tag ? `\n\n【ハッシュタグ】\n#${tag}` : ''}`;
    case 'line':
      return `【タイトル】\n${title}\n\n【説明文】\n${nm}${area}。${detail}\n\n【本文(配信用)】\n${nm}です。${title}のお知らせです。${detail}${url}`;
    case 'facebook':
      return `【メインテキスト】\n${title}｜${nm}${area}\n\n【見出し】\n${title}\n\n【説明文】\n${detail}\n\n【本文】\nいつもありがとうございます。${nm}${area}です。${title}のお知らせです。${detail}${url}`;
    default: // instagram
      return `【メインテキスト】\n${title}✨ ${nm}${area}\n\n【キャプション（本文）】\n${title}のお知らせ！\n${detail}${url}${tag ? `\n\n【ハッシュタグ】\n#${tag}` : ''}\n\n【見出し(任意)】\n${title}`;
  }
}

// メイン。指定メディアの広告文（コピペ用・見出し付き）を返す。
export async function generateAdCopy({ store, campaign, media, ctaUrl, style, extra, bizType }) {
  if (!AD_FORMATS[media]) media = 'instagram';
  if (!hasKey()) return { media, body: fallback({ store, campaign, media, ctaUrl }), source: 'fallback' };
  try {
    const text = await generateText(buildPrompt({ store, campaign, media, ctaUrl, style, extra, bizType }), { maxTokens: 1600 });
    if (!text) throw new Error('empty');
    return { media, body: text, source: 'ai' };
  } catch (e) {
    return { media, body: fallback({ store, campaign, media, ctaUrl }), source: 'fallback', error: String(e.message || e) };
  }
}

// 複数メディアを同時生成
export async function generateAdCopies({ store, campaign, medias, ctaUrl, style, extra, bizType }) {
  const list = (medias && medias.length ? medias : ['instagram']).filter(m => AD_FORMATS[m]);
  return Promise.all(list.map(media => generateAdCopy({ store, campaign, media, ctaUrl, style, extra, bizType })));
}
