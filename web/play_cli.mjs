#!/usr/bin/env node
// play_cli.mjs — headless UCI driver: each CLI arg is one command, output to stdout.
// usage: node web/play_cli.mjs "position startpos moves e2e4" "go depth 6"
import { readFileSync } from 'node:fs';
import { createEngine, EngineExit } from './shim.mjs';

const wasmBytes = readFileSync(new URL('./wanderer.wasm', import.meta.url));
const engine = await createEngine({
  wasmBytes,
  onLine: (l) => console.log(l),
});

try {
  for (const cmd of process.argv.slice(2)) engine.send(cmd);
} catch (e) {
  if (!(e instanceof EngineExit)) throw e;
}
