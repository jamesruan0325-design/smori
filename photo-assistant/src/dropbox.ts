/**
 * Dropbox connector: OAuth (refresh token stored encrypted) + incremental
 * listing of the camera-upload folder + downloads.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { getSecret, saveSecret, deleteSecret } from './tokens.js';

const SCOPES = 'files.metadata.read files.content.read account_info.read';
let cached: { token: string; expiresAt: number } | null = null;
const STATE_COOKIE = 'smori_dbx_state';

export function dropboxConfigured(): boolean {
  return Boolean(config.dropboxAppKey && config.dropboxAppSecret && config.appUrl && config.sessionSecret);
}

export async function dropboxConnected(): Promise<boolean> {
  return dropboxConfigured() && Boolean(await getSecret('dropbox_refresh_token'));
}

function sign(v: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(v).digest('base64url');
}

export function beginDropboxAuth(_req: Request, res: Response): void {
  if (!dropboxConfigured()) { res.status(500).send('Dropbox is not configured (DROPBOX_APP_KEY / DROPBOX_APP_SECRET)'); return; }
  const nonce = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, `${nonce}|${sign(nonce)}`, { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'lax', maxAge: 600_000, path: '/connect' });
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.searchParams.set('client_id', config.dropboxAppKey);
  url.searchParams.set('redirect_uri', `${config.appUrl}/connect/dropbox/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', nonce);
  res.redirect(url.toString());
}

export async function handleDropboxCallback(req: Request, res: Response, fetchImpl: typeof fetch = fetch): Promise<void> {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  if (error) { res.status(400).send(`Dropbox: ${error} ${error_description ?? ''}`); return; }
  const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(STATE_COOKIE + '='))?.slice(STATE_COOKIE.length + 1) ?? '';
  const [nonce, sig] = decodeURIComponent(cookie).split('|');
  if (!code || !state || !nonce || sig !== sign(nonce) || nonce !== state) { res.status(400).send('state mismatch; start again from the connect button'); return; }
  res.clearCookie(STATE_COOKIE, { path: '/connect' });
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${config.appUrl}/connect/dropbox/callback`, client_id: config.dropboxAppKey, client_secret: config.dropboxAppSecret });
  const r = await fetchImpl('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) { res.status(502).send(`Dropbox token exchange failed: ${(await r.text()).slice(0, 300)}`); return; }
  const json = (await r.json()) as { refresh_token?: string; account_id?: string };
  if (!json.refresh_token) { res.status(502).send('Dropbox did not return a refresh token'); return; }
  await saveSecret('dropbox_refresh_token', json.refresh_token);
  await saveSecret('dropbox_account_id', json.account_id ?? '');
  cached = null; // a new grant may carry new scopes
  await resetCursor();
  res.redirect('/?dropbox=connected');
}

export async function disconnectDropbox(): Promise<void> {
  cached = null;
  await deleteSecret('dropbox_refresh_token');
  await deleteSecret('dropbox_account_id');
  await resetCursor();
}


async function accessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const refresh = await getSecret('dropbox_refresh_token');
  if (!refresh) throw new Error('Dropbox is not connected');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: config.dropboxAppKey, client_secret: config.dropboxAppSecret });
  const r = await fetchImpl('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Dropbox refresh failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const json = (await r.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

/** Dropbox-API-Arg must be "HTTP header safe" JSON: escape every non-ASCII character. */
export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Team accounts with a team space: files outside the member folder need the root namespace as path root. */
function pathRootHeader(nsid?: string): Record<string, string> {
  return nsid ? { 'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', root: nsid }) } : {};
}

async function rpc<T>(endpoint: string, arg: unknown, fetchImpl: typeof fetch = fetch, nsid?: string): Promise<T> {
  const token = await accessToken(fetchImpl);
  const r = await fetchImpl(`https://api.dropboxapi.com/2/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...pathRootHeader(nsid) }, body: JSON.stringify(arg) });
  if (!r.ok) {
    const text = (await r.text()).slice(0, 300);
    if (r.status === 401) cached = null;
    throw new Error(`Dropbox ${endpoint}: HTTP ${r.status} ${text}`);
  }
  return (await r.json()) as T;
}

export interface DropboxFile {
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  size: number;
  client_modified: string;
  media_info?: { '.tag': string; metadata?: { '.tag': string; time_taken?: string; location?: { latitude: number; longitude: number } } };
}

interface ListResult { entries: ({ '.tag': string } & Partial<DropboxFile>)[]; cursor: string; has_more: boolean }

const stateFile = () => path.join(config.dataDir, 'auto', 'dropbox-state.json');

export interface DropboxState { cursor?: string; lastRun?: string; folder?: string; nsid?: string; seen: Record<string, string> }

export async function readState(): Promise<DropboxState> {
  try { return JSON.parse(await fs.readFile(stateFile(), 'utf8')); } catch { return { seen: {} }; }
}

export async function writeState(s: DropboxState): Promise<void> {
  await fs.mkdir(path.dirname(stateFile()), { recursive: true });
  await fs.writeFile(stateFile(), JSON.stringify(s, null, 2));
}

async function resetCursor(): Promise<void> {
  const s = await readState();
  delete s.cursor;
  delete s.folder;
  delete s.nsid;
  await writeState(s);
}

const CAMERA_FOLDER_NAMES = /^(camera uploads|camera|相机上传|相機上傳|カメラアップロード|kamera-uploads|camera-uploads|téléchargements de l'appareil photo|subidas de cámara)$/i;

/**
 * Finds the camera-upload folder: the configured DROPBOX_FOLDER if it exists,
 * otherwise a root folder with a known (localised) camera-upload name.
 */
export async function resolveFolder(fetchImpl: typeof fetch = fetch): Promise<{ folder: string; nsid?: string }> {
  const state = await readState();
  if (state.folder) return { folder: state.folder, nsid: state.nsid };
  const wanted = config.dropboxFolder.toLowerCase();
  const pick = (folders: { name?: string; path_lower?: string; path_display?: string }[]) =>
    folders.find((f) => f.path_lower === wanted) ?? folders.find((f) => CAMERA_FOLDER_NAMES.test(f.name ?? ''));
  const seen: string[] = [];

  // 1. member home namespace (default)
  const home = await rpc<ListResult>('files/list_folder', { path: '', recursive: false, limit: 500 }, fetchImpl);
  const homeFolders = home.entries.filter((e) => e['.tag'] === 'folder');
  seen.push(...homeFolders.map((f) => f.name ?? ''));
  let match = pick(homeFolders);
  let nsid: string | undefined;

  // 2. team space root and the member folder inside it
  if (!match) {
    const acct = await rpc<{ root_info?: { '.tag': string; root_namespace_id?: string; home_namespace_id?: string; home_path?: string } }>('users/get_current_account', null, fetchImpl);
    const ri = acct.root_info;
    if (ri?.root_namespace_id && ri.root_namespace_id !== ri.home_namespace_id) {
      nsid = ri.root_namespace_id;
      const paths = ['', ...(ri.home_path ? [ri.home_path] : [])];
      for (const p of paths) {
        const r = await rpc<ListResult>('files/list_folder', { path: p, recursive: false, limit: 500 }, fetchImpl, nsid);
        const folders = r.entries.filter((e) => e['.tag'] === 'folder');
        seen.push(...folders.map((f) => (p ? `${p}/` : '') + (f.name ?? '')));
        match = pick(folders);
        if (match) break;
        // one level deeper (e.g. team folder / camera)
        for (const f of folders) {
          const sub = await rpc<ListResult>('files/list_folder', { path: f.path_lower, recursive: false, limit: 200 }, fetchImpl, nsid);
          const subFolders = sub.entries.filter((e) => e['.tag'] === 'folder');
          seen.push(...subFolders.map((x) => `${f.name}/${x.name}`));
          match = pick(subFolders);
          if (match) break;
        }
        if (match) break;
      }
    }
  }
  if (!match?.path_display) {
    throw new Error(`Dropbox: camera-upload folder not found. Folders seen: ${seen.join(', ') || '(none)'}. Turn on camera uploads in the Dropbox app and upload one photo, or set DROPBOX_FOLDER.`);
  }
  state.folder = match.path_display;
  state.nsid = nsid;
  await writeState(state);
  return { folder: state.folder, nsid };
}

/**
 * Returns image files added since the last call (cursor-based). On first use it
 * starts from "now" so a large existing camera roll is not imported wholesale;
 * set `fromScratch` to import everything already in the folder.
 */
export async function listNewFiles(opts: { fromScratch?: boolean } = {}, fetchImpl: typeof fetch = fetch): Promise<DropboxFile[]> {
  const { folder, nsid } = await resolveFolder(fetchImpl);
  const state = await readState();
  const files: DropboxFile[] = [];
  let result: ListResult;
  if (!state.cursor) {
    if (opts.fromScratch) {
      result = await rpc<ListResult>('files/list_folder', { path: folder, recursive: false, include_media_info: true, limit: 500 }, fetchImpl, nsid);
    } else {
      const latest = await rpc<{ cursor: string }>('files/list_folder/get_latest_cursor', { path: folder, recursive: false, include_media_info: true }, fetchImpl, nsid);
      state.cursor = latest.cursor;
      state.lastRun = new Date().toISOString();
      await writeState(state);
      return [];
    }
  } else {
    result = await rpc<ListResult>('files/list_folder/continue', { cursor: state.cursor }, fetchImpl, nsid);
  }
  for (;;) {
    for (const e of result.entries) {
      if (e['.tag'] !== 'file' || !e.path_lower) continue;
      if (!/\.(jpe?g|png|webp|heic|heif)$/i.test(e.path_lower)) continue;
      if (state.seen[e.path_lower]) continue;
      files.push(e as DropboxFile);
    }
    state.cursor = result.cursor;
    if (!result.has_more) break;
    result = await rpc<ListResult>('files/list_folder/continue', { cursor: result.cursor }, fetchImpl, nsid);
  }
  state.lastRun = new Date().toISOString();
  await writeState(state);
  return files;
}

export async function markSeen(pathLower: string, status: string): Promise<void> {
  const s = await readState();
  s.seen[pathLower] = `${status}@${new Date().toISOString()}`;
  await writeState(s);
}

export async function download(pathLower: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const token = await accessToken(fetchImpl);
  const { nsid } = await readState();
  const r = await fetchImpl('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': headerJson({ path: pathLower }), ...pathRootHeader(nsid) } });
  if (!r.ok) throw new Error(`Dropbox download ${pathLower}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function dropboxAccount(fetchImpl: typeof fetch = fetch): Promise<{ email?: string; name?: string }> {
  const a = await rpc<{ email?: string; name?: { display_name?: string } }>('users/get_current_account', null, fetchImpl);
  return { email: a.email, name: a.name?.display_name };
}
