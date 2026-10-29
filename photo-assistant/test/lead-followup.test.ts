/**
 * Staff follow-up status (待跟进 → 已联系 → 已预约 → 已报价 → 成交 / 未成交): new leads start at
 * 待跟进, leads saved before the status existed keep working, every change is saved, and a change
 * never contacts the customer, never pushes and leaves the rest of the lead as it was.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-lead-followup-'));
process.env.DATA_DIR = tmp;
process.env.SHOPIFY_APP_URL = 'https://app.example.com';
// ntfy is configured here on purpose: a status change must not reach it even when pushes would work
process.env.NTFY_TOPIC = 'smori_followup_test';
delete process.env.SERVICE_ZIP_PREFIXES;

// every outgoing request (ntfy or anything else) is recorded and never leaves the machine
const requests: { url: string; body: string }[] = [];
globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
  requests.push({ url: String(url), body: String(init?.body ?? '') });
  return new Response('{}', { status: 200 });
}) as typeof fetch;

const leads = await import('../src/leads.js');
const old = await import('./fixtures/leads-46c7783.js');
const { upsertConversationLead, getConversationLead, listLeads, saveLead, setFollowupStatus, markLead, migrateLeads, retryFailedPushes, leadsToCsv } = leads;

after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

function recorder() {
  const pushes: { title: string; body: string }[] = [];
  return { pushes, notify: async (title: string, body: string) => { pushes.push({ title, body }); } };
}
const failing = () => async () => { throw new Error('ntfy HTTP 502'); };
const file = (id: string) => path.join(tmp, 'leads', `${id}.json`);
const raw = async (id: string) => JSON.parse(await fs.readFile(file(id), 'utf8'));
const listed = async (id: string) => (await listLeads(100_000)).find((l) => l.id === id)!;
const FOLLOWUP_KEYS = ['followup_status', 'followup_updated_at', 'followup_history', 'handled', 'updatedAt'];
const withoutFollowup = (l: Record<string, unknown>) => Object.fromEntries(Object.entries(l).filter(([k]) => !FOLLOWUP_KEYS.includes(k)));
const transcript = [{ role: 'user' as const, content: '客厅想装遮光帘，电话 949-555-8100' }, { role: 'assistant' as const, content: '好的，我们的顾问会联系您。' }];

test('new leads start as 待跟进 (chat, form and the old 转人工 form)', async () => {
  const r = recorder();
  const chat = await upsertConversationLead('fu-new-chat-01', { phone: '949-555-8001' }, { notify: r.notify });
  assert.equal((await raw(chat!.id)).followup_status, 'pending', 'saved in the file, not only derived on read');
  const noContact = await upsertConversationLead('fu-new-chat-02', { room_type: '主卧' }, { notify: r.notify });
  assert.equal((await raw(noContact!.id)).followup_status, 'pending');
  const form = await upsertConversationLead('fu-new-form-01', { email: 'f1@example.com' }, { notify: r.notify, source: 'form', signals: { consultation: true } });
  assert.equal((await raw(form!.id)).followup_status, 'pending');
  const legacy = await saveLead({ conversationId: 'form', source: 'form', reason: 'human', language: 'zh', phone: '9495558002' }, r.notify);
  assert.equal((await raw(legacy.id)).followup_status, 'pending');
  for (const l of [chat!, noContact!, form!, legacy]) assert.equal((await listed(l.id)).followup_status, 'pending');
});

test('leads saved before the follow-up status existed: nothing lost, 已处理 reads as 已联系, the rest as 待跟进', async () => {
  const r = recorder();
  // written by the production version (no follow-up status), including one marked 已处理 there
  const open = await old.upsertConversationLead('fu-old-open-01', { phone: '949-555-8011', room_type: '客厅', primary_need: '遮光', transcript }, { notify: r.notify });
  const done = await old.upsertConversationLead('fu-old-done-01', { email: 'done@example.com', room_type: '书房', primary_need: '隐私' }, { notify: r.notify });
  await old.markLead(done!.id, true);
  const legacyForm = await old.saveLead({ conversationId: 'form', source: 'form', reason: 'human', language: 'en', phone: '9495558012' }, r.notify);
  await fs.writeFile(file('20260101-fuold001'), JSON.stringify({ id: '20260101-fuold001', createdAt: '2026-01-01T00:00:00.000Z', conversationId: 'form', source: 'form', reason: 'quote', language: 'en', email: 'veryold@example.com' }));
  await fs.writeFile(file('20260102-fuold002'), JSON.stringify({ id: '20260102-fuold002', createdAt: '2026-01-02T00:00:00.000Z', conversationId: 'form', source: 'form', reason: 'human', language: 'zh', phone: '9495558013', handled: true }));
  const ids = [open!.id, done!.id, legacyForm.id, '20260101-fuold001', '20260102-fuold002'];
  const before = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await fs.readFile(file(id), 'utf8')])));
  const filesBefore = (await fs.readdir(path.join(tmp, 'leads'))).length;

  // reading derives the status and does not rewrite the files
  const expected: Record<string, string> = { [open!.id]: 'pending', [done!.id]: 'contacted', [legacyForm.id]: 'pending', '20260101-fuold001': 'pending', '20260102-fuold002': 'contacted' };
  for (const id of ids) assert.equal((await listed(id)).followup_status, expected[id], id);
  for (const id of ids) assert.equal(await fs.readFile(file(id), 'utf8'), before[id], `${id} untouched by reading`);

  // the startup migration keeps every lead, every conversation and the derived status
  const pushesBefore = r.pushes.length;
  const requestsBefore = requests.length;
  await migrateLeads();
  assert.equal((await fs.readdir(path.join(tmp, 'leads'))).length, filesBefore, 'no lead deleted');
  for (const id of ids) {
    const now = await raw(id);
    const was = JSON.parse(before[id]);
    assert.equal(now.followup_status, expected[id], id);
    assert.equal(now.handled, was.handled, `${id} 已处理 flag kept`);
    assert.deepEqual(now.transcript, was.transcript, `${id} conversation kept`);
    assert.equal(now.summary, was.summary);
    assert.equal(now.phone, was.phone);
    assert.equal(now.email, was.email);
  }
  assert.equal(r.pushes.length, pushesBefore, 'migration pushed nothing');
  assert.equal(requests.length, requestsBefore, 'migration sent nothing');
});

test('staff can set every status; it is saved, survives a re-read, and 成交 / 未成交 can be changed back', async () => {
  const r = recorder();
  const l = (await upsertConversationLead('fu-set-01', { phone: '949-555-8021', transcript }, { notify: r.notify }))!;
  for (const s of ['contacted', 'booked', 'quoted', 'won', 'lost', 'quoted', 'pending', 'won'] as const) {
    const saved = await setFollowupStatus(l.id, s);
    assert.equal(saved.followup_status, s);
    assert.equal((await raw(l.id)).followup_status, s, `${s} written to the file`);
    assert.equal((await listed(l.id)).followup_status, s, `${s} after re-reading`);
    assert.equal((await raw(l.id)).handled, s !== 'pending', 'the old 已处理 flag follows the status');
  }
  const after1 = await raw(l.id);
  await setFollowupStatus(l.id, 'won'); // same status again: no new history entry
  const after2 = await raw(l.id);
  assert.deepEqual(after2.followup_history.map((h: { status: string }) => h.status), ['contacted', 'booked', 'quoted', 'won', 'lost', 'quoted', 'pending', 'won']);
  assert.equal(after2.followup_history.length, after1.followup_history.length);
  assert.ok(after2.followup_updated_at && after2.updatedAt);
});

test('an unknown status or lead is rejected and nothing is written', async () => {
  const r = recorder();
  const l = (await upsertConversationLead('fu-bad-01', { phone: '949-555-8031' }, { notify: r.notify }))!;
  const before = await fs.readFile(file(l.id), 'utf8');
  await assert.rejects(setFollowupStatus(l.id, 'closed' as never), /unknown follow-up status/);
  await assert.rejects(setFollowupStatus(l.id, '' as never), /unknown follow-up status/);
  await assert.rejects(setFollowupStatus('20260101-nosuchlead', 'won'));
  assert.equal(await fs.readFile(file(l.id), 'utf8'), before);
});

test('changing the status never contacts anyone and leaves stage, pushes, conversation and summary as they were', async () => {
  const r = recorder();
  const l = (await upsertConversationLead('fu-quiet-01', { name: '王女士', phone: '949-555-8041', zip: '92618', room_type: '客厅', primary_need: '遮光', transcript }, { notify: r.notify }))!;
  assert.equal(l.stage, 'qualified');
  const before = await raw(l.id);
  const pushesBefore = r.pushes.length;
  const requestsBefore = requests.length;
  for (const s of ['contacted', 'booked', 'quoted', 'won', 'lost', 'pending', 'booked'] as const) await setFollowupStatus(l.id, s);
  const after = await raw(l.id);
  assert.deepEqual(withoutFollowup(after), withoutFollowup(before), 'only the follow-up fields changed');
  assert.equal(after.stage, 'qualified');
  assert.deepEqual(after.notified, before.notified);
  assert.deepEqual(after.stage_history, before.stage_history);
  assert.deepEqual(after.transcript, before.transcript);
  assert.equal(after.summary, before.summary);
  assert.equal(r.pushes.length, pushesBefore, 'no push');
  assert.equal(requests.length, requestsBefore, 'no request of any kind (ntfy, SMS, email, WeChat)');
});

test('a status change does not start a push: as with 已处理, a status past 待跟进 stops a failed push from retrying; back to 待跟进 sends nothing', async () => {
  const l = (await upsertConversationLead('fu-retry-01', { phone: '949-555-8051', room_type: '餐厅', primary_need: '采光' }, { notify: failing() }))!;
  assert.ok((await raw(l.id)).push_pending, 'push failed and is waiting to be retried');
  await setFollowupStatus(l.id, 'contacted');
  assert.equal((await raw(l.id)).push_pending, undefined);
  await setFollowupStatus(l.id, 'pending');
  assert.equal((await raw(l.id)).push_pending, undefined, 'going back to 待跟进 does not queue a push');
  const requestsBefore = requests.length;
  const later = new Date(Date.now() + 10 * 60_000);
  const res = await retryFailedPushes({ now: () => later }); // default notifier: would reach ntfy (the recorded fetch)
  assert.equal(res.retried, 0);
  assert.equal(requests.length, requestsBefore);
});

test('AI updates after a staff status keep the status (also when they run at the same time)', async () => {
  const r = recorder();
  const conv = 'fu-agent-01';
  const l = (await upsertConversationLead(conv, { phone: '949-555-8061' }, { notify: r.notify }))!;
  await setFollowupStatus(l.id, 'booked');
  const history = (await raw(l.id)).followup_history;
  const up = await upsertConversationLead(conv, { room_type: '主卧', primary_need: '隐私', transcript }, { notify: r.notify, signals: { consultation: true } });
  assert.equal(up!.stage, 'consultation_requested', 'the AI stage still moves on its own');
  assert.equal((await raw(l.id)).followup_status, 'booked');
  assert.deepEqual((await raw(l.id)).followup_history, history);

  await Promise.all([
    setFollowupStatus(l.id, 'quoted'),
    upsertConversationLead(conv, { zip: '92620' }, { notify: async () => { await new Promise((res) => setTimeout(res, 30)); } }),
  ]);
  const both = (await getConversationLead(conv))!;
  assert.equal(both.followup_status, 'quoted');
  assert.equal(both.zip, '92620');
});

test('the old 标记为已处理 call stays in step with the status', async () => {
  const r = recorder();
  const l = (await upsertConversationLead('fu-mark-01', { phone: '949-555-8071' }, { notify: r.notify }))!;
  await markLead(l.id, true);
  assert.equal((await raw(l.id)).followup_status, 'contacted', '已处理 on a 待跟进 lead = 已联系');
  await setFollowupStatus(l.id, 'quoted');
  await markLead(l.id, true);
  assert.equal((await raw(l.id)).followup_status, 'quoted', 'already past 待跟进: kept');
  await markLead(l.id, false);
  assert.equal((await raw(l.id)).followup_status, 'pending');
  assert.equal((await raw(l.id)).handled, false);
});

test('rollback: the previous version reads these leads, and its 已处理 changes carry over when this version is back', async () => {
  const r = recorder();
  const l = (await upsertConversationLead('fu-rollback-01', { phone: '949-555-8081', transcript }, { notify: r.notify }))!;
  await setFollowupStatus(l.id, 'won');
  const oldView = (await old.listLeads(100_000)).find((x) => x.id === l.id)!;
  assert.equal(oldView.handled, true, 'the previous version shows a closed lead as 已处理');
  assert.deepEqual(oldView.transcript, transcript);
  await old.markLead(l.id, false); // un-marked in the previous version
  assert.equal((await listed(l.id)).followup_status, 'pending');
  await old.markLead(l.id, true); // marked 已处理 again there: past 待跟进 again, the last status set here comes back
  assert.equal((await listed(l.id)).followup_status, 'won');
  const fresh = (await upsertConversationLead('fu-rollback-02', { phone: '949-555-8082' }, { notify: r.notify }))!;
  await old.markLead(fresh.id, true); // a 待跟进 lead marked 已处理 in the previous version
  assert.equal((await listed(fresh.id)).followup_status, 'contacted');
});

test('CSV export has the follow-up status in Chinese', async () => {
  const r = recorder();
  const l = (await upsertConversationLead('fu-csv-01', { phone: '949-555-8091' }, { notify: r.notify }))!;
  await setFollowupStatus(l.id, 'lost');
  const csv = leadsToCsv(await listLeads(100_000));
  const [header, ...rows] = csv.replace(/^﻿/, '').trim().split('\r\n');
  const col = header.split(',').indexOf('followup_status');
  assert.ok(col > 0);
  const row = rows.find((x) => x.startsWith(l.id))!;
  assert.equal(row.split(',')[col], '未成交');
  assert.ok(rows.some((x) => x.split(',')[col] === '待跟进'));
});
