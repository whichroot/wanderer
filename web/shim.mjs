// shim.mjs — JS host imports for wanderer.wasm (shared by worker + node CLI).
// i64 = BigInt at the boundary; clock_gettime writes {sec@+0,nsec@+8}; uname reads buf[0].

export class EngineExit extends Error {
  constructor(code) {
    super(`engine exit(${code})`);
    this.code = code;
  }
}

// createEngine({wasmBytes,onLine,onExit}) -> {send,instance,memory};
// send(line) runs one UCI command synchronously (output arrives via onLine).
export async function createEngine({ wasmBytes, onLine = () => {}, onExit = () => {} }) {
  let memory = null;
  let brk = 0; // JS-owned heap cursor, set from __heap_base after instantiation

  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let outBuf = '';

  const PAGE = 65536;
  // memory.buffer detaches on grow — always take fresh views.
  const mem = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);

  function ensure(end) {
    const need = end - memory.buffer.byteLength;
    if (need > 0) memory.grow(Math.ceil(need / PAGE));
  }

  // 16-byte-aligned bump allocator + first-fit free list
  const freeList = [];        // [{ptr, size}]
  const sizes = new Map();    // live ptr -> size

  function malloc(nBig) {
    let n = Number(nBig);
    if (n < 1) n = 1;
    n = (n + 15) & ~15;
    for (let i = 0; i < freeList.length; i++) {
      if (freeList[i].size >= n) {
        const b = freeList.splice(i, 1)[0];
        sizes.set(b.ptr, b.size);
        return b.ptr;
      }
    }
    const ptr = brk;
    ensure(ptr + n);
    brk = ptr + n;
    sizes.set(ptr, n);
    return ptr;
  }

  function free(ptr) {
    if (!ptr) return;
    const size = sizes.get(ptr);
    if (size === undefined) return; // unknown/double free: ignore
    sizes.delete(ptr);
    freeList.push({ ptr, size });
  }

  function write(fd, buf, nBig) {
    const n = Number(nBig);
    outBuf += dec.decode(new Uint8Array(memory.buffer, buf, n));
    let nl;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      onLine(outBuf.slice(0, nl));
      outBuf = outBuf.slice(nl + 1);
    }
    return BigInt(n);
  }

  function clock_gettime(clk, ts) {
    const ns = BigInt(Math.round(performance.now() * 1e6)); // monotonic; epoch arbitrary
    const d = dv();
    d.setBigInt64(ts, ns / 1000000000n, true);
    d.setBigInt64(ts + 8, ns % 1000000000n, true);
    return 0;
  }

  const imports = {
    env: {
      malloc,
      free,
      write,
      read: () => -1n,
      open: () => -1,
      creat: () => -1,
      close: () => 0,
      exit: (code) => {
        onExit(code);
        throw new EngineExit(code);
      },
      clock_gettime,
      uname: (buf) => {
        mem()[buf] = 76; // 'L' -> Linux -> CLOCK_MONOTONIC id 1
        return 0;
      },
    },
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  memory = instance.exports.memory;
  brk = (instance.exports.__heap_base.value + 15) & ~15;

  instance.exports.wasm_init();
  const inbox = instance.exports.wasm_inbox();

  function send(line) {
    const bytes = enc.encode(line);
    const n = Math.min(bytes.length, 8190);
    mem().set(bytes.subarray(0, n), inbox);
    instance.exports.wasm_line(BigInt(n));
  }

  return { send, instance, memory };
}
