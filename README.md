# Wanderer

A UCI chess engine in one [Traveler](../traveler) source file (`wanderer.tv`),
compiled by its `stage1` compiler (`cc` is only the linker). Fully legal move
generation (castling, en passant, underpromotion); perft-verified;
deterministic at fixed depth. Classical search plus an optional NNUE path.

Command reference: [`WANDERER.md`](WANDERER.md).

## Build

Needs the Traveler compiler (`stage1`), LLVM `llc` (21), and `cc`.

```sh
./build.sh              # wanderer.tv -> build/wanderer.ll -> wanderer
```

Overridable: `TVC`, `LLC`, `MIDOPT`, `CC`, `OPT`, `SRC`, `BIN` (see
`build.sh`). Default target is arm64 macOS. On Linux: add
`-target x86_64-pc-linux-gnu` and link with `-no-pie`.

Sanity:
```sh
printf 'perft 5\nquit\n' | ./wanderer          # -> 4865609 (startpos, exact)
printf 'position startpos\ngo movetime 1000\nquit\n' | ./wanderer
```

## Play in the browser

```sh
./build_wasm.sh                          # wasm/wanderer_wasm.tv -> web/wanderer.wasm
(cd web && python3 -m http.server 8000)  # open http://localhost:8000
```

The engine runs in a Web Worker (`web/engine-worker.js` + `web/shim.mjs`);
`web/app.js` is the board UI. Headless checks without a browser:

```sh
node web/play_cli.mjs "position startpos" "go depth 6"   # one-shot UCI
node web/soak_game.mjs                                   # full engine-vs-engine game
```

## Notes

- macOS: `now_ms()` uses `CLOCK_REALTIME` (0). Linux's `CLOCK_MONOTONIC` (1) is
  undefined on macOS and silently breaks time control — do not "restore" it.

## License

[MIT](LICENSE)
