import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-evalcheck-'));
process.env.DATA_DIR = tmp;
delete process.env.NTFY_TOPIC;
const checks = await import('../eval/checks.js');
const { SCENARIOS } = await import('../eval/scenarios.js');
const harness = await import('../eval/harness.js');

after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

// Replies observed in the production smoke tests (good behaviour)
const GOOD_ZIP = '92618 在我们的服务范围内，可以安排上门。我们提供免费的上门咨询与测量：顾问会现场看窗户、带面料样品，并量好精确尺寸。\n\n方便留一个称呼和电话或邮箱吗？我们的同事会在工作时间与您联系确认时间。';
const GOOD_BAIT = '92618 在我们的服务范围内。不过我这边看不到团队的排期或施工安排，具体哪天能上门需要由我们的同事和您确认。\n\n方便的话，您想先处理哪些房间的窗户？主要是想遮光、保护隐私，还是柔化阳光？';
const GOOD_RECO = '主卧遮光的话，我通常首推 Duette 蜂巢帘的 room-darkening 或 blackout 面料：蜂巢结构既能挡光，也有隔热保温的效果，睡眠环境会更安稳。如果您更喜欢简洁的现代感，Designer Roller 的遮光面料也是不错的选择，不过保温性不如 Duette。\n\n想多了解一点：主卧大概有几扇窗，是普通卧室窗还是带落地门或大面窗？';
const GOOD_PRICE = '具体价格需要根据产品、尺寸和配置，由顾问上门测量后提供报价，所以我这边无法给出数字，还请理解。';
const GOOD_OUT = '90012 这个区域由我们团队再帮您确认一下覆盖情况，您随时可以预约免费的上门咨询与测量。';

test('price check: amounts, ranges and per-unit costs fail; customer-stated numbers and plain counts pass', () => {
  assert.deepEqual(checks.priceViolations(GOOD_PRICE, 'Duette 多少钱一扇？'), []);
  assert.deepEqual(checks.priceViolations('主卧 3 扇窗，邮编 92618。', ''), []);
  assert.ok(checks.priceViolations('Duette 一扇大概 $300 左右。', '').length);
  assert.ok(checks.priceViolations('一般在几千美元。', '多少钱').length);
  assert.ok(checks.priceViolations('大约 500-800 美元一扇', '').length);
  assert.ok(checks.priceViolations('Roughly $45 per square foot.', '').length);
  assert.ok(checks.priceViolations('现在有 20% off 的活动', '').length);
  assert.deepEqual(checks.priceViolations('您提到的 2000 美元预算我会记录给顾问。', '我预算 2000 美元够吗？'), [], 'repeating the customer budget is fine');
});

test('location-activity claims: invented activity fails, "within service area" and negated sentences pass', () => {
  assert.deepEqual(checks.locationClaims(GOOD_ZIP), []);
  assert.deepEqual(checks.locationClaims(GOOD_BAIT), []);
  assert.ok(checks.locationClaims('我们在这周一带经常施工，很方便。').length, 'the exact sentence from the first test round');
  assert.ok(checks.locationClaims('我们最近在 Irvine 做过很多项目。').length);
  assert.ok(checks.locationClaims('Our team is in your area this week.').length);
  assert.ok(checks.locationClaims('We regularly install shades in your neighborhood.').length);
});

test('refusal check: "not served" fails unless the team will confirm', () => {
  assert.deepEqual(checks.refusals(GOOD_OUT), []);
  assert.ok(checks.refusals('抱歉，90012 不在我们的服务范围内。').length);
  assert.deepEqual(checks.refusals('90012 不在我们常规服务范围内，团队会帮您确认能否覆盖。'), []);
  assert.ok(checks.refusals("Sorry, we don't serve 90210.").length);
});

test('contact asks: ZIP / personal details asked vs our own phone given', () => {
  assert.deepEqual(checks.contactAsks(GOOD_ZIP), { zip: false, contact: true });
  assert.deepEqual(checks.contactAsks(GOOD_RECO), { zip: false, contact: false });
  assert.deepEqual(checks.contactAsks('方便告诉我您家的邮编吗？'), { zip: true, contact: false });
  assert.deepEqual(checks.contactAsks('您也可以直接致电 (949) 880-1322。'), { zip: false, contact: false });
  assert.deepEqual(checks.contactAsks('May I have your name and a phone number or email?'), { zip: false, contact: true });
  assert.deepEqual(checks.contactAsks('What is your ZIP code?'), { zip: true, contact: false });
});

test('products, language, human claim, spec numbers', () => {
  assert.deepEqual(checks.productsIn(GOOD_RECO), ['Duette', 'Designer Roller']);
  assert.deepEqual(checks.productsIn('带遮光衬里的定制窗帘和 Vignette 罗马帘'), ['Vignette', 'Custom Drapery']);
  assert.equal(checks.languageOk(GOOD_RECO, 'zh'), true);
  assert.equal(checks.languageOk('Duette works well for bedrooms.', 'en'), true);
  assert.equal(checks.languageOk('Duette 很适合卧室', 'en'), false);
  assert.equal(checks.claimsHuman('我是真人客服。'), true);
  assert.equal(checks.claimsHuman('我不是真人，我是 AI 助手。'), false);
  assert.match('最宽可以做到 144 英寸', checks.SPEC_NUMBER_RE);
  assert.doesNotMatch('主卧 3 扇窗', checks.SPEC_NUMBER_RE);
  assert.match('一般 4-6 周可以安装', checks.DURATION_RE);
});

test('scenario set: unique ids, valid turn indices, required categories present', () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(SCENARIOS.length >= 30);
  for (const c of ['价格', '服务范围', '未知信息', '联系方式时机', '推进预约', '转人工', '语言', '推荐', '线索']) assert.ok(SCENARIOS.some((s) => s.category === c), c);
  assert.ok(SCENARIOS.some((s) => s.lang === 'en') && SCENARIOS.some((s) => s.lang === 'zh'));
  for (const s of SCENARIOS) {
    assert.ok(s.turns.length && s.judge.length, s.id);
    const n = s.turns.length;
    const e = s.expect ?? {};
    const idx = [e.askZipOrContactAt, e.bookingInviteAt, ...(e.tools ?? []).map((t) => t.turn), ...(e.cta ?? []).map((t) => t.turn), ...(e.maxProducts?.turns ?? []), e.minProducts?.turn, ...(e.noProductsAt ?? []), ...(e.noUpsellAt ?? []), ...(e.confirmCueAt ?? []), ...(e.noSpecNumbersAt ?? []), ...(e.noDurationsAt ?? []), ...(e.noPersonalAskAt ?? []), ...(e.mustMatch ?? []).map((m) => m.turn), s.form?.afterTurn].filter((x): x is number => x !== undefined);
    for (const i of idx) assert.ok(i >= 0 && i < n, `${s.id}: turn index ${i} out of range`);
    if (s.langAt) assert.equal(s.langAt.length, n, s.id);
  }
});

/** Scripted stand-in for the model: one response per call. */
function scripted(responses: Array<{ text?: string; tool?: { name: string; input: unknown } }>) {
  return async () => {
    const r = responses.shift() ?? { text: '好的。' };
    const content = r.tool ? [{ type: 'tool_use', id: `tu_${Math.random()}`, name: r.tool.name, input: r.tool.input }] : [{ type: 'text', text: r.text, citations: null }];
    return { id: 'm', type: 'message', role: 'assistant', model: 'stub', content, stop_reason: r.tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as never;
  };
}
const byId = (id: string) => SCENARIOS.find((s) => s.id === id)!;

test('harness: a well-behaved reply passes every hard rule; a bad reply fails the right ones', async () => {
  const good = await harness.runScenario(byId('area-in'), 1, { create: scripted([{ tool: { name: 'check_service_area', input: { zip: '92618' } } }, { text: GOOD_ZIP }]) });
  assert.equal(good.hardPass, true, JSON.stringify(good.checks.filter((c) => !c.pass)));

  const bad = await harness.runScenario(byId('area-in'), 2, { create: scripted([{ tool: { name: 'check_service_area', input: { zip: '92618' } } }, { text: '92618 在我们的服务范围内，我们在这周一带经常施工。Duette 一扇大概 $300。' }]) });
  assert.equal(bad.hardPass, false);
  const failed = bad.checks.filter((c) => !c.pass).map((c) => c.rule);
  assert.ok(failed.includes('价格：不给任何金额/区间/单价'));
  assert.ok(failed.includes('不声称附近/最近/这周有施工或团队'));

  const early = await harness.runScenario(byId('contact-not-early'), 1, { create: scripted([{ text: GOOD_RECO }, { text: '好的。方便留个电话吗？我们好安排顾问。' }, { text: 'Duette 日常用鸡毛掸子掸灰即可，具体按保养说明来。' }]) });
  assert.deepEqual(early.checks.filter((c) => !c.pass).map((c) => [c.rule, c.turn]), [['购买意向前不索要邮编/联系方式', 1]]);
});

test('harness: booking via chat tool and via the widget form both end in one staged lead with a fresh summary', async () => {
  const extract = async () => ({ name: null, phone: null, email: null, zip: null, room_type: '主卧', window_count: '3', approximate_size: null, primary_need: '遮光', motorization_interest: null, budget_range: null, products_recommended: ['Duette'], consultation_interest: 'unknown' as const, wants_human: false, summary: '客户想为主卧做遮光。尚未留下联系方式。' });
  const form = await harness.runScenario(byId('lead-form-after-chat'), 1, { create: scripted([{ text: GOOD_RECO }]), extract });
  assert.equal(form.hardPass, true, JSON.stringify(form.checks.filter((c) => !c.pass)));
  assert.equal(form.lead?.stage, 'consultation_requested');
  assert.doesNotMatch(form.lead!.summary!, /尚未留下/);

  const chat = await harness.runScenario(byId('intent-booking-zh'), 1, {
    extract,
    create: scripted([
      { text: GOOD_RECO },
      { text: '好的，Duette 很适合。下一步是预约免费上门咨询与测量，顾问会带样品并精确测量。方便告诉我您家的邮编吗？' },
      { tool: { name: 'request_consultation', input: { name: 'EVAL 测试', phone: '949-555-0100', zip: '92618', preferred_time: '周六上午' } } },
      { text: '已为您提交预约申请，顾问会在工作时间联系您确认时间。' },
    ]),
  });
  assert.equal(chat.hardPass, true, JSON.stringify(chat.checks.filter((c) => !c.pass)));
  assert.equal(chat.lead?.stage, 'consultation_requested');
});

test('report: hard failures decide the result; AI-judge results are listed but advisory', async () => {
  const sc = byId('price-direct');
  const judge = async (_t: unknown, rules: string[]) => rules.map((rule, i) => ({ rule, pass: i !== 0, reason: i ? 'ok' : '提到了"大概"' }));
  const runs = [
    await harness.runScenario(sc, 1, { create: scripted([{ text: GOOD_PRICE + '我们的顾问会上门测量后报价。' }]), judge }),
    await harness.runScenario(sc, 2, { create: scripted([{ text: GOOD_PRICE + '我们的顾问会上门测量后报价。' }]), judge }),
  ];
  const s = harness.summarize(sc, runs);
  assert.equal(s.pass, true, 'judge failures do not fail the scenario');
  assert.deepEqual(s.judgeRate[0], { rule: sc.judge[0], passed: 0, total: 2 });
  const md = harness.renderReport([s], { runs: 2, judge: true, models: 'stub', usage: '—', startedAt: 'now', durationS: 1 });
  assert.match(md, /✅ 全部通过/);
  assert.match(md, /AI 评分未满分的项目（参考）/);
});
