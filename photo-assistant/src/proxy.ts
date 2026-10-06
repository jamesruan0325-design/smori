/**
 * Shopify App Proxy endpoints for the storefront chat widget.
 *   storefront  https://smoriwindowfashion.com/apps/assistant/<x>
 *   -> Shopify  https://smori-photo-assistant.fly.dev/proxy/<x>?shop=&path_prefix=&timestamp=&signature=
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { chatTurn, detectLanguage, logExchange, offlineReply, type ChatMessage } from './chat.js';
import { BUSINESS } from './knowledge.js';
import { hasContact, saveLead, upsertConversationLead, type PageContext } from './leads.js';
import { extractLead, salesTurn, validEmail, validPhone, validZip, type SalesDeps } from './sales.js';

/** App-proxy signature: sorted "key=value" pairs concatenated with no separator, HMAC-SHA256 hex with the app secret. */
export function verifyProxySignature(query: Record<string, unknown>, secret = config.apiSecret): boolean {
  const { signature, ...rest } = query as Record<string, string | string[]>;
  if (typeof signature !== 'string') return false;
  const message = Object.keys(rest).sort().map((k) => `${k}=${Array.isArray(rest[k]) ? (rest[k] as string[]).join(',') : rest[k]}`).join('');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return digest.length === signature.length && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

export function proxyAuth(req: Request, res: Response, next: NextFunction): void {
  if (config.proxySignatureOptional && !req.query.signature) return next();
  if (!config.apiSecret || !verifyProxySignature(req.query as Record<string, unknown>)) { res.status(401).json({ error: 'invalid proxy signature' }); return; }
  const ts = Number(req.query.timestamp);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 15 * 60) { res.status(401).json({ error: 'stale request' }); return; }
  next();
}

/* simple sliding-window limiter per client IP */
const hits = new Map<string, number[]>();
export function rateLimited(key: string, limit = config.chatRatePerHour, now = Date.now()): boolean {
  const windowStart = now - 3_600_000;
  const arr = (hits.get(key) ?? []).filter((t) => t > windowStart);
  if (arr.length >= limit) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
function clientIp(req: Request): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '');
  return xff.split(',')[0].trim() || req.ip || 'unknown';
}

const CONV_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Storefront page the chat was opened on (no query string except utm_*; nothing else is stored). */
export function cleanPageContext(raw: unknown): PageContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: PageContext = {};
  const clip = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const url = clip(r.url, 500);
  if (url) { try { const u = new URL(url); out.url = `${u.origin}${u.pathname}`; } catch { /* ignore */ } }
  const ref = clip(r.referrer, 500);
  if (ref) { try { out.referrer = new URL(ref).origin; } catch { /* ignore */ } }
  if (r.utm && typeof r.utm === 'object') {
    const utm: Record<string, string> = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) { const v = clip((r.utm as Record<string, unknown>)[k], 100); if (v) utm[k] = v; }
    if (Object.keys(utm).length) out.utm = utm;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Test seam: the sales agent's Claude calls and notifier can be replaced. */
export const salesDeps: SalesDeps = {};

export async function handleChat(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { conversationId?: string; messages?: ChatMessage[]; agent?: string; page?: unknown };
  const conversationId = typeof body.conversationId === 'string' && CONV_RE.test(body.conversationId) ? body.conversationId : crypto.randomBytes(8).toString('hex');
  const messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()).slice(-config.chatMaxTurns) : [];
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') { res.status(400).json({ error: 'last message must be from the user' }); return; }
  const lang = detectLanguage(last.content);
  const sales = body.agent === 'sales';
  if (last.content.length > 1500) { res.status(400).json({ error: lang === 'zh' ? '消息太长，请精简后再发。' : 'Message too long.' }); return; }
  if (rateLimited(clientIp(req))) { res.status(429).json({ reply: lang === 'zh' ? `消息有点多了，请稍后再试，或直接致电 ${BUSINESS.phone}。` : `Too many messages for now. Please try again later or call ${BUSINESS.phone}.`, language: lang, conversationId }); return; }
  if (messages.filter((m) => m.role === 'user').length > config.chatMaxTurns / 2) {
    res.json({ reply: lang === 'zh' ? `这段对话已经比较长了。为了更好地帮到您，请留下电话让顾问联系，或致电 ${BUSINESS.phone}。` : `This conversation is getting long. Please leave a phone number for our team, or call ${BUSINESS.phone}.`, language: lang, handoff: true, conversationId, ...(sales ? { cta: 'human_form' } : {}) });
    return;
  }
  if (sales) {
    const page = cleanPageContext(body.page);
    try {
      const result = await salesTurn(messages, conversationId, page, salesDeps);
      await logExchange(conversationId, last.content, { ...result, lead: result.lead ?? undefined }).catch(() => undefined);
      res.json({ conversationId, reply: result.reply, language: result.language, handoff: result.handoff, leadSaved: result.leadSaved, cta: result.cta });
      // after the reply is sent: structured lead fields + stage (never blocks the customer)
      const full = [...messages, { role: 'assistant' as const, content: result.reply }];
      void extractLead(full, conversationId, page, salesDeps).catch((e) => console.error('lead extraction failed', (e as Error).message));
    } catch (e) {
      console.error('sales chat error', e);
      res.status(503).json({ conversationId, reply: offlineReply(lang), language: lang, handoff: true, cta: 'human_form', error: 'assistant_unavailable' });
    }
    return;
  }
  try {
    const result = await chatTurn(messages, conversationId);
    await logExchange(conversationId, last.content, result).catch(() => undefined);
    res.json({ conversationId, reply: result.reply, language: result.language, handoff: result.handoff ?? false, leadSaved: Boolean(result.lead) });
  } catch (e) {
    console.error('chat error', e);
    res.status(503).json({ conversationId, reply: offlineReply(lang), language: lang, handoff: true, error: 'assistant_unavailable' });
  }
}

export async function handleLead(req: Request, res: Response): Promise<void> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim().slice(0, 300) : undefined);
  const lang = (s('language') === 'zh' ? 'zh' : detectLanguage(`${s('notes') ?? ''} ${s('interest') ?? ''} ${s('name') ?? ''}`)) as 'zh' | 'en';
  const input = { name: s('name'), phone: s('phone'), email: s('email'), wechat: s('wechat'), city: s('city'), interest: s('interest'), notes: s('notes'), preferred_time: s('preferred_time') };
  if (!hasContact(input)) { res.status(400).json({ error: lang === 'zh' ? '请至少留一个电话、邮箱或微信号。' : 'Please leave a phone number, email or WeChat ID.' }); return; }
  if (rateLimited(clientIp(req) + ':lead', 10)) { res.status(429).json({ error: 'too many requests' }); return; }
  const conversationId = typeof b.conversationId === 'string' && CONV_RE.test(b.conversationId) ? b.conversationId : 'form';
  const okMessage = lang === 'zh' ? `已收到，我们的顾问会在营业时间内联系您（${BUSINESS.hours}）。急事请致电 ${BUSINESS.phone}。` : `Received. A team member will contact you during business hours (${BUSINESS.hours}). For anything urgent, call ${BUSINESS.phone}.`;

  // AI Sales Agent widget: "预约咨询" (kind=consultation) or "转人工" (kind=human) merge into the conversation's lead
  const kind = s('kind');
  if (b.agent === 'sales' && (kind === 'consultation' || kind === 'human') && conversationId !== 'form') {
    const errs: string[] = [];
    if (input.phone && !validPhone(input.phone)) errs.push(lang === 'zh' ? '电话号码格式不对' : 'Please check the phone number');
    if (input.email && !validEmail(input.email)) errs.push(lang === 'zh' ? '邮箱格式不对' : 'Please check the email address');
    const zip = s('zip');
    if (zip && !validZip(zip)) errs.push(lang === 'zh' ? 'ZIP 应为 5 位数字' : 'ZIP code should be 5 digits');
    if (kind === 'consultation' && !input.phone && !input.email) errs.push(lang === 'zh' ? '预约咨询请留电话或邮箱。' : 'Please leave a phone number or email to book.');
    if (errs.length) { res.status(400).json({ error: errs.join('；') }); return; }
    const lead = await upsertConversationLead(conversationId, {
      ...input,
      zip: zip ? validZip(zip) : undefined,
      room_type: s('room_type'),
      page: cleanPageContext(b.page),
    }, { language: lang, source: 'form', signals: kind === 'human' ? { human: true } : { consultation: true }, notify: salesDeps.notify, now: salesDeps.now });
    res.json({ ok: true, id: lead?.id, stage: lead?.stage, message: kind === 'consultation'
      ? (lang === 'zh' ? `预约申请已收到。顾问会在营业时间内（${BUSINESS.hours}）联系您确认上门时间。急事请致电 ${BUSINESS.phone}。` : `Your consultation request is in. A team member will contact you during business hours (${BUSINESS.hours}) to confirm the visit. For anything urgent, call ${BUSINESS.phone}.`)
      : okMessage });
    return;
  }

  const lead = await saveLead({ ...input, reason: 'human', source: 'form', conversationId, language: lang });
  res.json({ ok: true, id: lead.id, message: okMessage });
}

export function handlePing(_req: Request, res: Response): void {
  res.json({ ok: true, assistant: config.hasAnthropicKey, phone: BUSINESS.phone, email: BUSINESS.email, hours: BUSINESS.hours });
}
