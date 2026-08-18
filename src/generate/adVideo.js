// 広告動画ビルダー。テンプレート(型)に沿ってシーンのテロップをAI生成し、既存スライドショーエンジンで合成する。
// 既存 generateSlideshow を流用（9:16実装済み）。将来 1:1/16:9 はエンジン側拡張で対応予定。
import Anthropic from '@anthropic-ai/sdk';
import { getAdVideoTemplate, AD_VIDEO_ASPECTS } from './adVideoTemplates.js';
import { generateSlideshow } from './video.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const hasKey = () => !!process.env.ANTHROPIC_API_KEY;

const TONE_TXT = { polite: 'です・ます調', casual: 'だ・である調', friendly: 'やわらかい口語' };

// テンプレの各シーン用テロップ（短い惹句）を一括生成。JSON配列で受け取り、失敗時は雛形にフォールバック。
async function buildCaptions({ store, campaign, template, style, extra }) {
  const scenes = template.scenes;
  if (!hasKey()) return fallbackCaptions({ store, campaign, scenes });
  const sceneList = scenes.map((s, i) => `${i + 1}. [${s.kind}] ${s.prompt}`).join('\n');
  const styleLine = style?.tone ? `文体: ${TONE_TXT[style.tone] || ''}${style.emoji === false ? '・絵文字控えめ' : ''}` : '';
  const prompt = `あなたは反応率の高い動画広告のコピーライターです。買取店の広告動画に焼き込む「短いテロップ」を作ります。

# 店舗
- 店名: ${store.name} / エリア: ${store.area || '未設定'}
# 訴求（キャンペーン）
- ${campaign ? `${campaign.title}｜${campaign.detail || ''}` : '買取キャンペーン'}
${extra ? `# 追加指示\n- ${extra}` : ''}
${styleLine ? `# ${styleLine}` : ''}

# 各シーンのテロップ（順番どおり、それぞれ指定の文字数目安で。動画に焼くので短く強く）
${sceneList}

# 出力形式（重要）
- 各シーンのテロップだけを、1行に1つ、番号や記号を付けずに、上の順番で ${scenes.length} 行出力。
- 誇大表現・断定的な買取額保証は避ける（景表法配慮）。`;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] });
    const text = (msg.content || []).map(b => (b.type === 'text' ? b.text : '')).join('').trim();
    const lines = text.split('\n').map(s => s.replace(/^\s*\d+[.、)]\s*/, '').trim()).filter(Boolean);
    if (lines.length < scenes.length) throw new Error('not enough lines');
    return lines.slice(0, scenes.length);
  } catch {
    return fallbackCaptions({ store, campaign, scenes });
  }
}

function fallbackCaptions({ store, campaign, scenes }) {
  const title = campaign?.title || 'お得に買取';
  const nm = store.name;
  const map = {
    hook: title.slice(0, 16),
    benefit: (campaign?.detail || '高価買取実施中').slice(0, 20),
    proof: '査定無料・その場で現金',
    cta: '今すぐ無料査定',
  };
  return scenes.map(s => map[s.kind] || nm);
}

// メイン。広告動画を生成して { videoUrl, seconds, ... } を返す（生成物は data/assets/<store> に保存）。
export async function generateAdVideo({ store, campaign, templateKey, aspect = '9:16', ctaUrl, ctaLabel, style, extra, images = [], bgmPath = null, autoBgm = true }) {
  const template = getAdVideoTemplate(templateKey) || getAdVideoTemplate('standard');
  const asp = AD_VIDEO_ASPECTS[aspect] || AD_VIDEO_ASPECTS['9:16'];
  const captions = await buildCaptions({ store, campaign, template, style, extra });
  // シーン数に合わせて1枚あたり秒数を決める（テンプレの平均尺）。写真が少なければ既存ロジックが単色/ループで補完。
  const avgPer = Math.round(template.scenes.reduce((a, s) => a + s.seconds, 0) / template.scenes.length) || 4;

  // 比率のW/Hをエンジンに渡す（9:16/1:1/16:9すべて対応）。
  const result = await generateSlideshow({
    storeId: store.id, brandColor: store.brand_color, ctaUrl,
    ctaLabel: ctaLabel || 'この店に今すぐ査定',
    images, captions, perSlide: Math.max(2, Math.min(6, avgPer)),
    autoBgm, bgmPath, width: asp.w, height: asp.h,
  });
  return { ...result, template: templateKey, aspect: AD_VIDEO_ASPECTS[aspect] ? aspect : '9:16', captions };
}
