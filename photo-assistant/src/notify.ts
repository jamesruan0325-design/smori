import { config } from './config.js';

export type Notifier = (title: string, message: string, click?: string) => Promise<void>;

/** Push notification through ntfy (https://ntfy.sh): the phone app subscribes to NTFY_TOPIC. */
export const ntfyNotify: Notifier = async (title, message, click) => {
  if (!config.ntfyTopic) { console.log(`[notify] ${title}: ${message}${click ? ` ${click}` : ''}`); return; }
  const res = await fetch(`${config.ntfyServer}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: config.ntfyTopic, title, message, click, tags: ['camera'] }),
  });
  if (!res.ok) console.error(`ntfy failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
};

export function notifyConfigured(): boolean {
  return Boolean(config.ntfyTopic);
}
