// チャネル別記事生成。Claude 主経路 + フォールバック（APIキー無/失敗時はテンプレ）。
// 各SNS/媒体の特徴に応じて文体・構成・文字数を変える。複数チャネル同時生成に対応。
import { generateText, aiEnabled } from './ai.js';

// チャネル別プロファイル（媒体特性を反映）
export const CHANNEL_PROFILES = {
  instagram: {
    label: 'Instagram', maxLen: 2000, hashtags: 6,
    tone: 'ビジュアル前提・親しみやすく絵文字を交える・共感から入る',
    structure: '1行目に強いフック→キャンペーンの魅力→利用するメリット→行動喚起。改行を多めに読みやすく。',
  },
  x: {
    label: 'X', maxLen: 130, hashtags: 2,
    tone: '端的・フック最優先・1ポストで完結・煽りすぎない',
    structure: '最初の一撃で惹きつけ、キャンペーン核だけ。冗長禁止。',
  },
  facebook: {
    label: 'Facebook', maxLen: 1200, hashtags: 3,
    tone: 'やや年齢層高め・丁寧で信頼感・地域密着の語り口',
    structure: '挨拶→キャンペーン背景/理由→具体メリット→来店の呼びかけ。落ち着いた文体。',
  },
  blog: {
    label: 'ブログ', maxLen: 2500, hashtags: 0,
    tone: '情報記事調・見出しで整理・SEOを意識した自然な語彙',
    structure: '見出し(##)を数個使い、導入→キャンペーン詳細→ご利用の流れ/よくある質問→まとめ。読み物として成立させる。',
  },
  homepage: {
    label: 'ホームページ', maxLen: 1500, hashtags: 0,
    tone: '公式サイトのお知らせ調・信頼性重視・過度な煽り無し',
    structure: 'タイトル的な一文→キャンペーン概要（期間/対象/特典）→注意事項→問い合わせ導線。箇条書きを活用。',
  },
  gbp: {
    label: 'Googleビジネスプロフィール', maxLen: 700, hashtags: 0,
    tone: '簡潔・検索ユーザー向け・最新情報の告知調',
    structure: '要点先出し（何が/いつまで/どこで）。1〜2段落で完結。ローカル検索を意識。',
  },
  line: {
    label: 'LINE', maxLen: 300, hashtags: 0,
    tone: '案内的・丁寧・短文・友だち向けのやわらかさ',
    structure: '一言挨拶→キャンペーン→ひとこと誘導。',
  },
};

export function listChannels() {
  return Object.entries(CHANNEL_PROFILES).map(([key, v]) => ({ key, label: v.label, maxLen: v.maxLen }));
}

function hasKey() { return aiEnabled(); }

function buildPrompt({ store, campaign, channel, bizType }) {
  const p = CHANNEL_PROFILES[channel] || CHANNEL_PROFILES.instagram;
  const biz = (bizType || '').trim();
  return `あなたは集客に強いSNS/Web運用者です。以下の事業者とキャンペーンをもとに、【${p.label}】向けの投稿本文を1つ作成してください。

# 事業者
- 名称: ${store.name}
- エリア: ${store.area || '（未設定）'}
${biz ? `- 業種: ${biz}` : '- 業種: （指定なし。特定業種を勝手に想定しない）'}

# 今日の訴求（キャンペーン）
- タイトル: ${campaign.title}
- 詳細: ${campaign.detail || '（なし）'}
- 有効期限: ${campaign.valid_to || '（未設定）'}

# この媒体の書き方
- トーン: ${p.tone}
- 構成: ${p.structure}
- 文字数: ${p.maxLen}文字以内（厳守）
- 末尾のCTA（リンク/QRの案内文）は書かない。本文のみ。
- 業種は上記のとおり。特定業種（例: 買取・査定など）を勝手に想定せず、与えられた情報に忠実に。業種不明なら中立的で汎用的に。
- 誇大表現・断定的な効果保証は避ける（景表法配慮）。
- ${p.hashtags ? `ハッシュタグを${p.hashtags}個ほど本文末尾に付ける（業種・訴求に合ったもの）。` : 'ハッシュタグは不要。'}

本文だけを出力してください（前置き・説明・見出し「本文:」などは不要）。`;
}

function fallback({ store, campaign, channel }) {
  const p = CHANNEL_PROFILES[channel] || CHANNEL_PROFILES.instagram;
  const area = store.area || '';
  const period = campaign.valid_to ? `\n期間: ${campaign.valid_to}まで` : '';
  let base;
  switch (channel) {
    case 'x':
      base = `【${campaign.title}】${store.name}${area ? `(${area})` : ''}。${campaign.detail || 'お得なキャンペーン実施中'}`;
      break;
    case 'blog':
      base = `## ${campaign.title}\n\n${store.name}${area ? `（${area}）` : ''}では、ただいま「${campaign.title}」を実施しています。\n\n${campaign.detail || 'この機会にぜひご利用ください。'}${period}\n\n## ご利用の流れ\n1. お問い合わせ・ご相談\n2. 内容のご案内・ご確認\n3. ご利用\n\n## まとめ\nこの機会に、ぜひお気軽にご相談ください。`;
      break;
    case 'homepage':
    case 'gbp':
      base = `${campaign.title}\n\n${store.name}${area ? `（${area}）` : ''}にて実施中のキャンペーンのお知らせです。\n・内容: ${campaign.detail || campaign.title}${period}\n\nお気軽にお問い合わせください。`;
      break;
    case 'facebook':
      base = `いつもありがとうございます。${store.name}${area ? `（${area}）` : ''}です。\n\nただいま「${campaign.title}」を実施しております。${campaign.detail || ''}${period}\n\nこの機会にぜひお立ち寄りください。`;
      break;
    case 'line':
      base = `${store.name}です。\n「${campaign.title}」実施中！${campaign.detail || ''}${period}\nお気軽にご相談ください。`;
      break;
    default: // instagram
      base = `【${campaign.title}】\n${store.name}${area ? `（${area}）` : ''}\n\n${campaign.detail || 'お得なキャンペーン実施中です。'}${period}`;
  }
  if (p.hashtags && area) base += `\n\n#${area.replace(/\s/g, '')}`;
  return base.slice(0, p.maxLen);
}

export async function generateArticle({ store, campaign, channel, bizType }) {
  if (!hasKey()) return { channel, body: fallback({ store, campaign, channel }), source: 'fallback' };
  try {
    const text = await generateText(buildPrompt({ store, campaign, channel, bizType }), { maxTokens: 1500 });
    if (!text) throw new Error('empty');
    const p = CHANNEL_PROFILES[channel] || CHANNEL_PROFILES.instagram;
    return { channel, body: text.slice(0, p.maxLen + 60), source: 'ai' };
  } catch (e) {
    return { channel, body: fallback({ store, campaign, channel }), source: 'fallback', error: String(e.message || e) };
  }
}

// 複数チャネルを同時生成（並行）
export async function generateArticles({ store, campaign, channels, bizType }) {
  const list = (channels && channels.length ? channels : ['instagram']).filter(c => CHANNEL_PROFILES[c]);
  return Promise.all(list.map(channel => generateArticle({ store, campaign, channel, bizType })));
}

// 記事末尾に CTA（査定リンク/QRの案内）を付与
export function appendCta(body, { ctaLabel, url }) {
  return `${body}\n\n▼${ctaLabel}\n${url}`;
}
