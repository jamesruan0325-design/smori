/**
 * Shopify App Proxy endpoints for the storefront chat widget.
 *   storefront  https://smoriwindowfashion.com/apps/assistant/<x>
 *   -> Shopify  https://smori-photo-assistant.fly.dev/proxy/<x>?shop=&path_prefix=&timestamp=&signature=
 */
import crypto from 'node:crypto';
import net from 'node:net';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { chatTurn, detectLanguage, logExchange, offlineReply, type ChatMessage } from './chat.js';
import { BUSINESS } from './knowledge.js';
import { CONTACT_PREFERENCE_ZH, contactPreference, hasContact, PREFERENCE_FIELD, saveLead, upsertConversationLead, type PageContext } from './leads.js';
import { extractLead, salesTurn, validEmail, validPhone, validWechat, validZip, type SalesDeps } from './sales.js';

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
  res.locals.proxySigned = true; // the request really came through Shopify's App Proxy
  next();
}

/* simple sliding-window limiter per client IP */
const hits = new Map<string, number[]>();
let sweepCounter = 0;
export function rateLimited(key: string, limit = config.chatRatePerHour, now = Date.now()): boolean {
  const windowStart = now - 3_600_000;
  if (++sweepCounter % 500 === 0) for (const [k, arr] of hits) if (!arr.some((t) => t > windowStart)) hits.delete(k); // drop idle keys
  const arr = (hits.get(key) ?? []).filter((t) => t > windowStart);
  if (arr.length >= limit) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
/** One address form for comparisons: no IPv6 brackets, no IPv4 port, no ::ffff: prefix, lower case. */
export function normalizeIp(v: string): string {
  let t = v.trim().toLowerCase();
  const bracket = t.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) t = bracket[1];
  const v4port = t.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4port) t = v4port[1];
  if (t.startsWith('::ffff:') && net.isIPv4(t.slice(7))) t = t.slice(7);
  return t;
}

/** IPv6 visitors are counted per /64 (one household or one server can rotate through a whole /64). */
function limitKey(ip: string): string {
  if (!net.isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const tl = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(8 - h.length - tl.length).fill('0'), ...tl] : h;
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Rate-limit key for the storefront visitor behind a request.
 * Shopify's App Proxy sets X-Forwarded-For to the shopper's IP ("Authenticate app proxies" on
 * shopify.dev: "X-Forwarded-For: The client IP address"); Fly's proxy then appends the address
 * it received the request from (Shopify's, also sent as Fly-Client-IP) and the app's own
 * address. So the first entry is the shopper (as before this change). If the first entry is
 * missing or is Shopify's own address, every shopper would share one counter, so the
 * conversation is counted instead (with a global cap). Unsigned requests (only possible with
 * PROXY_SIGNATURE_OPTIONAL, for local testing) use the connecting address.
 * `shape` records how the header looked, for the self-check in the admin page: "shopper-only"
 * means Shopify sent exactly one address, as documented.
 */
export function clientKey(headers: Record<string, unknown>, signed: boolean, conversationId: string, fallback = 'unknown'): { key: string; how: string; shape: string; entries: number } {
  const xff = String(headers['x-forwarded-for'] ?? '').split(',').map(normalizeIp).filter(Boolean);
  const fly = normalizeIp(String(headers['fly-client-ip'] ?? ''));
  const entries = xff.length;
  const flyAt = fly ? xff.lastIndexOf(fly) : -1;
  const shape = !entries ? 'no-xff' : flyAt < 0 ? 'fly-ip-not-in-xff' : flyAt === 1 ? 'shopper-only' : flyAt === 0 ? 'no-shopper' : 'extra-before-shopify';
  if (!signed) return { key: limitKey(fly || xff[0] || normalizeIp(fallback)), how: fly ? 'fly-client-ip' : entries ? 'xff-first' : 'socket', shape, entries };
  const first = xff[0] ?? '';
  if (!first || first === fly) return { key: `conv:${conversationId}`, how: 'conversation (no visitor IP)', shape, entries };
  return { key: limitKey(first), how: 'xff-first', shape, entries };
}

/* In-memory sample of how keys were derived, for the admin page (salted hashes only; no IPs kept). */
const keySalt = crypto.randomBytes(16);
const keySamples: { at: number; how: string; shape: string; entries: number; key: string; conv: string }[] = [];
const hashed = (v: string) => crypto.createHash('sha256').update(keySalt).update(v).digest('hex').slice(0, 12);
function visitorKey(req: Request, res: Response, conversationId: string): string {
  const r = clientKey(req.headers as Record<string, unknown>, res.locals?.proxySigned === true, conversationId, req.ip || 'unknown');
  keySamples.push({ at: Date.now(), how: r.how, shape: r.shape, entries: r.entries, key: hashed(r.key), conv: hashed(conversationId) });
  if (keySamples.length > 1000) keySamples.splice(0, keySamples.length - 1000);
  return r.key;
}
/** Without a visitor address the per-conversation key is easy to rotate: cap those requests site-wide. */
function limited(key: string, limit: number): boolean {
  if (key.startsWith('conv:') && rateLimited('conv-fallback-all', 300)) return true;
  return rateLimited(key, limit);
}

/**
 * Last 24 h, for the admin self-check: requests, distinct visitors and conversations, the most
 * conversations seen behind one visitor key (a shared address shows up as a large number), and
 * the X-Forwarded-For shapes ("shopper-only" = as documented).
 */
export function rateLimitDiagnostics(now = Date.now()): { requests: number; visitors: number; conversations: number; maxConversationsPerVisitor: number; how: Record<string, number>; shapes: Record<string, number>; xffEntries: Record<string, number> } {
  const recent = keySamples.filter((s) => s.at > now - 86_400_000);
  const count = (f: (s: (typeof recent)[number]) => string) => recent.reduce<Record<string, number>>((m, s) => { m[f(s)] = (m[f(s)] ?? 0) + 1; return m; }, {});
  const convsPerKey = new Map<string, Set<string>>();
  for (const s of recent) { if (!convsPerKey.has(s.key)) convsPerKey.set(s.key, new Set()); convsPerKey.get(s.key)!.add(s.conv); }
  return {
    requests: recent.length, visitors: convsPerKey.size, conversations: new Set(recent.map((s) => s.conv)).size,
    maxConversationsPerVisitor: Math.max(0, ...[...convsPerKey.values()].map((c) => c.size)),
    how: count((s) => s.how), shapes: count((s) => s.shape), xffEntries: count((s) => String(s.entries)),
  };
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
  if (limited(visitorKey(req, res, conversationId), config.chatRatePerHour)) { res.status(429).json({ reply: lang === 'zh' ? `消息有点多了，请稍后再试，或直接致电 ${BUSINESS.phone}。` : `Too many messages for now. Please try again later or call ${BUSINESS.phone}.`, language: lang, conversationId }); return; }
  if (messages.filter((m) => m.role === 'user').length > config.chatMaxTurns / 2) {
    res.json({ reply: lang === 'zh' ? `这段对话已经比较长了。为了更好地帮到您，请留下您方便的联系方式（电话、短信、邮箱或微信都可以），顾问会联系您；也可以致电 ${BUSINESS.phone}。` : `This conversation is getting long. Please leave the best way to reach you (call, text, email or WeChat) and our team will contact you, or call ${BUSINESS.phone}.`, language: lang, handoff: true, conversationId, ...(sales ? { cta: 'human_form' } : {}) });
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
  const conversationId = typeof b.conversationId === 'string' && CONV_RE.test(b.conversationId) ? b.conversationId : 'form';
  if (limited(visitorKey(req, res, conversationId) + ':lead', 10)) { res.status(429).json({ error: 'too many requests' }); return; }
  const okMessage = lang === 'zh' ? `已收到，我们的顾问会在营业时间内联系您（${BUSINESS.hoursZh}）。急事请致电 ${BUSINESS.phone}。` : `Received. A team member will contact you during business hours (${BUSINESS.hours}). For anything urgent, call ${BUSINESS.phone}.`;

  // AI Sales Agent widget: "预约咨询" (kind=consultation) or "转人工" (kind=human) merge into the conversation's lead
  const kind = s('kind');
  if (b.agent === 'sales' && (kind === 'consultation' || kind === 'human') && conversationId !== 'form') {
    const errs: string[] = [];
    if (input.phone && !validPhone(input.phone)) errs.push(lang === 'zh' ? '电话号码格式不对' : 'Please check the phone number');
    if (input.email && !validEmail(input.email)) errs.push(lang === 'zh' ? '邮箱格式不对' : 'Please check the email address');
    if (input.wechat && !validWechat(input.wechat)) errs.push(lang === 'zh' ? '微信号格式不对' : 'Please check the WeChat ID');
    const zip = s('zip');
    if (zip && !validZip(zip)) errs.push(lang === 'zh' ? 'ZIP 应为 5 位数字' : 'ZIP code should be 5 digits');
    // any one of phone / email / WeChat is enough; the customer chooses (hasContact above already requires one)
    const pref = contactPreference(s('contact_preference'));
    if (pref && !input[PREFERENCE_FIELD[pref]]) {
      const field = PREFERENCE_FIELD[pref];
      errs.push(lang === 'zh'
        ? `您选择了${CONTACT_PREFERENCE_ZH[pref]}联系，请填写${field === 'phone' ? '电话号码' : field === 'email' ? '邮箱' : '微信号'}`
        : `You chose ${({ phone: 'a call', sms: 'a text message', email: 'email', wechat: 'WeChat' })[pref]}; please fill in your ${field === 'phone' ? 'phone number' : field === 'email' ? 'email' : 'WeChat ID'}`);
    }
    if (errs.length) { res.status(400).json({ error: errs.join(lang === 'zh' ? '；' : '; ') }); return; }
    const lead = await upsertConversationLead(conversationId, {
      ...input,
      wechat: validWechat(input.wechat),
      contact_preference: pref,
      zip: zip ? validZip(zip) : undefined,
      room_type: s('room_type'),
      page: cleanPageContext(b.page),
    }, { language: lang, source: 'form', signals: kind === 'human' ? { human: true } : { consultation: true }, notify: salesDeps.notify, now: salesDeps.now });
    res.json({ ok: true, id: lead?.id, stage: lead?.stage, message: kind === 'consultation'
      ? (lang === 'zh' ? `预约申请已收到。顾问会在营业时间内（${BUSINESS.hoursZh}）联系您确认上门时间。急事请致电 ${BUSINESS.phone}。` : `Your consultation request is in. A team member will contact you during business hours (${BUSINESS.hours}) to confirm the visit. For anything urgent, call ${BUSINESS.phone}.`)
      : (lang === 'zh' ? '已收到。我们的顾问会在营业时间内尽快与您联系。' : 'Received. Our team will contact you during business hours as soon as possible.') });
    return;
  }

  const lead = await saveLead({ ...input, contact_preference: contactPreference(s('contact_preference')), reason: 'human', source: 'form', conversationId, language: lang });
  res.json({ ok: true, id: lead.id, message: okMessage });
}

export function handlePing(_req: Request, res: Response): void {
  res.json({ ok: true, assistant: config.hasAnthropicKey, phone: BUSINESS.phone, email: BUSINESS.email, hours: BUSINESS.hours });
}
