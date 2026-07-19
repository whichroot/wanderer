// app.js — board UI. Legality/mate/placement come from the engine's
// legalmoves/board commands; this file only draws state and relays clicks.

import { PIECES } from './pieces.js?v=2';

const PIECE_NAME = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
const FILES = 'abcdefgh';

const els = {
  board: document.getElementById('board'),
  status: document.getElementById('status'),
  evaltext: document.getElementById('evaltext'),
  pv: document.getElementById('pv'),
  moves: document.getElementById('moves'),
  newWhite: document.getElementById('new-white'),
  newBlack: document.getElementById('new-black'),
  undo: document.getElementById('undo'),
  promo: document.getElementById('promo'),
  promoChoices: document.getElementById('promo-choices'),
  pad: document.getElementById('pad'),
  padDot: document.getElementById('pad-dot'),
  padLabel: document.getElementById('pad-label'),
  evalbar: document.getElementById('evalbar'),
  evalFill: document.getElementById('evalbar-fill'),
};

const S = {
  ready: false,
  history: [],          // UCI moves from startpos
  human: 'w',
  pieces: {},           // square -> piece char, from `board`
  stm: 'w',             // side to move, from `board`
  legal: [],            // UCI strings, from `legalmoves`
  check: false,
  sel: null,            // selected square
  thinking: false,
  gameOver: null,       // null | {kind:'mate'|'stalemate', winner:'w'|'b'|null}
  stmAtGo: 'w',         // for white-centric eval display
  info: null,           // {depth, cp, pv}
  evalCp: null,         // white-centric centipawns for the bar (null = unknown)
  padX: 0.6505,         // -> ~1000 ms
  padY: 1.0,            // -> 0 cp (cold)
  timeMs: 1000,
  temp: 0,
};

// ---------- worker + line routing ----------

const worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
const pending = [];     // FIFO of {prefix, resolve} — engine output is ordered

function post(line) { worker.postMessage({ type: 'cmd', line }); }

function ask(line, prefix) {
  return new Promise((resolve) => {
    pending.push({ prefix, resolve });
    post(line);
  });
}

worker.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    S.ready = true;
    await newGame('w');
    return;
  }
  if (msg.type === 'fatal') {
    els.status.textContent = 'engine crashed — see console';
    console.error(msg.message);
    return;
  }
  if (msg.type !== 'line') return;
  const text = msg.text;

  if (pending.length && text.startsWith(pending[0].prefix)) {
    pending.shift().resolve(text);
    return;
  }
  if (text.startsWith('info depth')) {
    const m = text.match(/^info depth (\d+) score cp (-?\d+) nodes \d+ time \d+ pv (.*)$/);
    if (m) {
      S.info = { depth: +m[1], cp: +m[2], pv: m[3] };
      S.evalCp = S.stmAtGo === 'w' ? +m[2] : -+m[2];  // live search score, white-centric
      renderReadout();
      renderBar();
    }
  }
};

worker.postMessage({ type: 'init' });

// ---------- engine conversations ----------

async function sync() {
  post('position startpos' + (S.history.length ? ' moves ' + S.history.join(' ') : ''));
  const b = await ask('board', 'board ');
  const parts = b.split(/\s+/);           // ["board", placement, stm]
  S.pieces = parsePlacement(parts[1]);
  S.stm = parts[2];

  const lm = await ask('legalmoves', 'legalmoves');
  const [movesPart, checkPart] = lm.slice('legalmoves'.length).split('|');
  S.legal = movesPart.trim() ? movesPart.trim().split(/\s+/) : [];
  S.check = (checkPart || '').trim() === 'check 1';

  S.gameOver = S.legal.length ? null
    : S.check ? { kind: 'mate', winner: S.stm === 'w' ? 'b' : 'w' }
              : { kind: 'stalemate', winner: null };

  if (S.gameOver) {
    S.evalCp = S.gameOver.kind === 'stalemate' ? 0
      : (S.gameOver.winner === 'w' ? 30000 : -30000);
  } else {
    const ev = await ask('eval', 'eval ');           // static eval, stm-relative
    const cp = parseInt(ev.split(/\s+/)[1], 10);
    S.evalCp = S.stm === 'w' ? cp : -cp;              // white-centric
  }
  render();
}

async function engineMove() {
  S.thinking = true;
  S.stmAtGo = S.stm;
  render();
  const seed = Math.floor(Math.random() * 0x7fffffff);
  const bm = await ask(`go movetime ${S.timeMs} temperature ${S.temp} seed ${seed}`, 'bestmove');
  S.thinking = false;
  const mv = bm.split(/\s+/)[1];
  if (mv && mv !== '0000' && mv !== '(none)') {
    S.history.push(mv);
    await sync();
  } else {
    render();
  }
}

async function newGame(color) {
  S.history = [];
  S.human = color;
  S.sel = null;
  S.gameOver = null;
  S.info = null;
  S.evalCp = null;
  post('ucinewgame');
  await sync();
  if (!S.gameOver && S.stm !== S.human) await engineMove();
}

async function playHuman(uci) {
  S.history.push(uci);
  S.sel = null;
  await sync();
  if (!S.gameOver && S.stm !== S.human) await engineMove();
}

// ---------- undo (full turn) ----------

function humanMovesPlayed() {
  // white plays plies 0,2,4..; black plays 1,3,5..
  return S.human === 'w' ? Math.ceil(S.history.length / 2) : Math.floor(S.history.length / 2);
}

function canUndo() {
  return S.ready && !S.thinking && humanMovesPlayed() >= 1;
}

async function undo() {
  if (!canUndo()) return;
  const lastMover = S.stm === 'w' ? 'b' : 'w';   // color that made the last ply
  if (lastMover === S.human) {
    S.history.pop();                             // your move ended the game — take it back
  } else {
    S.history.pop();                             // engine's reply
    S.history.pop();                             // your move
  }
  S.sel = null;
  S.gameOver = null;
  S.info = null;
  await sync();                                  // now your turn again; no auto-move
}

// ---------- board parsing / helpers ----------

function parsePlacement(fen) {
  const pieces = {};
  const ranks = fen.split('/');           // ranks[0] = rank 8
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '8') { file += +ch; continue; }
      pieces[FILES[file] + (8 - r)] = ch;
      file++;
    }
  }
  return pieces;
}

function humansTurn() {
  return S.ready && !S.thinking && !S.gameOver && S.stm === S.human;
}

function kingSquare(color) {
  const k = color === 'w' ? 'K' : 'k';
  for (const [sq, p] of Object.entries(S.pieces)) if (p === k) return sq;
  return null;
}

// ---------- promotion picker ----------

function pickPromotion(color, candidates) {
  return new Promise((resolve) => {
    els.promoChoices.innerHTML = '';
    for (const uci of candidates) {
      const piece = color === 'w' ? uci[4].toUpperCase() : uci[4];
      const btn = document.createElement('button');
      btn.innerHTML = PIECES[piece];
      btn.setAttribute('aria-label', PIECE_NAME[uci[4]] || uci[4]);
      btn.onclick = (ev) => { ev.stopPropagation(); els.promo.classList.add('hidden'); resolve(uci); };
      els.promoChoices.appendChild(btn);
    }
    els.promo.onclick = () => { els.promo.classList.add('hidden'); resolve(null); }; // click-away cancels
    els.promo.classList.remove('hidden');
  });
}

// ---------- clicks ----------

async function onSquareClick(sq) {
  if (!humansTurn()) return;
  if (S.sel) {
    const cands = S.legal.filter((m) => m.slice(0, 2) === S.sel && m.slice(2, 4) === sq);
    if (cands.length === 1) return playHuman(cands[0]);
    if (cands.length > 1) {
      const choice = await pickPromotion(S.human, cands);
      if (choice) return playHuman(choice);
      S.sel = null;
      return render();
    }
  }
  // (re)select if this square has moves, else clear
  S.sel = S.legal.some((m) => m.startsWith(sq)) ? sq : null;
  render();
}

// ---------- the time/temperature pad ----------

function padApply() {
  S.timeMs = Math.round(50 * Math.pow(100, S.padX));           // 50 ms .. 5000 ms (log)
  S.timeMs = S.timeMs >= 1000 ? Math.round(S.timeMs / 100) * 100 : Math.round(S.timeMs / 10) * 10;
  S.temp = Math.round((1 - S.padY) * 200 / 5) * 5;             // 0 .. 200 cp (linear, step 5)
  const t = S.timeMs >= 1000 ? (S.timeMs / 1000).toFixed(1) + ' s' : S.timeMs + ' ms';
  const tp = S.temp === 0 ? 'cold' : S.temp + ' cp';
  els.padLabel.textContent = `${t} · ${tp}`;
  els.pad.setAttribute('aria-valuetext', `${t}, ${tp}`);
  els.padDot.style.left = (S.padX * 100) + '%';
  els.padDot.style.top = (S.padY * 100) + '%';
}

function padFromEvent(ev) {
  const r = els.pad.getBoundingClientRect();
  S.padX = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  S.padY = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
  padApply();
}

els.pad.addEventListener('pointerdown', (ev) => {
  els.pad.setPointerCapture(ev.pointerId);
  padFromEvent(ev);
});
els.pad.addEventListener('pointermove', (ev) => {
  if (ev.buttons) padFromEvent(ev);
});
els.pad.addEventListener('keydown', (ev) => {
  const step = 0.05;
  if (ev.key === 'ArrowLeft') S.padX = Math.max(0, S.padX - step);
  else if (ev.key === 'ArrowRight') S.padX = Math.min(1, S.padX + step);
  else if (ev.key === 'ArrowUp') S.padY = Math.max(0, S.padY - step);
  else if (ev.key === 'ArrowDown') S.padY = Math.min(1, S.padY + step);
  else return;
  ev.preventDefault();
  padApply();
});

// ---------- rendering ----------

function render() {
  const flipped = S.human === 'b';
  const lastUci = S.history[S.history.length - 1] || '';
  const last = new Set(lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : []);
  const targets = new Map(); // sq -> isCapture
  if (S.sel) {
    for (const m of S.legal) {
      if (m.slice(0, 2) === S.sel) {
        const to = m.slice(2, 4);
        targets.set(to, !!S.pieces[to]);
      }
    }
  }
  const checkSq = S.check ? kingSquare(S.stm) : null;

  els.board.innerHTML = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = flipped ? 7 - col : col;
      const rank = flipped ? row + 1 : 8 - row;
      const sq = FILES[file] + rank;
      const d = document.createElement('div');
      d.className = 'sq ' + ((file + rank) % 2 === 0 ? 'light' : 'dark'); // a1 (0+1) dark, h1 (7+1) light
      if (sq === S.sel) d.classList.add('sel');
      if (last.has(sq)) d.classList.add('last');
      if (sq === checkSq) d.classList.add('check');
      if (targets.has(sq)) {
        d.classList.add('target');
        if (targets.get(sq)) d.classList.add('capture');
      }
      const p = S.pieces[sq];
      if (p) {
        const g = document.createElement('span');
        g.className = 'glyph';
        g.innerHTML = PIECES[p];
        d.appendChild(g);
      }
      if (col === 7) {
        const c = document.createElement('span');
        c.className = 'coord rank';
        c.textContent = rank;
        d.appendChild(c);
      }
      if (row === 7) {
        const c = document.createElement('span');
        c.className = 'coord file';
        c.textContent = FILES[file];
        d.appendChild(c);
      }
      d.onclick = () => onSquareClick(sq);
      els.board.appendChild(d);
    }
  }

  // status
  let status;
  if (!S.ready) status = 'loading engine…';
  else if (S.gameOver) {
    if (S.gameOver.kind === 'stalemate') status = 'Stalemate — draw';
    else status = S.gameOver.winner === S.human ? 'Checkmate — you win!' : 'Checkmate — Wanderer wins';
  } else if (S.thinking) status = 'Wanderer is thinking…';
  else if (S.stm === S.human) status = S.check ? 'Your move — check!' : 'Your move';
  else status = 'Wanderer to move';
  els.status.textContent = status;

  els.newWhite.disabled = S.thinking;
  els.newBlack.disabled = S.thinking;
  els.undo.disabled = !canUndo();

  // move list
  let txt = '';
  for (let i = 0; i < S.history.length; i += 2) {
    txt += `${i / 2 + 1}. ${S.history[i]} ${S.history[i + 1] || ''} `;
  }
  els.moves.textContent = txt;

  renderReadout();
  renderBar();
}

function evalFraction(cp) {
  if (cp >= 29000) return 1;
  if (cp <= -29000) return 0;
  const t = cp / 350;
  return 0.5 + 0.5 * (t / (1 + Math.abs(t)));   // smooth, bounded (0,1)
}

function renderBar() {
  els.evalbar.classList.toggle('flipped', S.human === 'b');
  const frac = S.evalCp == null ? 0.5 : evalFraction(S.evalCp);
  els.evalFill.style.height = (frac * 100).toFixed(1) + '%';
}

function renderReadout() {
  if (!S.info) { els.evaltext.textContent = '—'; els.pv.textContent = ''; return; }
  const { depth, cp, pv } = S.info;
  const whiteCp = S.stmAtGo === 'w' ? cp : -cp;
  let evalStr;
  if (Math.abs(cp) >= 29000) {
    const plies = 30000 - Math.abs(cp);
    const mateIn = Math.ceil(plies / 2);
    evalStr = (whiteCp > 0 ? '+#' : '-#') + mateIn;
  } else {
    evalStr = (whiteCp >= 0 ? '+' : '') + (whiteCp / 100).toFixed(2);
  }
  els.evaltext.textContent = `depth ${depth}   ${evalStr}`;
  els.pv.textContent = pv;
}

// ---------- controls ----------

els.newWhite.onclick = () => newGame('w');
els.newBlack.onclick = () => newGame('b');
els.undo.onclick = () => undo();
window.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'z') { ev.preventDefault(); undo(); }
});

padApply();
