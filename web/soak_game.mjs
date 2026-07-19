#!/usr/bin/env node
// soak_game.mjs — full engine-vs-engine game via the app.js command cycle;
// asserts every bestmove is in the preceding legalmoves. usage: node soak_game.mjs [depth] [maxply]
import { readFileSync } from 'node:fs';
import { createEngine } from './shim.mjs';

const DEPTH = process.argv[2] || '5';
const MAXPLY = +(process.argv[3] || 160);

const lines = [];
const wasmBytes = readFileSync(new URL('./wanderer.wasm', import.meta.url));
const engine = await createEngine({ wasmBytes, onLine: (l) => lines.push(l) });

function run(cmd, prefix) {
  lines.length = 0;
  engine.send(cmd);
  const hit = lines.find((l) => l.startsWith(prefix));
  if (hit === undefined) throw new Error(`no '${prefix}' reply to '${cmd}'`);
  return hit;
}

const history = [];
let result = 'ply-cap';
for (let ply = 0; ply < MAXPLY; ply++) {
  // position produces no reply — fire and forget (same as app.js)
  engine.send(`position startpos${history.length ? ' moves ' + history.join(' ') : ''}`);

  const board = run('board', 'board ').split(/\s+/);
  const stm = board[2];
  const lm = run('legalmoves', 'legalmoves');
  const [mv, chk] = lm.slice('legalmoves'.length).split('|');
  const legal = mv.trim() ? mv.trim().split(/\s+/) : [];
  const check = (chk || '').trim() === 'check 1';

  if (legal.length === 0) {
    result = check ? `checkmate (${stm === 'w' ? 'black' : 'white'} wins)` : 'stalemate';
    break;
  }
  const bm = run(`go depth ${DEPTH}`, 'bestmove').split(/\s+/)[1];
  if (!legal.includes(bm)) {
    console.error(`BREACH ply ${ply}: bestmove ${bm} not in legalmoves [${legal.length}]`);
    process.exit(1);
  }
  history.push(bm);
}

console.log(`soak OK: ${history.length} plies, ${result}`);
console.log(`game: ${history.join(' ')}`);
