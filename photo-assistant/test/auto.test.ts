import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smori-auto-'));
process.env.DATA_DIR = tmp;
process.env.SHOPIFY_ADMIN_TOKEN = 'shpat_fake';
process.env.SHOPIFY_APP_URL = 'https://app.example.com';
process.env.AUTO_PUBLISH_CONFIDENCE = '0.8';
process.env.PROJECT_CLOSE_HOURS = '6';
const { startFakeShopify } = await import('./fake-shopify.js');
const fake = await startFakeShopify();
process.env.SHOPIFY_ADMIN_ENDPOINT = fake.endpoint;

const { belongsTo, decideProduct, ingestPhoto, finalizeProject, projectCenter } = await import('../src/auto.js');
const { formatPlace } = await import('../src/geocode.js');
const { distanceMeters } = await import('../src/exif.js');
const { getProject, saveProject } = await import('../src/store.js');
import type { Project } from '../src/store.js';
const { FIELD_DEFINITIONS } = await import('../src/shopify.js');

after(async () => { await fake.close(); await fs.rm(tmp, { recursive: true, force: true }); });

const img = (color: string) => sharp({ create: { width: 1600, height: 1200, channels: 3, background: color } }).jpeg().toBuffer();
const screenOf = (product: string, conf: number, installation = true) => ({ is_installation: installation, installation_confidence: installation ? 0.95 : 0.1, product, product_confidence: conf, category: 'sheer', room: 'Living Room', room_zh: '客厅', notes: 'test' });

test('helpers: distance, place formatting, product vote', () => {
  assert.ok(Math.abs(distanceMeters({ lat: 33.6846, lng: -117.8265 }, { lat: 33.6846, lng: -117.8265 })) < 1);
  assert.ok(distanceMeters({ lat: 33.6846, lng: -117.8265 }, { lat: 33.6946, lng: -117.8265 }) > 1000);
  assert.equal(formatPlace({ city: 'Irvine', state: 'California', country_code: 'us' }), 'Irvine, CA');
  assert.equal(formatPlace({ town: 'Laguna Beach', state: 'California', country_code: 'us' }), 'Laguna Beach, CA');
  const d = decideProduct([screenOf('Silhouette', 0.9), screenOf('Silhouette', 0.85), screenOf('Pirouette', 0.4), screenOf('x', 0, false)]);
  assert.equal(d.product, 'Silhouette');
  assert.equal(d.category, 'sheer');
  assert.ok(d.confidence > 0.7 && d.confidence <= 1, `confidence ${d.confidence}`);
  const low = decideProduct([screenOf('Silhouette', 0.5), screenOf('Pirouette', 0.5)]);
  assert.ok(low.confidence < 0.8);
  assert.equal(decideProduct([screenOf('unknown', 0)]).product, '');
});

test('belongsTo: time gap and GPS radius', () => {
  const base: Project = { id: 'x', createdAt: '', updatedAt: '', facts: { product_name: '', category: '', location: '' }, photos: [{ id: 'a', originalName: 'a', mime: 'image/jpeg', originalBytes: 1, webBytes: 1, width: 1, height: 1, order: 0, cover: true, lat: 33.6846, lng: -117.8265 }], auto: { source: 'dropbox', status: 'collecting', lastTakenAt: '2026-09-18T18:00:00Z' } };
  assert.equal(belongsTo(base, { takenAt: '2026-09-18T19:00:00Z', lat: 33.6847, lng: -117.8266 }), true);
  assert.equal(belongsTo(base, { takenAt: '2026-09-18T19:00:00Z', lat: 33.75, lng: -117.8266 }), false, 'different site');
  assert.equal(belongsTo(base, { takenAt: '2026-09-19T18:00:00Z', lat: 33.6847, lng: -117.8266 }), false, 'next day');
  assert.equal(belongsTo(base, { takenAt: '2026-09-18T20:00:00Z' }), true, 'no GPS but same day');
  assert.equal(belongsTo({ ...base, auto: { ...base.auto!, status: 'review' } }, { takenAt: '2026-09-18T19:00:00Z' }), false);
  assert.deepEqual(projectCenter(base), { lat: 33.6846, lng: -117.8265 });
});

test('ingest -> group -> finalize: confident project is published, uncertain one goes to review', async () => {
  const notes: { title: string; message: string }[] = [];
  let clock = new Date('2026-09-18T18:00:00Z');
  const deps = {
    screen: async (b: Buffer) => { const m = await sharp(b).stats(); const red = m.channels[0].mean; return red > 200 ? screenOf('Duette', 0.92) : red > 100 ? screenOf('Silhouette', 0.55) : screenOf('x', 0, false); },
    geocode: async () => 'Newport Beach, CA',
    notify: async (title: string, message: string) => { notes.push({ title, message }); },
    now: () => clock,
  };
  // three photos: two confident Duette at one site (with GPS hint), one personal photo
  const r1 = await ingestPhoto(await img('#ff0000'), 'IMG_1.jpg', 'dropbox', deps, { takenAt: '2026-09-18T18:00:00Z', lat: 33.6, lng: -117.9 });
  const r2 = await ingestPhoto(await img('#fe0000'), 'IMG_2.jpg', 'dropbox', deps, { takenAt: '2026-09-18T18:30:00Z', lat: 33.6001, lng: -117.9001 });
  const r3 = await ingestPhoto(await img('#000000'), 'IMG_3.jpg', 'dropbox', deps, { takenAt: '2026-09-18T18:40:00Z' });
  assert.equal(r1.action, 'added'); assert.equal(r2.action, 'added'); assert.equal(r3.action, 'discarded');
  assert.equal(r1.projectId, r2.projectId, 'same job grouped');
  // an uncertain photo far away -> separate project
  const r4 = await ingestPhoto(await img('#800000'), 'IMG_4.jpg', 'dropbox', deps, { takenAt: '2026-09-18T18:50:00Z', lat: 34.0, lng: -118.2 });
  assert.notEqual(r4.projectId, r1.projectId);

  clock = new Date('2026-09-19T03:00:00Z'); // 9h later
  // copy generation needs Claude; stub by pre-filling copy on both projects
  for (const id of [r1.projectId!, r4.projectId!]) {
    const p = await getProject(id);
    p.copy = { title: 'T', title_zh: '题', subtitle: 's', subtitle_zh: '副', summary: 'sum', summary_zh: '简', description: [{ type: 'paragraph', text: 'd' }], description_zh: [{ type: 'paragraph', text: '描' }], xhs_title: 'x', xhs_body: 'y', warnings: [] };
    await saveProject(p);
  }
  {
    const p1 = await finalizeProject(String(r1.projectId), deps);
    assert.equal(p1.auto!.status, 'published', String(p1.auto!.reason ?? p1.auto!.error));
    assert.equal(p1.facts.product_name, 'Duette');
    assert.equal(p1.facts.location, 'Newport Beach, CA');
    assert.equal(p1.facts.installed_on, '2026-09-18');
    assert.equal(fake.state.metaobjects.find((m) => m.id === p1.shopify!.metaobjectId)!.status, 'ACTIVE');
    const p4 = await finalizeProject(String(r4.projectId), deps);
    assert.equal(p4.auto!.status, 'review', String(p4.auto!.reason ?? p4.auto!.error));
    assert.match(p4.auto!.reason!, /把握度/);
    assert.equal(fake.state.metaobjects.find((m) => m.id === p4.shopify!.metaobjectId)!.status, 'DRAFT');
    assert.equal(notes.length, 2);
    assert.match(notes[0].title, /已发布/);
    assert.match(notes[1].title, /需要确认/);
    assert.equal(fake.state.definition!.fields.length, FIELD_DEFINITIONS.length);
  }
});
