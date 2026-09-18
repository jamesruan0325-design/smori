import sharp from 'sharp';
import exifReader from 'exif-reader';

export interface PhotoMeta {
  takenAt?: string; // ISO
  lat?: number;
  lng?: number;
}

function dms(v: unknown, ref: unknown): number | undefined {
  if (!Array.isArray(v) || v.length < 2) return undefined;
  const [d, m, s = 0] = v.map(Number);
  if ([d, m, s].some((n) => Number.isNaN(n))) return undefined;
  let deg = d + m / 60 + s / 3600;
  if (ref === 'S' || ref === 'W') deg = -deg;
  return Math.round(deg * 1e6) / 1e6;
}

/** Reads capture time and GPS from EXIF (before the web copy strips it). */
export async function readPhotoMeta(buffer: Buffer): Promise<PhotoMeta> {
  const out: PhotoMeta = {};
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.exif) return out;
    const exif = exifReader(meta.exif) as any;
    const dt: unknown = exif?.Photo?.DateTimeOriginal ?? exif?.Image?.DateTime;
    if (dt instanceof Date && !Number.isNaN(dt.getTime())) out.takenAt = dt.toISOString();
    else if (typeof dt === 'string') {
      const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(dt);
      if (m) out.takenAt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
    }
    const g = exif?.GPSInfo;
    if (g) {
      const lat = dms(g.GPSLatitude, g.GPSLatitudeRef);
      const lng = dms(g.GPSLongitude, g.GPSLongitudeRef);
      if (lat !== undefined && lng !== undefined && (lat !== 0 || lng !== 0)) { out.lat = lat; out.lng = lng; }
    }
  } catch { /* unreadable EXIF is not an error */ }
  return out;
}

/** Great-circle distance in metres. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
