import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-promo-'));
process.env.DATA_DIR = tmp;
process.env.SHOPIFY_ADMIN_TOKEN = 'shpat_fake';
process.env.SHOPIFY_APP_URL = 'https://app.example.com';
const { startFakeShopify } = await import('./fake-shopify.js');
const fake = await startFakeShopify();
process.env.SHOPIFY_ADMIN_ENDPOINT = fake.endpoint;
const { checkPromotions, pageText, offerKey, setPromotionLive, readPromoState } = await import('../src/promotions.js');

after(async () => { await fake.close(); await fs.rm(tmp, { recursive: true, force: true }); });

const HD_HTML = (body: string) => `<html><head><script>x</script></head><body><header>Menu</header><main><p>Limited Time</p><h2>${body}</h2><p>See a participating expert for terms.</p><form><label>Email</label></form></main><footer>©</footer></body></html>`;
const offer = (title: string, offerText: string) => ({ title, title_zh: '免费电动化', offer: offerText, offer_zh: '免费电动', details: 'Silhouette & Pirouette', details_zh: 'Silhouette 和 Pirouette', terms: 'See a participating expert for terms.', terms_zh: '条款请咨询参与活动的经销商。', start_date: '', end_date: 'not a date' });

test('page text strips chrome and forms', () => {
  const t = pageText(HD_HTML('FREE MOTORIZATION'));
  assert.match(t, /FREE MOTORIZATION/);
  assert.doesNotMatch(t, /Menu|Email|©/);
  assert.equal(offerKey('Hunter Douglas', { title: 'Free Motorization® on Our Top Shades' }), 'hunter-douglas:free-motorization-on-our-top-shades');
});

test('new offer -> draft; unchanged page -> no work; changed -> back to draft; gone -> taken down; blocked source -> one notice', async () => {
  let html = HD_HTML('FREE MOTORIZATION');
  let offers = [offer('Free Motorization', 'Free motorization on Silhouette & Pirouette')];
  let extractCalls = 0;
  const notes: string[] = [];
  const deps = {
    fetcher: async (url: string) => url.includes('alta') ? { status: 429, html: '<title>Vercel Security Checkpoint</title>' } : { status: 200, html },
    extract: async () => { extractCalls++; return { offers, page_ok: true }; },
    notify: async (t: string) => { notes.push(t); },
    now: () => new Date('2026-10-04T12:00:00Z'),
  };

  const r1 = await checkPromotions(deps);
  assert.deepEqual(r1.created, ['Hunter Douglas: Free Motorization']);
  assert.equal(r1.errors.length, 1);
  assert.match(r1.errors[0], /ALTA: HTTP 429 \(bot protection\)/);
  assert.equal(fake.state.definitions['promotion'].publishable, true);
  const mo = fake.state.metaobjects.find((m) => m.type === 'promotion')!;
  assert.equal(mo.status, 'DRAFT', 'never published automatically');
  assert.equal(mo.fields.end_date, undefined, 'invalid dates are dropped');
  assert.equal(mo.fields.terms, 'See a participating expert for terms.');
  assert.deepEqual(notes, ['Hunter Douglas 官网有新活动', 'ALTA 官网无法自动读取']);

  // unchanged page: no extraction, ALTA failure not re-notified
  const r2 = await checkPromotions(deps);
  assert.deepEqual(r2.unchanged, ['Hunter Douglas']);
  assert.equal(extractCalls, 1);
  assert.equal(notes.length, 2);

  // staff publishes, then the official wording changes -> taken back to draft
  const key = 'hunter-douglas:free-motorization';
  await setPromotionLive(key, true);
  assert.equal(mo.status, 'ACTIVE');
  html = HD_HTML('FREE MOTORIZATION ON TOP SHADES'); offers = [offer('Free Motorization', 'Free motorization on Silhouette, Pirouette & Luminette')];
  const r3 = await checkPromotions(deps);
  assert.deepEqual(r3.updated, ['Hunter Douglas: Free Motorization']);
  assert.equal(mo.status, 'DRAFT');
  assert.match(mo.fields.offer, /Luminette/);

  // offer disappears -> stays down, marked gone; cannot be published
  await setPromotionLive(key, true);
  html = HD_HTML('Spring styles'); offers = [];
  const r4 = await checkPromotions(deps);
  assert.deepEqual(r4.removed, ['Hunter Douglas: Free Motorization']);
  assert.equal(mo.status, 'DRAFT');
  await assert.rejects(setPromotionLive(key, true), /no longer/);
  assert.ok((await readPromoState()).offers[key].gone);
});
