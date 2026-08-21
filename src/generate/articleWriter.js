// ブログ/HP用の記事ライター。文体プロファイル(お手本)を使い、生成/共同編集アクションを1関数で扱う。
// キャンペーン投稿(article.js)とは別。長め記事・人とAIの往復編集が前提。
import { generateText, aiEnabled } from './ai.js';

const hasKey = () => aiEnabled();

// 対応アクション
export const ACTIONS = ['generate', 'continue', 'polish', 'expand', 'shorten', 'restyle', 'custom'];

const TONE_TXT = { polite: 'です・ます調', casual: 'だ・である調', friendly: 'やわらかく親しみやすい口語' };
const HARD_TXT = { soft: 'やわらかめ', normal: '標準的', hard: '硬め・かっちり' };
const LEN_TXT = { short: '400〜600字程度', medium: '800〜1200字程度', long: '1500〜2500字程度' };

// 文体プロファイルを「お手本」指示に変換
function styleGuide(style = {}) {
  const s = style || {};
  const lines = [
    `- 文体: ${TONE_TXT[s.tone] || TONE_TXT.polite}`,
    `- 硬さ: ${HARD_TXT[s.hardness] || HARD_TXT.normal}`,
    `- 絵文字: ${s.emoji ? '適度に使う' : '使わない'}`,
    `- 目安の長さ: ${LEN_TXT[s.length] || LEN_TXT.medium}`,
  ];
  if (s.notes && s.notes.trim()) lines.push(`- 追加の指示: ${s.notes.trim()}`);
  const samples = (Array.isArray(s.samples) ? s.samples : []).filter(x => x && x.trim()).slice(0, 5);
  let sampleBlock = '';
  if (samples.length) {
    sampleBlock = `\n# お手本の文章（この書き手の文体・語彙・リズムを真似てください。内容はコピーしない）\n` +
      samples.map((t, i) => `【お手本${i + 1}】\n${t.trim().slice(0, 1200)}`).join('\n\n');
  }
  return { guideLines: lines.join('\n'), sampleBlock };
}

function storeBlock(store = {}) {
  return `# 店舗\n- 店名: ${store.name || ''}\n- エリア: ${store.area || '（未設定）'}\n- 業種: 買取店`;
}

// アクション別の指示文
function actionInstruction({ action, theme, currentBody, instruction }) {
  switch (action) {
    case 'generate':
      return `# タスク\n次のテーマで、上のお手本の文体に合わせたブログ/HP記事を新規に書いてください。\n- テーマ: ${theme || 'お店のお役立ち情報'}\n- 見出し(##)で構成し、読み物として成立させる。\n- 誇大表現・断定的な買取額保証は避ける（景表法配慮）。`;
    case 'continue':
      return `# タスク\n以下の記事の「続き」を、同じ文体で自然に書き足してください。既存部分は出力せず、続きの本文だけを出力。\n\n# これまでの本文\n${currentBody || ''}`;
    case 'polish':
      return `# タスク\n以下の記事を、意味を変えずに文体を整え校正してください（誤字脱字・言い回し・読みやすさ）。整えた全文を出力。\n\n# 対象の本文\n${currentBody || ''}`;
    case 'expand':
      return `# タスク\n以下の記事を、同じ文体でより詳しく膨らませてください（具体例・補足・見出し追加など）。膨らませた全文を出力。\n\n# 対象の本文\n${currentBody || ''}`;
    case 'shorten':
      return `# タスク\n以下の記事を、要点を残して簡潔に短くしてください。短くした全文を出力。\n\n# 対象の本文\n${currentBody || ''}`;
    case 'restyle':
      return `# タスク\n以下の記事を、上のお手本の文体に合わせて書き直してください。内容は保ちつつ文体だけ寄せる。書き直した全文を出力。\n\n# 対象の本文\n${currentBody || ''}`;
    case 'custom':
      return `# タスク\n以下の記事に対して、ユーザーの指示を反映してください。反映後の全文を出力。\n\n# ユーザーの指示\n${instruction || ''}\n\n# 対象の本文\n${currentBody || ''}`;
    default:
      return `# タスク\n${theme || ''}についての記事を書いてください。`;
  }
}

function buildPrompt({ store, style, action, theme, currentBody, instruction }) {
  const { guideLines, sampleBlock } = styleGuide(style);
  return `あなたは買取店の集客に強いプロのブログ/Webライターです。指定の文体を忠実に真似て執筆します。

${storeBlock(store)}

# 文体ガイド（厳守）
${guideLines}${sampleBlock}

${actionInstruction({ action, theme, currentBody, instruction })}

記事の本文だけを出力してください（前置き・説明・「本文:」等のラベルは不要）。`;
}

// キー未設定時の簡易フォールバック（人が続けて編集できる最低限の土台）
function fallback({ action, theme, currentBody, store }) {
  const nm = store?.name || '当店';
  if (action === 'generate') {
    return `## ${theme || 'お役立ち情報'}\n\n${nm}です。${theme || 'このテーマ'}についてご紹介します。\n\n（ここに本文を書いてください。AI生成を使うには Claude APIキーの設定が必要です）\n\n## まとめ\nご相談はお気軽にどうぞ。`;
  }
  if (action === 'shorten') return (currentBody || '').slice(0, Math.ceil((currentBody || '').length / 2));
  if (action === 'continue') return (currentBody || '') + '\n\n（続き：AI生成にはAPIキーが必要です）';
  return currentBody || '';
}

// メイン。action に応じて生成/編集した本文文字列を返す。
export async function writeArticle({ store, style, action, theme, currentBody, instruction }) {
  if (!ACTIONS.includes(action)) action = 'generate';
  if (!hasKey()) return { body: fallback({ action, theme, currentBody, store }), source: 'fallback' };
  try {
    const text = await generateText(buildPrompt({ store, style, action, theme, currentBody, instruction }), { maxTokens: 3000 });
    if (!text) throw new Error('empty');
    return { body: text, source: 'ai' };
  } catch (e) {
    return { body: fallback({ action, theme, currentBody, store }), source: 'fallback', error: String(e.message || e) };
  }
}
