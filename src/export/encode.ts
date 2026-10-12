import { zlib, zipSync } from 'fflate';
import type { RenderedImage } from './OfflineRenderer';

export type ImageFormat = 'png' | 'jpeg';

/** Encodes via a 2D canvas (embeds the colour profile), falling back to a streaming PNG writer. */
export async function encodeImage(img: RenderedImage, format: ImageFormat, quality = 0.93): Promise<Blob> {
  try {
    return await encodeWithCanvas(img, format, quality);
  } catch (err) {
    // very large images exceed canvas limits on some devices (e.g. iOS: 16.7 MP)
    if (format === 'jpeg') console.warn('JPEG encoding failed, falling back to PNG', err);
    return encodePng(img);
  }
}

async function encodeWithCanvas(img: RenderedImage, format: ImageFormat, quality: number): Promise<Blob> {
  const colorSpace: PredefinedColorSpace = img.space === 'p3' ? 'display-p3' : 'srgb';
  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const data = new ImageData(img.data as unknown as Uint8ClampedArray<ArrayBuffer>, img.width, img.height, { colorSpace });
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d', { colorSpace }) as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('no 2d context');
    ctx.putImageData(data, 0, 0);
    return c.convertToBlob({ type, quality });
  }
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { colorSpace });
  if (!ctx) throw new Error('no 2d context');
  ctx.putImageData(data, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality));
}

// --- minimal PNG writer -------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bufs: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const b of bufs) for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const t = new TextEncoder().encode(type);
  out.set(t, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32([t, data]));
  return out;
}

export async function encodePng(img: RenderedImage): Promise<Blob> {
  const { width: w, height: h, data } = img;
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const compressed = await new Promise<Uint8Array>((resolve, reject) =>
    zlib(raw, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))),
  );
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (img.space === 'p3') {
    // cICP: Display P3 primaries (12), sRGB transfer (13), RGB, full range
    parts.push(chunk('cICP', new Uint8Array([12, 13, 0, 1])));
  } else {
    parts.push(chunk('sRGB', new Uint8Array([0])));
  }
  parts.push(chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0)));
  return new Blob(parts as BlobPart[], { type: 'image/png' });
}

export async function zipFiles(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const f of files) entries[f.name] = [new Uint8Array(await f.blob.arrayBuffer()), { level: 0 }];
  return new Blob([zipSync(entries) as BlobPart], { type: 'application/zip' });
}

/** Offers files via the share sheet on touch devices (save to Photos), otherwise downloads. */
export async function deliverFiles(files: { name: string; blob: Blob }[], zipName: string): Promise<void> {
  const asFiles = files.map((f) => new File([f.blob], f.name, { type: f.blob.type }));
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  if (coarse && navigator.canShare?.({ files: asFiles })) {
    try {
      await navigator.share({ files: asFiles });
      return;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return;
    }
  }
  if (files.length === 1) downloadBlob(files[0].blob, files[0].name);
  else downloadBlob(await zipFiles(files), zipName);
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
