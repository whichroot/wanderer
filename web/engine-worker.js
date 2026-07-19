// engine-worker.js — module Worker hosting wanderer.wasm (search blocks this thread).
// in: {type:'init'}|{type:'cmd',line}  out: {type:'ready'}|{type:'line',text}|{type:'fatal',message}
import { createEngine, EngineExit } from './shim.mjs';

let engine = null;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      const resp = await fetch(new URL('./wanderer.wasm', import.meta.url));
      const wasmBytes = new Uint8Array(await resp.arrayBuffer());
      engine = await createEngine({
        wasmBytes,
        onLine: (text) => self.postMessage({ type: 'line', text }),
      });
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'cmd' && engine) {
      engine.send(msg.line);
    }
  } catch (err) {
    if (!(err instanceof EngineExit)) {
      self.postMessage({ type: 'fatal', message: String(err && err.stack || err) });
    }
  }
};
