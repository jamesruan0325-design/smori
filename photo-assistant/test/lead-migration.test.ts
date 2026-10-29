/**
 * Deploy and rollback safety for the contact_pending stage. Lead files are written by the
 * production version itself (test/fixtures/leads-46c7783.ts, a frozen copy of main 46c7783)
 * and then handled by the current version, and the other way round.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-lead-migration-'));
process.env.DATA_DIR = tmp;
process.env.SHOPIFY_APP_URL = 'https://app.example.com';
delete process.env.SERVICE_ZIP_PREFIXES;
delete process.env.NTFY_TOPIC;

const leads = await import('../src/leads.js');
const old = await import('./fixtures/leads-46c7783.js');
const sales = await import('../src/sales.js');
const proxy = await import('../src/proxy.js');

after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

function recorder() {
  const pushes: { title: string; body: string }[] = [];
  return { pushes, notify: async (title: string, body: string) => { pushes.push({ title, body }); } };
}
const raw = async (id: string) => JSON.parse(await fs.readFile(path.join(tmp, 'leads', `${id}.json`), 'utf8'));
const byConv = async (conv: string) => (await leads.listLeads(100_000)).find((l) => l.conversationId === conv)!;
const extracted = (over: Partial<import('../src/sales.js').Extracted> = {}): import('../src/sales.js').Extracted => ({
  name: null, phone: null, email: null, wechat: null, contact_preference: null, zip: null, room_type: null, window_count: null, approximate_size: null, primary_need: null,
  motorization_interest: null, budget_range: null, products_recommended: [], consultation_interest: 'unknown', wants_human: false, summary: '', ...over,
});

/* ---------------- deploy: files written by the production version ---------------- */

test('deploy: leads written by the production version are migrated once, never pushed again, never turned into 转人工', async () => {
  const o = recorder();
  // every kind of lead the production version writes
  await old.upsertConversationLead('mig-new-nocontact', { room_type: '客厅' }, { notify: o.notify });
  await old.upsertConversationLead('mig-new-contact', { phone: '949-555-7001' }, { notify: o.notify });
  await old.upsertConversationLead('mig-new-contact-zip', { email: 'zz@example.com', zip: '92618', window_count: '4' }, { notify: o.notify });
  await old.upsertConversationLead('mig-qualified', { phone: '949-555-7002', room_type: '主卧', primary_need: '遮光' }, { notify: o.notify });
  await old.upsertConversationLead('mig-booked', { phone: '949-555-7003' }, { notify: o.notify, signals: { consultation: true } });
  await old.upsertConversationLead('mig-human', { wechat: 'wx_mig_007' }, { notify: o.notify, signals: { human: true } });
  const legacy = await old.saveLead({ conversationId: 'form', source: 'form', reason: 'human', language: 'zh', phone: '9495557004' }, o.notify);
  await fs.writeFile(path.join(tmp, 'leads', '20260101-veryold1.json'), JSON.stringify({ id: '20260101-veryold1', createdAt: '2026-01-01T00:00:00.000Z', conversationId: 'form', source: 'form', reason: 'quote', language: 'en', email: 'old@example.com' }));
  const staffBooked = await old.upsertConversationLead('mig-staff-booked', { phone: '949-555-7005', room_type: '书房', primary_need: '隐私' }, { notify: o.notify });
  await old.setLeadStage(staffBooked!.id, 'consultation_requested'); // the old admin did not record staff stages as notified
  const staffNew = await old.upsertConversationLead('mig-staff-new', { email: 'sn@example.com', room_type: 'den', primary_need: 'privacy' }, { notify: o.notify });
  await old.setLeadStage(staffNew!.id, 'new'); // staff moved it back to new by hand
  await old.upsertConversationLead('mig-oldfail', { phone: '949-555-7008', room_type: '餐厅', primary_need: '采光' }, { notify: async () => { throw new Error('ntfy down'); } });
  const pushedByOld = o.pushes.length;
  assert.equal(pushedByOld, 6, 'production pushed qualified x3, booked, human, legacy form');

  // dry run: counts, writes nothing
  const dry = await leads.migrateLeads({ dryRun: true });
  assert.equal(dry.migrated, 11);
  assert.equal(dry.toContactPending, 2);
  assert.equal((await raw(legacy.id)).schema, undefined, 'dry run writes nothing');

  // the server runs this at startup, then the push retry sweep runs
  const n = recorder();
  const m = await leads.migrateLeads();
  assert.deepEqual([m.migrated, m.toContactPending], [11, 2]);
  assert.deepEqual(await leads.retryFailedPushes({ notify: n.notify }), { retried: 0, delivered: 0 });
  assert.equal(n.pushes.length, 0, 'no push during the upgrade');

  const stage = async (c: string) => (await byConv(c)).stage;
  assert.equal(await stage('mig-new-nocontact'), 'new');
  assert.equal(await stage('mig-new-contact'), 'contact_pending', 'contact only: 已留联系方式');
  assert.equal(await stage('mig-new-contact-zip'), 'contact_pending', 'ZIP / window count is not a need: still not high intent');
  assert.equal(await stage('mig-qualified'), 'qualified');
  assert.equal(await stage('mig-booked'), 'consultation_requested');
  assert.equal(await stage('mig-human'), 'handed_to_human');
  assert.equal(await stage('mig-staff-booked'), 'consultation_requested', 'a stage staff set by hand is kept');
  assert.equal(await stage('mig-staff-new'), 'new', 'staff set "new" by hand: not raised');
  assert.equal(await stage('mig-oldfail'), 'qualified');
  const all = await leads.listLeads(100_000);
  assert.equal(all.find((l) => l.id === legacy.id)!.stage, 'handed_to_human', 'legacy form lead: 转人工, as in production');
  assert.equal(all.find((l) => l.id === '20260101-veryold1')!.stage, 'handed_to_human', 'pre-stage legacy lead: 转人工, as in production');
  const humans = all.filter((l) => l.stage === 'handed_to_human').map((l) => l.conversationId).sort();
  assert.deepEqual(humans, ['form', 'form', 'mig-human'], 'nothing else became 转人工');

  const mc = await raw((await byConv('mig-new-contact')).id);
  assert.equal(mc.schema, leads.LEAD_SCHEMA);
  assert.deepEqual(mc.stage_history.map((h: { stage: string; by: string }) => `${h.stage}/${h.by}`), ['new/agent', 'contact_pending/migration']);
  for (const l of all) assert.equal((await raw(l.id)).schema, leads.LEAD_SCHEMA, `${l.id} stamped`);
  assert.deepEqual((await leads.migrateLeads()).migrated, 0, 'idempotent');

  // the next customer message in any of these conversations re-sends nothing from history
  for (const c of ['mig-new-nocontact', 'mig-new-contact', 'mig-new-contact-zip', 'mig-qualified', 'mig-booked', 'mig-human', 'mig-staff-booked', 'mig-staff-new', 'mig-oldfail']) {
    await leads.upsertConversationLead(c, { needs_summary: 'follow-up message' }, { notify: n.notify });
  }
  assert.deepEqual(n.pushes.map((p) => p.title), [], 'no duplicate pushes of history');
  assert.notEqual(await stage('mig-staff-new'), 'handed_to_human');

  // real progress after the upgrade still pushes, once
  await leads.upsertConversationLead('mig-new-contact', { room_type: '主卧', primary_need: '遮光' }, { notify: n.notify });
  await leads.upsertConversationLead('mig-qualified', {}, { notify: n.notify, signals: { consultation: true } });
  await leads.upsertConversationLead('mig-new-nocontact', { phone: '949-555-7009' }, { notify: n.notify });
  assert.deepEqual(n.pushes.map((p) => p.title), ['SMORI 销售线索：已确认需求', 'SMORI 销售线索：申请预约咨询', 'SMORI 销售线索：已确认需求']);
});

/* ---------------- contact alone is never high intent ---------------- */

test('已留联系方式 and high intent are different: a phone / email / WeChat alone never becomes 申请预约咨询 or 转人工', async () => {
  // stage rules
  for (const l of [{ phone: '9495550100' }, { email: 'a@b.co' }, { wechat: 'wx_only_01' }, { phone: '9495550100', zip: '92618', budget_range: '5k', window_count: '6', motorization_interest: 'yes', products_recommended: ['Duette'] }]) {
    assert.equal(leads.computeStage(l), 'contact_pending', JSON.stringify(l));
  }
  assert.equal(leads.computeStage({ phone: '9495550100', room_type: 'den' }), 'qualified', 'a need is 已确认需求, still not high intent');
  assert.equal(leads.computeStage({ phone: '9495550100' }, { consultation: true }), 'consultation_requested', 'only an explicit booking');
  assert.equal(leads.computeStage({ phone: '9495550100', wants_human: true }), 'handed_to_human', 'only an explicit person request');

  // the background extractor wrongly says "agreed to book" / "wants a person" for a contact-only message: ignored
  const r = recorder();
  const onlyContact = [{ role: 'user' as const, content: '你好，我姓陈，电话 949-555-0123，先了解一下你们做哪些产品' }, { role: 'assistant' as const, content: '我们做 Hunter Douglas 遮阳产品和定制窗帘。请问是哪个房间？' }];
  let l = await sales.extractLead(onlyContact, 'hi-contact-only', undefined, { notify: r.notify, extract: async () => extracted({ name: '陈', phone: '949-555-0123', consultation_interest: 'yes', wants_human: true }) });
  assert.equal(l!.stage, 'contact_pending');
  assert.equal(l!.consultation_interest, 'unknown');
  assert.equal(l!.wants_human, undefined);
  assert.deepEqual(r.pushes.map((p) => p.title), ['SMORI 销售线索：已留联系方式']);

  // the customer's own booking words (or a yes to our invitation) do make it high intent
  const asked = [{ role: 'user' as const, content: '想预约上门测量，电话 949-555-0124' }];
  l = await sales.extractLead(asked, 'hi-asked-booking', undefined, { notify: r.notify, extract: async () => extracted({ phone: '949-555-0124', consultation_interest: 'yes' }) });
  assert.equal(l!.stage, 'consultation_requested');
  const yesToInvite = [
    { role: 'user' as const, content: '主卧想要遮光' },
    { role: 'assistant' as const, content: '推荐 Duette 遮光款。需要的话可以预约免费上门咨询，顾问会带样品来。' },
    { role: 'user' as const, content: '好的，我电话 949-555-0125' },
  ];
  l = await sales.extractLead(yesToInvite, 'hi-yes-invite', undefined, { notify: r.notify, extract: async () => extracted({ phone: '949-555-0125', room_type: '主卧', primary_need: '遮光', consultation_interest: 'yes' }) });
  assert.equal(l!.stage, 'consultation_requested');
  const person = [{ role: 'user' as const, content: '请顾问打电话给我，949-555-0126' }];
  l = await sales.extractLead(person, 'hi-person', undefined, { notify: r.notify, extract: async () => extracted({ phone: '949-555-0126', wants_human: true }) });
  assert.equal(l!.stage, 'handed_to_human');
  assert.equal(sales.customerAskedToBook([{ role: 'user', content: 'Hi, my number is 949-555-0127' }]), false);
  assert.equal(sales.customerAskedForPerson([{ role: 'user', content: 'Hi, my number is 949-555-0127' }]), false);

  // a ZIP + phone in chat, the model only checks the ZIP: 已留联系方式
  let calls = 0;
  const create = async () => ({ id: 'm', type: 'message', role: 'assistant', model: 'stub', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    ...(calls++ === 0 ? { content: [{ type: 'tool_use', id: 'tu_1', name: 'check_service_area', input: { zip: '92618' } }], stop_reason: 'tool_use' } : { content: [{ type: 'text', text: '92618 在我们的服务范围内。请问是哪个房间？', citations: null }], stop_reason: 'end_turn' }) }) as any;
  await sales.salesTurn([{ role: 'user', content: '我在 92618，电话 949-555-0128' }], 'hi-zip-phone', undefined, { create, notify: r.notify });
  await sales.extractLead([{ role: 'user', content: '我在 92618，电话 949-555-0128' }], 'hi-zip-phone', undefined, { notify: r.notify, extract: async () => extracted({ phone: '949-555-0128', zip: '92618' }) });
  assert.equal((await byConv('hi-zip-phone')).stage, 'contact_pending');

  // the widget's explicit buttons are explicit requests
  const res = { statusCode: 200, body: null as any, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  Object.assign(proxy.salesDeps, { notify: r.notify });
  try {
    await proxy.handleLead({ body: { conversationId: 'hi-form-booking', agent: 'sales', kind: 'consultation', phone: '949-555-0129', language: 'zh' }, headers: {}, ip: '10.30.0.1' } as any, res as any);
    assert.equal(res.body.stage, 'consultation_requested');
  } finally { for (const k of Object.keys(proxy.salesDeps)) delete (proxy.salesDeps as any)[k]; }
});

/* ---------------- rollback to the production version ---------------- */

test('rollback: after leads-before-rollback the production version neither shows 转人工 nor pushes history; without it, it would', async () => {
  const n = recorder();
  await leads.upsertConversationLead('rb-contact', { phone: '949-555-8001' }, { notify: n.notify });
  await leads.upsertConversationLead('rb-contact-2', { wechat: 'wx_rb_0002' }, { notify: n.notify });
  await leads.upsertConversationLead('rb-qualified', { phone: '949-555-8003', room_type: '客厅', primary_need: '隐私' }, { notify: n.notify });
  assert.equal(n.pushes.length, 3);

  // the risk the command removes: the production version reads contact_pending as 转人工
  assert.equal((await old.listLeads()).find((l) => l.conversationId === 'rb-contact')!.stage, 'handed_to_human');

  const pending = (await leads.listLeads(100_000)).filter((l) => l.stage === 'contact_pending').length;
  assert.ok(pending >= 2);
  assert.equal(await leads.downgradeContactPending(), pending);
  assert.equal((await leads.listLeads(100_000)).filter((l) => l.stage === 'contact_pending').length, 0);
  const view = await old.listLeads();
  const oldStage = (c: string) => view.find((l) => l.conversationId === c)!.stage;
  assert.equal(oldStage('rb-contact'), 'new');
  assert.equal(oldStage('rb-contact-2'), 'new');
  assert.equal(oldStage('rb-qualified'), 'qualified');
  assert.equal(view.filter((l) => l.stage === 'handed_to_human' && l.conversationId.startsWith('rb-')).length, 0, 'nothing shows as 转人工');

  // the production version running again: next messages push nothing from history, real progress still does
  const o = recorder();
  for (const c of ['rb-contact', 'rb-contact-2', 'rb-qualified']) await old.upsertConversationLead(c, { needs_summary: 'after rollback' }, { notify: o.notify });
  assert.equal(o.pushes.length, 0);
  assert.equal((await old.listLeads()).find((l) => l.conversationId === 'rb-contact')!.stage, 'new');
  await old.upsertConversationLead('rb-contact', { room_type: '主卧', primary_need: '遮光' }, { notify: o.notify });
  assert.deepEqual(o.pushes.map((p) => p.title), ['SMORI 销售线索：已确认需求']);
  await old.upsertConversationLead('rb-window', { phone: '949-555-8004' }, { notify: o.notify }); // a lead created while rolled back

  // deploying this version again: the startup migration restores contact_pending without pushing
  const again = recorder();
  const m = await leads.migrateLeads();
  assert.ok(m.migrated >= 3);
  assert.equal((await byConv('rb-contact-2')).stage, 'contact_pending');
  assert.equal((await byConv('rb-window')).stage, 'contact_pending');
  assert.equal((await byConv('rb-contact')).stage, 'qualified');
  for (const c of ['rb-contact', 'rb-contact-2', 'rb-qualified', 'rb-window']) await leads.upsertConversationLead(c, { needs_summary: 'after re-deploy' }, { notify: again.notify });
  assert.deepEqual(await leads.retryFailedPushes({ notify: again.notify }), { retried: 0, delivered: 0 });
  assert.equal(again.pushes.length, 0, 'no history re-sent after re-deploy');
});
