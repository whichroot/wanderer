# Wanderer — command reference

A UCI chess engine in one Traveler source file (`wanderer.tv`). Fully legal
move generation (castling, en passant, underpromotion); perft-verified
(startpos d5 = 4,865,609; Kiwipete d4 = 4,085,603). Deterministic at fixed
depth. ~2.9M nodes/sec classical search (arm64 M4 Pro, opt+llc -O2);
~1.1M nps with NNUE maintenance on (`nnue mode 1`, H=256).

Note: dev instrumentation referenced below (`tools/`, `bin/`, `data/`,
`files/`, corpora) is private and gitignored — the public repo ships only the
engine, `web/`, and the build scripts.

## Build

```sh
./build.sh        # tvc -> opt default<O2> -> llc -O2 -> cc
```
The `opt` middle-end stage is load-bearing: llc alone runs no LICM/vectorizer,
and the NNUE int16 hot loops rely on NEON (measured 1.9x on classical search,
3x on NN maintenance). Env overrides: `TVC LLC MIDOPT CC OPT SRC BIN`.
On Linux: add `-target x86_64-pc-linux-gnu` and link with `-no-pie`.

## Play in the browser (wasm32)

```sh
./build_wasm.sh                 # -> web/wanderer.wasm
./tools/gate_wasm.sh            # native-vs-wasm output-identity battery (dev gate)
node web/play_cli.mjs "position startpos" "go depth 6"   # headless UCI
node web/soak_game.mjs          # full engine-vs-engine game via the UI's cycle
(cd web && python3 -m http.server 8000)   # then open http://localhost:8000
```
`gate_wasm.sh` asserts byte-identical output (timing stripped) between the
native and wasm builds over a fixed battery: 10 positions × `board` +
`legalmoves` + `go depth 6`, plus 3 perfts. The engine runs in a Web Worker.

## UCI

`uci`, `isready`, `ucinewgame`, `position startpos|fen ... [moves ...]`,
`go [depth N | movetime MS | wtime/btime/winc/binc ...] [temperature CP] [seed N]`,
`quit`. `temperature CP` (0 = deterministic best; >0 samples among root moves
within CP centipawns of best, weighted by score gap) with optional `seed N`
(fixed seed = reproducible sample; at fixed depth+seed the sampled move is
deterministic and native==wasm identical). `info`/PV always report the true best.
Time-control note: macOS clock ids differ from Linux (see README notes).
Known limitation: `go` searches synchronously — `stop`/`ponderhit` are not
processed mid-search (fixed-depth and movetime are exact; GUI/tournament
interop is the named deferred item).

## Extra commands

Board/state oracles:
- `legalmoves` — every legal move for the side to move + check status, one
  line: `legalmoves e2e4 ... | check 0|1`. Empty list + check 1 = mate,
  + check 0 = stalemate.
- `board` — piece placement + side to move, FEN-style
  (`board rnbq.../... w`).
- `perft N` — node count + ms.
- `eval` — static eval of the current position.
- `evalks` — one machine-parseable line of king-safety probe values.
- `regime` — current internal danger-state values.
- `sense` — the folded per-ply probe stream.
- `nncnt` — print + reset the NN work counters (accumulator columns by cause /
  refreshes / half-slab copies / evals / ensure walks / lazy skips hi+lo /
  eval-cache classical+nn hits) accumulated since the last reset; costs nothing
  on the mode-0 path (nn functions are not called). Pair with `go` for per-node
  ratios. `tools/nnspeed.sh [depth]` = the us/node maintenance-tax ruler
  (mode-1 vs mode-0 over a fixed battery); `tools/margin_probe.py` = the
  |nn>>shift| correction distribution over corpus positions.

`nnue` suite (net training/inspection; all exact-integer, deterministic):
- `nnue` — recompute + eval + static gate.
- `nnue selftest N` — incremental==recompute + make/unmake round-trip + zobrist
  incremental==recompute (castle/EP included) over an N-ply walk, including
  null-slab and multi-ply lazy-chain probes (expect 0/0/0 mismatches).
- `nnue oracle 0|1` — recompute-verify EVERY nn_eval during search (the
  differential oracle; slow, exits loud on mismatch).
- `nnue walkcap N` — max ensure-walk length before finny-refresh fallback
  (default 8, the measured plateau).
- `nnue lazy A B` — lazy nn margin M = A + |classical|>>B (blend mode only;
  A<0 disables skipping; default 100 2). Skips the forward pass and the
  accumulator materialization when classical sits outside [alpha-M, beta+M].
- `nnue gradcheck` / `nnue train` / `nnue factorcheck` — RETIRED at H=256
  (named `ERR retired-v2` lines): the in-engine exact trainer was the
  tiny-ternary era's tool; v2 nets are MLX-trained (`train_mlx.py`) and
  imported through the exact membrane. Grad arrays are no longer allocated.
- `nnue boundcheck` — the lane-bound certificate: scans max|w| over the FT and
  asserts 32 active features × max|w| < 2^12 (accumulator fits int16 with 3
  guard bits). Run it after any import/load; `[CERTIFIED]` is the expected line.
- `nnue anchor PATH [stride] [cap]` / `nnue anchor clear` — load/reset labeled
  rows from a `tbcsv` file.
- `nnue save PATH` / `nnue load PATH` — weight persistence, format v2: 56-byte
  header (magic `WNDRNN02` + dims NFH/H/K/BAND + scale exponents KFT/KW2) then
  FT as int16 FEATURE-major (`ft[f*H+h]`) and heads as int8; valid size
  20,973,624 at H=256. The loader validates before touching weights: any
  failure (magic / dim or scale mismatch / short / trailing bytes) prints a
  named `nnue load ERR` line, re-initialises the weights, and returns 0 — so a
  failed load always leaves weights == fresh init. v1 files refuse with
  `ERR magic`. Under an `NN_BLEND=1` build a boot-load failure is fatal
  (`exit(1)`); interactive `nnue load` never exits.
- `nnue dump PATH [G] [D] [seed]` — export a sparse training corpus for the MLX
  trainer: one CSV row per position
  (`game,band,side,target,wfeats,bfeats,eval,fen`; wfeats/bfeats = active
  feature indices per perspective, eval = classical `evaluate()` side-to-move —
  the residual base). The `seed` selects the self-play RNG (distinct seeds →
  distinct corpora — the diversity dial); honors `tdlabel`.
- `nnue import PATH` — import a v1f float export (`WNDRNF01` magic, raw MASTER
  f32 weights, feature-major) from `train_mlx.py`, quantizing each weight
  exactly via `../traveler/src/lib/float/quant.tv` at the pinned scales
  (round-half-away(x·2^KFT), clamp ±127; inf/nan refuse the whole import;
  subnormals counted). Follow with `nnue save` for the canonical v2 artifact,
  then `nnue boundcheck` (expect CERTIFIED).
- `nnue dumpsib PATH [G] [D] [seed] [DD] [stride]` — sibling corpus for
  rank-sensitive admission (`rank_mlx.py`): at every `stride`-th self-play
  position (≤8/game), one row per LEGAL move with the child's features,
  classical eval, and an ID-search value to depth `DD` (both child
  side-to-move) — the move-ordering ground truth. Deterministic per seed.
- `nnue mode <0|1|2>` — runtime eval mode: 0 classical, 1 blend
  (classical + nn), 2 replace (exact material + nn positional; the net replaces
  the hand-crafted positional eval). Search and self-play honor it.
- `nnue order` — REMOVED (2026-07-16, with `ordergate.sh`): the ordering prior
  was instrument-refused 2026-07-15 (adds nodes vs the deployed
  TT+MVV-LVA+killers+history baseline at ~2.2× time/node; zero SPRT games
  spent), and the H=256 port made the FT feature-major natively, retiring the
  transpose the prior read.
- `nnue dumpself PATH [G] [D] [seed]` — net-in-loop corpus: self-plays with the
  CURRENTLY LOADED net at the current `nnue mode`, dumps
  `game,band,side,target,mat,wfeats,bfeats,fen` (target = deep searched value
  side-to-move, wide-clamped; mat = signed material). `train_mlx.py --replace`
  trains the net to predict `target − mat`. `loop_replace.sh` drives the loop.
- `nnue base w0..w5 | off` — install a fixed 6-weight base; targets become
  residuals.
- `nnue pstbase PATH | off` — install a piece-square base from
  `files/solve_pst` output (subsumes the material base).
- `nnue onebit <0|1>` — ternary constraint for fresh-init/import;
  `nnue ternarycheck` — the all-weights-ternary gate (meaningful while the
  import rule is ternary; superseded by `boundcheck` under scaled-int8).
- `nnue factor <0|1> [fshift]` — inert knob (its consumer, the in-engine
  trainer, is retired; `factorcheck` refuses).
- Compile-time flags: `NN_BLEND` (default 0 = classical eval only),
  `NN_BLEND_SHIFT`.

Endgame-table suite:
- `tb` — build the KQK+KRK tables; prints the longest-mate gates (10/16).
- `tbat` — probe the current position.
- `tbprobe <0|1|2>` — off / probe+verify / probe+trust during self-play
  (the dump/self-play paths auto-build tables when >0).
- `tbmirror` — exhaustive black-strong mirror gate.
- `nullmove <0|1>` — soundness knob for table-adjudicated play.
- `timecurve [0|1]` — clock-TC budget policy: 0 = binary danger-band extension
  (default), 1 = smooth saturating gain over the danger stream; prints the gain
  table (permille at d=0..400). SPRT 2026-07-15: +9 ±30 over 400 games @ 3+0.03,
  inconclusive — NOT promoted.

Label instruments:
- `tdmap [G] [Dplay] [Dsweep]` — sign agreement of searched value vs game
  outcome, by depth and phase band.
- `tdlabel <0|1>` — train against each position's own searched value
  (clamped ±3·scale) instead of the game outcome.
- `tdseg [G] [Dplay] [theta]` — value-stream segmentation statistics.
- `tdfocus <mode> [theta]` — 0 all positions; 1 punctuation only; 2 matched
  uniform control; 3 phase-adaptive.
- `tddump PATH [G] [D]` — feature + target CSV (train split only); consumed by
  `files/learn_mat`; `matgate G D w0..w5` runs a 6-weight model through the
  admission gate.
- `pstdump PATH [G] [D]` — 369-dim normal-equation dump; solved exactly by
  `files/solve_pst dump q20 cert` (verify with `pst_verify.py`);
  `pstgate [G] [D]` runs the solved model through the gate.
- `phifloor gen [G] [D] [maxply]` — deterministic self-play corpus;
  `phifloor <mat|sense|pst|nnue|nnueold> [scale]` (+ ` anchors`) — exact
  per-band SSE floors with witness FEN pairs; `phifloor dump PATH|off` —
  per-sample CSV for `files/fiber_map.py` (independent referee).

## Gates

`./tools/confine.sh [BASE_REF]` (default `HEAD~1`) builds the working tree and a
baseline git ref, runs a fixed multi-command trace with every knob at its
default, strips timing, and asserts the two engines' output is byte-identical.
`./tools/gate_wasm.sh` is the native-vs-wasm equivalent.
`./tools/gate_nnue.sh` — nnue file format v1: round-trip + five refusal fixtures
(headerless / truncated / dim-patch / oversize), each asserting a named `ERR`
line, return 0, and weights == fresh-init after a failed load.
`./tools/gate_mlx.sh` — the MLX membrane gate (skips if `.venv` lacks mlx+numpy):
trains a tiny net on the GPU, then proves the crossing back is EXACT two ways —
byte-identity of `nnue import` vs an independent numpy oracle, and forward-parity
of the engine's `nn_eval` vs a pure-integer numpy forward on the same positions
— plus the import refusal fixtures.

## MLX training (GPU weight-search oracle)

```sh
.venv/bin/pip install mlx numpy
./wanderer <<< $'tbprobe 2\ntdlabel 1\nnnue dump /tmp/c1.csv 250 4 111\nquit'  # per seed
.venv/bin/python tools/train_mlx.py /tmp/c1.csv,/tmp/c2.csv /tmp/m.v1f \
    --epochs 60 --residual                                       # GPU float SGD
./wanderer <<< $'nnue import /tmp/m.v1f\nnnue save wanderer.nnue\nquit'
.venv/bin/python tools/parity_mlx.py ./wanderer wanderer.nnue /tmp/c1.csv  # forward-parity
```
`./tools/gen_parallel.sh OUT_DIR N GAMES DEPTH SEED_BASE [BIN]` — mint dump corpora
with N parallel engine processes (distinct seeds; prints rows + rows/hour).
Measured 2026-07-16 on the M4 Pro at N=10: depth-4 2.62M rows/hour, depth-6
925k rows/hour.
`files/nnbench.tv` — standalone kernel bench for the NNUE arithmetic variants
(legacy i64 / int16 feature-major / SWAR / eval dot), built plain (llc only)
and middle-end-optimized (`opt -passes='default<O2>'` then llc) for comparison;
includes a SWAR-vs-scalar exactness cross-check. Note macOS CLOCK_MONOTONIC id
is 6 (the `clock_gettime(1, …)` idiom in files/*.tv is the Linux id and times
as zero on Darwin).
`train_mlx.py` takes comma-separated corpora, splits 80/20 by game per file,
and `--residual` trains on `target − eval` (blend = classical + nn by
construction). Before export it runs the ADMISSION gate on the held-out split
with the QUANTIZED net, per band, vs predict-zero (in residual mode that means
"vs classical eval alone"); refused heads are zeroed.
`tools/rank_mlx.py NET SIBCORPUS [--margin CP]` — the rank-sensitive admission
(SPRT-predictive gate): per parent, pairwise sibling ordering on decided pairs
(|Δtarget| ≥ margin) and top-1 move agreement vs the deep values, classical vs
classical+nn. `RANK-ADMITTED` only if the blend strictly improves BOTH.
Null-calibrated: a zero-heads net reports delta exactly +0.0000. Run this
before spending SPRT games.
`train_mlx.py … --rank [--hinge CP] [--margin CP] [--cap N]` — train the net
DIRECTLY on ordering: pairwise hinge loss on `dumpsib` sibling pairs (blend =
classical + nn ranks the children like the deep search), with per-band
admission on held-out SAME-BAND decided pairs (a head acts alone only when both
children route to it). Use fresh-seed `dumpsib` corpora for the external
`rank_mlx.py` gate that the trainer never saw. Training is float and
GPU-nondeterministic; every check is exact on the engine side (the export is
ternary-valued, `nnue import` reads it bit-exactly, and `gate_mlx.sh` asserts
both byte-identity and forward-parity). `NN_BLEND` stays 0 until an SPRT
promotes a net.
SPRT 2026-07-15 (first MLX net: 300-game corpus, outcome labels, blend shift 0):
+4 −60 =6 over 70 games @ 100ms, Elo −382 ± 118, LLR −2.96 — H0 accepted,
cleanly rejected, NOT promoted (`sprt_nnue_mlx.log`). Known costs: full-weight
blend on a ~±100-scale net distorts the centipawn eval, and nn maintenance is
~3× per node at fixed movetime.
SPRT 2026-07-15b (residual net: 4×250-game TD-label corpus, admission 4/4 on
held-out MSE, 8–12% under classical-alone per band): NPS-neutral depth-6,
+56 −186 =43 over 285 games, Elo −171 ± 41, LLR −2.96 — H0, NOT promoted
(`sprt_nnue_resid_d6.log`). Lesson recorded: held-out MSE improvement does NOT
imply move quality (regression in the bulk vs ranking at the margin); the
admission gate needs a rank-sensitive metric before the next campaign.
Rank instrument validated same day: on 937 parents / 333,775 decided pairs
(2×60-game `dumpsib` corpora, DD=5, fresh seeds), the same net scores pairwise
−0.0033 / top-1 −0.0085 → `RANK-REFUSED` — the offline gate agrees with SPRT
where MSE disagreed, for ~7 min of corpus vs 285 games. Baselines: classical
alone orders 66.4% of decided pairs and picks the deep-best move 62.2% —
the headroom a useful net must claim. Gate order is now: train → MSE admission
→ rank admission → only then SPRT.
SPRT 2026-07-15c (pairwise-hinge net, `--rank`, 3×80-game 888xxx corpora):
external gate on fresh 777xxx = pairwise **+0.0096** (first positive
out-of-sample), top-1 **+0.0000** → `RANK-REFUSED` (both must improve).
Calibration SPRT ran it anyway, depth-6: +111 −164 =92 / 367 games,
Elo ≈ −51 ± 34 (`sprt_rank_d6.log`, stopped at stable direction). The paid
lesson: training on pairwise ordering IMPROVES pairwise out-of-sample but
still loses, because **top-1 was flat and top-1 is the SPRT-predictive axis**
— the gate refused for exactly the right reason.
SPRT 2026-07-15d (best-vs-rest, `--rank --top1`): all offline metrics worse
(regret +2.05, top1 −0.0128, pairwise −0.0062), depth-6 −108 ± 43 / 200 —
overfit band 3, zeroed the rest; WORSE than all-pairs. The all-pairs pairwise
net stays the best candidate. Progress ledger (all depth-neutral bar the
first): −382±118 (MSE outcome/movetime) → −171±41 (MSE residual/TD) →
**−51±34 (rank/pairwise, best)**; −108±43 (best-vs-rest, worse).
**Meta-finding — the search confound:** `rank_mlx.py`'s regret metric ADMITTED
the −51 pairwise net (−5.90cp) yet SPRT rejected it; all three offline metrics
refused the −108 net. Static-position ordering ≠ Elo because the net is a LEAF
eval inside a depth-6 search, not a depth-1 move picker — only a search-based
proxy (≈ SPRT) reliably gates. The tiny ternary blend asymptotes negative; the
structural dials (net capacity, eval-replacement, net-in-loop self-play on
search-reached positions) are the real next moves, not more loss tweaks.
Eval-replacement + net-in-loop measured (2026-07-15e, `loop_replace.sh`,
material + net positional, depth-6 SPRT vs classical): iter0 classical
bootstrap −292 ± 79, then net-eval self-play iters −354, −344 — the loop
PLATEAUS BELOW its bootstrap, it does not climb. Two structural findings, both
paid: (1) replacement is CAPACITY-BOUND — a 16-hidden ternary net cannot BE the
whole positional eval (PST/mobility/king-safety/pawns), so material+net ≈ −292
vs full classical (worse than blend's −51, where the net only had to CORRECT);
(2) net-in-loop needs a strong-enough base — bootstrapping from a −292 net,
self-play generates weak-distribution data and the loop degrades/plateaus
(~−350), it doesn't bootstrap up. Verdict for THIS net size: the correction
(blend) architecture is structurally right and its ceiling (−51, search-
confounded) is the real ceiling; positive requires BOTH bigger capacity AND a
strong loop base — a larger build, not a loss/mode tweak. NN_BLEND stays 0.
2026-07-16 — the different-scale substrate LANDED (real-NNUE Stage 1): H=256,
FT int16 feature-major, heads int8, `opt` middle-end in build.sh (NEON on the
hot loops; classical search 1.9× faster, NN maintenance ~0.6µs/node measured),
in-engine trainer retired (MLX is the trainer), `nnue boundcheck` lane
certificate. Play path byte-identical vs HEAD (perft/go depth 9/selftest);
gates green (gate_nnue, gate_mlx, gate_wasm; confine diff = exactly the
retired-trainer lines). NN_BLEND stays 0 — Stage 2 (scaled-int8 membrane) and
the corpus/train campaign follow.
Stage 2 landed same day: format v2 (56-byte header + KFT/KW2 scale exponents,
magic WNDRNN02), `nnue import` quantizes RAW master floats Traveler-side via
`quant.tv` (round-half-away, clamp ±127 — the exact rule is a traveler library
with its own pinned-case gate), train_mlx exports raw floats + int8 STE +
np_qint8 oracle mirror. gate_mlx's byte-identity now tests the real crossing;
confine BYTE-IDENTICAL vs the Stage-1 commit over the full default trace.

## Match runner

```sh
python3 tools/match.py <games> <sec/move> skill <level>   # simple runner
.venv/bin/python tools/arena.py ...                        # supersedes it
```
