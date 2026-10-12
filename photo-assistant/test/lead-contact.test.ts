/**
 * Contact capture and lead pushes: the "有联系方式、待跟进" stage, push delivery / retry,
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

/* ---------------- 有联系方式、待跟进 ---------------- */

test('contact alone: "有联系方式、待跟进" is pushed at once (not a confirmed need), then each higher stage once', async () => {
  const { pushes, notify } = recorder();
  const conv = 'conv-contact-only-01';
  let l = await upsertConversationLead(conv, { phone: '949-555-0123' }, { notify });
  assert.equal(l!.stage, 'contact_pending');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'SMORI 销售线索：有联系方式、待跟进');
  assert.match(pushes[0].body, /949-555-0123/);
  assert.match(pushes[0].body, /客户留了联系方式，还没谈需求，也没要求预约。/);
  assert.match(l!.summary!, /阶段：有联系方式、待跟进/);

  l = await upsertConversationLead(conv, { room_type: '客厅', primary_need: '隐私' }, { notify });
  assert.equal(l!.stage, 'qualified', 'a need makes it 已确认需求 (still not buying intent)');
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].title, 'SMORI 销售线索：已确认需求');
  assert.doesNotMatch(pushes[1].body, /还没谈需求/);

  l = await upsertConversationLead(conv, {}, { notify, signals: { consultation: true } });
  assert.equal(l!.stage, 'consultation_requested', 'only an explicit booking makes it high intent');
  assert.equal(pushes.length, 3);
  assert.deepEqual(l!.stage_history!.map((h) => h.stage), ['contact_pending', 'qualified', 'consultation_requested']);

  // ZIP / budget / products are not a need: still 有联系方式、待跟进
  const r = recorder();
  const z = await upsertConversationLead('conv-contact-only-02', { email: 'z@example.com', zip: '92618', budget_range: '5k' }, { notify: r.notify });
  assert.equal(z!.stage, 'contact_pending');
  assert.equal(r.pushes.length, 1);
});

test('contact typed in chat with no need and no intent: extraction makes it 有联系方式、待跟进 and pushes', async () => {
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
  assert.match(p, /ask for their name and one way to reach them only when they want to book the consultation or need a person to follow up: a phone number \(call or text\), email or WeChat, whichever they prefer\. Let them choose; do not insist on a particular one/);
});

/* ---------------- push delivery ---------------- */

test('a failed push keeps the lead, is flagged, is not recorded as sent, and goes out on the next update', async () => {
  const conv = 'conv-push-fail-01';
  let l = await upsertConversationLead(conv, { phone: '949-555-0001' }, { notify: failing() });
  assert.equal(l!.stage, 'contact_pending', 'the lead is saved even though the push failed');
  assert.deepEqual(l!.notified ?? [], [], 'a failed push is not recorded as sent');
  assert.equal(l!.notify_error!.stage, 'contact_pending');
  assert.equal(l!.notify_error!.attempts, 1);
  assert.match(l!.notify_error!.error, /502/);
  assert.equal(leads.pushPending(l!), true);
  const onDisk = JSON.parse(await fs.readFile(path.join(tmp, 'leads', `${l!.id}.json`), 'utf8'));
  assert.equal(onDisk.notify_error.attempts, 1);

  l = await upsertConversationLead(conv, { name: 'Ann' }, { notify: failing() });
  assert.equal(l!.notify_error!.attempts, 2);

  const { pushes, notify } = recorder();
  l = await upsertConversationLead(conv, { needs_summary: 'x' }, { notify });
  assert.equal(pushes.length, 1, 'retried on the next update');
  assert.deepEqual(l!.notified, ['contact_pending']);
  assert.equal(l!.notify_error, undefined);
  await upsertConversationLead(conv, { needs_summary: 'y' }, { notify });
  assert.equal(pushes.length, 1, 'not sent twice');

  // the customer never waits for retries: a hanging push is not retried in the request
  let calls = 0;
  await upsertConversationLead('conv-push-fail-02', { email: 'b@example.com' }, { notify: async () => { calls++; throw new Error('timeout'); } });
  assert.equal(calls, 1);
});

test('a failure at one stage, then a higher stage: only the latest stage is pushed', async () => {
  const conv = 'conv-push-fail-03';
  await upsertConversationLead(conv, { phone: '949-555-0003' }, { notify: failing() });
  const { pushes, notify } = recorder();
  const l = await upsertConversationLead(conv, {}, { notify, signals: { consultation: true } });
  assert.deepEqual(pushes.map((p) => p.title), ['SMORI 销售线索：申请预约咨询']);
  assert.deepEqual(l!.notified, ['consultation_requested']);
  assert.equal(l!.notify_error, undefined);
});

test('retryFailedPushes: delivers flagged pushes, skips delivered and legacy leads, gives up after 48 h', async () => {
  await upsertConversationLead('conv-retry-a', { phone: '949-555-0101' }, { notify: failing() });
  await upsertConversationLead('conv-retry-b', { phone: '949-555-0102' }, { notify: async () => {} });
  const old = new Date(Date.now() - 3 * 86_400_000);
  await upsertConversationLead('conv-retry-c', { phone: '949-555-0103' }, { notify: failing(), now: () => old });
  // a lead written by the legacy assistant before stages existed (no stage, no notified)
  await fs.writeFile(path.join(tmp, 'leads', '20260101-legacy1.json'), JSON.stringify({ id: '20260101-legacy1', createdAt: '2026-01-01T00:00:00.000Z', conversationId: 'form', source: 'form', reason: 'human', language: 'zh', phone: '9490000000' }));

  const { pushes, notify } = recorder();
  const r = await retryFailedPushes({ notify });
  assert.equal(r.delivered, r.retried);
  assert.equal(pushes.length, r.delivered);
  const bodies = pushes.map((p) => p.body).join('\n');
  assert.match(bodies, /949-555-0101/, 'the flagged lead is delivered');
  assert.doesNotMatch(bodies, /949-555-0102/, 'an already delivered lead is not pushed again');
  assert.doesNotMatch(bodies, /949-555-0103/, 'older than 48 h: not retried');
  assert.doesNotMatch(bodies, /9490000000/, 'legacy leads are never pushed by the retry');
  assert.equal((await getConversationLead('conv-retry-a'))!.notify_error, undefined);
  assert.ok((await getConversationLead('conv-retry-c'))!.notify_error, 'left flagged for the admin page');
  assert.deepEqual(await retryFailedPushes({ notify }), { retried: 0, delivered: 0 }, 'nothing left to retry');
});

test('without NTFY_TOPIC the default lead notifier fails loudly: the lead is flagged, not silently marked as sent', async () => {
  const l = await upsertConversationLead('conv-no-topic-01', { phone: '949-555-0200' });
  assert.match(l!.notify_error!.error, /NTFY_TOPIC is not set/);
  assert.deepEqual(l!.notified ?? [], []);
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

test('WeChat: validated, kept only when the customer typed it; contact preference from the customer', () => {
  assert.equal(sales.validWechat('wx_test88'), 'wx_test88');
  assert.equal(sales.validWechat('微信：wx_test88'), 'wx_test88');
  assert.equal(sales.validWechat('WeChat ID: Li-Na_2020'), 'Li-Na_2020');
  assert.equal(sales.validWechat('13800138000'), '13800138000', 'a phone number used as WeChat ID');
  assert.equal(sales.validWechat('a b c'), undefined);
  assert.equal(sales.validWechat('ab'), undefined);
  const history = [{ role: 'user' as const, content: '想预约上门，我姓李，微信 li_test88，发短信也行' }];
  const p = sales.sanitizeExtraction(extracted({ wechat: 'li_test88', contact_preference: 'sms' }), history);
  assert.equal(p.wechat, 'li_test88');
  assert.equal(p.contact_preference, 'sms');
  const h = sales.sanitizeExtraction(extracted({ wechat: 'made_up_id', contact_preference: 'fax' as never }), history);
  assert.equal(h.wechat, undefined, 'a WeChat ID the customer never typed is dropped');
  assert.equal(h.contact_preference, undefined);
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

  // the model makes up a WeChat ID: no contact, so it asks the customer (lets them choose)
  s = scripted([{ tool: { name: 'request_consultation', input: { name: 'Tom', wechat: 'tom_wx_01' } } }, { text: 'How would you like us to reach you?' }]);
  r = await sales.salesTurn([{ role: 'user', content: 'I want to book a consultation' }], 'conv-wechat-book-02', undefined, { create: s.create, notify });
  const toolResult = s.calls[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /phone number, email or WeChat ID/);
  assert.match(toolResult.content, /letting them choose/);
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

test('rate-limit key: the visitor address Shopify forwarded, never one shared Shopify address, never a spoofed entry', () => {
  const k = (xff: string, fly: string | undefined, signed = true) => proxy.clientKey({ 'x-forwarded-for': xff, ...(fly ? { 'fly-client-ip': fly } : {}) }, signed, 'convkey01', 'socket-ip');
  // Shopify sends X-Forwarded-For: <shopper>; Fly appends Shopify's address (= Fly-Client-IP) and the app address
  assert.deepEqual(k('203.0.113.7, 34.1.1.1, 66.241.0.1', '34.1.1.1'), { key: '203.0.113.7', how: 'before-fly-client-ip', entries: 3 });
  // an X-Forwarded-For the shopper sent themselves (if Shopify appends instead of replacing) is ignored
  assert.equal(k('6.6.6.6, 203.0.113.7, 34.1.1.1, 66.241.0.1', '34.1.1.1').key, '203.0.113.7');
  // Fly lists only the app address after Shopify's header
  assert.equal(k('203.0.113.7, 66.241.0.1', '34.1.1.1').key, '203.0.113.7');
  assert.equal(k('6.6.6.6, 203.0.113.7, 66.241.0.1', undefined).key, '203.0.113.7');
  assert.equal(k('203.0.113.7', undefined).key, '203.0.113.7');
  // no shopper address at all: count the conversation, never Shopify's shared address
  assert.deepEqual(k('34.1.1.1, 66.241.0.1', '34.1.1.1'), { key: 'conv:convkey01', how: 'conversation (no visitor IP)', entries: 2 });
  assert.equal(k('', '34.1.1.1').key, 'conv:convkey01');
  // unsigned (local testing only): the connecting address
  assert.equal(k('1.2.3.4', '9.9.9.9', false).key, '9.9.9.9');
  assert.equal(k('', undefined, false).key, 'socket-ip');
});

test('rate-limit diagnostics count visitors vs conversations without keeping IPs', async () => {
  Object.assign(proxy.salesDeps, { create: scripted(Array.from({ length: 10 }, () => ({ text: 'ok' }))).create, notify: async () => {}, extract: async () => null });
  try {
    const chat = async (conv: string, xff: string) => {
      const res = fakeRes();
      await proxy.handleChat({ body: { conversationId: conv, agent: 'sales', messages: [{ role: 'user', content: 'hello' }] }, headers: { 'x-forwarded-for': xff, 'fly-client-ip': '34.1.1.1' }, query: { signature: 'verified-by-proxyAuth' }, ip: '172.16.0.1' } as any, res as any);
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
    assert.equal(d.how['before-fly-client-ip'] - (d0.how['before-fly-client-ip'] ?? 0), 3);
    assert.doesNotMatch(JSON.stringify(d), /198\.51|34\.1|66\.241/, 'no addresses in the diagnostics');
  } finally {
    for (const k of Object.keys(proxy.salesDeps)) delete (proxy.salesDeps as any)[k];
  }
});
