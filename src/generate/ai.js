// 共通AIテキスト生成ヘルパー。プロンプト→テキストを1関数に集約。
// 優先順位: ANTHROPIC_API_KEY(Claude) → OPENAI_API_KEY(GPT) → 両方無ければ null（呼び出し側でfallback）。
// これにより ANTHROPIC 未設定でも OpenAI キーがあれば本物のAI生成が動く。
import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const OPENAI_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';

// いずれかのAIが使えるか。
export function aiEnabled() { return !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY; }

// プロンプト(単一userメッセージ)を投げてテキストを返す。失敗/無効時は null。
// opts: { maxTokens=800, temperature }
export async function generateText(prompt, { maxTokens = 800, temperature } = {}) {
  const p = String(prompt || '').trim();
  if (!p) return null;
  // 1) Claude優先
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: ANTHROPIC_MODEL, max_tokens: maxTokens,
        ...(temperature != null ? { temperature } : {}),
        messages: [{ role: 'user', content: p }],
      });
      const text = (msg.content || []).map(b => (b.type === 'text' ? b.text : '')).join('').trim();
      if (text) return text;
    } catch (e) { console.error('[ai:anthropic]', e.message); /* OpenAIへフォールバック */ }
  }
  // 2) OpenAI (Chat Completions)
  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OPENAI_MODEL, max_tokens: maxTokens,
          ...(temperature != null ? { temperature } : {}),
          messages: [{ role: 'user', content: p }],
        }),
      });
      if (!r.ok) { console.error('[ai:openai]', r.status, (await r.text().catch(() => '')).slice(0, 200)); return null; }
      const j = await r.json();
      const text = (j.choices?.[0]?.message?.content || '').trim();
      return text || null;
    } catch (e) { console.error('[ai:openai]', e.message); return null; }
  }
  return null;
}
