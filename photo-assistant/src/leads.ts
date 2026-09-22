import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { ntfyNotify, type Notifier } from './notify.js';

export interface Lead {
  id: string;
  createdAt: string;
  conversationId: string;
  source: 'chat' | 'form';
  reason: 'quote' | 'measurement' | 'human' | 'question' | 'other';
  language: 'zh' | 'en';
  name?: string;
  phone?: string;
  email?: string;
  wechat?: string;
  city?: string;
  interest?: string;
  window_count?: string;
  preferred_time?: string;
  notes?: string;
  transcript?: { role: string; content: string }[];
  handled?: boolean;
}

const dir = () => path.join(config.dataDir, 'leads');

export function hasContact(l: Partial<Lead>): boolean {
  return Boolean((l.phone && l.phone.trim()) || (l.email && l.email.trim()) || (l.wechat && l.wechat.trim()));
}

export async function saveLead(input: Omit<Lead, 'id' | 'createdAt'>, notify: Notifier = ntfyNotify): Promise<Lead> {
  if (!hasContact(input)) throw new Error('a phone number, email or WeChat ID is required');
  const lead: Lead = { id: `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`, createdAt: new Date().toISOString(), ...input };
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(path.join(dir(), `${lead.id}.json`), JSON.stringify(lead, null, 2));
  const contact = [lead.phone, lead.email, lead.wechat && `WeChat ${lead.wechat}`].filter(Boolean).join(' · ');
  await notify('SMORI 网站新咨询', `${lead.name || '（未留姓名）'} · ${contact}\n${lead.interest || lead.notes || ''}${lead.city ? ` · ${lead.city}` : ''}`, `${config.appUrl}/#leads`).catch(() => undefined);
  return lead;
}

export async function listLeads(limit = 200): Promise<Lead[]> {
  try {
    const files = (await fs.readdir(dir())).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit);
    const out: Lead[] = [];
    for (const f of files) { try { out.push(JSON.parse(await fs.readFile(path.join(dir(), f), 'utf8'))); } catch { /* skip */ } }
    return out;
  } catch { return []; }
}

export async function markLead(id: string, handled: boolean): Promise<void> {
  const file = path.join(dir(), `${path.basename(id)}.json`);
  const lead = JSON.parse(await fs.readFile(file, 'utf8')) as Lead;
  lead.handled = handled;
  await fs.writeFile(file, JSON.stringify(lead, null, 2));
}
