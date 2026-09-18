import { config } from './config.js';

export type Notifier = (title: string, message: string, click?: string) => Promise<void>;

/** Push notification through ntfy (https://ntfy.sh): the phone app subscribes to NTFY_TOPIC. */
export const ntfyNotify: Notifier = async (title, message, click) => {
  if (!config.ntfyTopic) { console.log(`[notify] ${title}: ${message}${click ? ` ${click}` : ''}`); return; }
  await sendNtfy(title, message, click);
};

/** Sends one push and returns the server's answer (throws on failure). */
export async function sendNtfy(title: string, message: string, click?: string): Promise<{ id: string }> {
  if (!config.ntfyTopic) throw new Error('NTFY_TOPIC is not set');
  if (!/^[-_A-Za-z0-9]{1,64}$/.test(config.ntfyTopic)) throw new Error(`NTFY_TOPIC "${config.ntfyTopic}" is invalid: ntfy topics may only contain letters, digits, - and _`);
  const res = await fetch(`${config.ntfyServer}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: config.ntfyTopic, title, message, click, tags: ['camera'] }),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`ntfy failed: HTTP ${res.status} ${text.slice(0, 200)}`); throw new Error(`ntfy HTTP ${res.status}: ${text.slice(0, 200)}`); }
  console.log(`ntfy sent: ${text.slice(0, 120)}`);
  return JSON.parse(text) as { id: string };
}

export function notifyConfigured(): boolean {
  return Boolean(config.ntfyTopic);
}
