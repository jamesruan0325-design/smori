import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const US_STATES: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

/** "Irvine, CA" style label from a Nominatim address object. Exported for tests. */
export function formatPlace(address: Record<string, string | undefined>): string {
  const city = address.city || address.town || address.village || address.suburb || address.county || '';
  const state = address.state || '';
  const country = address.country_code?.toUpperCase();
  const st = country === 'US' ? US_STATES[state] ?? state : state;
  return [city, st].filter(Boolean).join(', ');
}

export type Geocoder = (lat: number, lng: number) => Promise<string>;

/** Reverse geocoding via OpenStreetMap Nominatim (free; 1 req/s; identify yourself). Cached on disk. */
export const nominatimGeocode: Geocoder = async (lat, lng) => {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const file = path.join(config.dataDir, 'auto', 'geocode-cache.json');
  let cache: Record<string, string> = {};
  try { cache = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* none */ }
  if (cache[key]) return cache[key];
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { headers: { 'User-Agent': `smori-photo-assistant/1.0 (${config.contactEmail})`, 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error(`geocode HTTP ${res.status}`);
  const json = (await res.json()) as { address?: Record<string, string> };
  const place = formatPlace(json.address ?? {});
  if (place) {
    cache[key] = place;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(cache, null, 2));
  }
  return place;
};
