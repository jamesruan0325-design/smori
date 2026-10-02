import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-draft-'));
process.env.DATA_DIR = tmp;
process.env.SHOPIFY_ADMIN_TOKEN = 'shpat_fake';
process.env.SHOPIFY_APP_URL = 'https://app.example.com';
delete process.env.AUTO_PUBLISH; // default: drafts only
const { startFakeShopify } = await import('./fake-shopify.js');
const fake = await startFakeShopify();
process.env.SHOPIFY_ADMIN_ENDPOINT = fake.endpoint;
const { ingestPhoto, finalizeProject } = await import('../src/auto.js');
const { getProject, saveProject } = await import('../src/store.js');

after(async () => { await fake.close(); await fs.rm(tmp, { recursive: true, force: true }); });

test('default pipeline creates a DRAFT even for a confident case, and notifies', async () => {
  const notes: string[] = [];
  const deps = {
    screen: async () => ({ is_installation: true, installation_confidence: 0.95, product: 'Duette', product_confidence: 0.95, category: 'blackout', room: 'Bedroom', room_zh: '卧室', notes: '' }),
    geocode: async () => 'Irvine, CA',
    notify: async (t: string) => { notes.push(t); },
    now: () => new Date('2026-10-01T18:00:00Z'),
  };
  const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
  const a = await ingestPhoto(img, 'a.jpg', 'dropbox', deps, { takenAt: '2026-10-01T18:00:00Z', lat: 33.7, lng: -117.8 }, '/c/a.jpg');
  await ingestPhoto(img, 'b.jpg', 'dropbox', deps, { takenAt: '2026-10-01T18:10:00Z', lat: 33.7, lng: -117.8 }, '/c/b.jpg');
  const p = await getProject(String(a.projectId));
  p.copy = { title: 'T', title_zh: '题', subtitle: 's', subtitle_zh: '副', summary: 'x', summary_zh: '简', description: [{ type: 'paragraph', text: 'd' }], description_zh: [{ type: 'paragraph', text: '描' }], xhs_title: 'x', xhs_body: 'y', warnings: [] };
  await saveProject(p);
  const done = await finalizeProject(p.id, deps);
  assert.equal(done.auto!.status, 'review');
  assert.match(String(done.auto!.reason), /已建草稿/);
  assert.equal(fake.state.metaobjects[0].status, 'DRAFT');
  assert.deepEqual(notes, ['SMORI 新案例草稿']);
});
