/**
 * Sales Agent eval runner (real model). Needs ANTHROPIC_API_KEY.
 *
 *   npm run eval:sales -- [--runs 3] [--only id1,id2] [--no-judge] [--out eval-report] [--concurrency 3]
 *
 * Isolation: leads go to a temporary DATA_DIR that is deleted afterwards, and push
 * notifications are disabled, so a run never touches production data or phones.
 * Exit code 1 when any hard rule fails (AI-judge results never change the exit code).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const runs = Math.min(10, Math.max(1, Math.floor(Number(arg('runs', '3'))) || 3)); // capped to keep costs bounded
const only = (arg('only', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const useJudge = !process.argv.includes('--no-judge');
const outDir = path.resolve(arg('out', 'eval-report')!);
const concurrency = Math.min(8, Math.max(1, Math.floor(Number(arg('concurrency', process.env.EVAL_CONCURRENCY ?? '3'))) || 3));

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('ANTHROPIC_API_KEY is not set. In GitHub: Settings → Secrets and variables → Actions → ANTHROPIC_API_KEY.');
  process.exit(2);
}

// isolate all writes before any app module reads config
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-eval-'));
process.env.DATA_DIR = dataDir;
process.env.NTFY_TOPIC = '';
process.env.PROXY_SIGNATURE_OPTIONAL = 'false';

/* token usage of every Messages API call (chat, extraction, judge), by model */
type Usage = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number };
const usage = new Map<string, Usage>();
const realFetch = globalThis.fetch;
const pendingUsage: Promise<void>[] = [];
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const res = await realFetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/v1/messages') && res.ok) {
    pendingUsage.push(res.clone().json().then((j: { model?: string; usage?: Record<string, number> }) => {
      const u = usage.get(j.model ?? '?') ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      u.calls++;
      u.input += j.usage?.input_tokens ?? 0;
      u.output += j.usage?.output_tokens ?? 0;
      u.cacheRead += j.usage?.cache_read_input_tokens ?? 0;
      u.cacheWrite += j.usage?.cache_creation_input_tokens ?? 0;
      usage.set(j.model ?? '?', u);
    }).catch(() => undefined));
  }
  return res;
}) as typeof fetch;

/* USD per million tokens (input, output), Anthropic first-party list prices; estimate only */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5],
};
function usageText(): string {
  let total = 0;
  let known = true;
  const parts = [...usage.entries()].map(([model, u]) => {
    const p = PRICES[model] ?? Object.entries(PRICES).find(([k]) => model.startsWith(k))?.[1];
    if (p) total += (u.input * p[0] + u.cacheWrite * p[0] * 1.25 + u.cacheRead * p[0] * 0.1 + u.output * p[1]) / 1e6;
    else known = false;
    return `${model}：${u.calls} 次调用，输入 ${u.input + u.cacheRead + u.cacheWrite}（其中缓存读取 ${u.cacheRead}）/ 输出 ${u.output} tokens`;
  });
  return `${parts.join('；') || '无'}${parts.length ? `；按官方标价估算约 $${total.toFixed(2)}${known ? '' : '（部分模型无价格表，未计入）'}` : ''}`;
}

const { SCENARIOS } = await import('./scenarios.js');
const { runScenario, summarize, renderReport } = await import('./harness.js');
const { claudeJudge, JUDGE_MODEL } = await import('./judge.js');
const { config } = await import('../src/config.js');

const selected = only.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
const unknown = only.filter((id) => !SCENARIOS.some((s) => s.id === id));
if (unknown.length) { console.error(`unknown scenario id(s): ${unknown.join(', ')}`); process.exit(2); }

const jobs = selected.flatMap((sc) => Array.from({ length: runs }, (_, k) => ({ sc, run: k + 1 })));
const results = new Map<string, Awaited<ReturnType<typeof runScenario>>[]>();
const startedAt = new Date();
console.log(`Sales Agent eval: ${selected.length} scenarios × ${runs} runs = ${jobs.length} conversations; chat model ${config.chatModel}; judge ${useJudge ? JUDGE_MODEL : 'off'}`);

let next = 0;
let done = 0;
async function worker() {
  while (next < jobs.length) {
    const { sc, run } = jobs[next++];
    const r = await runScenario(sc, run, { judge: useJudge ? claudeJudge : null });
    results.set(sc.id, [...(results.get(sc.id) ?? []), r]);
    done++;
    const failed = r.checks.filter((c) => !c.pass).map((c) => c.rule);
    console.log(`[${done}/${jobs.length}] ${r.hardPass ? 'PASS' : 'FAIL'} ${sc.id} #${run}${failed.length ? ` — ${failed.join('; ')}` : ''}${r.judgeError ? ' (judge error)' : ''}`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

await Promise.all(pendingUsage);
const summaries = selected.map((sc) => summarize(sc, (results.get(sc.id) ?? []).sort((a, b) => a.run - b.run)));
let commit: string | undefined;
try { commit = process.env.GITHUB_SHA?.slice(0, 7) ?? execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }
const report = renderReport(summaries, {
  runs,
  judge: useJudge,
  models: `对话 ${config.chatModel}（effort ${config.chatEffort}），线索提取 ${config.leadModel}（effort ${config.leadEffort}）${useJudge ? `，AI 评分 ${JUDGE_MODEL}` : ''}`,
  usage: usageText(),
  startedAt: startedAt.toISOString(),
  durationS: (Date.now() - startedAt.getTime()) / 1000,
  commit,
});
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, 'report.md'), report);
await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify({ runs, judge: useJudge, startedAt, commit, usage: Object.fromEntries(usage), summaries: summaries.map((s) => ({ id: s.scenario.id, category: s.scenario.category, title: s.scenario.title, pass: s.pass, hardPassRuns: s.hardPassRuns, judgeRate: s.judgeRate, runs: s.runs })) }, null, 2));
await fs.rm(dataDir, { recursive: true, force: true });
console.log(`\n${report}\nreport: ${path.join(outDir, 'report.md')}`);
process.exit(summaries.every((s) => s.pass) ? 0 : 1);
