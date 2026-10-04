/**
 * Tracks official manufacturer promotion pages and mirrors them as
 * `promotion` metaobjects:
 *  - new or changed offer  -> DRAFT entry + push notification (a person publishes)
 *  - offer gone from page  -> entry set to DRAFT (taken off the website) + notification
 * Extraction uses only the page text; nothing is invented.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { ntfyNotify, type Notifier } from './notify.js';
import { createDraftMetaobject, ensurePromotionDefinition, getMetaobjectStatus, PROMOTION_TYPE, updateMetaobject } from './shopify.js';

export interface PromoSource { id: string; brand: string; url: string }

export const SOURCES: PromoSource[] = [
  { id: 'hunter-douglas', brand: 'Hunter Douglas', url: 'https://www.hunterdouglas.com/promotions' },
  { id: 'alta', brand: 'ALTA', url: 'https://www.altawindowfashions.com/promotions/' },
];

const OfferSchema = z.object({
  offers: z.array(z.object({
    title: z.string().describe('Short English title of the promotion as worded on the page, e.g. "Free Motorization on Our Top Shades"'),
    title_zh: z.string().describe('Faithful Simplified Chinese translation of the title'),
    offer: z.string().describe('One-line English statement of what the customer gets, using only wording/amounts on the page'),
    offer_zh: z.string(),
    details: z.string().describe('Eligible products and conditions stated on the page; empty if none'),
    details_zh: z.string(),
    terms: z.string().describe('Terms or disclaimers exactly as stated on the page (e.g. "See a participating expert for terms."); empty if none'),
    terms_zh: z.string(),
    start_date: z.string().describe('YYYY-MM-DD only if a start date is explicitly printed on the page, else empty'),
    end_date: z.string().describe('YYYY-MM-DD only if an end date is explicitly printed on the page, else empty'),
  })).describe('Consumer promotions currently advertised on the page. Empty if the page shows none.'),
  page_ok: z.boolean().describe('false if the text is an error, captcha, security checkpoint or otherwise not the brand\'s promotions content'),
});
type Extracted = z.infer<typeof OfferSchema>;
export type Offer = Extracted['offers'][number];

export type Extractor = (brand: string, url: string, text: string) => Promise<Extracted>;
export type Fetcher = (url: string) => Promise<{ status: number; html: string }>;

/* ------------------------------------------------------------------ */

export function pageText(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<(header|footer|nav|form)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|section|span)>/gi, '\n').replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&reg;/g, '®').replace(/&trade;/g, '™').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const lines = s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // drop consecutive duplicates (form labels etc.)
  return lines.filter((l, i) => l !== lines[i - 1]).join('\n').slice(0, 20_000);
}

export function offerKey(brand: string, offer: Pick<Offer, 'title'>): string {
  const slug = offer.title.toLowerCase().replace(/[®™]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `${brand.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${slug}`;
}

function contentHash(o: Offer): string {
  return crypto.createHash('sha256').update(JSON.stringify([o.title, o.offer, o.details, o.terms, o.start_date, o.end_date])).digest('hex').slice(0, 16);
}

export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': `Mozilla/5.0 (compatible; SMORI-promo-check/1.0; +${config.appUrl || 'https://smoriwindowfashion.com'})`, 'Accept-Language': 'en-US' }, redirect: 'follow' });
  return { status: res.status, html: await res.text() };
};

export const claudeExtractor: Extractor = async (brand, url, text) => {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: config.claudeModel,
    max_tokens: 4000,
    system: `You read the official ${brand} promotions page and list the consumer promotions it currently advertises. Rules: use ONLY facts printed in the page text below; never add amounts, percentages, dates, eligible products or conditions that are not printed; keep brand and product names (Silhouette, Pirouette, PowerView…) in English inside the Chinese text; translations must be faithful, not marketing rewrites. Ignore navigation, sign-up forms, "free consultation", "free design guide" and other evergreen services — they are not promotions.`,
    messages: [{ role: 'user', content: `URL: ${url}\n\nPAGE TEXT:\n${text}` }],
    output_config: { format: zodOutputFormat(OfferSchema) },
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new Error(`extraction failed (${response.stop_reason})`);
  return response.parsed_output;
};

/* ------------------------------------------------------------------ */

interface Tracked { key: string; brand: string; metaobjectId: string; hash: string; title: string; firstSeen: string; lastSeen: string; gone?: string }
interface SourceState { lastCheck?: string; lastStatus?: string; pageHash?: string; error?: string }
export interface PromoState { sources: Record<string, SourceState>; offers: Record<string, Tracked>; lastRun?: string }

const stateFile = () => path.join(config.dataDir, 'promotions', 'state.json');
export async function readPromoState(): Promise<PromoState> {
  try { return JSON.parse(await fs.readFile(stateFile(), 'utf8')); } catch { return { sources: {}, offers: {} }; }
}
async function writePromoState(s: PromoState): Promise<void> {
  await fs.mkdir(path.dirname(stateFile()), { recursive: true });
  const tmp = stateFile() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(s, null, 2));
  await fs.rename(tmp, stateFile());
}

export interface PromoDeps { fetcher: Fetcher; extract: Extractor; notify: Notifier; now: () => Date }
const defaultDeps: PromoDeps = { fetcher: defaultFetcher, extract: claudeExtractor, notify: ntfyNotify, now: () => new Date() };

export interface PromoReport { checked: string[]; unchanged: string[]; created: string[]; updated: string[]; removed: string[]; errors: string[] }

function fieldsFor(brand: string, key: string, o: Offer, url: string, now: Date): Record<string, string> {
  const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  return {
    promo_key: key, brand, title: o.title, title_zh: o.title_zh, offer: o.offer, offer_zh: o.offer_zh,
    details: o.details, details_zh: o.details_zh, terms: o.terms, terms_zh: o.terms_zh,
    start_date: isDate(o.start_date) ? o.start_date : '', end_date: isDate(o.end_date) ? o.end_date : '',
    source_url: url, checked_at: now.toISOString().slice(0, 10),
  };
}

let running = false;

/** Checks every source once. Safe to call repeatedly; does nothing when a page has not changed. */
export async function checkPromotions(deps: PromoDeps = defaultDeps, opts: { force?: boolean } = {}): Promise<PromoReport> {
  const report: PromoReport = { checked: [], unchanged: [], created: [], updated: [], removed: [], errors: [] };
  if (running) { report.errors.push('already running'); return report; }
  running = true;
  try {
    const state = await readPromoState();
    await ensurePromotionDefinition();
    const now = deps.now();
    for (const src of SOURCES) {
      const ss = (state.sources[src.id] = state.sources[src.id] ?? {});
      ss.lastCheck = now.toISOString();
      try {
        const { status, html } = await deps.fetcher(src.url);
        if (status >= 400) throw new Error(`HTTP ${status}${/vercel security checkpoint|captcha|access denied/i.test(html) ? ' (bot protection)' : ''}`);
        const text = pageText(html);
        const pageHash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
        report.checked.push(src.brand);
        if (!opts.force && ss.pageHash === pageHash && !ss.error) { report.unchanged.push(src.brand); ss.lastStatus = 'unchanged'; continue; }
        const ex = await deps.extract(src.brand, src.url, text);
        if (!ex.page_ok) throw new Error('page did not contain promotion content (blocked or changed layout)');
        const seen = new Set<string>();
        for (const o of ex.offers) {
          const key = offerKey(src.brand, o);
          seen.add(key);
          const hash = contentHash(o);
          const fields = fieldsFor(src.brand, key, o, src.url, now);
          const t = state.offers[key];
          if (!t || t.gone) {
            const created = await createDraftMetaobject(fields, `${key.replace(/[^a-z0-9]+/g, '-')}-${now.toISOString().slice(0, 10)}`.slice(0, 80), PROMOTION_TYPE);
            state.offers[key] = { key, brand: src.brand, metaobjectId: created.id, hash, title: o.title, firstSeen: now.toISOString(), lastSeen: now.toISOString() };
            report.created.push(`${src.brand}: ${o.title}`);
            await deps.notify(`${src.brand} 官网有新活动`, `${o.title_zh || o.title}\n${o.offer_zh || o.offer}\n已生成草稿，请确认您参与该活动、内容无误后在照片助手发布。`, `${config.appUrl}/#promotions`);
          } else {
            t.lastSeen = now.toISOString();
            if (t.hash !== hash) {
              const wasLive = (await getMetaobjectStatus(t.metaobjectId)) === 'ACTIVE';
              await updateMetaobject(t.metaobjectId, fields, 'DRAFT');
              t.hash = hash; t.title = o.title;
              report.updated.push(`${src.brand}: ${o.title}`);
              await deps.notify(`${src.brand} 官网活动有变化`, `${o.title_zh || o.title}\n${o.offer_zh || o.offer}\n${wasLive ? '已从网站暂时下架并更新为草稿，' : '草稿已更新，'}请核对后重新发布。`, `${config.appUrl}/#promotions`);
            } else {
              await updateMetaobject(t.metaobjectId, { checked_at: now.toISOString().slice(0, 10) }, null);
            }
          }
        }
        for (const t of Object.values(state.offers)) {
          if (t.brand !== src.brand || t.gone || seen.has(t.key)) continue;
          const wasLive = (await getMetaobjectStatus(t.metaobjectId)) === 'ACTIVE';
          await updateMetaobject(t.metaobjectId, null, 'DRAFT');
          t.gone = now.toISOString();
          report.removed.push(`${src.brand}: ${t.title}`);
          await deps.notify(`${src.brand} 活动已结束`, `${t.title}\n官网已不再显示该活动${wasLive ? '，已自动从网站下架' : ''}。`, `${config.appUrl}/#promotions`);
        }
        ss.pageHash = pageHash; ss.lastStatus = `ok (${ex.offers.length} offers)`; delete ss.error;
      } catch (e) {
        const msg = (e as Error).message;
        report.errors.push(`${src.brand}: ${msg}`);
        const firstFailure = !ss.error;
        ss.error = msg; ss.lastStatus = 'error';
        if (firstFailure) await deps.notify(`${src.brand} 官网无法自动读取`, `${msg}\n请手动查看 ${src.url}，有新活动时把内容发给我们或在后台填写。`, src.url).catch(() => undefined);
      }
    }
    state.lastRun = now.toISOString();
    await writePromoState(state);
  } finally {
    running = false;
  }
  return report;
}

export async function setPromotionLive(key: string, live: boolean): Promise<void> {
  const state = await readPromoState();
  const t = state.offers[key];
  if (!t) throw new Error('unknown promotion');
  if (live && t.gone) throw new Error('this promotion is no longer on the official site');
  await updateMetaobject(t.metaobjectId, null, live ? 'ACTIVE' : 'DRAFT');
}

/** Daily check: runs at startup (after 1 min) and then every 6 h if the last run is older than 20 h. */
export function startPromotionScheduler(deps: PromoDeps = defaultDeps): void {
  const tick = async () => {
    const st = await readPromoState();
    if (st.lastRun && Date.now() - new Date(st.lastRun).getTime() < 20 * 3_600_000) return;
    await checkPromotions(deps);
  };
  setTimeout(() => tick().catch((e) => console.error('promo check failed', e)), 60_000);
  setInterval(() => tick().catch((e) => console.error('promo check failed', e)), 6 * 3_600_000);
}
