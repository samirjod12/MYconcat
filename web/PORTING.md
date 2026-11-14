# Concat on the web: what is ported, what is not

## Architecture

    index.html + app.js (browser host)  ──JSON commands──►  concat-web (Rust → WASM)
      decode · composite · play · encode                      = concat-project, unchanged
      <video>/<audio>, Canvas 2D, Web Audio, MediaRecorder    project model, every Command, undo, concat.json

`concat-project` (and `concat-core` under it) has no native dependencies, so the
document model, all ~90 edit commands, gestures/undo and the `concat.json` reader
and writer compile to `wasm32-unknown-unknown` as they are. A project saved on the
web opens in the desktop app and the other way round (media is relinked by name,
because a browser has no file paths).

## Status

| Layer | Desktop crate | Web |
|---|---|---|
| Project model, commands, undo, concat.json | concat-project | **WASM, unchanged** |
| Timeline UI | Slint (`concat`) | rewritten in HTML/JS: lanes, drag, trim, split, snap, zoom |
| Decode | concat-media (FFmpeg) | browser `<video>`/`<audio>`/`<img>` |
| Composite | concat-render (wgpu) | Canvas 2D: position, scale, stretch, rotation, flip, opacity, blend, titles |
| Audio | cpal + FFmpeg chains | Web Audio: volume, fades, track mute |
| Export | concat-export | real-time `MediaRecorder` (MP4 where supported, else WebM) |
| Effects (WGSL, 100 packages) | concat-effects + render | **not yet**: next step is wgpu→WebGPU or WebGL passes |
| Keyframes, masks, speed curves, transitions, shapes, layers | model: yes | stored and round-tripped, **not drawn** |
| Captions, TTS, voice cleanup | whisper.cpp, sherpa-onnx | **not ported** (needs a server or transformers.js/ONNX-web) |
| Background removal, stabilize | concat-vision (ort) | **not ported** (ort has a web build; models are large) |
| Proxies, 4K scrub, HEVC/AV1 export | FFmpeg | **not ported**; WebCodecs is the route |

## Next steps, in order of value

1. **WebCodecs export** instead of MediaRecorder: faster than real time, exact frames, MP4 via a muxer.
2. **Effects**: `concat-effects` + `concat-render` already target wgpu, which compiles to WebGPU; start by making them build for wasm32 and feeding the compositor with `ImageBitmap`s from `VideoFrame`s.
3. **Keyframes** in the preview (the model's `animate` module is in concat-core and is WASM-safe; expose `value_at` through concat-web).
4. **Slint to WASM** if you want the desktop UI itself rather than the HTML one: it needs `concat-host` split so file access, threads and FFmpeg sit behind a trait.

## Honest caveats

* The wasm build was **not compiled** where this was written (no network, no wasm target).
  `cargo test -p concat-web` and `web/build.sh` are the first things to run.
  Cargo.lock needs updating on first build (adds wasm-bindgen and console_error_panic_hook).
* The page's behaviour was tested in headless Chromium against a stand-in engine
  (`web/test/mock-engine.js`), not against the real wasm.
* Licence: AGPL-3.0-or-later. Serving this publicly means offering users the source.
  The name "Concat" and the logo are trademarks of the author; see `TRADEMARK.md`.
