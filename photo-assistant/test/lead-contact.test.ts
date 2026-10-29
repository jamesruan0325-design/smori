/**
 * Contact capture and lead pushes: the "已留联系方式" stage, push delivery / retry,
 * phone · text · email · WeChat as the customer chooses, and the rate-limit visitor key.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-lead-contact-'));
process.env.DATA_DIR = tmp;
process.env.SHOPIFY_API_SECRET = 'shpss_secret_abc';
process.env.SHOPIFY_APP_URL = 'https://app.example.com';
delete process.env.SERVICE_ZIP_PREFIXES;
delete process.env.NTFY_TOPIC;

const leads = await import('../src/leads.js');
const sales = await import('../src/sales.js');
const proxy = await import('../src/proxy.js');
const { upsertConversationLead, getConversationLead, listLeads, retryFailedPushes, markLead, leadsToCsv } = leads;

after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

function recorder() {
  const pushes: { title: string; body: string }[] = [];
  return { pushes, notify: async (title: string, body: string) => { pushes.push({ title, body }); } };
}
const failing = (msg = 'ntfy HTTP 502') => async () => { throw new Error(msg); };
const fakeRes = () => ({ statusCode: 200, body: null as any, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } });
function scripted(responses: Array<{ text?: string; tool?: { name: string; input: unknown } }>) {
  const calls: any[] = [];
  const create = async (params: any) => {
    calls.push(params);
    const r = responses.shift() ?? { text: '[stub] done' };
    const content = r.tool ? [{ type: 'tool_use', id: `tu_${calls.length}`, name: r.tool.name, input: r.tool.input }] : [{ type: 'text', text: r.text, citations: null }];
    return { id: 'm', type: 'message', role: 'assistant', model: 'stub', content, stop_reason: r.tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as any;
  };
  return { create, calls };
}
const extracted = (over: Partial<import('../src/sales.js').Extracted> = {}): import('../src/sales.js').Extracted => ({
  name: null, phone: null, email: null, wechat: null, contact_preference: null, zip: null, room_type: null, window_count: null, approximate_size: null, primary_need: null,
  motorization_interest: null, budget_range: null, products_recommended: [], consultation_interest: 'unknown', wants_human: false, summary: '', ...over,
});

/* ---------------- 已留联系方式 ---------------- */

test('contact alone: "已留联系方式" is pushed at once (not a confirmed need), then each higher stage once', async () => {
  const { pushes, notify } = recorder();
  const conv = 'conv-contact-only-01';
  let l = await upsertConversationLead(conv, { phone: '949-555-0123' }, { notify });
  assert.equal(l!.stage, 'contact_pending');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'SMORI 销售线索：已留联系方式');
  assert.match(pushes[0].body, /949-555-0123/);
  assert.match(pushes[0].body, /客户留了联系方式，还没谈需求，也没要求预约。/);
  assert.match(l!.summary!, /阶段：已留联系方式/);

  l = await upsertConversationLead(conv, { room_type: '客厅', primary_need: '隐私' }, { notify });
  assert.equal(l!.stage, 'qualified', 'a need makes it 已确认需求 (still not buying intent)');
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].title, 'SMORI 销售线索：已确认需求');
  assert.doesNotMatch(pushes[1].body, /还没谈需求/);

  l = await upsertConversationLead(conv, {}, { notify, signals: { consultation: true } });
  assert.equal(l!.stage, 'consultation_requested', 'only an explicit booking makes it high intent');
  assert.equal(pushes.length, 3);
  assert.deepEqual(l!.stage_history!.map((h) => h.stage), ['contact_pending', 'qualified', 'consultation_requested']);

  // ZIP / budget / products are not a need: still 已留联系方式
  const r = recorder();
  const z = await upsertConversationLead('conv-contact-only-02', { email: 'z@example.com', zip: '92618', budget_range: '5k' }, { notify: r.notify });
  assert.equal(z!.stage, 'contact_pending');
  assert.equal(r.pushes.length, 1);
});

test('contact typed in chat with no need and no intent: extraction makes it 已留联系方式 and pushes', async () => {
  const { pushes, notify } = recorder();
  const history = [
    { role: 'user' as const, content: "Hi, I'm Lisa, 949-555-1234. What products do you carry?" },
    { role: 'assistant' as const, content: 'We carry Hunter Douglas shades and custom drapery. Which room are you thinking about?' },
  ];
  const l = await sales.extractLead(history, 'conv-contact-chat-01', undefined, { notify, extract: async () => extracted({ name: 'Lisa', phone: '949-555-1234', summary: 'Asked what products we carry.' }) });
  assert.equal(l!.stage, 'contact_pending');
  assert.equal(l!.consultation_interest, 'unknown', 'no booking intent is invented');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].body, /Lisa · 949-555-1234/);
});

test('the sales prompt still asks for contact details only after conversion intent (rule 8 unchanged)', () => {
  const p = sales.SALES_SYSTEM;
  assert.match(p, /Until the customer has shown conversion intent \(rule 9\), do not invite them to the consultation, a visit or samples, and do not ask for a ZIP code/);
  assert.match(p, /If the customer volunteers a ZIP code or contact details earlier, use them \(call check_service_area for a ZIP\), but do not ask for more until conversion intent appears\./);
  assert.match(p, /ask for their name and one way to reach them only when they want to book the consultation or need a person to follow up: a phone call, a text message, email or WeChat \(in Chinese: 电话、短信、邮箱或微信\), whichever they prefer\. Name all four so the customer can pick\. Let them choose; do not insist on a particular one/);
});

/* ---------------- push delivery ---------------- */

const onDisk = async (id: string) => JSON.parse(await fs.readFile(path.join(tmp, 'leads', `${id}.json`), 'utf8'));

test('a failed push keeps the lead, stays pending (not recorded as sent), and goes out on the next update', async () => {
  const conv = 'conv-push-fail-01';
  let l = await upsertConversationLead(conv, { phone: '949-555-0001' }, { notify: failing() });
  assert.equal(l!.stage, 'contact_pending', 'the lead is saved even though the push failed');
  assert.deepEqual(l!.notified ?? [], [], 'a failed push is not recorded as sent');
  assert.equal(l!.push_pending!.stage, 'contact_pending');
  assert.equal(l!.push_pending!.attempts, 1);
  assert.match(l!.push_pending!.last_error!, /502/);
  assert.equal(leads.pushStatus(l!), 'retrying');
  assert.equal((await onDisk(l!.id)).push_pending.attempts, 1);

  l = await upsertConversationLead(conv, { name: 'Ann' }, { notify: failing() });
  assert.equal(l!.push_pending!.attempts, 2);

  const { pushes, notify } = recorder();
  l = await upsertConversationLead(conv, { needs_summary: 'x' }, { notify });
  assert.equal(pushes.length, 1, 'retried on the next update');
  assert.deepEqual(l!.notified, ['contact_pending']);
  assert.equal(l!.push_pending, undefined);
  assert.equal(leads.pushStatus(l!), null);
  await upsertConversationLead(conv, { needs_summary: 'y' }, { notify });
  assert.equal(pushes.length, 1, 'not sent twice');

  // one attempt per update: the customer never waits for retries
  let calls = 0;
  await upsertConversationLead('conv-push-fail-02', { email: 'b@example.com' }, { notify: async () => { calls++; throw new Error('timeout'); } });
  assert.equal(calls, 1);
});

test('the pending push is on disk before it is sent: a restart mid-push is retried by the sweep', async () => {
  let release!: () => void;
  const hang = () => new Promise<void>((r) => { release = r; });
  const t0 = Date.now();
  const p = upsertConversationLead('conv-crash-01', { phone: '949-555-0011' }, { notify: hang, now: () => new Date(t0) });
  await new Promise((r) => setTimeout(r, 30));
  const disk = await onDisk((await listLeads()).find((x) => x.conversationId === 'conv-crash-01')!.id);
  assert.equal(disk.push_pending.stage, 'contact_pending', 'marker written before the push is sent');
  assert.equal(disk.push_pending.attempts, 0);
  assert.equal(leads.pushStatus(disk, t0 + 1000), null, 'a push in flight is not shown as failed');
  assert.equal(leads.pushStatus(disk, t0 + 120_000), 'retrying', 'still pending after a minute (process died): retried');
  release(); await p;
});

test('a failure at one stage, then a higher stage: only the latest stage is pushed', async () => {
  const conv = 'conv-push-fail-03';
  await upsertConversationLead(conv, { phone: '949-555-0003' }, { notify: failing() });
  const { pushes, notify } = recorder();
  const l = await upsertConversationLead(conv, {}, { notify, signals: { consultation: true } });
  assert.deepEqual(pushes.map((x) => x.title), ['SMORI 销售线索：申请预约咨询']);
  assert.deepEqual(l!.notified, ['consultation_requested']);
  assert.equal(l!.push_pending, undefined);
});

test('retryFailedPushes: delivers pending pushes, skips delivered and older leads, gives up after 48 h', async () => {
  await upsertConversationLead('conv-retry-a', { phone: '949-555-0101' }, { notify: failing() });
  await upsertConversationLead('conv-retry-b', { phone: '949-555-0102' }, { notify: async () => {} });
  const old = new Date(Date.now() - 3 * 86_400_000);
  await upsertConversationLead('conv-retry-c', { phone: '949-555-0103' }, { notify: failing(), now: () => old });
  // leads written by earlier versions: legacy (no stage) and a sales lead created before this change (no marker)
  await fs.writeFile(path.join(tmp, 'leads', '20260101-legacy1.json'), JSON.stringify({ id: '20260101-legacy1', createdAt: '2026-01-01T00:00:00.000Z', conversationId: 'form', source: 'form', reason: 'human', language: 'zh', phone: '9490000000' }));
  await fs.writeFile(path.join(tmp, 'leads', '20261001-cprevious001.json'), JSON.stringify({ id: '20261001-cprevious001', createdAt: '2026-10-01T00:00:00.000Z', conversationId: 'conv-previous-01', source: 'chat', lead_source: 'AI Sales Agent', reason: 'other', language: 'en', stage: 'qualified', notified: [], phone: '9491112233', room_type: 'den' }));

  const { pushes, notify } = recorder();
  const r = await retryFailedPushes({ notify });
  assert.equal(r.delivered, r.retried);
  assert.equal(pushes.length, r.delivered);
  const bodies = pushes.map((x) => x.body).join('\n');
  assert.match(bodies, /949-555-0101/, 'the pending lead is delivered');
  assert.doesNotMatch(bodies, /949-555-0102/, 'an already delivered lead is not pushed again');
  assert.doesNotMatch(bodies, /949-555-0103/, 'older than 48 h: not retried');
  assert.doesNotMatch(bodies, /9490000000|9491112233/, 'leads from earlier versions are never pushed by the sweep (no burst on deploy)');
  assert.equal((await getConversationLead('conv-retry-a'))!.push_pending, undefined);
  const c = (await getConversationLead('conv-retry-c'))!;
  assert.equal(leads.pushStatus(c), 'gave_up', 'left flagged for the admin page as given up');
  assert.deepEqual(await retryFailedPushes({ notify }), { retried: 0, delivered: 0 }, 'nothing left to retry');
});

test('without NTFY_TOPIC the default lead notifier fails loudly: the push stays pending, not silently marked as sent', async () => {
  const l = await upsertConversationLead('conv-no-topic-01', { phone: '949-555-0200' });
  assert.match(l!.push_pending!.last_error!, /NTFY_TOPIC is not set/);
  assert.deepEqual(l!.notified ?? [], []);
});

test('sendNtfy gives up after its timeout (a booking never waits longer than that)', async () => {
  const http = await import('node:http');
  const server = http.createServer(() => { /* never answers */ });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { config } = await import('../src/config.js');
  const saved = { server: config.ntfyServer, topic: config.ntfyTopic };
  Object.assign(config, { ntfyServer: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, ntfyTopic: 'smori-test-topic' });
  try {
    const { sendNtfy } = await import('../src/notify.js');
    const t = Date.now();
    await assert.rejects(sendNtfy('t', 'm', undefined, 300), /timeout|aborted/i);
    assert.ok(Date.now() - t < 2000);
  } finally {
    Object.assign(config, { ntfyServer: saved.server, ntfyTopic: saved.topic });
    server.closeAllConnections(); server.close();
  }
});

test('staff: a stage set by hand is not pushed; marking handled stops retries', async () => {
  const a = await upsertConversationLead('conv-staff-stage-01', { phone: '949-555-3001' }, { notify: failing() });
  await leads.setLeadStage(a!.id, 'handed_to_human');
  const { pushes, notify } = recorder();
  await retryFailedPushes({ notify });
  assert.equal(pushes.filter((x) => /949-555-3001/.test(x.body)).length, 0, 'staff-set 转人工 is not pushed by the retry');
  assert.equal(leads.pushStatus((await getConversationLead('conv-staff-stage-01'))!), null);
  await upsertConversationLead('conv-staff-stage-01', { needs_summary: 'later message' }, { notify });
  assert.equal(pushes.filter((x) => /949-555-3001/.test(x.body)).length, 0, 'nor on the next customer message');

  const b = await upsertConversationLead('conv-staff-handled-01', { phone: '949-555-3002' }, { notify: failing() });
  await markLead(b!.id, true);
  assert.equal((await getConversationLead('conv-staff-handled-01'))!.push_pending, undefined);
  assert.equal((await retryFailedPushes({ notify })).retried >= 0, true);
  assert.equal(pushes.filter((x) => /949-555-3002/.test(x.body)).length, 0);
});

test('legacy assistant form leads follow the same rule: pending until delivered', async () => {
  const l = await leads.saveLead({ conversationId: 'form', source: 'form', reason: 'human', language: 'zh', phone: '9495554000' }, failing());
  assert.deepEqual(l.notified ?? [], []);
  assert.equal(l.push_pending!.attempts, 1);
  const { pushes, notify } = recorder();
  await retryFailedPushes({ notify });
  assert.equal(pushes.filter((x) => /949-555-4000/.test(x.body)).length, 1);
  const ok = await leads.saveLead({ conversationId: 'form', source: 'form', reason: 'human', language: 'zh', phone: '9495554001' }, async () => {});
  assert.deepEqual(ok.notified, ['handed_to_human']);
  assert.equal(ok.push_pending, undefined);
});

test('phone numbers: US numbers are saved and shown as 949-555-0103 however typed; other numbers stay as typed', async () => {
  for (const [typed, shown] of [
    ['9495550103', '949-555-0103'], ['949-555-0103', '949-555-0103'], ['(949) 555-0103', '949-555-0103'], ['949.555.0103', '949-555-0103'],
    ['+1 949 555 0103', '949-555-0103'], ['+19495550103', '949-555-0103'],
    ['13800138000', '13800138000'], ['+86 138 0013 8000', '+86 138 0013 8000'], ['1-949-555-0103', '1-949-555-0103'], ['949 555 0103 ext 2', '949 555 0103 ext 2'],
  ]) assert.equal(leads.formatPhone(typed), shown, typed);

  const { pushes, notify } = recorder();
  const a = await upsertConversationLead('conv-phone-fmt-01', { phone: '9495554100' }, { notify });
  assert.equal(a!.phone, '949-555-4100', 'saved in the common format');
  assert.match(pushes.at(-1)!.body, /^（未留姓名） · 949-555-4100/);
  assert.match(a!.summary!, /电话 949-555-4100/);
  const b = await upsertConversationLead('conv-phone-fmt-02', { phone: '(949) 555-4101' }, { notify });
  assert.equal(b!.phone, '949-555-4101');
  const c = await upsertConversationLead('conv-phone-fmt-03', { wechat: 'wx_fmt_01', phone: '+86 138 0013 8000' }, { notify });
  assert.equal(c!.phone, '+86 138 0013 8000', 'a non-US number is kept as typed');
  const legacy = await leads.saveLead({ conversationId: 'form', source: 'form', reason: 'human', language: 'zh', phone: '949.555.4103' }, async () => {});
  assert.equal(legacy.phone, '949-555-4103', 'old assistant form too');
  // leads saved before this change keep the digits as typed; the CSV shows them in the common format
  const csv = leadsToCsv([{ ...a!, phone: '9495554102' }]);
  assert.match(csv, /,949-555-4102,/);
});

test('a booking / person request before any contact is kept, so the contact that follows makes it high intent', async () => {
  const { pushes, notify } = recorder();
  // turn 1: "I want to book an in-home measurement" -> request_consultation without contact
  let s = scripted([{ tool: { name: 'request_consultation', input: { name: 'Amy' } } }, { text: 'Sure. What is the best way to reach you: a phone number (call or text), email or WeChat?' }]);
  await sales.salesTurn([{ role: 'user', content: 'I want to book an in-home measurement' }], 'conv-intent-first-01', undefined, { create: s.create, notify });
  const before = await getConversationLead('conv-intent-first-01');
  assert.equal(before!.stage, 'new', 'the request is saved even with nothing else known');
  assert.equal(before!.consultation_interest, 'yes');
  assert.equal(toolErrorText(s), true);
  // turn 2: only a phone number, and the model does not call the tool again: extraction alone
  const history = [{ role: 'user' as const, content: 'I want to book an in-home measurement' }, { role: 'assistant' as const, content: 'What is the best way to reach you?' }, { role: 'user' as const, content: 'Text me at 949-555-0142' }];
  const l = await sales.extractLead(history, 'conv-intent-first-01', undefined, { notify, extract: async () => extracted({ phone: '949-555-0142', contact_preference: 'sms' }) });
  assert.equal(l!.stage, 'consultation_requested');
  assert.deepEqual(pushes.map((x) => x.title), ['SMORI 销售线索：申请预约咨询']);
  assert.equal(l!.contact_preference, 'sms');

  function toolErrorText(sc: ReturnType<typeof scripted>) { return /call request_consultation again with those details/.test(sc.calls[1].messages.at(-1).content[0].content); }
  s = scripted([{ tool: { name: 'request_human', input: { reason: 'wants a person' } } }, { text: '方便留下您的称呼和联系方式吗？' }]);
  await sales.salesTurn([{ role: 'user', content: '我想找真人' }], 'conv-intent-first-02', undefined, { create: s.create, notify });
  assert.equal((await getConversationLead('conv-intent-first-02'))!.wants_human, true);
});

test('push wording: contact_pending says what is known; a preferred method without its detail is flagged', async () => {
  const { pushes, notify } = recorder();
  await upsertConversationLead('conv-hint-01', { phone: '949-555-0501', zip: '92618', window_count: '6' }, { notify });
  assert.match(pushes[0].body, /客户留了联系方式，还没确认房间或主要需求，也没要求预约。/);
  assert.doesNotMatch(pushes[0].body, /还没谈需求/);
  await upsertConversationLead('conv-hint-02', { email: 'amy@example.com', contact_preference: 'sms' }, { notify });
  assert.match(pushes[1].body, /amy@example.com（首选短信，但没留电话）/);
  const l = await getConversationLead('conv-hint-02');
  assert.match(l!.summary!, /首选短信，但没留电话/);
});

test('rollback safety: an unknown stage on a sales lead reads as new (never 转人工); contact_pending can be downgraded first', async () => {
  await fs.writeFile(path.join(tmp, 'leads', '20261005-cfuturestage01.json'), JSON.stringify({ id: '20261005-cfuturestage01', createdAt: '2026-10-05T00:00:00.000Z', conversationId: 'conv-future-01', source: 'chat', lead_source: 'AI Sales Agent', reason: 'other', language: 'en', stage: 'some_future_stage', notified: ['some_future_stage'], phone: '9497770000' }));
  assert.equal((await listLeads()).find((x) => x.id === '20261005-cfuturestage01')!.stage, 'new');
  const c = await upsertConversationLead('conv-downgrade-01', { phone: '949-555-0601' }, { notify: async () => {} });
  assert.equal(c!.stage, 'contact_pending');
  const n = await leads.downgradeContactPending();
  assert.ok(n >= 1);
  const d = (await getConversationLead('conv-downgrade-01'))!;
  assert.equal(d.stage, 'new');
  assert.equal(d.stage_history!.at(-1)!.by, 'migration');
  assert.equal(d.schema, undefined, 'format version removed so a later re-deploy migrates it again');
  assert.equal((await listLeads()).filter((x) => x.stage === 'contact_pending').length, 0);
});

test('staff edits and agent updates do not overwrite each other', async () => {
  const conv = 'conv-staff-lock-01';
  const l = await upsertConversationLead(conv, { phone: '949-555-0300' }, { notify: async () => {} });
  await Promise.all([
    markLead(l!.id, true),
    upsertConversationLead(conv, { room_type: 'den', primary_need: 'privacy' }, { notify: async () => { await new Promise((r) => setTimeout(r, 30)); } }),
  ]);
  const after = await getConversationLead(conv);
  assert.equal(after!.handled, true);
  assert.equal(after!.stage, 'qualified');
});

/* ---------------- phone · text · email · WeChat ---------------- */

test('asking how to reach the customer names all four choices: call, text, email, WeChat', async () => {
  assert.equal((sales.SALES_SYSTEM.match(/电话、短信、邮箱或微信/g) ?? []).length, 2, 'the booking rule and the talk-to-a-person rule');
  assert.match(sales.SALES_SYSTEM, /a phone call, a text message, email or WeChat/);
  for (const [tool, input] of [['request_human', { reason: 'wants a person' }], ['request_consultation', { name: 'Amy' }]] as const) {
    const s = scripted([{ tool: { name: tool, input } }, { text: '方便留下您的称呼和联系方式吗？' }]);
    await sales.salesTurn([{ role: 'user', content: '我想预约上门测量' }], `conv-choices-${tool.replace('_', '-')}`, undefined, { create: s.create, notify: async () => {} });
    const r = s.calls[1].messages.at(-1).content[0];
    assert.equal(r.is_error, true, tool);
    assert.match(r.content, /电话、短信、邮箱或微信/, `${tool}: the follow-up instruction names all four`);
  }
});

test('WeChat: real IDs and phone numbers accepted, labels stripped, names and plain words rejected', () => {
  assert.equal(sales.validWechat('wx_test88'), 'wx_test88');
  assert.equal(sales.validWechat('wxid_abc123'), 'wxid_abc123');
  assert.equal(sales.validWechat('微信：wx_test88'), 'wx_test88');
  assert.equal(sales.validWechat('微信号Li_Na-88'), 'Li_Na-88');
  assert.equal(sales.validWechat('WeChat ID: Li-Na_2020'), 'Li-Na_2020');
  assert.equal(sales.validWechat('WeChatLina2020'), 'WeChatLina2020', 'an ID that starts with "wechat" is kept whole');
  assert.equal(sales.validWechat('wechat_lina88'), 'wechat_lina88');
  assert.equal(sales.validWechat('+86 138 0013 8000'), '+86 138 0013 8000', 'WeChat = phone number');
  assert.equal(sales.validWechat('(949) 555-0101'), '(949) 555-0101');
  assert.equal(sales.validWechat('13800138000'), '13800138000');
  for (const bad of ['Lina', 'yes', 'ab', 'a b c', '!!', '_lina88']) assert.equal(sales.validWechat(bad), undefined, bad);

  const said = (...u: string[]) => u.map((content) => ({ role: 'user' as const, content }));
  assert.equal(sales.customerSaid(said('我叫 Lina2020，想预约'), 'Lina2020', 'wechat'), false, 'no mention of WeChat');
  assert.equal(sales.customerSaid(said('加我微信 li_test88 就行'), 'li_test88', 'wechat'), true);
  assert.equal(sales.customerSaid(said('加我微信 li_test888 就行'), 'li_test88', 'wechat'), false, 'whole-word match only');
  assert.equal(sales.customerSaid(said('微信就是手机号 (949) 555-0101'), '949 555 0101', 'wechat'), true, 'a phone number compares by digits');

  const history = said('想预约上门，我姓李，微信 li_test88，发短信也行');
  const p = sales.sanitizeExtraction(extracted({ wechat: 'li_test88', contact_preference: 'sms' }), history);
  assert.equal(p.wechat, 'li_test88');
  assert.equal(p.contact_preference, 'sms');
  const h = sales.sanitizeExtraction(extracted({ wechat: 'made_up_id', contact_preference: 'fax' }), history);
  assert.equal(h.wechat, undefined, 'a WeChat ID the customer never typed is dropped');
  assert.equal(h.contact_preference, undefined);
});

test('contact preference: any spelling from the model is normalised; the extraction schema never rejects it', () => {
  assert.equal(sales.normalizePreference('WeChat'), 'wechat');
  assert.equal(sales.normalizePreference('text'), 'sms');
  assert.equal(sales.normalizePreference('短信'), 'sms');
  assert.equal(sales.normalizePreference('Call'), 'phone');
  assert.equal(sales.normalizePreference('E-mail'), 'email');
  assert.equal(sales.normalizePreference('carrier pigeon'), undefined);
  // structured output does not enforce enums: an unexpected value must not fail the whole extraction
  const parsed = sales.ExtractSchema.parse({ ...extracted(), contact_preference: 'WeChat', phone: '949-555-0101' });
  assert.equal(parsed.contact_preference, 'WeChat');
  const p = sales.sanitizeExtraction(parsed, [{ role: 'user', content: '电话 949-555-0101，微信联系我最方便' }]);
  assert.equal(p.phone, '949-555-0101');
  assert.equal(p.contact_preference, 'wechat');
});

test('request_consultation accepts WeChat alone and the preferred method; an invented WeChat ID is not contact', async () => {
  const { pushes, notify } = recorder();
  const hist = [{ role: 'user' as const, content: '主卧想做遮光，想预约上门测量。我姓李，微信 li_test88，不方便接电话，微信联系我' }];
  let s = scripted([{ tool: { name: 'request_consultation', input: { name: '李女士', wechat: 'li_test88', contact_preference: 'wechat' } } }, { text: '好的，顾问会在营业时间通过微信联系您确认时间。' }]);
  let r = await sales.salesTurn(hist, 'conv-wechat-book-01', undefined, { create: s.create, notify });
  assert.equal(r.cta, 'booked');
  const l = await getConversationLead('conv-wechat-book-01');
  assert.equal(l!.stage, 'consultation_requested');
  assert.equal(l!.wechat, 'li_test88');
  assert.equal(l!.contact_preference, 'wechat');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].body, /WeChat li_test88（首选微信）/);
  assert.match(l!.summary!, /微信 li_test88、首选微信/);

  // the model uses the customer's name as the WeChat ID: not a contact
  s = scripted([{ tool: { name: 'request_consultation', input: { name: 'Lina2020', wechat: 'Lina2020' } } }, { text: '方便留一个联系方式吗？' }]);
  r = await sales.salesTurn([{ role: 'user', content: '我叫Lina2020，想预约上门测量，可以加微信联系' }], 'conv-wechat-name-01', undefined, { create: s.create, notify });
  assert.equal(s.calls[1].messages.at(-1).content[0].is_error, true);
  assert.equal((await getConversationLead('conv-wechat-name-01'))?.wechat, undefined);

  // the model makes up a WeChat ID: no contact, so it asks the customer (lets them choose)
  s = scripted([{ tool: { name: 'request_consultation', input: { name: 'Tom', wechat: 'tom_wx_01' } } }, { text: 'How would you like us to reach you?' }]);
  r = await sales.salesTurn([{ role: 'user', content: 'I want to book a consultation' }], 'conv-wechat-book-02', undefined, { create: s.create, notify });
  const toolResult = s.calls[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /phone number, email or WeChat ID/);
  assert.match(toolResult.content, /whichever they prefer\. Name all four so the customer can pick/);
  assert.equal(r.cta, 'consultation');

  // request_human: an invented WeChat ID is dropped too
  s = scripted([{ tool: { name: 'request_human', input: { reason: 'wants a person', wechat: 'ghost_id' } } }, { text: '方便留下您的称呼和联系方式吗？' }]);
  r = await sales.salesTurn([{ role: 'user', content: '我想找真人' }], 'conv-wechat-human-01', undefined, { create: s.create, notify });
  assert.equal(r.cta, 'human_form');
  assert.equal((await getConversationLead('conv-wechat-human-01'))?.wechat, undefined);
});

test('booking form: phone, email or WeChat (any one); a preferred method needs its field', async () => {
  const post = async (body: Record<string, unknown>, ip: string) => { const res = fakeRes(); await proxy.handleLead({ body: { agent: 'sales', kind: 'consultation', ...body }, headers: {}, ip } as any, res as any); return res; };
  const { pushes, notify } = recorder();
  Object.assign(proxy.salesDeps, { notify });
  try {
    const wx = await post({ conversationId: 'conv-form-wx-01', name: '李', wechat: 'li_test88', contact_preference: 'wechat', language: 'zh' }, '10.20.0.1');
    assert.equal(wx.statusCode, 200);
    assert.equal(wx.body.stage, 'consultation_requested');
    assert.equal((await getConversationLead('conv-form-wx-01'))!.contact_preference, 'wechat');

    const sms = await post({ conversationId: 'conv-form-sms-01', name: 'Tom', email: 'tom@example.com', contact_preference: 'sms', language: 'en' }, '10.20.0.2');
    assert.equal(sms.statusCode, 400);
    assert.equal(sms.body.error, 'You chose a text message; please fill in your phone number');
    const smsZh = await post({ conversationId: 'conv-form-sms-02', name: '王', email: 'w@example.com', contact_preference: 'wechat', language: 'zh' }, '10.20.0.3');
    assert.equal(smsZh.body.error, '您选择了微信联系，请填写微信号');

    const badWx = await post({ conversationId: 'conv-form-wx-02', wechat: '!!', language: 'zh' }, '10.20.0.4');
    assert.equal(badWx.statusCode, 400);
    assert.match(badWx.body.error, /微信号格式不对/);

    const ok = await post({ conversationId: 'conv-form-sms-03', name: 'Tom', phone: '949-555-0199', contact_preference: 'sms', language: 'en' }, '10.20.0.5');
    assert.equal(ok.statusCode, 200);
    assert.match(pushes.at(-1)!.body, /949-555-0199（首选短信）/);

    const ignored = await post({ conversationId: 'conv-form-pref-01', name: 'X', phone: '949-555-0198', contact_preference: 'carrier-pigeon', language: 'en' }, '10.20.0.6');
    assert.equal(ignored.statusCode, 200);
    assert.equal((await getConversationLead('conv-form-pref-01'))!.contact_preference, undefined, 'unknown preference ignored');

    const csv = leadsToCsv((await listLeads()).filter((l) => l.conversationId === 'conv-form-sms-03'));
    assert.match(csv.split('\r\n')[0], /,wechat,contact_preference,zip,/);
    assert.match(csv, /,sms,/);
  } finally {
    for (const k of Object.keys(proxy.salesDeps)) delete (proxy.salesDeps as any)[k];
  }
});

/* ---------------- rate-limit visitor key ---------------- */

test('rate-limit key: the shopper address Shopify sends first; never one shared Shopify address', () => {
  const k = (xff: string, fly: string | undefined, signed = true) => proxy.clientKey({ 'x-forwarded-for': xff, ...(fly ? { 'fly-client-ip': fly } : {}) }, signed, 'convkey01', 'socket-ip');
  // Shopify sends X-Forwarded-For: <shopper>; Fly appends Shopify's address (= Fly-Client-IP) and the app address
  assert.deepEqual(k('203.0.113.7, 34.1.1.1, 66.241.0.1', '34.1.1.1'), { key: '203.0.113.7', how: 'xff-first', shape: 'shopper-only', entries: 3 });
  // more entries in front of Shopify's address: the key stays the first entry, and the shape shows it for the self-check
  assert.deepEqual(k('203.0.113.7, 172.70.10.1, 34.1.1.1, 66.241.0.1', '34.1.1.1'), { key: '203.0.113.7', how: 'xff-first', shape: 'extra-before-shopify', entries: 4 });
  assert.equal(k('203.0.113.7, 66.241.0.1', '34.1.1.1').shape, 'fly-ip-not-in-xff');
  // no shopper address at all: count the conversation (capped site-wide), never Shopify's shared address
  assert.deepEqual(k('34.1.1.1, 66.241.0.1', '34.1.1.1'), { key: 'conv:convkey01', how: 'conversation (no visitor IP)', shape: 'no-shopper', entries: 2 });
  assert.equal(k('', '34.1.1.1').key, 'conv:convkey01');
  // address forms are normalised before comparing
  assert.equal(k('34.1.1.1:443, 66.241.0.1', '::ffff:34.1.1.1').key, 'conv:convkey01');
  assert.equal(k('[2001:db8:1:2::1]:443, 34.1.1.1', '34.1.1.1').key, '2001:db8:1:2::/64', 'IPv6 counted per /64');
  assert.equal(k('2001:db8:1:2:abcd::9, 34.1.1.1', '34.1.1.1').key, '2001:db8:1:2::/64');
  // unsigned (local testing only): the connecting address
  assert.equal(k('1.2.3.4', '9.9.9.9', false).key, '9.9.9.9');
  assert.equal(k('', undefined, false).key, 'socket-ip');
  assert.equal(proxy.normalizeIp(' [2001:DB8::1] '), '2001:db8::1');
  assert.equal(proxy.normalizeIp('203.0.113.7:51234'), '203.0.113.7');
});

test('rate limit: requests count as signed only after proxyAuth verified them; no-IP fallback is capped', async () => {
  // proxyAuth marks verified requests; an empty ?signature= in optional mode is NOT verified
  const { config } = await import('../src/config.js');
  const savedOptional = config.proxySignatureOptional;
  Object.assign(config, { proxySignatureOptional: true });
  try {
    const res: any = { locals: {}, status() { return this; }, json() { return this; } };
    let nexted = false;
    proxy.proxyAuth({ query: { signature: '' } } as any, res, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(res.locals.proxySigned, undefined, 'optional mode, no real signature: not marked as signed');
  } finally { Object.assign(config, { proxySignatureOptional: savedOptional }); }
});

test('rate-limit diagnostics count visitors, conversations and header shapes without keeping IPs', async () => {
  Object.assign(proxy.salesDeps, { create: scripted(Array.from({ length: 10 }, () => ({ text: 'ok' }))).create, notify: async () => {}, extract: async () => null });
  try {
    const chat = async (conv: string, xff: string) => {
      const res: any = { ...fakeRes(), locals: { proxySigned: true } };
      await proxy.handleChat({ body: { conversationId: conv, agent: 'sales', messages: [{ role: 'user', content: 'hello' }] }, headers: { 'x-forwarded-for': xff, 'fly-client-ip': '34.1.1.1' }, query: {}, ip: '172.16.0.1' } as any, res);
      assert.equal(res.statusCode, 200);
    };
    const d0 = proxy.rateLimitDiagnostics();
    await chat('conv-diag-0001', '198.51.100.1, 34.1.1.1, 66.241.0.1');
    await chat('conv-diag-0002', '198.51.100.2, 34.1.1.1, 66.241.0.1');
    await chat('conv-diag-0002', '198.51.100.2, 34.1.1.1, 66.241.0.1');
    const d = proxy.rateLimitDiagnostics();
    assert.equal(d.requests - d0.requests, 3);
    assert.equal(d.visitors - d0.visitors, 2);
    assert.equal(d.conversations - d0.conversations, 2);
    assert.equal((d.shapes['shopper-only'] ?? 0) - (d0.shapes['shopper-only'] ?? 0), 3);
    assert.ok(d.maxConversationsPerVisitor >= 1);
    assert.doesNotMatch(JSON.stringify(d), /198\.51|34\.1|66\.241/, 'no addresses in the diagnostics');
  } finally {
    for (const k of Object.keys(proxy.salesDeps)) delete (proxy.salesDeps as any)[k];
  }
});

test('talking to a person: the tool is called at once, even before contact details; the reply is written after tool results', () => {
  const p = sales.SALES_SYSTEM;
  assert.match(p, /call request_human right away in this same turn, even if they have not given any contact details yet/);
  assert.match(p, /12b\. When you call a tool, do not write anything to the customer before the call; write your whole reply after the result comes back\./);
});

test('tool loop: text written before a tool call is kept when nothing is written after it', async () => {
  const { runToolLoop } = await import('../src/chat.js');
  const replies = [
    { content: [{ type: 'text', text: 'May I have your name and the best way to reach you?', citations: null }, { type: 'tool_use', id: 'tu_1', name: 'request_human', input: { reason: 'wants a person' } }], stop_reason: 'tool_use' },
    { content: [], stop_reason: 'end_turn' },
  ];
  const create = async () => ({ id: 'm', type: 'message', role: 'assistant', model: 'stub', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, ...replies.shift()! }) as any;
  const out = await runToolLoop({ system: 's', tools: [], history: [{ role: 'user', content: 'Can I speak with a sales representative?' }], create, onTool: async () => ({ content: 'ok' }) });
  assert.equal(out.text, 'May I have your name and the best way to reach you?');
  // normal case: the reply after the tool result is used as is
  const replies2 = [
    { content: [{ type: 'text', text: 'Let me check.', citations: null }, { type: 'tool_use', id: 'tu_1', name: 'check_service_area', input: { zip: '92618' } }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: '92618 is within our service area.', citations: null }], stop_reason: 'end_turn' },
  ];
  const create2 = async () => ({ id: 'm', type: 'message', role: 'assistant', model: 'stub', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, ...replies2.shift()! }) as any;
  const out2 = await runToolLoop({ system: 's', tools: [], history: [{ role: 'user', content: '92618' }], create: create2, onTool: async () => ({ content: 'ok' }) });
  assert.equal(out2.text, '92618 is within our service area.');
});
