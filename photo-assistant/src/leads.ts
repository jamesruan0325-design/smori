import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { ntfyNotify, type Notifier } from './notify.js';

/** Lead pipeline, forward-only for the agent (staff may set any stage by hand). */
export const STAGES = ['new', 'qualified', 'consultation_requested', 'handed_to_human'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL_ZH: Record<Stage, string> = { new: '新线索', qualified: '已确认需求', consultation_requested: '申请预约咨询', handed_to_human: '转人工' };

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
  /** Stages a push notification was already sent for (each stage pushes at most once). */
  notified?: Stage[];
  name?: string;
  phone?: string;
  email?: string;
  wechat?: string;
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
  summary?: string;
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
  return [l.phone, l.email, l.wechat && `WeChat ${l.wechat}`].filter(Boolean).join(' · ');
}

/** Legacy assistant: saves a lead that already has contact details (always a human follow-up). */
export async function saveLead(input: Omit<Lead, 'id' | 'createdAt'>, notify: Notifier = ntfyNotify): Promise<Lead> {
  if (!hasContact(input)) throw new Error('a phone number, email or WeChat ID is required');
  const now = new Date();
  const lead: Lead = { id: newId(now), createdAt: now.toISOString(), lead_source: 'AI Assistant', stage: 'handed_to_human', ...input };
  lead.stage_history ??= [{ stage: lead.stage!, at: lead.createdAt, by: 'agent' }];
  lead.notified ??= [lead.stage!];
  await writeLead(lead);
  await notify('SMORI 网站新咨询', `${lead.name || '（未留姓名）'} · ${contactLine(lead)}\n${lead.interest || lead.notes || ''}${lead.city ? ` · ${lead.city}` : ''}`, `${config.appUrl}/#leads`).catch(() => undefined);
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

export async function markLead(id: string, handled: boolean): Promise<void> {
  const lead = await readLead(id);
  lead.handled = handled;
  lead.updatedAt = new Date().toISOString();
  await writeLead(lead);
}

/** Staff override: any stage, any direction. */
export async function setLeadStage(id: string, stage: Stage): Promise<Lead> {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
  const lead = await readLead(id);
  const at = new Date().toISOString();
  if (lead.stage !== stage) {
    lead.stage = stage;
    lead.stage_history = [...(lead.stage_history ?? []), { stage, at, by: 'staff' }];
  }
  lead.updatedAt = at;
  await writeLead(lead);
  return lead;
}

const rank = (s: Stage | undefined | null) => (s ? STAGES.indexOf(s) : -1);

/** Anything that tells us about the project (not contact details). */
export function hasQualification(l: Partial<Lead>): boolean {
  return Boolean(l.room_type || l.window_count || l.approximate_size || l.primary_need || l.motorization_interest || l.budget_range || l.zip || (l.products_recommended && l.products_recommended.length));
}

export interface StageSignals { consultation?: boolean; human?: boolean }

/**
 * Deterministic stage rules:
 *  new                    any qualification info (room, need, size, ZIP, budget…) or a contact method
 *  qualified              contact (phone/email/WeChat) + room type or primary need
 *  consultation_requested contact + the customer agreed to book (button, form or in chat)
 *  handed_to_human        contact + the customer asked for a person (转人工) or the agent could not help
 * Without a contact method nobody can follow up, so a booking / human request is
 * remembered (consultation_interest / wants_human) and takes effect as soon as contact arrives.
 */
export function computeStage(l: Partial<Lead>, signals: StageSignals = {}): Stage | null {
  const contact = hasContact(l);
  if (contact && (signals.human || l.wants_human)) return 'handed_to_human';
  if (contact && (signals.consultation || l.consultation_interest === 'yes')) return 'consultation_requested';
  if (contact && (l.room_type || l.primary_need)) return 'qualified';
  if (contact || hasQualification(l)) return 'new';
  return null;
}

export type LeadPatch = Partial<Omit<Lead, 'id' | 'createdAt' | 'conversationId' | 'stage' | 'stage_history' | 'notified'>>;

const MERGE_SKIP = new Set(['products_recommended', 'transcript', 'page', 'consultation_interest', 'wants_human']);

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

const PUSH_TITLE: Record<Stage, string> = { new: '', qualified: 'SMORI 销售线索：已确认需求', consultation_requested: 'SMORI 销售线索：申请预约咨询', handed_to_human: 'SMORI 销售线索：转人工' };

function pushBody(l: Lead): string {
  const facts = [l.room_type, l.window_count && `${l.window_count} 扇窗`, l.primary_need, l.motorization_interest && `电动：${l.motorization_interest}`, l.zip && `ZIP ${l.zip}${l.zip_in_area ? '（OC）' : ''}`, l.preferred_time && `时间：${l.preferred_time}`].filter(Boolean).join(' · ');
  return `${l.name || '（未留姓名）'} · ${contactLine(l)}\n${facts}${l.summary ? `\n${l.summary}` : ''}`.slice(0, 900);
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
 * from "qualified" on. Returns null when there is nothing to save yet.
 */
export function upsertConversationLead(conversationId: string, patch: LeadPatch, opts: UpsertOptions = {}): Promise<Lead | null> {
  return withLock(conversationId, async () => {
    const notify = opts.notify ?? ntfyNotify;
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

    const notified = new Set(merged.notified ?? []);
    const shouldPush = stage !== 'new' && !notified.has(stage) && rank(stage) > Math.max(-1, ...[...notified].map(rank));
    if (shouldPush) { notified.add(stage); merged.notified = [...notified]; }
    await writeLead(merged);
    if (shouldPush) await notify(PUSH_TITLE[stage], pushBody(merged), `${config.appUrl}/#leads`).catch(() => undefined);
    return merged;
  });
}

export function zipInServiceArea(zip: string, prefixes = config.serviceZipPrefixes): boolean {
  const z = zip.trim();
  return /^\d{5}(-\d{4})?$/.test(z) && prefixes.some((p) => z.startsWith(p));
}

const CSV_COLUMNS = ['id', 'createdAt', 'updatedAt', 'stage', 'lead_source', 'name', 'phone', 'email', 'wechat', 'zip', 'zip_in_area', 'city', 'room_type', 'window_count', 'approximate_size', 'primary_need', 'motorization_interest', 'budget_range', 'products_recommended', 'consultation_interest', 'preferred_time', 'summary', 'notes', 'language', 'handled', 'page_url', 'utm'] as const;

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
