import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { leadNotify, ntfyNotify, type Notifier } from './notify.js';

/** Lead pipeline, forward-only for the agent (staff may set any stage by hand). */
export const STAGES = ['new', 'contact_pending', 'qualified', 'consultation_requested', 'handed_to_human'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL_ZH: Record<Stage, string> = { new: '新线索', contact_pending: '有联系方式、待跟进', qualified: '已确认需求', consultation_requested: '申请预约咨询', handed_to_human: '转人工' };

/** How the customer wants to be reached; the customer chooses, none is required. */
export const CONTACT_PREFERENCES = ['phone', 'sms', 'email', 'wechat'] as const;
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number];
export const CONTACT_PREFERENCE_ZH: Record<ContactPreference, string> = { phone: '电话', sms: '短信', email: '邮件', wechat: '微信' };
/** The contact field each preferred method needs (a call or a text both need the phone number). */
export const PREFERENCE_FIELD: Record<ContactPreference, 'phone' | 'email' | 'wechat'> = { phone: 'phone', sms: 'phone', email: 'email', wechat: 'wechat' };
export function contactPreference(v: unknown): ContactPreference | undefined {
  return typeof v === 'string' && (CONTACT_PREFERENCES as readonly string[]).includes(v) ? (v as ContactPreference) : undefined;
}

export const SALES_SOURCE = 'AI Sales Agent';

export interface PageContext { url?: string; referrer?: string; utm?: Record<string, string> }

export interface Lead {
  id: string;
  createdAt: string;
  updatedAt?: string;
  conversationId: string;
  source: 'chat' | 'form';
  /** "AI Sales Agent" for the sales agent; legacy assistant leads are "AI Assistant". */
  lead_source?: string;
  reason: 'quote' | 'measurement' | 'human' | 'question' | 'consultation' | 'other';
  language: 'zh' | 'en';
  stage?: Stage;
  stage_history?: { stage: Stage; at: string; by: 'agent' | 'staff' }[];
  /** Stages a push notification was delivered for (each stage pushes at most once). */
  notified?: Stage[];
  /** Last failed push: the stage stays out of `notified`, so it is retried (next update or the periodic retry). */
  notify_error?: { stage: Stage; first_at: string; last_at: string; attempts: number; error: string };
  name?: string;
  phone?: string;
  email?: string;
  wechat?: string;
  contact_preference?: ContactPreference;
  city?: string;
  zip?: string;
  /** true when the ZIP starts with a configured service prefix (preliminary signal only). */
  zip_in_area?: boolean;
  interest?: string;
  room_type?: string;
  window_count?: string;
  approximate_size?: string;
  primary_need?: string;
  motorization_interest?: string;
  budget_range?: string;
  products_recommended?: string[];
  /** yes = agreed to book; no = declined; unknown = not discussed yet */
  consultation_interest?: 'yes' | 'no' | 'unknown';
  wants_human?: boolean;
  preferred_time?: string;
  /** Sales-team summary, rebuilt from the latest lead state on every upsert (narrative + current status). */
  summary?: string;
  /** AI narrative about the project and needs only (no contact / ZIP / stage claims); input to `summary`. */
  needs_summary?: string;
  notes?: string;
  page?: PageContext;
  transcript?: { role: string; content: string }[];
  handled?: boolean;
}

const dir = () => path.join(config.dataDir, 'leads');

export function hasContact(l: Partial<Lead>): boolean {
  return Boolean((l.phone && l.phone.trim()) || (l.email && l.email.trim()) || (l.wechat && l.wechat.trim()));
}

const newId = (now: Date) => `${now.toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
const convKey = (conversationId: string) => crypto.createHash('sha256').update(conversationId).digest('hex').slice(0, 12);

async function writeLead(lead: Lead): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  const file = path.join(dir(), `${lead.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(lead, null, 2));
  await fs.rename(tmp, file);
}

function contactLine(l: Lead): string {
  const line = [l.phone, l.email, l.wechat && `WeChat ${l.wechat}`].filter(Boolean).join(' · ');
  return l.contact_preference ? `${line}（首选${CONTACT_PREFERENCE_ZH[l.contact_preference]}）` : line;
}

/** Legacy assistant: saves a lead that already has contact details (always a human follow-up). */
export async function saveLead(input: Omit<Lead, 'id' | 'createdAt'>, notify: Notifier = ntfyNotify): Promise<Lead> {
  if (!hasContact(input)) throw new Error('a phone number, email or WeChat ID is required');
  const now = new Date();
  const lead: Lead = { id: newId(now), createdAt: now.toISOString(), lead_source: 'AI Assistant', stage: 'handed_to_human', ...input };
  lead.stage_history ??= [{ stage: lead.stage!, at: lead.createdAt, by: 'agent' }];
  lead.notified ??= [lead.stage!];
  await writeLead(lead);
  await notify('SMORI 网站新咨询', `${lead.name || '（未留姓名）'} · ${contactLine(lead)}\n${lead.interest || lead.notes || ''}${lead.city ? ` · ${lead.city}` : ''}`, `${config.appUrl}/#leads`)
    .catch((e) => console.error(`lead push failed: ${lead.id}: ${(e as Error).message}`));
  return lead;
}

/** Old leads (before stages existed) were all contact-form / human follow-ups. */
export function normalizeLead(l: Lead): Lead {
  if (!l.stage || !STAGES.includes(l.stage)) l.stage = 'handed_to_human';
  if (!l.lead_source) l.lead_source = l.source === 'form' ? 'AI Assistant (form)' : 'AI Assistant';
  return l;
}

export async function listLeads(limit = 500, stage?: Stage): Promise<Lead[]> {
  let files: string[];
  try { files = (await fs.readdir(dir())).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out: Lead[] = [];
  for (const f of files) { try { out.push(normalizeLead(JSON.parse(await fs.readFile(path.join(dir(), f), 'utf8')))); } catch { /* skip */ } }
  out.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
  return (stage ? out.filter((l) => l.stage === stage) : out).slice(0, limit);
}

async function readLead(id: string): Promise<Lead> {
  return normalizeLead(JSON.parse(await fs.readFile(path.join(dir(), `${path.basename(id)}.json`), 'utf8')) as Lead);
}

/** Staff edits take the conversation's lock too, so an agent update or a push in flight cannot overwrite them. */
async function staffUpdate(id: string, fn: (lead: Lead) => void): Promise<Lead> {
  const { conversationId } = await readLead(id);
  return withLock(conversationId, async () => {
    const lead = await readLead(id);
    fn(lead);
    await writeLead(lead);
    return lead;
  });
}

export async function markLead(id: string, handled: boolean): Promise<void> {
  await staffUpdate(id, (lead) => { lead.handled = handled; lead.updatedAt = new Date().toISOString(); });
}

/** Staff override: any stage, any direction. */
export async function setLeadStage(id: string, stage: Stage): Promise<Lead> {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
  return staffUpdate(id, (lead) => {
    const at = new Date().toISOString();
    if (lead.stage !== stage) {
      lead.stage = stage;
      lead.stage_history = [...(lead.stage_history ?? []), { stage, at, by: 'staff' }];
    }
    lead.updatedAt = at;
  });
}

const rank = (s: Stage | undefined | null) => (s ? STAGES.indexOf(s) : -1);

/** Anything that tells us about the project (not contact details). */
export function hasQualification(l: Partial<Lead>): boolean {
  return Boolean(l.room_type || l.window_count || l.approximate_size || l.primary_need || l.motorization_interest || l.budget_range || l.zip || (l.products_recommended && l.products_recommended.length));
}

export interface StageSignals { consultation?: boolean; human?: boolean }

/**
 * Deterministic stage rules:
 *  new                    qualification info only (room, need, size, ZIP, budget…), no way to reach the customer
 *  contact_pending        a contact method (phone/email/WeChat) but no room / need and no booking or person request yet:
 *                         reachable, NOT a confirmed need or buying intent
 *  qualified              contact + room type or primary need
 *  consultation_requested contact + the customer explicitly asked for / agreed to a consultation, visit or measurement
 *  handed_to_human        contact + the customer asked for a person (转人工) or the agent could not help
 * Without a contact method nobody can follow up, so a booking / human request is
 * remembered (consultation_interest / wants_human) and takes effect as soon as contact arrives.
 */
export function computeStage(l: Partial<Lead>, signals: StageSignals = {}): Stage | null {
  const contact = hasContact(l);
  if (contact && (signals.human || l.wants_human)) return 'handed_to_human';
  if (contact && (signals.consultation || l.consultation_interest === 'yes')) return 'consultation_requested';
  if (contact && (l.room_type || l.primary_need)) return 'qualified';
  if (contact) return 'contact_pending';
  if (hasQualification(l)) return 'new';
  return null;
}

export type LeadPatch = Partial<Omit<Lead, 'id' | 'createdAt' | 'conversationId' | 'stage' | 'stage_history' | 'notified'>>;

const MERGE_SKIP = new Set(['products_recommended', 'transcript', 'page', 'consultation_interest', 'wants_human', 'summary']);

/** Merges non-empty values; flags only move forward (yes / true are never reset by a later extraction). */
export function mergeLead(base: Lead, patch: LeadPatch): Lead {
  const out: Lead = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (MERGE_SKIP.has(k)) continue;
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) continue;
    (out as unknown as Record<string, unknown>)[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (patch.products_recommended?.length) out.products_recommended = [...new Set([...(base.products_recommended ?? []), ...patch.products_recommended])];
  if (patch.transcript?.length) out.transcript = patch.transcript;
  if (patch.page && !base.page) out.page = patch.page;
  if (patch.wants_human) out.wants_human = true;
  if (patch.consultation_interest && base.consultation_interest !== 'yes') {
    if (patch.consultation_interest !== 'unknown' || !base.consultation_interest) out.consultation_interest = patch.consultation_interest;
  }
  return out;
}

/** Clauses that state contact / ZIP / stage status. Those facts come from the lead fields, never from AI text that may be out of date. */
const STATUS_CLAIM_RE = /(尚未|还未|还没|没有|未)(留|提供|给|填)|联系方式|联系电话|电话号码|留了?电话|电话\s*\d|邮箱|e-?mail|姓名|名字|ZIP|邮编|contact (info|details)|phone number|阶段|\bstage\b/i;

/** Drops clauses of an AI narrative that make contact / ZIP / stage claims, keeping the rest. */
export function stripStatusClaims(text: string): string {
  const parts = text.split(/([，,。；;！？!?\n]+|\.(?=\s|$))/);
  let out = '';
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i] ?? '';
    const delim = parts[i + 1] ?? '';
    if (!clause.trim() || STATUS_CLAIM_RE.test(clause)) continue;
    out += clause + delim;
  }
  out = out.trim().replace(/^[，,。；;！？!?\s]+/, '').replace(/[，,；;]+$/, '');
  if (out && /[\u4e00-\u9fff]$/.test(out)) out += '。';
  return out;
}

/** Deterministic status line from the current lead fields. */
export function leadStatusLine(l: Lead): string {
  const got = [l.name && `姓名 ${l.name}`, l.phone && `电话 ${l.phone}`, l.email && `邮箱 ${l.email}`, l.wechat && `微信 ${l.wechat}`, l.contact_preference && `首选${CONTACT_PREFERENCE_ZH[l.contact_preference]}`].filter(Boolean);
  const contact = hasContact(l) ? `联系信息：${got.join('、')}` : `联系信息：${l.name ? `姓名 ${l.name}，` : ''}尚未留下电话或邮箱`;
  const zip = l.zip ? `ZIP ${l.zip}（${l.zip_in_area ? 'OC 常规服务区' : '服务范围待团队确认'}）` : '';
  const stage = l.stage ? `阶段：${STAGE_LABEL_ZH[l.stage]}${l.preferred_time ? `，希望时间 ${l.preferred_time}` : ''}` : '';
  return `【当前状态】${[contact, zip, stage].filter(Boolean).join('；')}`;
}

/** summary = AI needs narrative (status claims removed) + status line built from the latest fields. */
export function composeSummary(l: Lead): string {
  return [stripStatusClaims(l.needs_summary ?? ''), leadStatusLine(l)].filter(Boolean).join('\n');
}

const PUSH_TITLE: Record<Stage, string> = { new: '', contact_pending: 'SMORI 销售线索：有联系方式、待跟进', qualified: 'SMORI 销售线索：已确认需求', consultation_requested: 'SMORI 销售线索：申请预约咨询', handed_to_human: 'SMORI 销售线索：转人工' };

function pushBody(l: Lead): string {
  const facts = [l.room_type, l.window_count && `${l.window_count} 扇窗`, l.primary_need, l.motorization_interest && `电动：${l.motorization_interest}`, l.zip && `ZIP ${l.zip}${l.zip_in_area ? '（OC）' : ''}`, l.preferred_time && `时间：${l.preferred_time}`].filter(Boolean).join(' · ');
  const hint = l.stage === 'contact_pending' ? '客户留了联系方式，还没谈需求，也没要求预约。' : '';
  return `${l.name || '（未留姓名）'} · ${contactLine(l)}\n${[hint, facts].filter(Boolean).join('\n')}${l.summary ? `\n${l.summary}` : ''}`.slice(0, 900);
}

/** A push is due when the current stage (from contact_pending on) is higher than every stage already delivered. */
export function pushDue(l: Pick<Lead, 'stage' | 'notified'>): boolean {
  const { stage } = l;
  if (!stage || stage === 'new') return false;
  const notified = l.notified ?? [];
  return !notified.includes(stage) && rank(stage) > Math.max(-1, ...notified.map(rank));
}

/** Sends the push for the lead's current stage. Only a delivered push is recorded in `notified`; a failure is recorded in `notify_error` and retried later. */
async function deliverPush(lead: Lead, notify: Notifier, at: string): Promise<boolean> {
  const stage = lead.stage!;
  try {
    await notify(PUSH_TITLE[stage], pushBody(lead), `${config.appUrl}/#leads`);
    lead.notified = [...new Set([...(lead.notified ?? []), stage])];
    delete lead.notify_error;
    return true;
  } catch (e) {
    const prev = lead.notify_error?.stage === stage ? lead.notify_error : undefined;
    const error = String((e as Error)?.message ?? e).slice(0, 200);
    lead.notify_error = { stage, first_at: prev?.first_at ?? at, last_at: at, attempts: (prev?.attempts ?? 0) + 1, error };
    console.error(`lead push failed: ${lead.id} stage=${stage} attempt=${lead.notify_error.attempts}: ${error}`);
    return false;
  }
}

/** Serialize writes per conversation (the chat reply, the extractor and the form can race). */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => undefined);
  return next;
}

async function findConversationLead(conversationId: string): Promise<Lead | null> {
  const suffix = `-c${convKey(conversationId)}.json`;
  let files: string[];
  try { files = (await fs.readdir(dir())).filter((f) => f.endsWith(suffix)); } catch { return null; }
  if (!files.length) return null;
  return normalizeLead(JSON.parse(await fs.readFile(path.join(dir(), files[0]), 'utf8')) as Lead);
}

export async function getConversationLead(conversationId: string): Promise<Lead | null> {
  return findConversationLead(conversationId);
}

export interface UpsertOptions { notify?: Notifier; now?: () => Date; signals?: StageSignals; language?: 'zh' | 'en'; source?: 'chat' | 'form' }

/**
 * One lead per sales conversation. Creates it once there is something worth keeping
 * (stage "new" or better), advances the stage forward only, and pushes once per stage
 * from "contact_pending" on. The lead is written before the push, so a failed push never
 * loses it; the push is retried on the next update or by retryFailedPushes.
 * Returns null when there is nothing to save yet.
 */
export function upsertConversationLead(conversationId: string, patch: LeadPatch, opts: UpsertOptions = {}): Promise<Lead | null> {
  return withLock(conversationId, async () => {
    const notify = opts.notify ?? leadNotify;
    const now = (opts.now ?? (() => new Date()))();
    const at = now.toISOString();
    const existing = await findConversationLead(conversationId);
    const base: Lead = existing ?? {
      id: `${at.slice(0, 10).replace(/-/g, '')}-c${convKey(conversationId)}`,
      createdAt: at,
      conversationId,
      source: opts.source ?? 'chat',
      lead_source: SALES_SOURCE,
      reason: 'other',
      language: opts.language ?? 'en',
    };
    const merged = mergeLead(base, patch);
    if (opts.signals?.human) merged.wants_human = true;
    if (opts.signals?.consultation) merged.consultation_interest = 'yes';
    if (merged.zip) merged.zip_in_area = zipInServiceArea(merged.zip);

    const computed = computeStage(merged, opts.signals);
    if (!computed && !existing) return null;
    const current = existing?.stage ?? null;
    const stage = rank(computed) > rank(current) ? computed! : current!;
    if (stage !== current) merged.stage_history = [...(merged.stage_history ?? []), { stage, at, by: 'agent' }];
    merged.stage = stage;
    if (stage === 'handed_to_human') merged.reason = 'human';
    else if (stage === 'consultation_requested') merged.reason = 'consultation';
    merged.updatedAt = at;
    // leads saved before needs_summary existed: reuse their old AI summary as the narrative
    if (existing && existing.needs_summary === undefined && !patch.needs_summary) merged.needs_summary = existing.summary ?? '';
    merged.needs_summary = stripStatusClaims(merged.needs_summary ?? '');
    merged.summary = composeSummary(merged); // always rebuilt from the latest state, before any push

    await writeLead(merged);
    if (pushDue(merged)) {
      await deliverPush(merged, notify, at);
      await writeLead(merged);
    }
    return merged;
  });
}

/**
 * Retries pushes that failed (leads flagged with notify_error), e.g. after an ntfy outage or a
 * restart. Runs periodically from the server; gives up `maxAgeHours` after the first failure
 * (the lead keeps its failure flag in the admin page).
 */
export async function retryFailedPushes(opts: { notify?: Notifier; now?: () => Date; maxAgeHours?: number } = {}): Promise<{ retried: number; delivered: number }> {
  const notify = opts.notify ?? leadNotify;
  const now = (opts.now ?? (() => new Date()))();
  const maxAgeMs = (opts.maxAgeHours ?? 48) * 3_600_000;
  let retried = 0;
  let delivered = 0;
  for (const l of await listLeads(100_000)) {
    if (!l.notify_error || !pushDue(l) || now.getTime() - Date.parse(l.notify_error.first_at) > maxAgeMs) continue;
    retried++;
    const ok = await withLock(l.conversationId, async () => {
      const fresh = await readLead(l.id);
      if (!fresh.notify_error || !pushDue(fresh)) return false;
      const sent = await deliverPush(fresh, notify, now.toISOString());
      await writeLead(fresh);
      return sent;
    });
    if (ok) delivered++;
  }
  return { retried, delivered };
}

/** Leads whose latest push has not been delivered (shown in the admin page). */
export function pushPending(l: Lead): boolean {
  return Boolean(l.notify_error) && pushDue(l);
}

export function zipInServiceArea(zip: string, prefixes = config.serviceZipPrefixes): boolean {
  const z = zip.trim();
  return /^\d{5}(-\d{4})?$/.test(z) && prefixes.some((p) => z.startsWith(p));
}

const CSV_COLUMNS = ['id', 'createdAt', 'updatedAt', 'stage', 'lead_source', 'name', 'phone', 'email', 'wechat', 'contact_preference', 'zip', 'zip_in_area', 'city', 'room_type', 'window_count', 'approximate_size', 'primary_need', 'motorization_interest', 'budget_range', 'products_recommended', 'consultation_interest', 'preferred_time', 'summary', 'notes', 'language', 'handled', 'page_url', 'utm'] as const;

export function leadsToCsv(leads: Lead[]): string {
  const cell = (v: unknown) => {
    let s = v === undefined || v === null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // never let a spreadsheet treat a value as a formula
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = leads.map((l) => CSV_COLUMNS.map((c) => cell(
    c === 'page_url' ? l.page?.url : c === 'utm' ? (l.page?.utm ? Object.entries(l.page.utm).map(([k, v]) => `${k}=${v}`).join('&') : '') : (l as unknown as Record<string, unknown>)[c],
  )).join(','));
  return '﻿' + [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}
