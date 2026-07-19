#!/usr/bin/env bash
# build_wasm.sh — compile the engine to wasm32 (tvc -> llc -> wasm-ld).
# env overrides: TRAVELER TVC LLC WLD OPT. Host imports: web/shim.mjs.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TRAVELER="${TRAVELER:-$HOME/Documents/git/whichroot/traveler}"
TVC="${TVC:-$TRAVELER/src/bootstrap/out/stage1}"
LLC="${LLC:-/opt/homebrew/opt/llvm@21/bin/llc}"
MIDOPT="${MIDOPT:-/opt/homebrew/opt/llvm@21/bin/opt}"
WLD="${WLD:-/opt/homebrew/opt/llvm@18/bin/wasm-ld}"
OPT="${OPT:--O2}"

SRC="$HERE/wasm/wanderer_wasm.tv"
LL="$HERE/build/wanderer_wasm.ll"
OBJ="$HERE/build/wanderer_wasm.o"
OUT="$HERE/web/wanderer.wasm"

[ -x "$TVC" ] || { echo "error: Traveler compiler not found/executable: $TVC" >&2; exit 1; }
[ -x "$LLC" ] || { echo "error: llc not found/executable: $LLC" >&2; exit 1; }
[ -x "$WLD" ] || { echo "error: wasm-ld not found/executable: $WLD" >&2; exit 1; }

mkdir -p "$HERE/build" "$HERE/web"

echo "[1/3] tvc     : wanderer_wasm.tv -> wanderer_wasm.ll  (wasm32-unknown-unknown)"
"$TVC" "$SRC" -target wasm32-unknown-unknown -o "$LL"

# NOTE: no opt middle-end here — O2 idiom-recognition synthesizes libcalls
# (e.g. strlen) that become env imports the shim does not provide. llc-only
# keeps the import set at the documented 10.
echo "[2/3] llc     : $OPT +bulk-memory -> wanderer_wasm.o"
"$LLC" $OPT -mtriple=wasm32-unknown-unknown -mattr=+bulk-memory -filetype=obj "$LL" -o "$OBJ"

echo "[3/3] wasm-ld : -> web/wanderer.wasm"
# no-entry reactor module; undefined symbols become env.* imports (web/shim.mjs);
# stack-first traps overflow; 8 MiB stack, 128 MiB initial memory growable to 1 GiB.
"$WLD" --no-entry --allow-undefined --stack-first \
    --export=wasm_init --export=wasm_inbox --export=wasm_line \
    --export=__heap_base \
    -z stack-size=8388608 \
    --initial-memory=134217728 --max-memory=1073741824 \
    "$OBJ" -o "$OUT"

echo "OK: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
