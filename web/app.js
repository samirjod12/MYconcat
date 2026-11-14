// SPDX-License-Identifier: AGPL-3.0-or-later
// Concat Web: the browser host for the engine's project model (concat-web,
// compiled to WebAssembly). The wasm module owns the edit: every change is a
// Command sent to it. This file owns what a browser must do instead of
// FFmpeg/wgpu/cpal: decode, composite, play and encode.

const $ = (id) => document.getElementById(id);
const useMock = new URLSearchParams(location.search).get('engine') === 'mock';

let Engine; // class WebEditor
async function loadEngine() {
  if (useMock) {
    Engine = (await import('./test/mock-engine.js')).WebEditor;
    return;
  }
  const mod = await import('./pkg/concat_web.js');
  await mod.default();
  Engine = mod.WebEditor;
}

// ---- state --------------------------------------------------------------
let ed, proj;
const files = new Map(); // media path -> File
const urls = new Map(); // media path -> object URL
const els = new Map(); // clip id -> {el, kind, gain, src}
let pathSeq = 0;
let zoom = 80;
let playhead = 0;
let playing = false;
let playBase = 0, playWall = 0;
const sel = new Set();
let audioCtx, bus, exportDest;
let exporting = false;

const timeline = () => proj.timelines.find((t) => t.id === proj.activeTimelineId) || proj.timelines[0];
const clipById = (id) => timeline().clips.find((c) => c.id === id);
const mediaById = (id) => proj.media.find((m) => m.id === id);
const duration = () => timeline().clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 3500);
}

function run(cmd, gesture) {
  try {
    const text = JSON.stringify(cmd);
    const out = JSON.parse(gesture ? ed.applyWithin(gesture, text) : ed.apply(text));
    refresh();
    return out;
  } catch (e) {
    toast(e.message || String(e));
    return null;
  }
}

function newProject() {
  ed = new Engine('Untitled', 1920, 1080, 30, 1);
  sel.clear(); playhead = 0; stop();
  refresh();
}

// ---- refresh ------------------------------------------------------------
function refresh() {
  proj = JSON.parse(ed.project());
  const tl = timeline();
  const cv = $('preview');
  if (cv.width !== tl.video.width || cv.height !== tl.video.height) {
    cv.width = tl.video.width; cv.height = tl.video.height;
  }
  for (const id of [...sel]) if (!clipById(id)) sel.delete(id);
  $('undo').disabled = !ed.canUndo();
  $('redo').disabled = !ed.canRedo();
  renderBin(); renderTimeline(); renderProps(); drawFrame();
}

// ---- media import -------------------------------------------------------
function probe(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'video';
    const done = (info) => resolve({ url, kind, ...info });
    if (kind === 'image') {
      const i = new Image();
      i.onload = () => done({ width: i.naturalWidth, height: i.naturalHeight, duration: null });
      i.onerror = () => reject(new Error(`Cannot read ${file.name}`));
      i.src = url;
    } else {
      const v = document.createElement(kind === 'audio' ? 'audio' : 'video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => done({
        width: v.videoWidth || null, height: v.videoHeight || null,
        duration: isFinite(v.duration) ? v.duration : null,
      });
      v.onerror = () => reject(new Error(`This browser cannot decode ${file.name}`));
      v.src = url;
    }
  });
}

async function importFiles(list) {
  for (const file of list) {
    try {
      const p = await probe(file);
      const path = `web://${++pathSeq}/${file.name}`;
      files.set(path, file); urls.set(path, p.url);
      run({
        op: 'addMedia',
        item: {
          path, name: file.name, duration: p.duration, kind: p.kind,
          width: p.width, height: p.height, frameRate: p.kind === 'video' ? 30 : null,
          frameRateFraction: p.kind === 'video' ? '30/1' : null,
          videoCodec: null, audioCodec: null, hasAudio: p.kind !== 'image',
        },
      });
    } catch (e) { toast(e.message); }
  }
}

// ---- bin ----------------------------------------------------------------
function renderBin() {
  const ul = $('media'); ul.textContent = '';
  const miss = [];
  for (const m of proj.media) {
    const li = document.createElement('li');
    const have = urls.has(m.path);
    if (!have) { li.className = 'gone'; miss.push(m); }
    li.draggable = true;
    li.innerHTML = '<span></span><small></small>';
    li.firstChild.textContent = m.name;
    li.lastChild.textContent = m.kind + (m.duration ? ` ${m.duration.toFixed(1)}s` : '');
    li.ondragstart = (e) => e.dataTransfer.setData('text/concat-media', m.id);
    li.ondblclick = () => placeMedia(m.id, firstLaneId(), playhead);
    ul.append(li);
  }
  const box = $('missing');
  box.hidden = miss.length === 0;
  if (miss.length) {
    box.innerHTML = `${miss.length} media file(s) need relinking. <button id="relink">Choose files…</button>`;
    $('relink').onclick = relink;
  }
}

function relink() {
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true;
  input.onchange = async () => {
    for (const file of input.files) {
      const m = proj.media.find((x) => x.name === file.name && !urls.has(x.path));
      if (!m) continue;
      const p = await probe(file);
      const path = `web://${++pathSeq}/${file.name}`;
      files.set(path, file); urls.set(path, p.url);
      run({ op: 'updateMediaPath', mediaId: m.id, newPath: path });
    }
  };
  input.click();
}

const firstLaneId = () => timeline().tracks[timeline().tracks.length - 1].id; // topmost
function placeMedia(mediaId, trackId, start) {
  const out = run({ op: 'addClip', mediaId, trackId, start });
  if (out && out.createdId) { sel.clear(); sel.add(out.createdId); refresh(); }
}

// ---- timeline -----------------------------------------------------------
function renderTimeline() {
  const tl = timeline();
  const width = Math.max((duration() + 10) * zoom, $('timeline').clientWidth);
  const ruler = $('ruler'); ruler.textContent = ''; ruler.style.width = width + 'px';
  const step = zoom >= 120 ? 1 : zoom >= 50 ? 2 : zoom >= 25 ? 5 : 10;
  for (let s = 0; s * zoom < width; s += step) {
    const i = document.createElement('i');
    i.style.left = s * zoom + 'px'; i.textContent = fmt(s, true); ruler.append(i);
  }
  const lanes = $('lanes'); lanes.textContent = ''; lanes.style.width = width + 'px';
  for (const track of [...tl.tracks].reverse()) {
    const lane = document.createElement('div');
    lane.className = 'lane'; lane.dataset.track = track.id;
    const lh = document.createElement('span'); lh.className = 'lh';
    lh.innerHTML = `${track.id} <button data-f="visible" title="Show/hide">${track.visible ? 'V' : 'v̶'}</button><button data-f="muted" title="Mute">${track.muted ? 'M' : 'm'}</button>`;
    lh.onclick = (e) => {
      const f = e.target.dataset.f; if (!f) return;
      run({ op: 'setTrackFlag', trackId: track.id, flag: f, value: f === 'visible' ? !track.visible : !track.muted });
    };
    lane.append(lh);
    lane.ondragover = (e) => { e.preventDefault(); lane.classList.add('over'); };
    lane.ondragleave = () => lane.classList.remove('over');
    lane.ondrop = (e) => {
      e.preventDefault(); lane.classList.remove('over');
      const id = e.dataTransfer.getData('text/concat-media');
      if (id) placeMedia(id, track.id, Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / zoom));
    };
    for (const c of tl.clips.filter((c) => c.trackId === track.id)) lane.append(clipEl(c));
    lanes.append(lane);
  }
  placePlayhead();
}

function clipEl(c) {
  const d = document.createElement('div');
  d.className = `clip ${c.kind}${sel.has(c.id) ? ' sel' : ''}`;
  d.style.left = c.start * zoom + 'px'; d.style.width = Math.max(4, c.duration * zoom) + 'px';
  d.textContent = c.name || c.kind;
  d.innerHTML += '<span class="h l"></span><span class="h r"></span>';
  d.onpointerdown = (e) => {
    const edge = e.target.classList.contains('l') ? 'start' : e.target.classList.contains('r') ? 'end' : null;
    if (e.shiftKey) { sel.has(c.id) ? sel.delete(c.id) : sel.add(c.id); } else if (!sel.has(c.id)) { sel.clear(); sel.add(c.id); }
    refresh();
    dragClip(e, c, edge);
    e.stopPropagation();
  };
  return d;
}

function dragClip(e0, c, edge) {
  const gid = 'drag' + Date.now();
  const x0 = e0.clientX;
  const startPos = new Map([...sel].map((id) => [id, clipById(id).start]));
  let lastEdge = 0, moved = false;
  const move = (e) => {
    const dx = (e.clientX - x0) / zoom;
    if (Math.abs(e.clientX - x0) < 3 && !moved) return;
    moved = true;
    if (edge) {
      const delta = dx - lastEdge; lastEdge = dx;
      run({ op: 'trimClip', clipId: c.id, edge, delta, ripple: false }, gid);
    } else {
      const lane = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList?.contains('lane'));
      const moves = [...sel].map((id) => ({
        clipId: id,
        start: Math.max(0, snap(startPos.get(id) + dx, id)),
        trackId: sel.size === 1 && lane ? lane.dataset.track : clipById(id).trackId,
      }));
      run({ op: 'moveClips', moves }, gid);
    }
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); ed.endGesture(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function snap(t, selfId) {
  const tol = 6 / zoom;
  const pts = [0, playhead];
  for (const c of timeline().clips) if (c.id !== selfId) pts.push(c.start, c.start + c.duration);
  for (const p of pts) if (Math.abs(p - t) < tol) return p;
  return t;
}

function placePlayhead() {
  $('playhead').style.left = playhead * zoom + 'px';
  $('clock').textContent = fmt(playhead);
}
function fmt(s, short) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return short ? `${m}:${String(Math.floor(r)).padStart(2, '0')}` : `${m}:${r.toFixed(2).padStart(5, '0')}`;
}

$('ruler').onpointerdown = (e) => {
  const seek = (ev) => { setTime(Math.max(0, (ev.clientX - $('ruler').getBoundingClientRect().left) / zoom)); };
  seek(e);
  const up = () => { window.removeEventListener('pointermove', seek); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', seek); window.addEventListener('pointerup', up);
};
$('lanes').onpointerdown = (e) => { if (e.target.classList.contains('lane')) { sel.clear(); refresh(); } };
$('zoom').oninput = (e) => { zoom = +e.target.value; renderTimeline(); };

// ---- inspector ----------------------------------------------------------
function renderProps() {
  const box = $('props'); box.textContent = '';
  if (sel.size !== 1) { box.textContent = sel.size ? `${sel.size} clips selected.` : 'Select a clip.'; return; }
  const c = clipById([...sel][0]);
  const row = (label, input) => { const l = document.createElement('label'); l.textContent = label; l.append(input); box.append(l); return input; };
  const num = (label, value, step, apply) => {
    const i = document.createElement('input'); i.type = 'number'; i.step = step; i.value = +(+value).toFixed(3);
    i.onchange = () => { const v = parseFloat(i.value); if (isFinite(v)) apply(v); };
    return row(label, i);
  };
  const txt = (label, value, apply) => {
    const i = document.createElement('input'); i.type = 'text'; i.value = value;
    i.onchange = () => apply(i.value); return row(label, i);
  };
  txt('Name', c.name, (v) => run({ op: 'updateClip', clipId: c.id, patch: { name: v } }));
  num('Start (s)', c.start, 0.1, (v) => run({ op: 'moveClips', moves: [{ clipId: c.id, start: Math.max(0, v), trackId: c.trackId }] }));
  num('Length (s)', c.duration, 0.1, (v) => run({ op: 'trimClip', clipId: c.id, edge: 'end', delta: v - c.duration, ripple: false }));
  if (c.kind !== 'text') num('Speed', c.speed, 0.25, (v) => run({ op: 'setClipSpeed', clipId: c.id, speed: v, ripple: false }));
  num('Volume', c.volume, 0.1, (v) => run({ op: 'updateClip', clipId: c.id, patch: { volume: v } }));
  num('Opacity', c.opacity, 0.1, (v) => run({ op: 'updateClip', clipId: c.id, patch: { opacity: v } }));
  if (c.kind !== 'audio') {
    const tr = (k) => (v) => run({ op: 'setClipTransform', clipId: c.id, [k]: v });
    num('Scale', c.scale, 0.1, tr('scale'));
    num('X offset', c.offsetX, 0.05, tr('offsetX'));
    num('Y offset', c.offsetY, 0.05, tr('offsetY'));
    num('Rotation', c.rotation, 5, tr('rotation'));
  }
  if (c.kind === 'text' && c.text) {
    txt('Text', c.text.content, (v) => run({ op: 'updateClip', clipId: c.id, patch: { text: { ...c.text, content: v } } }));
    num('Size', c.text.fontSize, 0.01, (v) => run({ op: 'updateClip', clipId: c.id, patch: { text: { ...c.text, fontSize: v } } }));
    const col = document.createElement('input'); col.type = 'color'; col.value = c.text.color.slice(0, 7);
    col.onchange = () => run({ op: 'updateClip', clipId: c.id, patch: { text: { ...c.text, color: col.value } } });
    row('Colour', col);
  }
}

// ---- compositor + playback ---------------------------------------------
function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  bus = audioCtx.createGain(); bus.connect(audioCtx.destination);
  exportDest = audioCtx.createMediaStreamDestination(); bus.connect(exportDest);
}

function getEl(c) {
  let rec = els.get(c.id);
  const m = mediaById(c.mediaId);
  const url = m && urls.get(m.path);
  if (rec && rec.src === url) return rec;
  if (rec) rec.el.pause?.();
  if (!url) return null;
  let el;
  if (c.kind === 'image') { el = new Image(); el.src = url; }
  else {
    el = document.createElement('video'); el.src = url; el.preload = 'auto'; el.playsInline = true;
    el.onseeked = () => { if (!playing) drawFrame(); };
  }
  rec = { el, src: url, gain: null };
  if (c.kind !== 'image' && audioCtx) wireAudio(rec);
  els.set(c.id, rec);
  return rec;
}

function wireAudio(rec) {
  if (rec.gain) return;
  const src = audioCtx.createMediaElementSource(rec.el);
  rec.gain = audioCtx.createGain(); src.connect(rec.gain); rec.gain.connect(bus);
}

const BLEND = { multiply: 'multiply', screen: 'screen', add: 'lighter', lighten: 'lighten', darken: 'darken' };

function sync(c, t, tl) {
  const track = tl.tracks.find((x) => x.id === c.trackId);
  const rec = getEl(c);
  const active = t >= c.start && t < c.start + c.duration;
  if (!rec) return null;
  if (c.kind === 'image') return active ? rec : null;
  const el = rec.el;
  if (!active) { if (!el.paused) el.pause(); return null; }
  const want = c.sourceStart + (t - c.start) * c.speed;
  el.playbackRate = Math.min(16, Math.max(0.0625, c.speed));
  if (playing) {
    if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
    if (el.paused) el.play().catch(() => {});
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - want) > 0.02) el.currentTime = want;
  }
  if (rec.gain) {
    const into = t - c.start, left = c.start + c.duration - t;
    const f = Math.min(c.fadeIn > 0 ? into / c.fadeIn : 1, c.fadeOut > 0 ? left / c.fadeOut : 1, 1);
    rec.gain.gain.value = track?.muted || c.muted ? 0 : c.volume * Math.max(0, f);
  } else el.volume = track?.muted || c.muted ? 0 : Math.min(1, c.volume);
  return rec;
}

function drawFrame() {
  if (!proj) return;
  const tl = timeline(), cv = $('preview'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  const t = playhead, bg = tl.video.canvas || [0, 0, 0, 255];
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`; g.fillRect(0, 0, W, H);
  const seen = new Set();
  for (const track of tl.tracks) { // stored bottom first
    for (const c of tl.clips) {
      if (c.trackId !== track.id) continue;
      seen.add(c.id);
      const rec = sync(c, t, tl);
      if (!track.visible || !rec && c.kind !== 'text') continue;
      if (t < c.start || t >= c.start + c.duration) continue;
      if (c.kind === 'audio') continue;
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, c.opacity));
      g.globalCompositeOperation = BLEND[c.blend] || 'source-over';
      g.translate(W / 2 + c.offsetX * W, H / 2 + c.offsetY * H);
      g.rotate((c.rotation * Math.PI) / 180);
      if (c.kind === 'text' && c.text) drawText(g, c, W, H);
      else if (rec) {
        const el = rec.el, w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
        if (w && h) {
          const s = Math.min(W / w, H / h) * c.scale;
          const sx = s * (c.stretchX ?? 1) * (c.flipH ? -1 : 1), sy = s * (c.stretchY ?? 1) * (c.flipV ? -1 : 1);
          g.scale(sx, sy);
          try { g.drawImage(el, -w / 2, -h / 2, w, h); } catch { /* frame not ready */ }
        }
      }
      g.restore();
    }
  }
  for (const [id, rec] of els) if (!seen.has(id)) { rec.el.pause?.(); els.delete(id); }
}

function drawText(g, c, W, H) {
  const st = c.text, px = (st.fontSize * H) / 0.72; // fontSize is cap height / frame height
  g.scale(c.scale, c.scale);
  g.font = `${st.italic ? 'italic ' : ''}${st.fontWeight || 700} ${px}px "${st.fontFamily}", "Hanken Grotesk", system-ui, sans-serif`;
  g.textAlign = st.align === 'left' ? 'left' : st.align === 'right' ? 'right' : 'center';
  g.textBaseline = 'middle';
  g.globalAlpha *= st.opacity ?? 1;
  let text = st.content;
  if (st.textCase === 'upper') text = text.toUpperCase(); else if (st.textCase === 'lower') text = text.toLowerCase();
  const lines = text.split('\n'), lh = px * 1.2, y0 = -((lines.length - 1) * lh) / 2;
  lines.forEach((line, i) => {
    const y = y0 + i * lh;
    if (st.shadow) { g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = px * 0.08; g.shadowOffsetY = px * 0.03; }
    if (st.strokeWidth > 0) { g.lineWidth = st.strokeWidth * H; g.strokeStyle = st.strokeColor; g.strokeText(line, 0, y); }
    g.fillStyle = st.color; g.fillText(line, 0, y);
  });
}

function setTime(t) {
  playhead = Math.max(0, t);
  if (playing) { playBase = playhead; playWall = performance.now(); }
  placePlayhead(); drawFrame();
}

function tick() {
  if (!playing) return;
  playhead = playBase + (performance.now() - playWall) / 1000;
  if (playhead >= duration()) { playhead = duration(); stop(); if (exporting) finishExport(); }
  placePlayhead(); drawFrame();
  if (playing) requestAnimationFrame(tick);
}

function play() {
  if (!duration()) return;
  ensureAudio(); audioCtx.resume();
  for (const rec of els.values()) if (rec.el.pause) wireAudio(rec);
  if (playhead >= duration()) playhead = 0;
  playing = true; playBase = playhead; playWall = performance.now();
  $('play').textContent = 'Pause'; requestAnimationFrame(tick);
}
function stop() {
  playing = false; $('play').textContent = 'Play';
  for (const rec of els.values()) rec.el.pause?.();
}
$('play').onclick = () => (playing ? stop() : play());

// ---- export (real time, MediaRecorder) ---------------------------------
let recorder, chunks;
function startExport() {
  if (!duration()) return toast('Nothing to export.');
  if (!window.MediaRecorder) return toast('This browser cannot record the canvas.');
  ensureAudio(); stop(); sel.clear(); refresh();
  const fps = Math.round(timeline().video.rateNum / timeline().video.rateDen) || 30;
  const stream = $('preview').captureStream(fps);
  exportDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mime = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 });
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, { type: mime })); a.download = `export.${ext}`; a.click();
    $('export').textContent = 'Export'; $('export').disabled = false; exporting = false;
  };
  exporting = true; $('export').disabled = true; $('export').textContent = 'Exporting…';
  playhead = 0; recorder.start(250); play();
}
function finishExport() { setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), 300); }
$('export').onclick = startExport;

// ---- project I/O and misc buttons --------------------------------------
$('save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ed.document()], { type: 'application/json' }));
  a.download = 'concat.json'; a.click();
};
$('open').onclick = () => {
  const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,application/json';
  i.onchange = async () => {
    try { ed = Engine.fromDocument(await i.files[0].text()); sel.clear(); playhead = 0; stop(); refresh(); toast('Opened. Relink media to see pictures.'); }
    catch (e) { toast(e.message); }
  };
  i.click();
};
$('new').onclick = () => newProject();
$('undo').onclick = () => { ed.undo(); refresh(); };
$('redo').onclick = () => { ed.redo(); refresh(); };
$('addTrack').onclick = () => run({ op: 'addTrack' });
$('addText').onclick = () => {
  const out = run({ op: 'addTextClip', trackId: firstLaneId(), start: playhead, style: { content: 'Your text' } });
  if (out && out.createdId) { sel.clear(); sel.add(out.createdId); refresh(); }
};
$('split').onclick = () => { if (sel.size) run({ op: 'splitClips', clipIds: [...sel], time: playhead }); };
$('del').onclick = () => { if (sel.size) run({ op: 'removeClips', clipIds: [...sel], ripple: false }); };
$('file').onchange = (e) => importFiles([...e.target.files]);
$('drop').ondragover = (e) => { e.preventDefault(); $('drop').classList.add('over'); };
$('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = (e) => { e.preventDefault(); $('drop').classList.remove('over'); importFiles([...e.dataTransfer.files]); };

window.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  else if (e.key === 's' && !mod) $('split').click();
  else if (e.key === 'Delete' || e.key === 'Backspace') $('del').click();
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? $('redo') : $('undo')).click(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); $('redo').click(); }
  else if (e.key === 'ArrowLeft') setTime(playhead - 1 / 30);
  else if (e.key === 'ArrowRight') setTime(playhead + 1 / 30);
});

loadEngine().then(newProject).catch((e) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#ffb454">Could not load the engine (web/pkg/concat_web.js).\nRun web/build.sh first.\n\n${e.message}</pre>`;
});
