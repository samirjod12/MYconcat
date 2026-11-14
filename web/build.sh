#!/usr/bin/env bash
# Builds the engine for the browser into web/pkg. Needs network once, for the
# toolchain target and wasm-bindgen.
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-pack        (or: cargo install wasm-bindgen-cli)
set -euo pipefail
cd "$(dirname "$0")/../src"
wasm-pack build crates/concat-web --release --target web --out-dir ../../../web/pkg --out-name concat_web
echo "Built web/pkg. Serve it:  cd web && python3 -m http.server 8080   then open http://localhost:8080"
