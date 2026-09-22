import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-assist-'));
process.env.DATA_DIR = tmp;
process.env.SHOPIFY_API_SECRET = 'shpss_secret_abc';
process.env.SHOPIFY_APP_URL = 'https://app.example.com';
const { verifyProxySignature, rateLimited, handleLead } = await import('../src/proxy.js');
const { detectLanguage } = await import('../src/chat.js');
const { saveLead, listLeads, hasContact } = await import('../src/leads.js');
const { KNOWLEDGE } = await import('../src/knowledge.js');

after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

function sign(q: Record<string, string>) {
  const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('');
  return crypto.createHmac('sha256', 'shpss_secret_abc').update(msg).digest('hex');
}

test('app proxy signature (sorted, no separator) is verified', () => {
  const q = { shop: 'smori-9216.myshopify.com', path_prefix: '/apps/assistant', timestamp: '1789770000', logged_in_customer_id: '' };
  assert.equal(verifyProxySignature({ ...q, signature: sign(q) }), true);
  assert.equal(verifyProxySignature({ ...q, timestamp: '1789770001', signature: sign(q) }), false);
  assert.equal(verifyProxySignature(q), false);
});

test('language detection and rate limiter', () => {
  assert.equal(detectLanguage('请问遮光帘多少钱'), 'zh');
  assert.equal(detectLanguage('Do you install in Newport Beach?'), 'en');
  assert.equal(detectLanguage('???', 'zh'), 'zh');
  const now = Date.now();
  for (let i = 0; i < 3; i++) assert.equal(rateLimited('ip1', 3, now + i), false);
  assert.equal(rateLimited('ip1', 3, now + 10), true);
  assert.equal(rateLimited('ip1', 3, now + 3_700_000), false, 'window slides');
});

test('knowledge contains no prices, lead times or warranty terms', () => {
  assert.doesNotMatch(KNOWLEDGE, /\$\s?\d|\d+\s?(days|weeks)\b.*(delivery|lead time)|year warranty/i);
  assert.match(KNOWLEDGE, /WHAT WE CANNOT ANSWER HERE/);
});

test('leads: contact required, saved, notified, listed; form handler validates', async () => {
  const notes: string[] = [];
  const notify = async (t: string, m: string) => { notes.push(`${t}|${m}`); };
  assert.equal(hasContact({ name: 'x' }), false);
  await assert.rejects(saveLead({ conversationId: 'c1', source: 'chat', reason: 'quote', language: 'zh', name: '王' }, notify), /required/);
  const lead = await saveLead({ conversationId: 'c1', source: 'chat', reason: 'quote', language: 'zh', name: '王女士', phone: '949-000-0000', interest: '主卧遮光' }, notify);
  assert.ok(lead.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /王女士/);
  const all = await listLeads();
  assert.equal(all.length, 1);
  assert.equal(all[0].phone, '949-000-0000');

  const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  await handleLead({ body: { name: 'A', notes: 'hi' }, headers: {}, ip: '1.1.1.1' } as any, res);
  assert.equal(res.statusCode, 400);
  await handleLead({ body: { name: 'Anna', email: 'a@b.com', interest: 'motorized shades', language: 'en', conversationId: 'abcdefgh' }, headers: {}, ip: '1.1.1.1' } as any, res);
  assert.equal(res.statusCode, 400, 'status object reused; check body instead');
  assert.equal(res.body.ok, true);
  assert.match(res.body.message, /Received/);
});
