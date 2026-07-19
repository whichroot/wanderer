#!/usr/bin/env bash
# build.sh — compile wanderer.tv to a native binary (tvc -> llc -> cc link).
# env overrides: TRAVELER TVC LLC CC OPT SRC BIN
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TRAVELER="${TRAVELER:-$HOME/Documents/git/whichroot/traveler}"
TVC="${TVC:-$TRAVELER/src/bootstrap/out/stage1}"
LLC="${LLC:-/opt/homebrew/opt/llvm@21/bin/llc}"
MIDOPT="${MIDOPT:-/opt/homebrew/opt/llvm@21/bin/opt}"   # middle-end (LICM/vectorize); llc alone runs neither
CC="${CC:-cc}"
OPT="${OPT:--O2}"
SRC="${SRC:-$HERE/wanderer.tv}"
BIN="${BIN:-$HERE/wanderer}"

LL="$HERE/build/$(basename "${SRC%.tv}").ll"
OBJ="$HERE/build/$(basename "${SRC%.tv}").o"

[ -x "$TVC" ] || { echo "error: Traveler compiler not found/executable: $TVC" >&2; exit 1; }
[ -x "$LLC" ] || { echo "error: llc not found/executable: $LLC" >&2; exit 1; }
[ -f "$SRC" ] || { echo "error: source not found: $SRC" >&2; exit 1; }

mkdir -p "$HERE/build"

echo "[1/4] tvc  : $(basename "$SRC") -> $(basename "$LL")"
"$TVC" "$SRC" -o "$LL"

echo "[2/4] opt  : default<O2> (middle-end)"
"$MIDOPT" -S -passes='default<O2>' "$LL" -o "$LL.opt.ll"

echo "[3/4] llc  : $OPT -> $(basename "$OBJ")"
"$LLC" $OPT -filetype=obj "$LL.opt.ll" -o "$OBJ"

echo "[4/4] link : -> $(basename "$BIN")"
"$CC" "$OBJ" -o "$BIN"

echo "OK: $BIN"
