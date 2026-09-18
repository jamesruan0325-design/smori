/**
 * Automatic pipeline: photos arrive (Dropbox camera uploads or /api/inbox),
 * get screened, grouped into projects by time + GPS, and once a project has
 * been quiet for a while it is finalised: geocode, copy, Shopify draft, and
 * either auto-publish (confident) or ask a human (uncertain).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, PRODUCTS } from './config.js';
import { claudeScreen, type Screener } from './copy.js';
import * as dropbox from './dropbox.js';
import { distanceMeters, readPhotoMeta } from './exif.js';
import { nominatimGeocode, type Geocoder } from './geocode.js';
import { forClaude, processUpload } from './images.js';
import { ntfyNotify, type Notifier } from './notify.js';
import { runGenerate, runSaveDraft } from './pipeline.js';
import { updateMetaobject } from './shopify.js';
import { createProject, getProject, listProjects, saveProject, type PhotoScreen, type Project } from './store.js';

export interface AutoDeps { screen: Screener; geocode: Geocoder; notify: Notifier; now: () => Date }

const defaultDeps: AutoDeps = { screen: claudeScreen, geocode: nominatimGeocode, notify: ntfyNotify, now: () => new Date() };

const logFile = () => path.join(config.dataDir, 'auto', 'log.jsonl');
export async function log(event: string, data: Record<string, unknown> = {}): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  console.log(`[auto] ${line}`);
  await fs.mkdir(path.dirname(logFile()), { recursive: true });
  await fs.appendFile(logFile(), line + '\n');
}
export async function readLog(limit = 100): Promise<string[]> {
  try { const lines = (await fs.readFile(logFile(), 'utf8')).trim().split('\n'); return lines.slice(-limit); } catch { return []; }
}

/* ------------------------------------------------------------------ */
/* Pure helpers (tested)                                               */
/* ------------------------------------------------------------------ */

function localDay(iso: string, tz = config.timezone): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** Does a photo belong to an open project? Same job = close in time and (when both have GPS) close in space. */
export function belongsTo(project: Project, photo: { takenAt?: string; lat?: number; lng?: number }, opts = { gapHours: config.clusterGapHours, radius: config.clusterRadiusMeters }): boolean {
  if (!project.auto || project.auto.status !== 'collecting') return false;
  const last = project.auto.lastTakenAt;
  if (!last || !photo.takenAt) return false;
  const gap = Math.abs(new Date(photo.takenAt).getTime() - new Date(last).getTime()) / 3_600_000;
  if (gap > opts.gapHours) return false;
  const center = projectCenter(project);
  if (center && photo.lat !== undefined && photo.lng !== undefined) {
    return distanceMeters(center, { lat: photo.lat, lng: photo.lng }) <= opts.radius;
  }
  // no GPS on one side: accept only within the same local calendar day
  return localDay(photo.takenAt) === localDay(last);
}

export function projectCenter(project: Project): { lat: number; lng: number } | null {
  const pts = project.photos.filter((p) => p.lat !== undefined && p.lng !== undefined).map((p) => ({ lat: p.lat!, lng: p.lng! }));
  if (!pts.length) return null;
  const sorted = (k: 'lat' | 'lng') => pts.map((p) => p[k]).sort((a, b) => a - b)[Math.floor(pts.length / 2)];
  return { lat: sorted('lat'), lng: sorted('lng') };
}

/** Weighted vote over per-photo guesses -> product, category, confidence 0-1. */
export function decideProduct(screens: PhotoScreen[]): { product: string; category: string; confidence: number; votes: Record<string, number>; room: string; room_zh: string } {
  const votes: Record<string, number> = {};
  const rooms: Record<string, { n: number; zh: string }> = {};
  let total = 0;
  for (const s of screens) {
    if (!s.is_installation) continue;
    if (s.product !== 'unknown' && s.product !== 'other') {
      votes[s.product] = (votes[s.product] ?? 0) + s.product_confidence;
      total += s.product_confidence;
    }
    if (s.room) { rooms[s.room] = rooms[s.room] ?? { n: 0, zh: s.room_zh }; rooms[s.room].n++; }
  }
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const roomTop = Object.entries(rooms).sort((a, b) => b[1].n - a[1].n)[0];
  if (!ranked.length) return { product: '', category: '', confidence: 0, votes, room: roomTop?.[0] ?? '', room_zh: roomTop?.[1].zh ?? '' };
  const [product, score] = ranked[0];
  const share = score / total;                       // agreement between photos
  const n = screens.filter((s) => s.is_installation && s.product === product).length;
  const mean = score / Math.max(n, 1);               // average confidence of the winning votes
  const confidence = Math.round(Math.min(1, share * mean * (n >= 2 ? 1 : 0.85)) * 100) / 100;
  const known = PRODUCTS.find((p) => p.name === product);
  const category = known ? known.category : product === 'shutters' ? 'shutters' : 'signature';
  return { product, category, confidence, votes, room: roomTop?.[0] ?? '', room_zh: roomTop?.[1].zh ?? '' };
}

/* ------------------------------------------------------------------ */
/* Ingest                                                              */
/* ------------------------------------------------------------------ */

export interface IngestResult { action: 'discarded' | 'added'; projectId?: string; screen: PhotoScreen; reason?: string }

/** Screens one photo and files it into a collecting project (or discards it). */
export async function ingestPhoto(buffer: Buffer, name: string, source: 'dropbox' | 'inbox', deps: AutoDeps = defaultDeps, metaHint: { takenAt?: string; lat?: number; lng?: number } = {}): Promise<IngestResult> {
  const meta = { ...(await readPhotoMeta(buffer)), ...Object.fromEntries(Object.entries(metaHint).filter(([, v]) => v !== undefined)) };
  if (!meta.takenAt) meta.takenAt = deps.now().toISOString();
  // screening on a small JPEG (also validates that sharp can read the file)
  const { default: sharp } = await import('sharp');
  const small = await sharp(buffer).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const screen = await deps.screen(small);
  if (!screen.is_installation || screen.installation_confidence < 0.5) {
    await log('discard', { name, source, reason: screen.notes, confidence: screen.installation_confidence });
    return { action: 'discarded', screen, reason: screen.notes };
  }
  const open = (await listProjects()).filter((p) => p.auto?.status === 'collecting');
  let project = open.find((p) => belongsTo(p, meta));
  if (!project) {
    project = await createProject({ product_name: '', category: '', location: '', notes: 'auto-imported' });
    project.auto = { source, status: 'collecting', lastTakenAt: meta.takenAt, lastIngestAt: deps.now().toISOString() };
    await log('project.new', { projectId: project.id, name, takenAt: meta.takenAt });
  }
  const { photo } = await processUpload(project.id, buffer, name, project.photos.length);
  Object.assign(photo, { takenAt: meta.takenAt, lat: meta.lat, lng: meta.lng, source, screen });
  project.photos.push(photo);
  if (!project.photos.some((p) => p.cover)) photo.cover = true;
  project.auto!.lastIngestAt = deps.now().toISOString();
  if (!project.auto!.lastTakenAt || meta.takenAt > project.auto!.lastTakenAt) project.auto!.lastTakenAt = meta.takenAt;
  await saveProject(project);
  await log('photo.added', { projectId: project.id, name, product: screen.product, confidence: screen.product_confidence });
  return { action: 'added', projectId: project.id, screen };
}

/* ------------------------------------------------------------------ */
/* Finalise                                                            */
/* ------------------------------------------------------------------ */

function isDue(p: Project, now: Date): boolean {
  if (!p.auto || p.auto.status !== 'collecting' || !p.photos.length) return false;
  const quietTaken = (now.getTime() - new Date(p.auto.lastTakenAt ?? 0).getTime()) / 3_600_000 >= config.projectCloseHours;
  const quietIngest = (now.getTime() - new Date(p.auto.lastIngestAt ?? 0).getTime()) / 60_000 >= 20;
  return quietTaken && quietIngest;
}

export async function finalizeProject(projectId: string, deps: AutoDeps = defaultDeps, opts: { force?: boolean } = {}): Promise<Project> {
  let project = await getProject(projectId);
  if (!project.auto) throw new Error('not an automatic project');
  const uiUrl = `${config.appUrl}/#${project.id}`;
  project.auto.status = 'processing';
  project.auto.attempts = (project.auto.attempts ?? 0) + 1;
  await saveProject(project);
  try {
    const decision = decideProduct(project.photos.map((p) => p.screen).filter(Boolean) as PhotoScreen[]);
    const center = projectCenter(project);
    let location = project.facts.location;
    if (!location && center) {
      try { location = await deps.geocode(center.lat, center.lng); } catch (e) { await log('geocode.error', { projectId, error: (e as Error).message }); }
    }
    const takenDay = project.auto.lastTakenAt ? localDay(project.auto.lastTakenAt) : undefined;
    project.facts = {
      ...project.facts,
      product_name: project.facts.product_name || decision.product,
      category: project.facts.category || decision.category,
      location,
      room: project.facts.room || decision.room,
      room_zh: project.facts.room_zh || decision.room_zh,
      installed_on: project.facts.installed_on || takenDay,
    };
    project.auto.confidence = decision.confidence;
    project.auto.votes = decision.votes;
    await saveProject(project);

    const problems: string[] = [];
    if (!project.facts.product_name) problems.push('无法判断产品型号');
    else if (decision.confidence < config.autoPublishConfidence && !opts.force) problems.push(`产品型号把握度 ${Math.round(decision.confidence * 100)}%（${project.facts.product_name}）`);
    if (!project.facts.location) problems.push('照片没有 GPS，无法确定地点');

    if (project.facts.product_name && project.facts.category) {
      if (!project.copy) project = await runGenerate(project.id, (m) => log('copy', { projectId, m }));
      if (!project.shopify || project.shopify.dryRun) project = await runSaveDraft(project.id, {}, (m) => log('shopify', { projectId, m }));
    }
    project = await getProject(project.id);
    project.auto!.finalizedAt = deps.now().toISOString();

    if (!problems.length && project.shopify?.metaobjectId) {
      await updateMetaobject(project.shopify.metaobjectId, null, 'ACTIVE');
      project.shopify.status = 'ACTIVE';
      project.auto!.status = 'published';
      project.auto!.reason = `自动发布：${project.facts.product_name}，把握度 ${Math.round(decision.confidence * 100)}%`;
      await saveProject(project);
      await log('published', { projectId, product: project.facts.product_name, confidence: decision.confidence });
      await deps.notify('SMORI 案例已发布', `${project.copy?.title_zh ?? project.copy?.title ?? project.id}\n${project.facts.product_name} · ${project.facts.location} · ${project.photos.length} 张`, project.shopify.adminUrl || uiUrl);
    } else {
      project.auto!.status = 'review';
      project.auto!.reason = problems.join('；') || '未能创建草稿';
      await saveProject(project);
      await log('review', { projectId, problems });
      await deps.notify('SMORI 案例需要确认', `${problems.join('；') || '请检查'}\n${project.photos.length} 张照片${project.shopify ? '，草稿已创建' : ''}`, uiUrl);
    }
  } catch (e) {
    project = await getProject(project.id);
    project.auto!.status = (project.auto!.attempts ?? 1) >= 3 ? 'error' : 'collecting';
    project.auto!.error = (e as Error).message;
    await saveProject(project);
    await log('error', { projectId, error: (e as Error).message, attempts: project.auto!.attempts });
    if (project.auto!.status === 'error') await deps.notify('SMORI 案例处理失败', (e as Error).message, uiUrl);
  }
  return project;
}

/** Staff decision from the review screen: facts were edited in the UI; regenerate if asked, then publish. */
export async function approveAndPublish(projectId: string, opts: { regenerate?: boolean } = {}, deps: AutoDeps = defaultDeps): Promise<Project> {
  let project = await getProject(projectId);
  if (!project.facts.product_name || !project.facts.category || !project.facts.location) throw new Error('product, category and location are required before publishing');
  if (opts.regenerate || !project.copy) project = await runGenerate(project.id, (m) => log('copy', { projectId, m }));
  if (!project.shopify || project.shopify.dryRun) {
    project = await runSaveDraft(project.id, {}, (m) => log('shopify', { projectId, m }));
  } else {
    const { buildMetaobjectFields } = await import('./pipeline.js');
    const ordered = [...project.photos].sort((a, b) => a.order - b.order);
    const cover = ordered.find((p) => p.cover) ?? ordered[0];
    const fields = buildMetaobjectFields(project, { cover: cover.shopifyFileId, photos: ordered.map((p) => p.shopifyFileId!).filter(Boolean) });
    delete fields._handle;
    await updateMetaobject(project.shopify.metaobjectId, fields, null);
  }
  project = await getProject(project.id);
  await updateMetaobject(project.shopify!.metaobjectId, null, 'ACTIVE');
  project.shopify!.status = 'ACTIVE';
  if (project.auto) { project.auto.status = 'published'; project.auto.reason = '人工确认后发布'; }
  await saveProject(project);
  await log('published.manual', { projectId });
  return project;
}

/* ------------------------------------------------------------------ */
/* Cycle                                                               */
/* ------------------------------------------------------------------ */

let running = false;
export interface CycleReport { pulled: number; added: number; discarded: number; finalized: string[]; skipped: number; errors: string[] }

export async function runAutoCycle(deps: AutoDeps = defaultDeps, opts: { fromScratch?: boolean } = {}): Promise<CycleReport> {
  const report: CycleReport = { pulled: 0, added: 0, discarded: 0, finalized: [], skipped: 0, errors: [] };
  if (running) { report.errors.push('already running'); return report; }
  running = true;
  try {
    if (await dropbox.dropboxConnected()) {
      const files = await dropbox.listNewFiles({ fromScratch: opts.fromScratch });
      report.pulled = files.length;
      for (const f of files) {
        try {
          if (/\.(heic|heif)$/i.test(f.name)) { await dropbox.markSeen(f.path_lower, 'skipped-heic'); report.skipped++; await log('skip.heic', { name: f.name }); continue; }
          const buf = await dropbox.download(f.path_lower);
          const hint = { takenAt: f.media_info?.metadata?.time_taken, lat: f.media_info?.metadata?.location?.latitude, lng: f.media_info?.metadata?.location?.longitude };
          const r = await ingestPhoto(buf, f.name, 'dropbox', deps, hint);
          await dropbox.markSeen(f.path_lower, r.action);
          if (r.action === 'added') report.added++; else report.discarded++;
        } catch (e) {
          report.errors.push(`${f.name}: ${(e as Error).message}`);
          await log('ingest.error', { name: f.name, error: (e as Error).message });
        }
      }
      if (report.skipped) await deps.notify('SMORI 照片助手', `有 ${report.skipped} 张 HEIC 照片无法处理。请在 Dropbox 应用的相机上传设置里打开"将 HEIC 保存为 JPG"。`);
    }
    const now = deps.now();
    for (const p of await listProjects()) {
      if (isDue(p, now)) {
        await finalizeProject(p.id, deps);
        report.finalized.push(p.id);
      }
    }
  } finally {
    running = false;
  }
  if (report.pulled || report.finalized.length || report.errors.length) await log('cycle', report as unknown as Record<string, unknown>);
  return report;
}

export function startScheduler(deps: AutoDeps = defaultDeps): void {
  if (!config.autoEnabled) { console.log('auto pipeline disabled (AUTO_ENABLED=false)'); return; }
  const ms = Math.max(1, config.autoPollMinutes) * 60_000;
  setTimeout(() => runAutoCycle(deps).catch((e) => console.error('auto cycle failed', e)), 15_000);
  setInterval(() => runAutoCycle(deps).catch((e) => console.error('auto cycle failed', e)), ms);
  console.log(`auto pipeline: every ${config.autoPollMinutes} min`);
}
