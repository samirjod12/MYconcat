# Concat Web

    rustup target add wasm32-unknown-unknown && cargo install wasm-pack
    cargo test -p concat-web          # from src/: native check of the wrapper
    web/build.sh                      # writes web/pkg/
    cd web && python3 -m http.server 8080

Open http://localhost:8080, drop in clips, double-click one in the bin to place it.
Keys: Space play, S split, Delete remove, Ctrl+Z / Ctrl+Y undo/redo, arrows step a frame.
See PORTING.md for what is and is not ported.
