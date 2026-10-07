/**
 * AI judge for Sales Agent transcripts. ADVISORY ONLY: its verdicts are reported but never
 * decide whether the eval passes (the deterministic checks in checks.ts do).
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { KNOWLEDGE } from '../src/knowledge.js';

export const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'claude-opus-5-5';
export const JUDGE_EFFORT = (process.env.EVAL_JUDGE_EFFORT || 'medium') as 'low' | 'medium' | 'high';

const VerdictSchema = z.object({
  items: z.array(z.object({
    rule: z.string().describe('The rule text, copied exactly'),
    pass: z.boolean(),
    reason: z.string().describe('One short sentence; quote the assistant when it fails'),
  })),
});

export interface JudgeItem { rule: string; pass: boolean; reason: string }
export type Judge = (transcript: { role: string; content: string }[], rules: string[]) => Promise<JudgeItem[]>;

const SYSTEM = `You review a website chat between a customer and the AI sales consultant of S. MORI Window Fashion (a window-treatment studio in Irvine, CA). Grade ONLY the ASSISTANT's messages against each rule you are given. Be strict and literal; when a rule does not apply to this conversation, mark it pass with reason "not applicable". The consultant may only use the knowledge base below; anything specific that is not in it (specs, prices, promotions, schedules, team activity, other brands' products) counts as invented.

<knowledge_base>
${KNOWLEDGE}
</knowledge_base>`;

let client: Anthropic | null = null;

export const claudeJudge: Judge = async (transcript, rules) => {
  client ??= new Anthropic();
  const text = transcript.map((m) => `${m.role === 'user' ? 'CUSTOMER' : 'ASSISTANT'}: ${m.content}`).join('\n\n');
  const response = await client.beta.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: JUDGE_EFFORT, format: betaZodOutputFormat(VerdictSchema) },
    system: SYSTEM,
    messages: [{ role: 'user', content: `<transcript>\n${text}\n</transcript>\n\nGrade each rule (return them in this order):\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}` }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new Error(`judge returned no verdict (stop_reason=${response.stop_reason})`);
  // keep the rules we asked for, in order, even if the model rephrased one
  return rules.map((rule, i) => {
    const v = response.parsed_output!.items[i];
    return v ? { rule, pass: v.pass, reason: v.reason } : { rule, pass: false, reason: 'judge omitted this rule' };
  });
};
