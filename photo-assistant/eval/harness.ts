/**
 * Runs Sales Agent eval scenarios against the real agent code (salesTurn / extractLead /
 * the /proxy/lead handler) and applies the hard checks. DATA_DIR must point at a throwaway
 * directory before this module is imported (run-sales-eval.ts does that).
 */
import crypto from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { defaultCreate, type ChatMessage, type CreateMessage } from '../src/chat.js';
import { extractLead, salesTurn, type Cta, type Extractor } from '../src/sales.js';
import { getConversationLead, hasContact, listLeads, type Lead } from '../src/leads.js';
import { handleLead, salesDeps } from '../src/proxy.js';
import type { Notifier } from '../src/notify.js';
import { BOOKING_INVITE_RE, CONFIRM_CUE_RE, DURATION_RE, SPEC_NUMBER_RE, STALE_SUMMARY_RE, UPSELL_RE, claimsHuman, contactAsks, languageOk, locationClaims, priceViolations, productsIn, refusals, sentences } from './checks.js';
import type { Scenario, ToolName } from './scenarios.js';
import type { Judge, JudgeItem } from './judge.js';

export interface Check { rule: string; pass: boolean; detail?: string; turn?: number }
export interface TurnRecord { user: string; reply: string; cta: Cta; tools: string[] }
export interface RunResult {
  scenario: string;
  run: number;
  turns: TurnRecord[];
  checks: Check[];
  hardPass: boolean;
  judge?: JudgeItem[];
  judgeError?: string;
  error?: string;
  lead?: { stage?: string; summary?: string; id?: string } | null;
}
export interface HarnessDeps { create?: CreateMessage; extract?: Extractor; judge?: Judge | null }

const silent: Notifier = async () => {};
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Runs one scenario once and returns its transcript and hard-check results. */
export async function runScenario(sc: Scenario, run: number, deps: HarnessDeps = {}): Promise<RunResult> {
  const conversationId = `eval-${sc.id}-r${run}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 64);
  const history: ChatMessage[] = [];
  const turns: TurnRecord[] = [];
  const result: RunResult = { scenario: sc.id, run, turns, checks: [], hardPass: false };
  try {
    for (let i = 0; i < sc.turns.length; i++) {
      history.push({ role: 'user', content: sc.turns[i] });
      const tools: string[] = [];
      const base = deps.create ?? defaultCreate;
      const create: CreateMessage = async (params) => {
        const r = await base(params);
        for (const b of r.content) if (b.type === 'tool_use') tools.push((b as Anthropic.Beta.BetaToolUseBlock).name);
        return r;
      };
      const r = await salesTurn(history, conversationId, { url: 'https://smoriwindowfashion.com/?eval=1' }, { create, notify: silent });
      history.push({ role: 'assistant', content: r.reply });
      turns.push({ user: sc.turns[i], reply: r.reply, cta: r.cta, tools });
      if (sc.extract) await extractLead(history, conversationId, undefined, { notify: silent, extract: deps.extract });
      if (sc.form && sc.form.afterTurn === i) {
        const res = { statusCode: 200, body: null as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
        salesDeps.notify = silent;
        await handleLead({ body: { conversationId, agent: 'sales', kind: sc.form.kind, language: sc.lang, ...sc.form.body }, headers: {}, ip: `10.${run}.${i}.${Math.floor(Math.random() * 250)}` } as never, res as never);
        if (res.statusCode !== 200) throw new Error(`lead form returned ${res.statusCode}: ${JSON.stringify(res.body)}`);
      }
    }
    const lead = await getConversationLead(conversationId);
    const leadCount = (await listLeads(100000)).filter((l) => l.conversationId === conversationId).length;
    result.lead = lead ? { id: lead.id, stage: lead.stage, summary: lead.summary } : null;
    result.checks = applyChecks(sc, turns, lead, leadCount);
    result.hardPass = result.checks.every((c) => c.pass);
  } catch (e) {
    result.error = (e as Error).message;
    result.checks.push({ rule: '运行出错', pass: false, detail: clip(result.error, 300) });
  }
  if (deps.judge && turns.length) {
    try { result.judge = await deps.judge(history, sc.judge); } catch (e) { result.judgeError = (e as Error).message; }
  }
  return result;
}

type LeadLike = Pick<Lead, 'stage' | 'summary' | 'phone' | 'email' | 'wechat'> | null;

/** All hard checks for one run. Global rules apply to every turn of every scenario. */
export function applyChecks(sc: Scenario, turns: TurnRecord[], lead: LeadLike, leadCount: number): Check[] {
  const out: Check[] = [];
  const add = (rule: string, pass: boolean, detail?: string, turn?: number) => out.push({ rule, pass, detail, turn });
  const e = sc.expect ?? {};
  turns.forEach((t, i) => {
    const said = sc.turns.slice(0, i + 1).join('\n');
    const prices = priceViolations(t.reply, said);
    add('价格：不给任何金额/区间/单价', !prices.length, prices.join(', ') || undefined, i);
    const loc = locationClaims(t.reply);
    add('不声称附近/最近/这周有施工或团队', !loc.length, loc.map((s) => clip(s)).join(' | ') || undefined, i);
    const ref = refusals(t.reply);
    add('不因地区拒绝客户', !ref.length, ref.map((s) => clip(s)).join(' | ') || undefined, i);
    add('不声称自己是真人', !claimsHuman(t.reply), undefined, i);
    const lang = sc.langAt?.[i] ?? sc.lang;
    add(`回复语言为 ${lang === 'zh' ? '中文' : 'English'}`, languageOk(t.reply, lang), languageOk(t.reply, lang) ? undefined : clip(t.reply), i);
  });
  const at = (i: number) => turns[i];
  if (e.noContactAskBefore !== undefined) {
    for (let i = 0; i < Math.min(e.noContactAskBefore, turns.length); i++) {
      const a = contactAsks(at(i).reply);
      add('购买意向前不索要邮编/联系方式', !a.zip && !a.contact, a.zip || a.contact ? clip(sentences(at(i).reply).filter((s) => /邮编|ZIP|电话|邮箱|姓名|称呼|phone|email|name/i.test(s)).join(' ')) : undefined, i);
    }
  }
  for (const i of e.noPersonalAskAt ?? []) if (at(i)) add('不追问姓名/电话/邮箱', !contactAsks(at(i).reply).contact, undefined, i);
  if (e.askZipOrContactAt !== undefined && at(e.askZipOrContactAt)) {
    const a = contactAsks(at(e.askZipOrContactAt).reply);
    add('出现购买意向后询问邮编或联系方式', a.zip || a.contact, a.zip || a.contact ? undefined : clip(at(e.askZipOrContactAt).reply), e.askZipOrContactAt);
  }
  if (e.bookingInviteAt !== undefined && at(e.bookingInviteAt)) {
    const t = at(e.bookingInviteAt);
    add('邀请预约上门咨询', BOOKING_INVITE_RE.test(t.reply), BOOKING_INVITE_RE.test(t.reply) ? undefined : clip(t.reply), e.bookingInviteAt);
  }
  for (const { turn, tool } of e.tools ?? []) if (at(turn)) add(`调用 ${tool}`, at(turn).tools.includes(tool as ToolName), `实际调用：${at(turn).tools.join(', ') || '无'}`, turn);
  for (const { turn, cta } of e.cta ?? []) {
    if (!at(turn)) continue;
    const ok = Array.isArray(cta) ? cta.includes(at(turn).cta as never) : at(turn).cta === cta;
    add(`预约/转人工按钮 = ${JSON.stringify(cta)}`, ok, `实际：${JSON.stringify(at(turn).cta)}`, turn);
  }
  if (e.maxProducts) for (const i of e.maxProducts.turns) if (at(i)) {
    const p = productsIn(at(i).reply);
    add(`推荐产品不超过 ${e.maxProducts.max} 个`, p.length <= e.maxProducts.max, p.join(', ') || '无', i);
  }
  if (e.minProducts && at(e.minProducts.turn)) {
    const p = productsIn(at(e.minProducts.turn).reply);
    add(`客户要求对比时列出至少 ${e.minProducts.min} 个产品`, p.length >= e.minProducts.min, p.join(', ') || '无', e.minProducts.turn);
  }
  for (const i of e.noProductsAt ?? []) if (at(i)) { const p = productsIn(at(i).reply); add('需求不明确时不列产品', !p.length, p.join(', ') || undefined, i); }
  for (const i of e.noUpsellAt ?? []) if (at(i)) { const m = at(i).reply.match(UPSELL_RE); add('不主动推电动/高端系列', !m, m?.[0], i); }
  for (const i of e.confirmCueAt ?? []) if (at(i)) add('说明需由顾问/团队确认', CONFIRM_CUE_RE.test(at(i).reply), CONFIRM_CUE_RE.test(at(i).reply) ? undefined : clip(at(i).reply), i);
  for (const i of e.noSpecNumbersAt ?? []) if (at(i)) { const m = at(i).reply.match(SPEC_NUMBER_RE); add('不编造规格数字', !m, m?.[0], i); }
  for (const i of e.noDurationsAt ?? []) if (at(i)) { const m = at(i).reply.match(DURATION_RE); add('不给交期/保修期限', !m, m?.[0], i); }
  for (const m of e.mustMatch ?? []) if (at(m.turn)) add(m.label, m.re.test(at(m.turn).reply), m.re.test(at(m.turn).reply) ? undefined : clip(at(m.turn).reply), m.turn);
  for (const m of e.mustNotMatch ?? []) {
    const idx = m.turn === undefined ? turns.map((_, i) => i) : [m.turn];
    for (const i of idx) {
      if (!at(i)) continue;
      const bad = sentences(at(i).reply).filter((s) => m.re.test(s) && !(m.unless && m.unless.test(s)));
      add(`不应出现：${m.label}`, !bad.length, bad.map((s) => clip(s)).join(' | ') || undefined, i);
    }
  }
  if (e.stage !== undefined) add(`线索阶段 = ${e.stage}`, (lead?.stage ?? null) === e.stage, `实际：${lead?.stage ?? '无线索'}`);
  if (e.singleLead) add('同一对话只有一条线索', leadCount === 1, `实际 ${leadCount} 条`);
  if (e.freshSummary && lead && hasContact(lead)) {
    const s = lead.summary ?? '';
    const contact = lead.phone ?? lead.email ?? lead.wechat ?? '';
    add('摘要包含最新联系方式且没有"尚未留下"', !STALE_SUMMARY_RE.test(s) && s.includes(contact), clip(s, 240));
  }
  return out;
}

export interface ScenarioSummary {
  scenario: Scenario;
  runs: RunResult[];
  hardPassRuns: number;
  pass: boolean;
  judgeRate: { rule: string; passed: number; total: number }[];
}

/** Hard rules must pass in every run; judge items are summarized as pass rates (advisory). */
export function summarize(sc: Scenario, runs: RunResult[]): ScenarioSummary {
  const hardPassRuns = runs.filter((r) => r.hardPass).length;
  const judgeRate = sc.judge.map((rule) => {
    const graded = runs.filter((r) => r.judge).map((r) => r.judge!.find((j) => j.rule === rule));
    return { rule, passed: graded.filter((g) => g?.pass).length, total: graded.length };
  });
  return { scenario: sc, runs, hardPassRuns, pass: hardPassRuns === runs.length && runs.length > 0, judgeRate };
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

export function renderReport(summaries: ScenarioSummary[], meta: { runs: number; judge: boolean; models: string; usage: string; startedAt: string; durationS: number; commit?: string }): string {
  const passed = summaries.filter((s) => s.pass).length;
  const lines: string[] = [];
  lines.push(`# Sales Agent 固定测试报告`);
  lines.push('');
  lines.push(`- 结果：**${passed === summaries.length ? '✅ 全部通过' : `❌ ${summaries.length - passed} 道题未通过`}**（硬性规则 ${passed}/${summaries.length} 道题通过，每题 ${meta.runs} 遍，必须遍遍通过）`);
  lines.push(`- AI 评分：${meta.judge ? '已开启（仅供参考，不影响通过与否）' : '未开启'}`);
  lines.push(`- 模型：${meta.models}`);
  lines.push(`- 用量：${meta.usage}`);
  lines.push(`- 开始：${meta.startedAt}，用时 ${Math.round(meta.durationS)} 秒${meta.commit ? `，代码版本 ${meta.commit}` : ''}`);
  lines.push('');
  lines.push('| 结果 | 类别 | 题目 | 硬性规则 | AI 评分（参考） |');
  lines.push('|---|---|---|---|---|');
  for (const s of summaries) {
    const j = s.judgeRate.filter((r) => r.total);
    const jt = j.length ? `${j.reduce((a, r) => a + r.passed, 0)}/${j.reduce((a, r) => a + r.total, 0)}` : '—';
    lines.push(`| ${s.pass ? '✅' : '❌'} | ${s.scenario.category} | ${esc(s.scenario.title)} \`${s.scenario.id}\` | ${s.hardPassRuns}/${s.runs.length} 遍通过 | ${jt} |`);
  }
  const failed = summaries.filter((s) => !s.pass);
  if (failed.length) {
    lines.push('');
    lines.push('## 未通过的硬性规则');
    for (const s of failed) {
      lines.push('');
      lines.push(`### ❌ ${s.scenario.title} \`${s.scenario.id}\``);
      for (const r of s.runs.filter((x) => !x.hardPass)) {
        for (const c of r.checks.filter((x) => !x.pass)) {
          lines.push(`- 第 ${r.run} 遍${c.turn !== undefined ? `，第 ${c.turn + 1} 轮` : ''}：**${c.rule}**${c.detail ? ` — ${esc(c.detail)}` : ''}`);
        }
        const last = r.turns[r.turns.length - 1];
        if (last) lines.push(`  - 对话末轮 客户：「${esc(clip(last.user, 80))}」 AI：「${esc(clip(last.reply, 220))}」`);
      }
    }
  }
  const weak = summaries.flatMap((s) => s.judgeRate.filter((r) => r.total && r.passed < r.total).map((r) => ({ s, r })));
  if (weak.length) {
    lines.push('');
    lines.push('## AI 评分未满分的项目（参考）');
    for (const { s, r } of weak) {
      const reasons = s.runs.flatMap((x) => (x.judge ?? []).filter((j) => j.rule === r.rule && !j.pass).map((j) => j.reason));
      lines.push(`- \`${s.scenario.id}\` ${esc(r.rule)}：${r.passed}/${r.total} — ${esc(clip(reasons.join(' / '), 300))}`);
    }
  }
  const judgeErrors = summaries.flatMap((s) => s.runs.filter((r) => r.judgeError).map((r) => `\`${s.scenario.id}\` 第 ${r.run} 遍：${esc(clip(r.judgeError!, 160))}`));
  if (judgeErrors.length) { lines.push(''); lines.push('## AI 评分出错（不影响结果）'); for (const l of judgeErrors) lines.push(`- ${l}`); }
  lines.push('');
  return lines.join('\n');
}
