import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-sales-'));
process.env.DATA_DIR = tmp;
process.env.SHOPIFY_API_SECRET = 'shpss_secret_abc';
process.env.SHOPIFY_APP_URL = 'https://app.example.com';
delete process.env.SERVICE_ZIP_PREFIXES;
delete process.env.NTFY_TOPIC;

const leads = await import('../src/leads.js');
const sales = await import('../src/sales.js');
const { KNOWLEDGE } = await import('../src/knowledge.js');
const proxy = await import('../src/proxy.js');
const { chatTurn } = await import('../src/chat.js');
const { upsertConversationLead, computeStage, listLeads, getConversationLead, leadsToCsv, setLeadStage } = leads;

after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

function recorder() {
  const pushes: string[] = [];
  return { pushes, notify: async (title: string, msg: string) => { pushes.push(`${title}|${msg}`); } };
}
const fakeRes = () => ({ statusCode: 200, body: null as any, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } });

/** Scripted stand-in for client.beta.messages.create: returns the queued responses in order. */
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
const emptyExtract = (over: Partial<import('../src/sales.js').Extracted> = {}): import('../src/sales.js').Extracted => ({
  name: null, phone: null, email: null, zip: null, room_type: null, window_count: null, approximate_size: null, primary_need: null,
  motorization_interest: null, budget_range: null, products_recommended: [], consultation_interest: 'unknown', wants_human: false, summary: '', ...over,
});

test('stage rules (deterministic)', () => {
  assert.equal(computeStage({}), null, 'nothing to save');
  assert.equal(computeStage({ room_type: 'bedroom' }), 'new');
  assert.equal(computeStage({ zip: '92618' }), 'new');
  assert.equal(computeStage({ phone: '9495551234' }), 'new', 'contact alone is a new lead');
  assert.equal(computeStage({ phone: '9495551234', primary_need: 'blackout' }), 'qualified');
  assert.equal(computeStage({ email: 'a@b.com', room_type: 'bedroom', consultation_interest: 'yes' }), 'consultation_requested');
  assert.equal(computeStage({ room_type: 'bedroom', consultation_interest: 'yes' }), 'new', 'booking needs a contact method');
  assert.equal(computeStage({ phone: '9495551234' }, { consultation: true }), 'consultation_requested');
  assert.equal(computeStage({ phone: '9495551234', wants_human: true }), 'handed_to_human');
  assert.equal(computeStage({ wants_human: true }), null, 'human request without contact or info: nothing to save');
});

test('one lead per conversation; stages advance forward only; one push per stage from qualified on', async () => {
  const { pushes, notify } = recorder();
  const conv = 'conv-stage-flow-1';
  assert.equal(await upsertConversationLead(conv, {}, { notify }), null, 'no lead before any info');

  let l = await upsertConversationLead(conv, { room_type: 'master bedroom', primary_need: 'blackout' }, { notify });
  assert.equal(l!.stage, 'new');
  assert.equal(l!.lead_source, 'AI Sales Agent');
  assert.equal(pushes.length, 0, 'stage new is saved but not pushed');

  l = await upsertConversationLead(conv, { zip: '92618', name: 'Anna', phone: '949-555-1234' }, { notify });
  assert.equal(l!.stage, 'qualified');
  assert.equal(l!.zip_in_area, true);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /已确认需求/);
  assert.match(pushes[0], /Anna · 949-555-1234/);

  l = await upsertConversationLead(conv, { summary: 'again' }, { notify });
  assert.equal(l!.stage, 'qualified');
  assert.equal(pushes.length, 1, 'same stage is not pushed twice');

  l = await upsertConversationLead(conv, { preferred_time: 'Saturday' }, { notify, signals: { consultation: true } });
  assert.equal(l!.stage, 'consultation_requested');
  assert.equal(pushes.length, 2);

  l = await upsertConversationLead(conv, { consultation_interest: 'unknown', room_type: '' }, { notify });
  assert.equal(l!.stage, 'consultation_requested', 'a later, emptier extraction never moves the stage back');
  assert.equal(l!.consultation_interest, 'yes');
  assert.equal(l!.room_type, 'master bedroom', 'empty values do not overwrite');

  l = await upsertConversationLead(conv, {}, { notify, signals: { human: true } });
  assert.equal(l!.stage, 'handed_to_human');
  assert.equal(pushes.length, 3);
  assert.deepEqual(l!.stage_history!.map((h) => h.stage), ['new', 'qualified', 'consultation_requested', 'handed_to_human']);

  const all = (await listLeads()).filter((x) => x.conversationId === conv);
  assert.equal(all.length, 1, 'still a single lead file for the conversation');

  // a jump straight to a high stage pushes once (the highest), not once per skipped stage
  const r2 = recorder();
  const j = await upsertConversationLead('conv-jump-1', { phone: '7145550000', room_type: 'office' }, { notify: r2.notify, signals: { human: true } });
  assert.equal(j!.stage, 'handed_to_human');
  assert.equal(r2.pushes.length, 1);
});

test('concurrent upserts for one conversation do not create duplicates', async () => {
  const conv = 'conv-race-0001';
  await Promise.all([
    upsertConversationLead(conv, { room_type: 'den' }, { notify: async () => {} }),
    upsertConversationLead(conv, { phone: '9495550101' }, { notify: async () => {} }),
    upsertConversationLead(conv, { primary_need: 'privacy' }, { notify: async () => {} }),
  ]);
  const l = (await listLeads()).filter((x) => x.conversationId === conv);
  assert.equal(l.length, 1);
  assert.equal(l[0].stage, 'qualified');
});

test('ZIP: 926/927/928 is a preliminary OC signal; other ZIPs are never refused', () => {
  const inArea = sales.checkServiceArea('92618');
  assert.equal(inArea.likely_in_area, true);
  for (const z of ['92701', '92801']) assert.equal(sales.checkServiceArea(z).likely_in_area, true);
  const la = sales.checkServiceArea('90012');
  assert.equal(la.likely_in_area, false);
  assert.match(la.content, /confirm coverage/);
  assert.match(la.content, /Do NOT say we do not serve/);
  assert.equal(sales.checkServiceArea('9261').zip, undefined);
  assert.equal(sales.checkServiceArea('92618-1234').zip, '92618');
  assert.equal(leads.zipInServiceArea('92618', ['900']), false, 'prefixes are configurable');
});

test('extractor output is validated: formats, contact must be typed by the customer, known products only', () => {
  const history = [
    { role: 'user' as const, content: 'Hi, master bedroom blackout for 3 windows. I am Anna, 949-555-1234, ZIP 92618' },
    { role: 'assistant' as const, content: 'Duette or Designer Roller in blackout would fit. You can also call (949) 880-1322.' },
  ];
  const p = sales.sanitizeExtraction(emptyExtract({
    name: 'Anna', phone: '949-555-1234', email: 'not-an-email', zip: '92618', room_type: 'master bedroom', window_count: '3',
    primary_need: 'blackout', budget_range: 'around 2k', products_recommended: ['Duette honeycomb', 'Designer Roller', 'Made-up Product X'], consultation_interest: 'unknown',
  }), history);
  assert.equal(p.phone, '949-555-1234');
  assert.equal(p.email, undefined, 'invalid email dropped');
  assert.equal(p.zip, '92618');
  assert.deepEqual(p.products_recommended, ['Duette', 'Designer Roller'], 'unknown products dropped');
  assert.equal(p.budget_range, 'around 2k', 'customer-stated budget kept verbatim');

  const halluc = sales.sanitizeExtraction(emptyExtract({ phone: '(949) 880-1322', email: 'someone@example.com', zip: '92660' }), history);
  assert.equal(halluc.phone, undefined, "the business's own phone (said by the assistant) is not the customer's");
  assert.equal(halluc.email, undefined, 'email the customer never typed is dropped');
  assert.equal(halluc.zip, undefined);

  assert.equal(sales.validPhone('12345'), undefined);
  assert.equal(sales.validPhone('+1 (949) 555-1234'), '+1 (949) 555-1234');
  assert.equal(sales.validEmail('a.b+c@smori.co'), 'a.b+c@smori.co');
});

test('sales language: a bare ZIP or phone keeps the conversation language', () => {
  const h = (...u: string[]) => u.map((content) => ({ role: 'user' as const, content }));
  assert.equal(sales.conversationLanguage(h('主卧想要遮光', 'ZIP 92618')), 'zh');
  assert.equal(sales.conversationLanguage(h('主卧想要遮光', '949-555-1234 anna@example.com')), 'zh');
  assert.equal(sales.conversationLanguage(h('主卧想要遮光', 'Actually, could you answer in English please')), 'en');
  assert.equal(sales.conversationLanguage(h('We need blackout shades for the bedroom', '92618')), 'en');
  assert.equal(sales.conversationLanguage(h('Hello')), 'en');
});

test('knowledge and sales prompt: no prices, no ALTA product claims, ZIP never used to refuse', () => {
  for (const text of [KNOWLEDGE, sales.SALES_SYSTEM]) {
    assert.doesNotMatch(text, /\$\s?\d|\d+\s?(usd|dollars)|per square (foot|ft)\s*\$/i);
  }
  assert.match(KNOWLEDGE, /ALTA Window Fashions: no product details/);
  assert.doesNotMatch(KNOWLEDGE, /ALTA[^\n]*(motoriz|blackout|honeycomb|shutter)/i, 'no ALTA product facts were added');
  assert.match(sales.SALES_SYSTEM, /never state, estimate, compare or imply any price, price range/);
  assert.match(sales.SALES_SYSTEM, /never tell a customer that we do not serve their area/i);
  assert.match(sales.SALES_SYSTEM, /No upselling/);
});

test('sales prompt: one primary recommendation (+ at most one alternative); ZIP / contact only after conversion intent', () => {
  const p = sales.SALES_SYSTEM;
  assert.match(p, /Give ONE primary recommendation/);
  assert.match(p, /at most ONE alternative/);
  assert.match(p, /why the primary recommendation fits their stated need better/);
  assert.match(p, /List several products only when the customer explicitly asks to compare/);
  assert.match(p, /Knowing the room, window type or need is NOT a reason to ask for a ZIP code, phone or email/);
  assert.match(p, /Conversion intent means/);
  assert.doesNotMatch(p, /Offer one to three fitting options/, 'old multi-option instruction removed');
  assert.doesNotMatch(p, /once the customer has shared some project details, ask for their ZIP/, 'old early-ZIP instruction removed');
});

test('consultation button follows conversion intent, not just known room / need', async () => {
  const conv = 'conv-cta-intent-01';
  await upsertConversationLead(conv, { room_type: 'master bedroom', primary_need: 'blackout' }, { notify: async () => {} });
  const turn = async (text: string) => sales.salesTurn([{ role: 'user', content: text }], conv, undefined, { create: scripted([{ text: 'ok' }]).create, notify: async () => {} });
  assert.equal((await turn('Is Duette easy to clean?')).cta, null, 'room + need known, plain question: no booking button');
  assert.equal((await turn('卧室遮光帘白天会不会太暗？')).cta, null);
  for (const t of ['How much would this cost?', 'Can you come measure?', 'Do you have samples?', 'How long does installation take?', "I'm interested in the Duette", '这个多少钱', '可以上门量尺吗', '安装要多久', '我对这个方案感兴趣']) {
    assert.equal((await turn(t)).cta, 'consultation', t);
  }
  for (const t of ['我想咨询一下遮光', 'Which is better for privacy?']) assert.doesNotMatch(t, sales.INTENT_RE, `${t} is a question, not conversion intent`);
});

test('legacy leads (no stage) read as handed_to_human; old assistant flow unchanged', async () => {
  await fs.mkdir(path.join(tmp, 'leads'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'leads', '20260101-abcdef.json'), JSON.stringify({ id: '20260101-abcdef', createdAt: '2026-01-01T00:00:00.000Z', conversationId: 'form', source: 'form', reason: 'human', language: 'zh', phone: '9490000000' }));
  const legacy = (await listLeads()).find((l) => l.id === '20260101-abcdef')!;
  assert.equal(legacy.stage, 'handed_to_human');
  assert.equal(legacy.lead_source, 'AI Assistant (form)');
  assert.equal((await listLeads(500, 'handed_to_human')).some((l) => l.id === legacy.id), true);

  // old assistant (no agent flag) still uses create_lead and saves a separate human lead
  const { create, calls } = scripted([{ tool: { name: 'create_lead', input: { name: 'Wang', phone: '9491112222', reason: 'quote' } } }, { text: 'ok' }]);
  const saved: any[] = [];
  const r = await chatTurn([{ role: 'user', content: '报价，电话 9491112222' }], 'oldconv1', { create, saveLead: async (x: any) => { saved.push(x); return { ...x, id: 'L1', createdAt: 'now' }; } });
  assert.equal(r.reply, 'ok');
  assert.equal(r.handoff, true);
  assert.equal(saved[0].phone, '9491112222');
  assert.deepEqual(calls[0].tools.map((t: any) => t.name), ['create_lead'], 'old assistant still has only create_lead');
  assert.doesNotMatch(calls[0].system[0].text, /check_service_area/);
});

test('salesTurn: tools, consultation without contact is held, then booked; CTA signals', async () => {
  const { pushes, notify } = recorder();
  const conv = 'conv-turn-0001';
  // 1) ZIP check
  let s = scripted([{ tool: { name: 'check_service_area', input: { zip: '92620' } } }, { text: 'We work in your area regularly.' }]);
  let r = await sales.salesTurn([{ role: 'user', content: 'Bedroom blackout, my ZIP is 92620' }], conv, { url: 'https://smoriwindowfashion.com/pages/cases' }, { create: s.create, notify });
  assert.equal(r.reply, 'We work in your area regularly.');
  assert.equal(r.cta, 'consultation', 'a ZIP the customer gives (check_service_area ran) shows the consultation button');
  assert.match(s.calls[1].messages.at(-1).content[0].content, /usual Orange County service area/);
  assert.deepEqual(s.calls[0].tools.map((t: any) => t.name), ['check_service_area', 'request_consultation', 'request_human']);
  let lead = await getConversationLead(conv);
  assert.equal(lead!.zip, '92620');
  assert.equal(lead!.page!.url, 'https://smoriwindowfashion.com/pages/cases');

  // 2) wants to book but no contact yet -> tool error asks for contact; interest remembered
  s = scripted([{ tool: { name: 'request_consultation', input: { name: 'Leo' } } }, { text: 'May I have a phone number or email?' }]);
  r = await sales.salesTurn([{ role: 'user', content: 'I want to book a consultation' }], conv, undefined, { create: s.create, notify });
  assert.equal(s.calls[1].messages.at(-1).content[0].is_error, true);
  assert.equal(r.cta, 'consultation');
  assert.equal(r.leadSaved, false);
  lead = await getConversationLead(conv);
  assert.equal(lead!.consultation_interest, 'yes');
  assert.equal(lead!.stage, 'new');
  assert.equal(pushes.length, 0);

  // 3) gives contact -> request_consultation succeeds -> consultation_requested (one push)
  const hist = [
    { role: 'user' as const, content: 'I want to book a consultation' },
    { role: 'assistant' as const, content: 'May I have a phone number or email?' },
    { role: 'user' as const, content: "I'm Leo, leo@example.com, Saturday morning works" },
  ];
  s = scripted([{ tool: { name: 'request_consultation', input: { name: 'Leo', email: 'leo@example.com', phone: '(949) 880-1322', preferred_time: 'Saturday morning' } } }, { text: 'Thanks Leo, our team will contact you to confirm.' }]);
  r = await sales.salesTurn(hist, conv, undefined, { create: s.create, notify });
  assert.equal(r.cta, 'booked');
  assert.equal(r.leadSaved, true);
  lead = await getConversationLead(conv);
  assert.equal(lead!.stage, 'consultation_requested');
  assert.equal(lead!.email, 'leo@example.com');
  assert.equal(lead!.phone, undefined, 'a phone the customer never typed (our own number) is not stored');
  assert.equal(lead!.preferred_time, 'Saturday morning');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /申请预约咨询/);

  // 4) asks for a person -> handed_to_human
  s = scripted([{ tool: { name: 'request_human', input: { reason: 'wants to talk to a person' } } }, { text: 'A team member will contact you.' }]);
  r = await sales.salesTurn([...hist, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'can I talk to a person' }], conv, undefined, { create: s.create, notify });
  assert.equal(r.cta, 'human_sent');
  assert.equal((await getConversationLead(conv))!.stage, 'handed_to_human');
  assert.equal(pushes.length, 2);

  // 5) refusal / failure with contact on file -> handed to a person, offline reply
  const conv2 = 'conv-turn-0002';
  await upsertConversationLead(conv2, { phone: '7145551111', room_type: 'kitchen' }, { notify: async () => {} });
  const refusal = async () => ({ id: 'm', type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: 'refusal', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as any);
  r = await sales.salesTurn([{ role: 'user', content: 'something odd' }], conv2, undefined, { create: refusal, notify: async () => {} });
  assert.equal(r.cta, 'human_form');
  assert.equal((await getConversationLead(conv2))!.stage, 'handed_to_human');
});

test('extractLead: background extraction builds the qualified lead from the conversation', async () => {
  const { pushes, notify } = recorder();
  const conv = 'conv-extract-01';
  const history = [
    { role: 'user' as const, content: '主卧想要遮光，3 扇窗' },
    { role: 'assistant' as const, content: '可以考虑 Duette 遮光款。方便告诉我 ZIP 吗？' },
    { role: 'user' as const, content: '92618，我叫王丽 949-555-7788' },
  ];
  const l = await sales.extractLead(history, conv, { utm: { utm_source: 'google' } }, { notify, extract: async () => emptyExtract({ name: '王丽', phone: '949-555-7788', zip: '92618', room_type: '主卧', window_count: '3', primary_need: '遮光', products_recommended: ['Duette'], summary: '主卧 3 扇窗遮光，已留电话。' }) });
  assert.equal(l!.stage, 'qualified');
  assert.equal(l!.language, 'zh');
  assert.equal(l!.summary, '主卧 3 扇窗遮光，已留电话。');
  assert.equal(l!.page!.utm!.utm_source, 'google');
  assert.equal(pushes.length, 1);
  assert.equal(await sales.extractLead(history, 'conv-extract-02', undefined, { extract: async () => null }), null, 'refused extraction saves nothing');
});

test('proxy: /chat with agent=sales returns a CTA and extracts in the background; /lead merges into the conversation lead', async () => {
  const { pushes, notify } = recorder();
  const s = scripted([{ text: 'Duette in blackout opacity would suit a bedroom. Which room is it for?' }]);
  Object.assign(proxy.salesDeps, { create: s.create, notify, extract: async () => emptyExtract({ room_type: 'bedroom', primary_need: 'blackout', products_recommended: ['Duette'], summary: '卧室遮光' }) });
  const conv = 'conv-proxy-0001';
  const res = fakeRes();
  await proxy.handleChat({ body: { conversationId: conv, agent: 'sales', page: { url: 'https://smoriwindowfashion.com/?utm_source=x&email=a@b.com', referrer: 'https://www.google.com/search?q=shades', utm: { utm_source: 'google', evil: 'x' } }, messages: [{ role: 'user', content: 'How much for bedroom blackout shades?' }] }, headers: {}, ip: '10.0.0.1' } as any, res as any);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cta, 'consultation', 'price question = buying intent -> consultation CTA');
  assert.equal(res.body.leadSaved, false);
  await new Promise((r) => setTimeout(r, 50));
  let lead = await getConversationLead(conv);
  assert.equal(lead!.stage, 'new');
  assert.equal(lead!.page!.url, 'https://smoriwindowfashion.com/', 'query string stripped');
  assert.equal(lead!.page!.referrer, 'https://www.google.com');
  assert.deepEqual(lead!.page!.utm, { utm_source: 'google' });

  // the widget's "预约咨询" form
  const bad = fakeRes();
  await proxy.handleLead({ body: { conversationId: conv, agent: 'sales', kind: 'consultation', wechat: 'wx123', language: 'zh' }, headers: {}, ip: '10.0.0.2' } as any, bad as any);
  assert.equal(bad.statusCode, 400, 'booking needs phone or email');
  const badZip = fakeRes();
  await proxy.handleLead({ body: { conversationId: conv, agent: 'sales', kind: 'consultation', phone: '9495552222', zip: '926', language: 'en' }, headers: {}, ip: '10.0.0.2' } as any, badZip as any);
  assert.equal(badZip.statusCode, 400);
  const ok = fakeRes();
  await proxy.handleLead({ body: { conversationId: conv, agent: 'sales', kind: 'consultation', name: 'Mia', phone: '9495552222', zip: '90210', preferred_time: 'weekday evening', language: 'en' }, headers: {}, ip: '10.0.0.2' } as any, ok as any);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.stage, 'consultation_requested');
  lead = await getConversationLead(conv);
  assert.equal(lead!.zip, '90210');
  assert.equal(lead!.zip_in_area, false, 'outside the preliminary prefixes, but saved and booked normally');
  assert.equal(lead!.room_type, 'bedroom', 'fields from the chat are kept');
  assert.equal((await listLeads()).filter((l) => l.conversationId === conv).length, 1);

  // 转人工 form in sales mode
  const h = fakeRes();
  await proxy.handleLead({ body: { conversationId: conv, agent: 'sales', kind: 'human', phone: '9495552222', language: 'en' }, headers: {}, ip: '10.0.0.3' } as any, h as any);
  assert.equal(h.body.stage, 'handed_to_human');
  assert.deepEqual(pushes.map((p) => p.split('|')[0]), ['SMORI 销售线索：申请预约咨询', 'SMORI 销售线索：转人工']);

  // staff override + CSV
  const back = await setLeadStage(lead!.id, 'qualified');
  assert.equal(back.stage, 'qualified');
  assert.equal(back.stage_history!.at(-1)!.by, 'staff');
  const csv = leadsToCsv([back, { ...back, id: 'x', name: '=HYPERLINK("x")', summary: 'a, "b"\nc' }]);
  assert.match(csv, /^﻿id,createdAt/);
  assert.match(csv, /'=HYPERLINK/, 'formula-like cells are neutralised');
  assert.match(csv, /"a, ""b""\nc"/);
  for (const k of Object.keys(proxy.salesDeps)) delete (proxy.salesDeps as any)[k];
});
