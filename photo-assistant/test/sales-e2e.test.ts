/**
 * End-to-end over HTTP: express app-proxy routes -> salesTurn -> real @anthropic-ai/sdk -> local
 * TEST DOUBLE of the Messages API (test/fake-anthropic.ts). Walks one conversation through
 * new -> qualified -> consultation_requested -> handed_to_human, as the storefront widget would.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startFakeAnthropic } from './fake-anthropic.js';

const fake = await startFakeAnthropic();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-sales-e2e-'));
Object.assign(process.env, { DATA_DIR: tmp, ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'test-dummy-key', PROXY_SIGNATURE_OPTIONAL: 'true', SHOPIFY_API_SECRET: 'x' });
delete process.env.NTFY_TOPIC;

const express = (await import('express')).default;
const { proxyAuth, handleChat, handleLead, salesDeps } = await import('../src/proxy.js');
const { getConversationLead } = await import('../src/leads.js');
const pushes: string[] = [];
salesDeps.notify = async (t) => { pushes.push(t); };

const app = express();
app.use('/proxy', express.json(), proxyAuth);
app.post('/proxy/chat', (req, res) => { handleChat(req, res).catch((e) => res.status(500).json({ error: String(e) })); });
app.post('/proxy/lead', (req, res) => { handleLead(req, res).catch((e) => res.status(500).json({ error: String(e) })); });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/proxy`;

after(async () => { server.close(); await fake.close(); await fs.rm(tmp, { recursive: true, force: true }); });

const conv = 'e2econversation01';
const messages: { role: 'user' | 'assistant'; content: string }[] = [];
async function say(text: string) {
  messages.push({ role: 'user', content: text });
  const r = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: conv, agent: 'sales', page: { url: 'http://localhost/preview' }, messages }) });
  const j = await r.json() as { reply: string; cta: string | null; leadSaved: boolean };
  assert.equal(r.status, 200, JSON.stringify(j));
  messages.push({ role: 'assistant', content: j.reply });
  await new Promise((res) => setTimeout(res, 150)); // background extraction
  return j;
}

test('four lead stages through the HTTP chat + forms, with the real SDK against the test double', async () => {
  let j = await say('Master bedroom, 3 windows, we need blackout');
  assert.match(j.reply, /\[test double\]/);
  let lead = await getConversationLead(conv);
  assert.equal(lead!.stage, 'new');
  assert.equal(lead!.room_type, 'master bedroom');
  assert.deepEqual(lead!.products_recommended, ['Duette', 'Designer Roller'], 'invented product filtered out');
  assert.equal(pushes.length, 0);

  j = await say('ZIP 92618');
  assert.match(j.reply, /92618 is within our service area/, 'check_service_area tool ran through the SDK tool loop');
  assert.equal(j.cta, 'consultation');

  j = await say("I'm Anna, 949-555-1234");
  lead = await getConversationLead(conv);
  assert.equal(lead!.stage, 'qualified');
  assert.equal(lead!.phone, '949-555-1234');
  assert.equal(lead!.zip_in_area, true);

  j = await say('Please book a consultation, Saturday morning');
  assert.equal(j.cta, 'booked');
  assert.equal(j.leadSaved, true);
  lead = await getConversationLead(conv);
  assert.equal(lead!.stage, 'consultation_requested');
  assert.equal(lead!.preferred_time, 'Saturday morning');

  j = await say('转人工');
  assert.equal(j.cta, 'human_sent');
  lead = await getConversationLead(conv);
  assert.equal(lead!.stage, 'handed_to_human');
  assert.deepEqual(lead!.stage_history!.map((h) => h.stage), ['new', 'qualified', 'consultation_requested', 'handed_to_human']);
  assert.deepEqual(pushes, ['SMORI 销售线索：已确认需求', 'SMORI 销售线索：申请预约咨询', 'SMORI 销售线索：转人工']);

  const chatCalls = fake.calls.filter((c) => !c.structured);
  assert.ok(chatCalls.every((c) => c.tools.join() === 'check_service_area,request_consultation,request_human'));
  assert.ok(chatCalls.every((c) => /never state, estimate, compare or imply any price/.test(c.system)), 'sales system prompt sent');
  assert.ok(fake.calls.some((c) => c.structured), 'structured-output extractor was called');
});

test('widget forms alone (no chat details) still create a staged lead; old widget payload uses the legacy path', async () => {
  const r = await fetch(`${base}/lead`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'e2eformonly0001', agent: 'sales', kind: 'consultation', name: 'Bo', email: 'bo@example.com', zip: '92660', preferred_time: 'Mon 10am', language: 'en' }) });
  const j = await r.json() as { stage: string };
  assert.equal(j.stage, 'consultation_requested');

  const old = await fetch(`${base}/lead`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'e2eoldwidget0001', name: 'Old', phone: '9490001111', notes: 'old widget' }) });
  assert.equal(old.status, 200);
  assert.equal(await getConversationLead('e2eoldwidget0001'), null, 'old widget payload does not create a sales lead');
});
