// 広告動画ビルダー。テンプレート(型)に沿ってシーンのテロップをAI生成し、既存スライドショーエンジンで合成する。
// 既存 generateSlideshow を流用（9:16実装済み）。将来 1:1/16:9 はエンジン側拡張で対応予定。
import { getAdVideoTemplate, AD_VIDEO_ASPECTS } from './adVideoTemplates.js';
import { generateSlideshow } from './video.js';
import { generateText, aiEnabled } from './ai.js';

const hasKey = () => aiEnabled();

const TONE_TXT = { polite: 'です・ます調', casual: 'だ・である調', friendly: 'やわらかい口語' };

// テンプレの各シーン用テロップ（短い惹句）を一括生成。JSON配列で受け取り、失敗時は雛形にフォールバック。
// bizType=業種名(任意)。業種非依存のため、指定があればそれに合わせ、無ければ中立の表現にする。
export async function buildCaptions({ store, campaign, template, style, extra, bizType }) {
  const scenes = template.scenes;
  if (!hasKey()) return fallbackCaptions({ store, campaign, scenes });
  const sceneList = scenes.map((s, i) => `${i + 1}. [${s.kind}] ${s.prompt}`).join('\n');
  const styleLine = style?.tone ? `文体: ${TONE_TXT[style.tone] || ''}${style.emoji === false ? '・絵文字控えめ' : ''}` : '';
  const biz = (bizType || '').trim();
  const prompt = `あなたは反応率の高い動画広告のコピーライターです。事業者の広告動画に焼き込む「短いテロップ」を作ります。

# 事業者
- 名称: ${store.name} / エリア: ${store.area || '未設定'}${biz ? ` / 業種: ${biz}` : ''}
# 訴求（キャンペーン）
- ${campaign ? `${campaign.title}${campaign.discount_type ? `（種別: ${campaign.discount_type}）` : ''}｜${campaign.detail || ''}` : (extra ? '（下記の追加指示に沿って訴求）' : 'おすすめ・キャンペーン')}
${extra ? `# 追加指示（最優先で反映）\n- ${extra}` : ''}
${styleLine ? `# ${styleLine}` : ''}

# 各シーンのテロップ（順番どおり、それぞれ指定の文字数目安で。動画に焼くので短く強く）
${sceneList}

# 重要な制約
- この事業者の業種は上記のとおり。特定業種（例: 買取・査定など）を勝手に想定せず、与えられた情報と追加指示だけに忠実に。
- 業種が不明なら、特定サービスを断定しない中立的で汎用的な表現にする。

# 出力形式（重要）
- 各シーンのテロップだけを、1行に1つ、番号や記号を付けずに、上の順番で ${scenes.length} 行出力。
- 誇大表現・断定的な効果保証は避ける（景表法配慮）。`;
  try {
    const text = await generateText(prompt, { maxTokens: 500 });
    if (!text) throw new Error('no ai');
    const lines = text.split('\n').map(s => s.replace(/^\s*\d+[.、)]\s*/, '').trim()).filter(Boolean);
    if (lines.length < scenes.length) throw new Error('not enough lines');
    return lines.slice(0, scenes.length);
  } catch {
    return fallbackCaptions({ store, campaign, scenes });
  }
}

// 業種非依存の中立的な雛形（AI無効/失敗時）。特定業種の語（査定/買取等）は使わない。
function fallbackCaptions({ store, campaign, scenes }) {
  const title = campaign?.title || 'お知らせ';
  const nm = store.name;
  const map = {
    hook: title.slice(0, 16),
    benefit: (campaign?.detail || 'ただいまおすすめ実施中').slice(0, 20),
    proof: '地域で選ばれています',
    cta: '詳しくはこちら',
  };
  return scenes.map(s => map[s.kind] || nm);
}

// メイン。広告動画を生成して { videoUrl, seconds, ... } を返す（生成物は data/assets/<store> に保存）。
export async function generateAdVideo({ store, campaign, templateKey, aspect = '9:16', ctaUrl, ctaLabel, style, extra, bizType, captions: userCaptions = null, images = [], clips = [], clipSeconds = 6, clipSpeeds = [], colorGrade = 'none', logoPath = null, logoPos = 'top-right', logoSize = 'medium', bgmPath = null, autoBgm = true, transition = 'fade', opening = true, showTelop = true, narration = false, narrVoice = null, narrSpeed = 1.05, narrTone = 'normal' }) {
  const template = getAdVideoTemplate(templateKey) || getAdVideoTemplate('standard');
  const asp = AD_VIDEO_ASPECTS[aspect] || AD_VIDEO_ASPECTS['9:16'];
  // ユーザーが編集したテロップがあれば優先。空要素はAI/雛形で補完。無ければ全部AI生成。
  const captions = (Array.isArray(userCaptions) && userCaptions.some(x => (x || '').trim()))
    ? userCaptions.map(x => (x || '').trim())
    : await buildCaptions({ store, campaign, template, style, extra, bizType });
  // シーン数に合わせて1枚あたり秒数を決める（テンプレの平均尺）。写真が少なければ既存ロジックが単色/ループで補完。
  const avgPer = Math.round(template.scenes.reduce((a, s) => a + s.seconds, 0) / template.scenes.length) || 4;

  // 比率のW/Hをエンジンに渡す（9:16/1:1/16:9すべて対応）。opening=trueで冒頭に店名ブランド面。
  const result = await generateSlideshow({
    storeId: store.id, brandColor: store.brand_color, ctaUrl,
    ctaLabel: ctaLabel || '詳しくはこちら',
    images, captions, perSlide: Math.max(2, Math.min(6, avgPer)),
    autoBgm, bgmPath, width: asp.w, height: asp.h,
    transition, openingText: opening ? (store.name || null) : null,
    clips, clipSeconds, clipSpeeds, colorGrade, logoPath, logoPos, logoSize, // 動画クリップ素材＋個別秒数/速度/色補正/ロゴ(位置/サイズ)
    showTelop, narration, narrVoice, narrSpeed, narrTone, // テロップ表示ON/OFF・AIナレーションON/OFF・声/話速/トーン
  });
  return { ...result, template: templateKey, aspect: AD_VIDEO_ASPECTS[aspect] ? aspect : '9:16', transition, captions };
}
