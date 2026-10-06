/**
 * TEST DOUBLE of the Anthropic Messages API (POST /v1/messages) for local tests only.
 * Point the SDK at it with ANTHROPIC_BASE_URL=http://127.0.0.1:<port> and a dummy key.
 * It does NOT generate answers: replies are fixed, labelled "[test double]" strings chosen by
 * simple keyword rules, so the real HTTP / tool-loop / structured-output code paths can be
 * exercised without network access or an API key. Never used by the production server.
 */
import http from 'node:http';

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string };
type Msg = { role: 'user' | 'assistant'; content: string | Block[] };

const textOf = (m: Msg) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
const PHONE = /\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const ZIP = /\b(9\d{4})\b/;

export interface FakeCall { structured: boolean; system: string; tools: string[]; lastUser: string }

function message(content: Block[], stop: string) {
  return { id: `msg_test_${Math.random().toString(36).slice(2, 10)}`, type: 'message', role: 'assistant', model: 'test-double', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
}

function extract(transcript: string) {
  const customer = [...transcript.matchAll(/CUSTOMER: ([\s\S]*?)(?=\n\nASSISTANT: |\n\nCUSTOMER: |\n<\/transcript>|$)/g)].map((m) => m[1]).join('\n');
  const has = (re: RegExp) => re.test(customer);
  return {
    name: customer.match(/(?:I'm|I am|my name is|我是|我叫)\s*([A-Za-z]+|[一-鿿]{1,4})/i)?.[1] ?? null,
    phone: customer.match(PHONE)?.[0] ?? null,
    email: customer.match(EMAIL)?.[0] ?? null,
    zip: customer.match(ZIP)?.[1] ?? null,
    room_type: has(/bedroom|主卧|卧室/i) ? 'master bedroom' : has(/living room|客厅/i) ? 'living room' : null,
    window_count: customer.match(/(\d+)\s*(?:windows|扇)/i)?.[1] ?? null,
    approximate_size: null,
    primary_need: has(/blackout|遮光/i) ? 'blackout' : has(/privacy|隐私/i) ? 'privacy' : null,
    motorization_interest: has(/motor|电动/i) ? 'yes' : null,
    budget_range: null,
    products_recommended: has(/blackout|遮光/i) ? ['Duette', 'Designer Roller', 'Made-up Product X'] : [],
    consultation_interest: has(/book|预约|consultation/i) ? 'yes' : 'unknown',
    wants_human: has(/转人工|real person|talk to a person/i),
    summary: '[test double] 客户咨询窗饰方案。',
  };
}

function chat(messages: Msg[]) {
  const last = messages[messages.length - 1];
  if (typeof last.content !== 'string' && last.content.some((b) => b.type === 'tool_result')) {
    const r = last.content.find((b) => b.type === 'tool_result')!;
    const body = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
    return message([{ type: 'text', text: `[test double] tool result received: ${body.slice(0, 80)}` }], 'end_turn');
  }
  const userText = textOf(last);
  const allUser = messages.filter((m) => m.role === 'user').map(textOf).join('\n');
  const contact = { name: allUser.match(/(?:I'm|I am|我是|我叫)\s*([A-Za-z]+|[一-鿿]{1,4})/i)?.[1] ?? '', phone: allUser.match(PHONE)?.[0] ?? '', email: allUser.match(EMAIL)?.[0] ?? '' };
  const tool = (name: string, input: unknown) => message([{ type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2, 10)}`, name, input }], 'tool_use');
  if (/转人工|real person|talk to a person/i.test(userText)) return tool('request_human', { ...contact, reason: 'customer asked for a person' });
  if (/book|预约/i.test(userText)) return tool('request_consultation', { ...contact, preferred_time: /saturday|周六/i.test(userText) ? 'Saturday morning' : '' });
  const zip = userText.match(ZIP)?.[1];
  if (zip) return tool('check_service_area', { zip });
  return message([{ type: 'text', text: `[test double] reply to: ${userText.slice(0, 60)}` }], 'end_turn');
}

export async function startFakeAnthropic(port = 0): Promise<{ url: string; calls: FakeCall[]; close: () => Promise<void> }> {
  const calls: FakeCall[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) { res.writeHead(404).end('{}'); return; }
      const body = JSON.parse(raw) as { messages: Msg[]; system?: unknown; tools?: { name: string }[]; output_config?: { format?: unknown } };
      const structured = Boolean(body.output_config?.format);
      const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
      calls.push({ structured, system, tools: (body.tools ?? []).map((t) => t.name), lastUser: textOf(body.messages[body.messages.length - 1]) });
      const out = structured
        ? message([{ type: 'text', text: JSON.stringify(extract(textOf(body.messages[0]))) }], 'end_turn')
        : chat(body.messages);
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_test' }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, calls, close: () => new Promise((r) => server.close(() => r())) };
}

if (process.argv[1] && /fake-anthropic\.ts$/.test(process.argv[1])) {
  const port = Number(process.env.FAKE_ANTHROPIC_PORT ?? 4567);
  startFakeAnthropic(port).then((f) => console.log(`fake Anthropic API (test double) on ${f.url}`));
}
