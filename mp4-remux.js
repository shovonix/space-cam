// mp4-remux.js — turns Chrome's fragmented MP4 (what MediaRecorder writes: an empty index, then a moof + mdat pair
// every ~2 s) into a normal MP4 with one full index (moov with complete sample tables), without re-encoding.
// Why: DaVinci Resolve doesn't import fragmented MP4 (the import closes and no clip appears); QuickTime and
// Premiere do. Found 27 Nov 2026 with a user's two FluentPlayer takes; rebuilding the container fixed the import.
//
// The picture and sound bytes are not touched or copied into memory: the result is a Blob made of
// [new ftyp][mdat header][slices of the original file's sample data …][new moov]. A sound offset (capture cards:
// the HDMI picture is ~120 ms late) is kept as a standard edit list (an empty edit before the track starts).
//
//   import { defragmentMp4 } from './mp4-remux.js';
//   const blob = await defragmentMp4(file, { audioShiftMs: 120 });   // throws if the file isn't what we expect

const enc = new TextEncoder();
const u8 = n => new Uint8Array(n);

// ---------- writing ----------
function box(type, ...parts) {
  const len = parts.reduce((n, p) => n + p.length, 8), out = u8(len), dv = new DataView(out.buffer);
  dv.setUint32(0, len); out.set(enc.encode(type), 4);
  let o = 8; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function fullbox(type, version, flags, ...parts) { const h = u8(4); h[0] = version; h[1] = flags >> 16; h[2] = (flags >> 8) & 255; h[3] = flags & 255; return box(type, h, ...parts); }
function u32s(arr) { const out = u8(arr.length * 4), dv = new DataView(out.buffer); arr.forEach((v, i) => dv.setUint32(i * 4, v >>> 0)); return out; }
function u64s(arr) { const out = u8(arr.length * 8), dv = new DataView(out.buffer); arr.forEach((v, i) => dv.setBigUint64(i * 8, BigInt(v))); return out; }
function i32s(arr) { const out = u8(arr.length * 4), dv = new DataView(out.buffer); arr.forEach((v, i) => dv.setInt32(i * 4, v | 0)); return out; }

// ---------- reading ----------
const name4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
function kids(dv, o, end, fn) {
  while (o + 8 <= end) {
    let size = dv.getUint32(o), hdr = 8; const type = name4(dv, o + 4);
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
    if (size < 8 || o + size > end) throw new Error('bad box ' + type);
    fn(type, o, size, hdr); o += size;
  }
}
const find = (dv, o, end, type) => { let r = null; kids(dv, o, end, (t, bo, s, h) => { if (!r && t === type) r = { o: bo, size: s, hdr: h }; }); return r; };

export async function defragmentMp4(file, { audioShiftMs = 0 } = {}) {
  // 1) top-level boxes
  const top = [];
  for (let o = 0; o + 8 <= file.size;) {
    const dv = new DataView(await file.slice(o, o + 16).arrayBuffer());
    let size = dv.getUint32(0), hdr = 8; const type = name4(dv, 4);
    if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; } else if (size === 0) size = file.size - o;
    if (size < 8) break;
    if (o + size > file.size) { if (type === 'mdat' || type === 'moof') break; throw new Error('truncated ' + type); } // a crash-cut last piece: drop it
    top.push({ type, o, size, hdr }); o += size;
  }
  const moovB = top.find(b => b.type === 'moov');
  if (!moovB) throw new Error('no moov');
  if (!top.some(b => b.type === 'moof')) return file; // already a normal MP4

  // 2) the original moov: tracks, their timescales, handler, stsd; trex defaults
  const mv = new DataView(await file.slice(moovB.o, moovB.o + moovB.size).arrayBuffer()), mvBytes = new Uint8Array(mv.buffer);
  let movieScale = 1000; const tracks = new Map(); const trex = new Map();
  kids(mv, moovB.hdr, moovB.size, (t, o, s, h) => {
    if (t === 'mvhd') { const v = mv.getUint8(o + h); movieScale = mv.getUint32(o + h + (v === 1 ? 20 : 12)); }
    if (t === 'mvex') kids(mv, o + h, o + s, (t2, o2, s2, h2) => { if (t2 === 'trex') trex.set(mv.getUint32(o2 + h2 + 4), { dur: mv.getUint32(o2 + h2 + 12), size: mv.getUint32(o2 + h2 + 16), flags: mv.getUint32(o2 + h2 + 20) }); });
    if (t !== 'trak') return;
    const tr = { o, size: s, hdr: h, id: 0, scale: 0, handler: '', samples: [], chunks: [], start: null, time: 0 };
    const tk = find(mv, o + h, o + s, 'tkhd'); { const v = mv.getUint8(tk.o + tk.hdr); tr.id = mv.getUint32(tk.o + tk.hdr + (v === 1 ? 20 : 12)); tr.tkhd = mvBytes.slice(tk.o, tk.o + tk.size); }
    const md = find(mv, o + h, o + s, 'mdia');
    const mh = find(mv, md.o + md.hdr, md.o + md.size, 'mdhd'); { const v = mv.getUint8(mh.o + mh.hdr); tr.scale = mv.getUint32(mh.o + mh.hdr + (v === 1 ? 20 : 12)); tr.mdhd = mvBytes.slice(mh.o, mh.o + mh.size); }
    const hd = find(mv, md.o + md.hdr, md.o + md.size, 'hdlr'); tr.handler = name4(mv, hd.o + hd.hdr + 8); tr.hdlr = mvBytes.slice(hd.o, hd.o + hd.size);
    const mi = find(mv, md.o + md.hdr, md.o + md.size, 'minf');
    tr.minfKeep = []; // vmhd / smhd / dinf, as they are
    kids(mv, mi.o + mi.hdr, mi.o + mi.size, (t3, o3, s3) => { if (t3 !== 'stbl') tr.minfKeep.push(mvBytes.slice(o3, o3 + s3)); });
    const st = find(mv, mi.o + mi.hdr, mi.o + mi.size, 'stbl');
    const sd = find(mv, st.o + st.hdr, st.o + st.size, 'stsd'); tr.stsd = mvBytes.slice(sd.o, sd.o + sd.size);
    tracks.set(tr.id, tr);
  });

  // 3) every moof: where each run of samples sits in the file, with sizes, durations, flags, composition offsets
  for (let i = 0; i < top.length; i++) {
    const b = top[i]; if (b.type !== 'moof') continue;
    const dv = new DataView(await file.slice(b.o, b.o + b.size).arrayBuffer());
    kids(dv, b.hdr, b.size, (t, to, ts, th) => {
      if (t !== 'traf') return;
      let tr = null, base = b.o, dDur = 0, dSize = 0, dFlags = 0, decode = null;
      kids(dv, to + th, to + ts, (t2, o2, s2, h2) => {
        const p = o2 + h2, fl = dv.getUint32(p) & 0xffffff;
        if (t2 === 'tfhd') {
          const id = dv.getUint32(p + 4); tr = tracks.get(id); const tx = trex.get(id) || { dur: 0, size: 0, flags: 0 };
          let q = p + 8; dDur = tx.dur; dSize = tx.size; dFlags = tx.flags;
          if (fl & 0x1) { base = Number(dv.getBigUint64(q)); q += 8; }
          if (fl & 0x2) q += 4;
          if (fl & 0x8) { dDur = dv.getUint32(q); q += 4; }
          if (fl & 0x10) { dSize = dv.getUint32(q); q += 4; }
          if (fl & 0x20) { dFlags = dv.getUint32(q); q += 4; }
          if (!(fl & 0x1) && !(fl & 0x20000)) base = b.o; // (Chrome sets default-base-is-moof; the moof start either way)
        }
        if (t2 === 'tfdt' && tr) { const v = dv.getUint8(p); decode = v === 1 ? Number(dv.getBigUint64(p + 4)) : dv.getUint32(p + 4); if (tr.start == null) tr.start = decode; }
        if (t2 === 'trun' && tr) {
          const v = dv.getUint8(p), n = dv.getUint32(p + 4); let q = p + 8, dataOff = 0, first = null;
          if (fl & 0x1) { dataOff = dv.getInt32(q); q += 4; }
          if (fl & 0x4) { first = dv.getUint32(q); q += 4; }
          let at = base + dataOff; const chunk = { at, bytes: 0, n };
          // Each piece says when its first sample starts (tfdt). Chrome's pieces don't always follow on exactly from
          // the frame lengths before them, so the last sample before a piece is stretched or shortened to meet it:
          // every sample keeps exactly the time it had in the original (checked packet by packet).
          if (decode != null) {
            if (tr.samples.length && tr.time !== decode) { const last = tr.samples[tr.samples.length - 1]; last.dur = Math.max(1, last.dur + decode - tr.time); }
            tr.time = decode; decode = null;
          }
          for (let k = 0; k < n; k++) {
            const dur = fl & 0x100 ? dv.getUint32((q += 4) - 4) : dDur;
            const size = fl & 0x200 ? dv.getUint32((q += 4) - 4) : dSize;
            let flags = fl & 0x400 ? dv.getUint32((q += 4) - 4) : dFlags; if (k === 0 && first != null) flags = first;
            const cts = fl & 0x800 ? (v === 1 ? dv.getInt32((q += 4) - 4) : dv.getUint32((q += 4) - 4)) : 0;
            tr.samples.push({ dur, size, sync: !(flags & 0x10000), cts }); tr.time += dur;
            chunk.bytes += size;
          }
          if (at + chunk.bytes > file.size) throw new Error('sample data past the end');
          tr.chunks.push(chunk);
        }
      });
    });
  }
  const list = [...tracks.values()].filter(t => t.samples.length);
  if (!list.length) throw new Error('no samples');

  // 4) new layout: ftyp · mdat (all runs, in file order) · moov
  const ftyp = box('ftyp', enc.encode('isom'), u32s([0x200]), enc.encode('isomiso2avc1mp41'));
  const runs = list.flatMap(t => t.chunks.map(c => ({ t, c }))).sort((a, b) => a.c.at - b.c.at);
  const dataBytes = runs.reduce((n, r) => n + r.c.bytes, 0);
  const mdatHdr = u8(16); { const dv = new DataView(mdatHdr.buffer); dv.setUint32(0, 1); mdatHdr.set(enc.encode('mdat'), 4); dv.setBigUint64(8, BigInt(16 + dataBytes)); }
  let pos = ftyp.length + 16; for (const r of runs) { r.c.newAt = pos; pos += r.c.bytes; }

  const minStart = Math.min(...list.map(t => (t.start || 0) / t.scale));
  let movieDur = 0;
  const traks = list.map(t => {
    const isSound = t.handler === 'soun';
    const startSec = (t.start || 0) / t.scale - minStart + (isSound ? Math.max(0, audioShiftMs) / 1000 : 0);
    const mediaDur = t.samples.reduce((n, s) => n + s.dur, 0);
    const emptyM = Math.round(startSec * movieScale), mediaM = Math.round(mediaDur / t.scale * movieScale);
    movieDur = Math.max(movieDur, emptyM + mediaM);
    // sample tables
    const stts = []; for (const s of t.samples) { const l = stts[stts.length - 1]; if (l && l[1] === s.dur) l[0]++; else stts.push([1, s.dur]); }
    const anyCts = t.samples.some(s => s.cts);
    const ctts = []; if (anyCts) for (const s of t.samples) { const l = ctts[ctts.length - 1]; if (l && l[1] === s.cts) l[0]++; else ctts.push([1, s.cts]); }
    const stsc = []; t.chunks.forEach((c, i) => { const l = stsc[stsc.length - 1]; if (!l || l[1] !== c.n) stsc.push([i + 1, c.n, 1]); });
    const sync = []; let allSync = true; t.samples.forEach((s, i) => { if (s.sync) sync.push(i + 1); else allSync = false; });
    const stbl = box('stbl', t.stsd,
      fullbox('stts', 0, 0, u32s([stts.length]), u32s(stts.flat())),
      ...(anyCts ? [fullbox('ctts', 1, 0, u32s([ctts.length]), ...ctts.map(([n, o]) => new Uint8Array([...u32s([n]), ...i32s([o])])))] : []),
      ...(allSync ? [] : [fullbox('stss', 0, 0, u32s([sync.length]), u32s(sync))]),
      fullbox('stsc', 0, 0, u32s([stsc.length]), u32s(stsc.flat())),
      fullbox('stsz', 0, 0, u32s([0, t.samples.length]), u32s(t.samples.map(s => s.size))),
      fullbox('co64', 0, 0, u32s([t.chunks.length]), u64s(t.chunks.map(c => c.newAt))));
    // headers with the real durations (Chrome's are version 1: 64-bit times)
    const tkhd = t.tkhd.slice(), mdhd = t.mdhd.slice();
    setDur(tkhd, 'tkhd', emptyM + mediaM); setDur(mdhd, 'mdhd', mediaDur);
    const edts = emptyM > 0 ? box('edts', fullbox('elst', 1, 0, u32s([2]), u64s([emptyM]), i32s([-1, -1]), u32s([0x00010000]), u64s([mediaM]), u64s([0]), u32s([0x00010000]))) : u8(0);
    return box('trak', tkhd, edts, box('mdia', mdhd, t.hdlr, box('minf', ...t.minfKeep, stbl)));
  });
  // mvhd: copy, set the duration; leave out mvex (its presence alone tells players the file is fragmented)
  const mvhdB = find(mv, moovB.hdr, moovB.size, 'mvhd'); const mvhd = mvBytes.slice(mvhdB.o, mvhdB.o + mvhdB.size); setDur(mvhd, 'mvhd', movieDur);
  { const dv = new DataView(mvhd.buffer), v = mvhd[8]; dv.setUint32(8 + (v === 1 ? 4 + 8 + 8 + 4 + 8 : 4 + 4 + 4 + 4 + 4) + 76, Math.max(...list.map(t => t.id)) + 1); } // next_track_ID
  const moov = box('moov', mvhd, ...traks);

  const parts = [ftyp, mdatHdr];
  for (const r of runs) parts.push(file.slice(r.c.at, r.c.at + r.c.bytes));
  parts.push(moov);
  return new Blob(parts, { type: 'video/mp4' });
}

// duration field of mvhd / tkhd / mdhd (box bytes, version 0 or 1)
function setDur(b, type, d) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), v = b[8], p = 12; // after size+type+version/flags
  const off = type === 'tkhd' ? (v === 1 ? p + 8 + 8 + 4 + 4 : p + 4 + 4 + 4 + 4) : (v === 1 ? p + 8 + 8 + 4 : p + 4 + 4 + 4);
  if (v === 1) dv.setBigUint64(off, BigInt(Math.max(0, Math.round(d)))); else dv.setUint32(off, Math.max(0, Math.round(d)) >>> 0);
}
