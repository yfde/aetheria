// Runs world generation off the main thread.
// { cmd: 'strip', j0, j1 }  -> heights for a band of rows (stage 1, parallelisable)
// { cmd: 'full', height? }  -> the whole world (uses the pre-computed heights when given)
import { generateWorld, macroStrip } from './worldgen.js';

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.cmd === 'strip') {
    const out = macroStrip(m.j0, m.j1);
    self.postMessage({ type: 'strip', j0: m.j0, j1: m.j1, data: out }, [out.buffer]);
    return;
  }
  const t0 = performance.now();
  const w = generateWorld((p, label) => self.postMessage({ type: 'progress', p, label }), m.height || null);
  w.genMs = performance.now() - t0;
  const transfer = [w.height.buffer, w.water.buffer, w.normalTex.buffer, w.maskTex.buffer, w.biomeTex.buffer, w.slopeY.buffer, w.mapImg.buffer, w.veg.bushes.buffer, w.veg.rocks.buffer, ...w.veg.trees.map((t) => t.buffer)];
  self.postMessage({ type: 'done', world: w }, transfer);
};
