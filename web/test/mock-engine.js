// TEST DOUBLE ONLY. Mimics the shape of concat-web's WebEditor for the
// commands the page sends, so the page's wiring can be tested without the
// wasm build. It is NOT the engine and its semantics are simplified.
let n = 0;
const clone = (x) => JSON.parse(JSON.stringify(x));
const blank = () => ({
  media: [], fonts: [], activeTimelineId: 'TL1',
  timelines: [{ id: 'TL1', name: 'Timeline 1', video: { width: 1920, height: 1080, rateNum: 30, rateDen: 1, canvas: [0, 0, 0, 255] },
    tracks: [1, 2, 3, 4].map((i) => ({ id: 'T' + i, visible: true, muted: false })), clips: [] }],
});
export class WebEditor {
  constructor(name, w, h, rn, rd) { this.p = blank(); this.p.timelines[0].video = { width: w, height: h, rateNum: rn, rateDen: rd, canvas: [0, 0, 0, 255] }; this.name = name; this.u = []; this.r = []; }
  static fromDocument(text) { const d = JSON.parse(text); if (!d.timelines) throw new Error('That file is not a Concat project.'); const e = new WebEditor('x', 1, 1, 30, 1); e.p = d; return e; }
  get tl() { return this.p.timelines[0]; }
  apply(text) { return this.applyWithin(null, text); }
  applyWithin(g, text) {
    const c = JSON.parse(text), before = clone(this.p), tl = this.tl; let id = null;
    const clip = (i) => tl.clips.find((x) => x.id === i);
    const mk = (o) => ({ id: 'c' + ++n, name: '', kind: 'video', start: 0, duration: 5, sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0, scale: 1, offsetX: 0, offsetY: 0, rotation: 0, opacity: 1, speed: 1, ...o });
    switch (c.op) {
      case 'addMedia': id = 'm' + ++n; this.p.media.push({ id, ...c.item }); break;
      case 'addClip': { const m = this.p.media.find((x) => x.id === c.mediaId); if (!m) throw new Error('That media is no longer in the bin.');
        id = 'c' + ++n; tl.clips.push(mk({ id, trackId: c.trackId, mediaId: m.id, name: m.name, kind: m.kind, start: c.start, duration: m.duration || 5 })); break; }
      case 'addTextClip': id = 'c' + ++n; tl.clips.push(mk({ id, trackId: c.trackId, kind: 'text', name: 'Your text', start: c.start, duration: 4, text: { content: 'Your text', fontFamily: 'Hanken Grotesk', fontSize: 0.09, fontWeight: 700, color: '#ffffff', align: 'center', opacity: 1, strokeWidth: 0, strokeColor: '#000', shadow: true, textCase: 'original', ...c.style } })); break;
      case 'splitClips': for (const i of c.clipIds) { const o = clip(i); if (!o || c.time <= o.start || c.time >= o.start + o.duration) continue; const d = c.time - o.start; const b = { ...clone(o), id: 'c' + ++n, start: c.time, duration: o.duration - d, sourceStart: o.sourceStart + d }; o.duration = d; tl.clips.push(b); } break;
      case 'moveClips': for (const m of c.moves) { const o = clip(m.clipId); if (o) { o.start = m.start; o.trackId = m.trackId; } } break;
      case 'trimClip': { const o = clip(c.clipId); if (c.edge === 'end') o.duration = Math.max(1 / 60, o.duration + c.delta); else { o.start += c.delta; o.sourceStart += c.delta; o.duration -= c.delta; } break; }
      case 'removeClips': tl.clips = tl.clips.filter((x) => !c.clipIds.includes(x.id)); break;
      case 'updateClip': { const o = clip(c.clipId); const { text, ...rest } = c.patch; Object.assign(o, rest); if (text) o.text = text; break; }
      case 'setClipTransform': { const { op, clipId, ...rest } = c; Object.assign(clip(clipId), rest); break; }
      case 'setClipSpeed': clip(c.clipId).speed = c.speed; break;
      case 'setTrackFlag': tl.tracks.find((t) => t.id === c.trackId)[c.flag] = c.value; break;
      case 'addTrack': id = 't' + ++n; tl.tracks.push({ id, visible: true, muted: false }); break;
      case 'updateMediaPath': this.p.media.find((m) => m.id === c.mediaId).path = c.newPath; break;
      default: throw new Error('mock: unsupported ' + c.op);
    }
    if (!(g && this.g === g && this.u.length)) this.u.push(before);
    this.g = g; this.r = [];
    return JSON.stringify({ createdId: id, applied: true });
  }
  endGesture() { this.g = null; }
  undo() { if (!this.u.length) return false; this.r.push(this.p); this.p = this.u.pop(); return true; }
  redo() { if (!this.r.length) return false; this.u.push(this.p); this.p = this.r.pop(); return true; }
  canUndo() { return this.u.length > 0; }
  canRedo() { return this.r.length > 0; }
  project() { return JSON.stringify(this.p); }
  document() { return JSON.stringify({ concat: '0.1.0', name: this.name, ...this.p }); }
  setName(n) { this.name = n; }
}
