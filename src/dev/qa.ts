import { getEngine } from '../render/engineRef';
import { useStore } from '../model/store';
import { OfflineRenderer } from '../export/OfflineRenderer';
import { encodeImage } from '../export/encode';
import { activeTarget } from '../model/actions';

/** Dev helper: renders the active frame offline and stores it via the dev server for review. */
async function qa(name = 'qa.png', opts: { scale?: number; samples?: number; preview?: boolean } = {}) {
  const e = getEngine();
  if (!e) throw new Error('no engine');
  const doc = useStore.getState().doc;
  const t = activeTarget(doc);
  const scale = opts.scale ?? 0.5;
  const w = Math.round(t.width * scale);
  const h = Math.round(t.height * scale);
  const t0 = performance.now();
  e.suspend();
  const off = new OfflineRenderer(e);
  try {
    off.prepare(doc, 'srgb');
    const img = await off.render(doc, { width: w, height: h, camera: t.camera ?? doc.camera, samples: opts.samples ?? 64, preview: opts.preview, space: 'srgb' });
    const blob = await encodeImage(img, 'png');
    await fetch(`/__qa/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return { ms: Math.round(performance.now() - t0), w, h };
  } finally {
    off.restore();
    e.resume();
  }
}

Object.assign(window, { qa });
