'use strict';
/*
 * Activity Tracker - zero-dependency Node server (Node 18+).
 *   /            -> HOST app (create an activity, live map of everyone)
 *   /e/<id>      -> PARTICIPANT app (one big "Share location" button)
 * Run:  node server.js     (PORT env var optional)
 */
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const EVENT_TTL = 48 * 3600 * 1000; // activities are deleted after 48h of inactivity
const MAX_TRAIL = 300;
const MAX_PEOPLE = 200;

const events = new Map();
let dirty = false;

/* ---------- checkpoints (from the LLAB 9 ConOps maps: master map + equipment drop maps) ----------
 * Coordinates were estimated from the aerial master map (scaled from Pauley Pavilion's published
 * position), so they are APPROXIMATE (about +/-50-100 m). The host can drag each one to its exact
 * spot with "Edit spots" on the host map. Radius = how close counts as "at" the checkpoint. */
const DEFAULT_CHECKPOINTS = [
  { id: 'drake',    name: 'Drake Stadium',     type: 'FOB Securement',   lat: 34.07165, lng: -118.44842, radius: 90,
    items: '', source: 'Master map (orange star); ConOps: Final FOB / Mission Debrief' },
  { id: 'sage',     name: 'Sage Hill',         type: 'FC Retrieval',     lat: 34.07452, lng: -118.45549, radius: 100,
    items: '', source: 'Master map (magenta star); ConOps: Flight Commander Retrieval' },
  { id: 'cto',      name: 'CTO Court',         type: 'Equipment Pickup', lat: 34.07017, lng: -118.44550, radius: 75,
    items: '', source: 'Master map (cyan star); ConOps: Operation Last-Mile Airdrop' },
  { id: 'sunken',   name: 'Sunken Garden (S)', type: 'Equipment Pickup', lat: 34.07165, lng: -118.43951, radius: 75,
    items: '', source: 'Master map (cyan star); ConOps: Operation Color Run (Sunken Garden South)' },
  { id: 'sculpt',   name: 'Sculpture Garden',  type: 'Equipment Pickup', lat: 34.07549, lng: -118.43938, radius: 75,
    items: '', source: 'Master map (cyan star); ConOps: Operation Interlocked' }
];
function cloneCheckpoints() { return JSON.parse(JSON.stringify(DEFAULT_CHECKPOINTS)); }

/* ---------- PURPOSE of each checkpoint, from "Term I LLAB 9 ConOps AY 26-27" (file 3) ----------
 * HOST / VIEW-ONLY ONLY: this text is never sent to the participants' link.
 * Kept separate from the saved checkpoint data so editing the wording here and redeploying updates every activity. */
const PURPOSES = {
  sunken: {
    place: 'Sunken Garden', label: 'Ammo cans',
    headline: 'Picking up AMMO CANS',
    operation: 'Operation Color Run',
    gets: '4 ammo cans',
    time: '~20 min',
    what: 'Staff playing "local nationals" make the flight do a PT circuit, then a puzzle: move four colour-coded ammo cans between two boxes in the exact order the clues give (carried at a run, a different cadet for each move). Solving it earns the ammo cans.',
    done: 'Puzzle solved in the right order, then the flight leaves carrying the ammo cans.'
  },
  cto: {
    place: 'CTO Court', label: 'Med kits',
    headline: 'Picking up MED KITS',
    operation: 'Operation Last-Mile Airdrop',
    gets: '1 training med kit',
    time: '~20 min',
    what: 'A staff "clinic courier" runs a silent paper-airplane challenge: groups of 4-6 build one plane, one fold each, no talking, then launch it at a 2 m target. When it is done the flight is awarded the med kit.',
    done: 'Every group built and tested a plane with everyone folding; med kit handed over.'
  },
  sculpt: {
    place: 'Sculpture Garden', label: 'Rucks & staffs',
    headline: 'Picking up RUCKSACKS and WOODEN STAFFS',
    operation: 'Operation Interlocked',
    gets: 'rucksacks + wooden (Huebner) staffs',
    time: '~25 min',
    what: 'After a PT circuit, staff playing the "Scubba Tribe" set the "no one left behind" challenge: the whole flight (except the commander, who leads) crosses a course with arms and legs interlocked: 2 minutes to plan, 10 to move. The rucks and staffs are the reward.',
    done: 'Every cadet crosses the finish line still interlocked; rucks and staffs awarded.'
  },
  sage: {
    place: 'Sage Hill', label: 'Rescue Flt/CC',
    headline: 'RESCUING the Flight Commander',
    operation: 'Flight Commander Retrieval',
    gets: 'their Flight Commander + the final base location (Drake Stadium)',
    time: '~25 min',
    what: 'Flights only get sent here after finishing a THIRD equipment stop. Staff playing the commander\'s old training instructor ("OPFOR") put the flight through a 20-minute "perfect" Open Ranks Inspection plus Warrior Knowledge questions. Pass: the commander is released. Fail: the commander is "shot" in a skit but still reveals the final base.',
    done: 'Inspection finished and the commander has told them the final base is Drake Stadium.'
  },
  drake: {
    place: 'Drake Stadium', label: 'Final base',
    headline: 'FINAL BASE: handing in the equipment',
    operation: 'Final FOB, then Mission Debrief',
    gets: 'safe refuge, but only the FIRST 2 flights are let in',
    time: 'debrief 1010-1030',
    what: 'Flights bring EVERYTHING they collected (ammo cans, med kit, ruck, wooden staff) to the guard in exchange for refuge. Capacity is two flights; later flights are turned away. After the mission everyone debriefs here. (Drake Stadium is also where the morning formation starts at 0630.)',
    done: 'All four items handed in (first two flights win); later, the flight debriefs.'
  }
};
const EQUIP_IDS = ['sunken', 'cto', 'sculpt'];

const MISSION_GUIDE = {
  title: 'LLAB 9: Operation Change of Command (20 Nov 2026)',
  sections: [
    { h: 'The story in 30 seconds', items: [
      'The Flight Commanders (Flt/CCs) have been "kidnapped" by pretend enemy staff. Each flight, now led by its Deputy Flight Commander, must get its commander back and reach the final base.',
      'To be let into the final base each flight must carry four items: an ammo can, a med kit, a rucksack and a wooden staff.',
      'The items are held by staff playing "local nationals" at three stations. Flights earn each item by completing a short challenge there.',
      'Only the first 2 flights to reach the final base are let in. The mission is a race as well as a task.'
    ]},
    { h: 'The five stops (what each marker on the map means)', items: [
      'Sunken Garden (S): AMMO CANS (Operation Color Run), about 20 min.',
      'CTO Court: MED KITS (Operation Last-Mile Airdrop), about 20 min.',
      'Sculpture Garden: RUCKSACKS + WOODEN STAFFS (Operation Interlocked), about 25 min.',
      'Sage Hill: RESCUE THE FLIGHT COMMANDER (perfect inspection), about 25 min. Flights are only told about this location after their 3rd equipment stop.',
      'Drake Stadium: FINAL BASE. Hand in all four items. Only 2 flights fit. Also where the mission debrief happens.'
    ]},
    { h: 'What a normal flight looks like on your map', items: [
      'Visits Sunken Garden, CTO Court and Sculpture Garden in any order (all three equipment stops).',
      'Then Sage Hill (rescue), then Drake Stadium (final base).',
      'Fastest walking route is about 65 minutes: CTO, Sunken, Sculpture, Sage Hill, Drake (about 3 miles). Flights are told to double-time between stops, and each stop takes about 20 minutes.',
      'A flight at Sage Hill with fewer than three equipment stops visited, or at Drake without Sage Hill, is out of the expected order. The log flags this in its Purpose line.'
    ]},
    { h: 'Why a flight might be somewhere unexpected', items: [
      'Each flight\'s map shows only 2 of the 3 equipment stops (Alpha and Charlie: Sunken + CTO. Bravo and Delta: Sunken + Sculpture). They must radio other flights to find the third.',
      'Flights that are far ahead of schedule may be redirected by a planned "inject" to Anderson Court, Inverted Fountain or Court of Sciences. Those are not marked on this map.',
      'Some flights contain a planted "mole" who may try to steer them wrong or stall.'
    ]},
    { h: 'Accountability rules for the tracker (Base Command)', items: [
      'Order of precedence: SAFETY, then ACCOUNTABILITY, then MISSION, then TIMELINE.',
      'Flights report their location and destination by radio when moving between stations. Base Command is radio Channel 10 (Flights A to D use Channels 1 to 4).',
      'Base Command (C/Tran, at the SAC) monitors this app, keeps the accountability spreadsheet, and tells the Deputy Flight Commanders about discrepancies, unaccounted-for personnel or flights that cannot be found.'
    ]}
  ],
  timeline: [
    ['0600-0620', 'POC dry run at SAC steps'],
    ['0630-0645', 'Opening formation at Drake Stadium'],
    ['0645-0705', 'Kidnapping skit, then everyone runs to the SAC'],
    ['0705-0730', 'Mission brief in the SAC classrooms; flights get their map and radio'],
    ['0730-0900', 'Equipment pickups (Sunken Garden, CTO Court, Sculpture Garden): about 80-90 min'],
    ['0850-0955', 'Flight Commander retrieval at Sage Hill: about 45-55 min'],
    ['by 1010',   'Final base at Drake Stadium (first 2 flights win)'],
    ['1010-1030', 'Mission debrief at Drake Stadium'],
    ['1040-1050', 'Closing formation and retreat at Drake Stadium']
  ]
};
function purposeShort(id) {
  const p = PURPOSES[id];
  return p ? p.headline + ' (' + p.operation + ')' : '';
}
const MAX_LOG = 3000;

/* ---------- persistence (simple JSON snapshot) ---------- */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const e of raw) {
      events.set(e.id, {
        id: e.id, name: e.name, token: e.token, created: e.created, last: e.last, shared: e.shared === true,
        viewToken: e.viewToken || (dirty = true, crypto.randomBytes(16).toString('hex')),
        checkpoints: Array.isArray(e.checkpoints) ? e.checkpoints : cloneCheckpoints(), log: Array.isArray(e.log) ? e.log : [],
        people: new Map(e.people.map(p => [p.pid, p])), clients: new Set()
      });
    }
  } catch (_) { /* first run */ }
}
function save(sync) {
  if (!dirty) return;
  dirty = false;
  const out = [...events.values()].map(e => ({
    id: e.id, name: e.name, token: e.token, created: e.created, last: e.last, shared: e.shared, viewToken: e.viewToken,
    checkpoints: e.checkpoints, log: e.log,
    people: [...e.people.values()]
  }));
  if (sync) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(out)); } catch (_) {} }
  else fs.writeFile(DATA_FILE, JSON.stringify(out), () => {});
}
load();
setInterval(save, 30000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [id, e] of events) {
    if (now - e.last > EVENT_TTL) { endEvent(e); events.delete(id); dirty = true; }
  }
}, 3600000).unref();

/* ---------- helpers ---------- */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newId() {
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function send(res, type, body, cache) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache || 'no-cache' });
  res.end(body);
}
function readJson(req, cb) {
  let b = '', big = false;
  req.on('data', d => { b += d; if (b.length > 4096) { big = true; req.destroy(); } });
  req.on('end', () => { if (big) return; try { cb(null, JSON.parse(b || '{}')); } catch (e) { cb(e); } });
}
function safeEq(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
/* 'host' = full control, 'viewer' = view-only (same screens, cannot change or end anything), null = no access */
function roleOf(ev, t) {
  if (safeEq(t, ev.token)) return 'host';
  if (safeEq(t, ev.viewToken)) return 'viewer';
  return null;
}
function viewerManifest(id, tok, name) {
  return JSON.stringify({
    name: name ? 'View: ' + name : 'Activity Viewer', short_name: 'Viewer',
    start_url: '/v/' + id + '/' + tok, scope: '/v/' + id + '/', display: 'standalone',
    background_color: '#0f172a', theme_color: '#0f172a', icons: ICONS
  });
}
function tokenOk(ev, t) {
  if (!t || typeof t !== 'string' || t.length !== ev.token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ev.token));
}
function broadcast(ev, type, data, hostOnly) {
  const msg = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of ev.clients) if (!hostOnly || c._host) c.write(msg);
}
function endEvent(ev) {
  broadcast(ev, 'ended', {});
  for (const c of ev.clients) c.end();
  ev.clients.clear();
}
// Checkpoint info (which checkpoint someone is at) is for the host only.
function pub(p, host, ev) {
  const o = { pid: p.pid, name: p.name, lat: p.lat, lng: p.lng, acc: p.acc, ts: p.ts, stopped: !!p.stopped };
  if (host) {
    o.cp = p.cp || null;
    o.lost = !!p.lost;
    o.total = Math.round((p.lg && p.lg.total) || 0);
    o.visits = p.visits || {};
    o.where = ev ? statusText(ev, p, null) : '';
    o.doing = ev ? doingText(ev, p) : '';   // purpose: HOST / VIEW-ONLY ONLY, never in the participant payload
  }
  return o;
}
/* Purpose wording for a checkpoint, adapted to how far through the mission this person is. */
function purposeFor(id, p) {
  if (!PURPOSES[id]) return '';
  const others = Object.keys((p && p.visits) || {}).some(k => k !== id);
  if (id === 'drake' && !others) return 'Start area: the morning formation is held here. It becomes the FINAL BASE once flights have their equipment';
  return purposeShort(id);
}
function doingText(ev, p) {
  if (p.stopped) return '';
  if (p.cp && PURPOSES[p.cp]) return purposeFor(p.cp, p);
  const nc = p.nearCur, pu = nc && PURPOSES[nc.id];
  return pu ? 'Between stops. Nearest: ' + pu.place + ' (' + pu.label.toLowerCase() + ')' : '';
}
/* The "Purpose" line on a log entry, plus a heads-up if the flight seems out of the expected order. */
function purposeNote(ev, p, type, cpId) {
  if (!cpId || !PURPOSES[cpId]) return '';
  let s = purposeFor(cpId, p);
  const vs = p.visits || {};
  const eq = EQUIP_IDS.filter(i => vs[i]).length;
  if (type === 'Arrived') {
    if (cpId === 'sage' && eq < 3) s += '. HEADS UP: only ' + eq + ' of 3 equipment stops visited so far (flights are normally sent here after the third)';
    if (cpId === 'drake' && Object.keys(vs).some(k => k !== 'drake')) {
      const missing = [];
      if (eq < 3) missing.push('only ' + eq + ' of 3 equipment stops visited');
      if (!vs.sage) missing.push('Sage Hill (rescue) not visited');
      s += missing.length ? '. HEADS UP: ' + missing.join('; ') : '. Progress: all 3 equipment stops and the rescue visited';
    }
  }
  return s;
}
function broadcastLoc(ev, p, extra) {
  const mk = host => 'event: loc\ndata: ' + JSON.stringify(Object.assign(pub(p, host, ev), extra)) + '\n\n';
  const h = mk(true), g = mk(false);
  for (const c of ev.clients) c.write(c._host ? h : g);
}
/* Checkpoints as sent to the HOST / VIEW-ONLY screens (includes the purpose text). Never sent to participants. */
function pubCps(ev) {
  return ev.checkpoints.map(c => {
    const pu = PURPOSES[c.id] || {};
    return {
      id: c.id, name: c.name, type: c.type, lat: c.lat, lng: c.lng, radius: c.radius, items: pu.gets || '',
      place: pu.place || c.name, label: pu.label || c.name, headline: pu.headline || '', operation: pu.operation || '',
      gets: pu.gets || '', time: pu.time || '', what: pu.what || '', done: pu.done || ''
    };
  });
}
/* The same, plus the source note, for the spreadsheet's Checkpoints tab. */
function cpFull(ev) {
  return pubCps(ev).map(c => {
    const d = DEFAULT_CHECKPOINTS.find(x => x.id === c.id);
    return Object.assign(c, { source: d ? d.source : '' });
  });
}
/* ---------- accountability log -> Google Sheet (via Apps Script web app) ---------- */
const SHEET_URL = process.env.SHEET_WEBHOOK_URL || '';
const SHEET_SECRET = process.env.SHEET_SECRET || '';
const MOVE_M = 30;            // log a "Moved" row after this many metres
const UPDATE_MS = 300000;     // and an "Update" row at least this often while sharing
const sheetQ = [];
let flushing = false;
function dist(aLat, aLng, bLat, bLng) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function cpName(ev, id) {
  const c = id && ev.checkpoints.find(x => x.id === id);
  return c ? c.name : '';
}
function nearest(ev, lat, lng) {
  let b = null;
  for (const c of ev.checkpoints) {
    const d = dist(c.lat, c.lng, lat, lng);
    if (!b || d < b.d) b = { id: c.id, name: c.name, d };
  }
  return b;
}
/* Human-readable position status: "Arrived at X" / "At X" / "250 m from X (closer by 40 m)" */
function statusText(ev, p, type, checkpoint) {
  if (type === 'Arrived') return 'Arrived at ' + checkpoint;
  const nc = p.nearCur;
  if (p.cp) return 'At ' + cpName(ev, p.cp);
  if (!nc) return '';
  let s = nc.d + ' m from ' + nc.name;
  if (nc.toward > 0) s += ' (closer by ' + nc.toward + ' m)';
  else if (nc.toward < 0) s += ' (farther by ' + (-nc.toward) + ' m)';
  return s;
}
const LOST_MS = Number(process.env.LOST_MS) || 120000;  // no update for this long while "sharing" = "No signal"
function personState(p) { return p.stopped ? 'Stopped' : (p.lost ? 'No signal' : 'Sharing'); }
/* Plain-English sentence for an event (no name; the person has their own column). */
function eventText(type, entry) {
  switch (type) {
    case 'Arrived': return entry.visit > 1 ? 'Arrived at ' + entry.checkpoint + ' again (visit ' + entry.visit + ')' : 'Arrived at ' + entry.checkpoint;
    case 'Left': return 'Left ' + entry.checkpoint;
    case 'Moved': return 'Moved ' + entry.moved + ' m';
    case 'Joined': return 'Started sharing location';
    case 'Resumed': return 'Resumed sharing location';
    case 'Stopped': return 'Stopped sharing location';
    case 'Lost signal': return 'No location update for 2+ minutes';
    case 'Back online': return 'Location updates are back';
    default: return 'Standing still';
  }
}
/* One event -> the in-app log (host panel) AND the spreadsheet queue. checkpointId: the checkpoint it is about. */
function logRow(ev, p, type, moved, checkpointId, tsOverride) {
  const nc = p.nearCur;
  const cpId = checkpointId !== undefined ? checkpointId : p.cp;
  const entry = {
    ts: tsOverride || p.ts || Date.now(), pid: p.pid, person: p.name, type,
    checkpoint: cpName(ev, cpId),
    lat: p.lat, lng: p.lng, acc: p.acc,
    moved: Math.round(moved || 0), total: Math.round((p.lg && p.lg.total) || 0),
    nearest: nc ? nc.name : '', nearDist: nc ? nc.d : null, toward: nc ? nc.toward : null
  };
  if (type === 'Arrived') entry.visit = (p.visits && p.visits[cpId] && p.visits[cpId].count) || 1;
  entry.status = statusText(ev, p, type, entry.checkpoint);
  entry.purpose = purposeNote(ev, p, type, cpId);   // host / view-only only (the log is never sent to participants)
  entry.text = eventText(type, entry);
  entry.state = type === 'Stopped' ? 'Stopped' : (type === 'Lost signal' ? 'No signal' : 'Sharing');
  ev.log.push(entry);
  if (ev.log.length > MAX_LOG) ev.log.splice(0, ev.log.length - MAX_LOG);
  broadcast(ev, 'log', entry, true);
  if (!SHEET_URL) return;
  // for the spreadsheet's per-person board: the first arrival time at every checkpoint, in checkpoint order
  const visits = ev.checkpoints.map(c => {
    const v = p.visits && p.visits[c.id], pu = PURPOSES[c.id];
    return { name: c.name, label: pu ? pu.label + ' @ ' + pu.place : c.name, first: v ? new Date(v.first).toISOString() : null };
  });
  sheetQ.push(Object.assign({}, entry, {
    ts: new Date(entry.ts).toISOString(), lastSeen: new Date(p.ts || entry.ts).toISOString(),
    activity: ev.name, activityId: ev.id, visits, doing: doingText(ev, p)
  }));
  if (sheetQ.length > 5000) sheetQ.splice(0, sheetQ.length - 5000);
}
/* "No signal" watchdog: a person who is sharing but silent for LOST_MS gets flagged once, until updates resume. */
setInterval(() => {
  const now = Date.now();
  for (const ev of events.values()) {
    for (const p of ev.people.values()) {
      if (p.stopped || p.lost || p.lat === undefined || !p.ts) continue;
      if (now - p.ts > LOST_MS && now - p.ts < 6 * 3600000) {
        p.lost = true; dirty = true;
        logRow(ev, p, 'Lost signal', 0, p.cp, now);
        broadcastLoc(ev, p, { pt: false, now });
      }
    }
  }
}, 15000).unref();
/* Which checkpoint is this position in? Leaving needs 15% extra distance so GPS jitter at the edge doesn't flap. */
function cpAt(ev, p, lat, lng) {
  const cur = p.cp && ev.checkpoints.find(c => c.id === p.cp);
  if (cur && dist(cur.lat, cur.lng, lat, lng) <= cur.radius * 1.15) return cur.id;
  let best = null, bd = Infinity;
  for (const c of ev.checkpoints) {
    const d = dist(c.lat, c.lng, lat, lng);
    if (d <= c.radius && d < bd) { best = c.id; bd = d; }
  }
  return best;
}
async function postSheet(payload) {
  const r = await fetch(SHEET_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ secret: SHEET_SECRET }, payload)), redirect: 'follow'
  });
  const txt = await r.text();
  if (!r.ok || !/"ok"\s*:\s*true/.test(txt)) throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 120));
}
/* Send the checkpoint reference table (names, types, items, positions) to the sheet's "Checkpoints" tab. */
const cpTimers = new Map();
function syncCheckpointsToSheet(ev) {
  if (!SHEET_URL) return;
  clearTimeout(cpTimers.get(ev.id));
  cpTimers.set(ev.id, setTimeout(() => {
    postSheet({ action: 'checkpoints', activity: ev.name, activityId: ev.id, checkpoints: cpFull(ev), guide: MISSION_GUIDE })
      .catch(e => { console.log('Checkpoint table sync failed, retrying in 60s:', e.message); cpTimers.set(ev.id, setTimeout(() => syncCheckpointsToSheet(ev), 60000)); });
  }, 3000));
}
async function flushSheet() {
  if (!SHEET_URL || flushing || !sheetQ.length) return;
  flushing = true;
  const batch = sheetQ.splice(0, 200);
  try {
    await postSheet({ rows: batch });
  } catch (e) {
    sheetQ.unshift(...batch); // keep rows and retry next round
    console.log('Sheet log failed, will retry:', e.message);
  }
  flushing = false;
}
if (SHEET_URL) { setInterval(flushSheet, 15000).unref(); console.log('Logging to Google Sheet is ON'); }

const createLog = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (createLog.get(ip) || []).filter(t => now - t < 3600000);
  if (arr.length >= 30) { createLog.set(ip, arr); return true; }
  arr.push(now); createLog.set(ip, arr); return false;
}

/* ---------- icons (generated PNGs, no files needed) ---------- */
const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const iconCache = {};
function icon(size) {
  if (iconCache[size]) return iconCache[size];
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const c0 = size / 2;
  const layers = [[0.30, [255, 255, 255]], [0.22, [59, 130, 246]], [0.09, [255, 255, 255]]];
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      let c = [15, 23, 42];
      const d = Math.hypot(x + 0.5 - c0, y + 0.5 - c0);
      for (const [r, col] of layers) {
        const cov = Math.min(1, Math.max(0, r * size - d + 0.5));
        c = [c[0] * (1 - cov) + col[0] * cov, c[1] * (1 - cov) + col[1] * cov, c[2] * (1 - cov) + col[2] * cov];
      }
      const o = y * stride + 1 + x * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
  return (iconCache[size] = png);
}

/* ---------- manifests + service worker ---------- */
const ICONS = [
  { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
  { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
];
const HOST_MANIFEST = JSON.stringify({
  name: 'Activity Tracker (Host)', short_name: 'Host Map', start_url: '/', scope: '/',
  display: 'standalone', background_color: '#0f172a', theme_color: '#0f172a', icons: ICONS
});
function joinManifest(id, name) {
  return JSON.stringify({
    name: name ? 'Share location: ' + name : 'Share location', short_name: 'Share Location',
    start_url: '/e/' + id, scope: '/e/' + id, display: 'standalone',
    background_color: '#0f172a', theme_color: '#0f172a', icons: ICONS
  });
}
const SW = String.raw`
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e){
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  if (u.pathname.indexOf('/api/') === 0) return;
  var ok = u.origin === self.location.origin || u.hostname === 'unpkg.com';
  e.respondWith(fetch(r).then(function(resp){
    if (ok && resp && (resp.ok || resp.type === 'opaque')) {
      var c = resp.clone();
      caches.open('at-v1').then(function(ca){ ca.put(r, c); }).catch(function(){});
    }
    return resp;
  }).catch(function(){ return caches.match(r); }));
});
`;

const BASE_CSS = String.raw`
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%;margin:0;background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
button,input{font:inherit}
`;

/* ================= HOST PAGE ================= */
const HOST_HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Activity Tracker - Host</title>
<meta name="theme-color" content="#0f172a">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
${BASE_CSS}
#map{position:absolute;inset:0}
.hidden{display:none!important}
#create{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:14px;text-align:center}
#create h1{margin:0;font-size:26px}
#create p{margin:0;color:#94a3b8;max-width:340px}
.in{width:100%;max-width:340px;padding:14px;border-radius:12px;border:1px solid #334155;background:#1e293b;color:#fff;font-size:17px}
.btn{padding:12px 18px;border-radius:12px;border:0;background:#3b82f6;color:#fff;font-weight:600;font-size:16px;cursor:pointer}
.btn.sec{background:#1e293b;border:1px solid #334155;color:#e2e8f0}
.btn.sm{padding:8px 12px;font-size:14px;border-radius:10px}
.btn.danger{background:#7f1d1d}
#past{max-width:340px;width:100%;display:flex;flex-direction:column;gap:8px}
#bar{position:absolute;top:0;left:0;right:0;z-index:1000;padding:calc(env(safe-area-inset-top) + 8px) 10px 20px;background:linear-gradient(#0f172aee,#0f172a00);display:flex;flex-wrap:wrap;gap:8px;align-items:center;pointer-events:none}
#bar>*{pointer-events:auto}
#title{font-weight:700;font-size:16px;flex:1 1 100%;display:flex;align-items:center;gap:8px}
#dot{width:9px;height:9px;border-radius:50%;background:#22c55e;display:inline-block}
#dot.off{background:#ef4444}
.pc{padding:10px 10px 11px;border-top:1px solid #1e293b;cursor:pointer;border-left:4px solid transparent}
.pc.lost{border-left-color:#f97316;background:#431407aa}
.pc.at{border-left-color:#22c55e}
.pc.enroute{border-left-color:#38bdf8}
.pc.stopped{border-left-color:#64748b;opacity:.7}
.pc .pt{display:flex;align-items:center;gap:8px}
.pc .c{width:14px;height:14px;border-radius:50%;flex:none}
.pc .n{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700;font-size:16px}
.pc .bd{flex:none;font-size:12.5px;font-weight:700;padding:2px 9px;border-radius:10px;background:#334155}
.pc.at .bd{background:#166534;color:#dcfce7}.pc.enroute .bd{background:#075985;color:#e0f2fe}.pc.lost .bd{background:#c2410c;color:#fff}
.pc .pw{font-size:13px;color:#94a3b8;margin:3px 0 0 22px}
.pc .chips{display:flex;flex-wrap:wrap;gap:5px;margin:7px 0 0 22px}
.chip{font-size:11.5px;padding:2px 8px;border-radius:9px;border:1px solid #334155;color:#64748b}
.chip.done{background:#14532d;border-color:#166534;color:#bbf7d0;font-weight:600}
.chip.here{outline:2px solid #4ade80}
#sheet{position:absolute;left:0;right:0;bottom:0;z-index:1000;background:#0f172af2;border-radius:18px 18px 0 0;max-height:52vh;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom)}
#sheet.min #list{display:none}
#sh{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;cursor:pointer;font-weight:600}
#list{overflow:auto;padding:0 8px 8px}
.row{display:flex;align-items:center;gap:10px;padding:10px 8px;border-top:1px solid #1e293b;cursor:pointer}
.row .c{width:14px;height:14px;border-radius:50%;flex:none}
.row .n{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.row .t{font-size:13px;color:#94a3b8;flex:none}
.row.stale .n{color:#94a3b8}
.empty{padding:14px 10px;color:#94a3b8;font-size:14px}
.mk .pin{position:absolute;width:30px;height:30px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:#fff;font:700 13px system-ui;transform:translate(-50%,-50%)}
.mk .lbl{position:absolute;transform:translate(-50%,0);top:18px;white-space:nowrap;background:rgba(15,23,42,.88);color:#fff;font:600 11px system-ui;padding:1px 6px;border-radius:8px}
.mk.stale .pin{filter:grayscale(1);opacity:.65}
.mk.stale .lbl{opacity:.75}
.cpmk{background:none;border:0}
.cpmk .cplbl{position:absolute;left:50%;top:32px;transform:translateX(-50%);white-space:nowrap;background:rgba(15,23,42,.9);color:#fff;font:700 11px system-ui;padding:1px 6px;border-radius:8px}
.cpmk svg{display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))}
#vbadge{font-size:11px;font-weight:800;letter-spacing:.04em;padding:2px 8px;border-radius:8px;background:#0369a1;color:#e0f2fe}
#smenu{position:fixed;z-index:2600;top:calc(env(safe-area-inset-top) + 64px);left:10px;right:10px;max-width:440px;background:#0f172a;border:1px solid #334155;border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:14px;box-shadow:0 12px 40px rgba(0,0,0,.6)}
#smenu .mi{display:flex;flex-direction:column;gap:7px;align-items:flex-start}
#smenu .mi b{font-size:16px}
#smenu .mi span{font-size:13px;color:#94a3b8;line-height:1.4}
.cpop{font:14px system-ui;min-width:170px;color:#0f172a}
.cpop b{font-size:15px}.cpop .m{color:#475569;font-size:13px;margin-top:2px}
.cpop input{width:80px;padding:5px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px}
.cpop button{margin-left:6px;padding:5px 10px;border:0;border-radius:6px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
#logp{position:absolute;inset:0;z-index:3000;background:#0f172a;display:flex;flex-direction:column;padding-top:env(safe-area-inset-top)}
#logh{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px;border-bottom:1px solid #1e293b}
#logh b{font-size:17px;flex:1 1 auto}
#logf{padding:7px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:14px}
#logcsv{text-decoration:none;display:inline-block}
#logl{flex:1;overflow:auto;padding-bottom:env(safe-area-inset-bottom)}
.le{padding:10px 14px;border-bottom:1px solid #1e293b;font-size:15px;line-height:1.35}
.le .a{color:#94a3b8;font-size:12.5px;margin-top:2px}
.le .st{color:#7dd3fc;font-size:14px;margin-top:3px;font-weight:600}.le .st.at{color:#4ade80}
.le .pur{margin-top:4px;font-size:13.5px;color:#e2e8f0;background:#1e293b;border-left:3px solid #a78bfa;padding:5px 9px;border-radius:0 8px 8px 0;line-height:1.35}
.le .pur b{color:#c4b5fd}.le .pur.warn{border-left-color:#f97316;background:#431407}.le .pur.warn b{color:#fdba74}
.pc .pdo{margin:5px 0 0 22px;font-size:13px;color:#ddd6fe;font-weight:600}
.cpop .pup{margin-top:8px;padding-top:7px;border-top:1px solid #e2e8f0}.cpop .ph{font-weight:800;font-size:14px;color:#5b21b6}
#guidep{position:absolute;inset:0;z-index:3000;background:#0f172a;display:flex;flex-direction:column;padding-top:env(safe-area-inset-top)}
#guideh{display:flex;gap:8px;align-items:center;padding:12px;border-bottom:1px solid #1e293b}
#guideh b{flex:1;font-size:17px}
#guideb{flex:1;overflow:auto;padding:4px 14px 30px;line-height:1.45}
#guideb h3{margin:18px 0 6px;font-size:16px;color:#c4b5fd}
#guideb ul{margin:0;padding-left:20px}#guideb li{margin:5px 0;font-size:15px}
#guideb .tl{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #1e293b;font-size:15px}
#guideb .tl span:first-child{flex:none;width:84px;font-weight:700;color:#7dd3fc}
.le .tag{display:inline-block;font-size:12px;font-weight:700;padding:1px 7px;border-radius:8px;margin-right:6px;background:#334155;color:#e2e8f0}
.le .tag.Lostsignal{background:#9a3412;color:#ffedd5}.le .tag.Backonline{background:#1e40af;color:#dbeafe}
.le .tag.Arrived{background:#166534;color:#dcfce7}.le .tag.Left{background:#92400e;color:#fef3c7}.le .tag.Stopped{background:#7f1d1d;color:#fee2e2}
#toast{position:absolute;left:50%;top:90px;transform:translateX(-50%);z-index:2000;background:#111827;color:#fff;padding:8px 14px;border-radius:10px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.on{opacity:1}
</style>
</head><body>
<div id="create" class="hidden">
  <h1>Activity Tracker</h1>
  <p>Create an activity, share the link, and watch everyone who taps "Share location" appear live on the map.</p>
  <input id="newname" class="in" placeholder="Activity name (e.g. Saturday hike)" maxlength="60">
  <label style="display:flex;gap:10px;align-items:flex-start;max-width:340px;text-align:left;color:#cbd5e1;font-size:15px"><input id="shared" type="checkbox" checked style="margin-top:3px;width:18px;height:18px"><span>Let people see each other on the map (they can only see others while they are sharing too)</span></label>
  <button id="mk" class="btn">Create activity</button>
  <div id="past"></div>
</div>
<div id="app" class="hidden">
  <div id="map"></div>
  <div id="bar">
    <div id="title"><span id="dot" class="off"></span><span id="tname">Activity</span><span id="vbadge" class="hidden">VIEW ONLY</span><span id="cnt" style="font-weight:400;color:#94a3b8"></span></div>
    <button id="share" class="btn sm">Share &#9662;</button>
    <button id="fit" class="btn sm sec">Fit all</button>
    <button id="trails" class="btn sm sec">Trails: on</button>
    <button id="logbtn" class="btn sm">Log</button>
    <button id="guidebtn" class="btn sm sec">Guide</button>
    <button id="spots" class="btn sm sec">Edit spots: off</button>
    <button id="end" class="btn sm danger">End</button>
  </div>
  <div id="sheet">
    <div id="sh"><span id="shl">People</span><span id="chev">&#9662;</span></div>
    <div id="list"></div>
  </div>
  <div id="guidep" class="hidden">
    <div id="guideh"><b id="guidet">Mission guide</b><button id="guidex" class="btn sm">Close</button></div>
    <div id="guideb"></div>
  </div>
  <div id="smenu" class="hidden">
    <div class="mi">
      <b>Link for your group</b>
      <span>Everyone you send this to taps one button to share their location.</span>
      <button id="sharep" class="btn sm">Share group link</button>
    </div>
    <div class="mi">
      <b>View-only link</b>
      <span>Shows this exact map, roster and log on another phone, but can't change or end anything. It reveals everyone's live location, so only send it to people you trust.</span>
      <button id="sharev" class="btn sm">Share view-only link</button>
      <button id="newv" class="btn sm sec">Make a new view-only link (old one stops working)</button>
    </div>
    <button id="smx" class="btn sm sec">Close</button>
  </div>
  <div id="logp" class="hidden">
    <div id="logh">
      <b>Activity log <span id="logn" style="font-weight:400;color:#94a3b8;font-size:14px"></span></b>
      <select id="logperson"><option value="">Everyone</option></select>
      <select id="logf"><option value="all">All events</option><option value="cp">Checkpoints only</option><option value="problems">Problems (no signal / stopped)</option></select>
      <a id="logcsv" class="btn sm sec" href="#">Download CSV</a>
      <button id="logx" class="btn sm">Close</button>
    </div>
    <div id="logl"></div>
  </div>
  <div id="toast"></div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function color(pid){var h=0;for(var i=0;i<pid.length;i++)h=(h*31+pid.charCodeAt(i))>>>0;return 'hsl('+(h%360)+',70%,45%)'}
var skew=0;
function age(ts){return Math.max(0,Math.round((Date.now()+skew-ts)/1000))}
function agoTxt(s){if(s<60)return s+'s ago';var m=Math.round(s/60);if(m<60)return m+'m ago';return Math.round(m/60)+'h ago'}
function toast(t){var e=$('toast');e.textContent=t;e.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(function(){e.classList.remove('on')},2200)}
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(function(){});

var ev=null, map=null, people={}, es=null, showTrails=true, fitted=false, drawn=false;
function lsGet(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}

// /v/<id>/<token> = view-only link: same screens as the host, but nothing can be changed or ended
var VIEW=location.pathname.match(/^\/v\/([a-z2-9]{8})\/([0-9a-f]{32})\/?$/);
function viewerFail(msg){
  document.body.innerHTML='<div style="min-height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:28px;font:17px system-ui;color:#e2e8f0;background:#0f172a">'+(msg||'This view-only link is no longer valid. The activity may have ended or the host made a new link. Ask the host for the current one.')+'</div>';
}
function remember(e){
  if(VIEW)return;
  lsSet('at_current',e);
  var list=lsGet('at_events',[]).filter(function(x){return x.id!==e.id});
  list.unshift(e); lsSet('at_events',list.slice(0,10));
}
function forget(id){
  if(VIEW)return;
  var list=lsGet('at_events',[]).filter(function(x){return x.id!==id});
  lsSet('at_events',list);
  var c=lsGet('at_current',null); if(c&&c.id===id)lsSet('at_current',null);
}

function parseHash(){
  var h=location.hash.replace(/^#/,''); if(!h)return null;
  var o={}; h.split('&').forEach(function(p){var kv=p.split('=');o[kv[0]]=decodeURIComponent(kv[1]||'')});
  return o.id&&o.t?{id:o.id,token:o.t,name:o.n||''}:null;
}

function showCreate(){
  $('app').classList.add('hidden'); $('create').classList.remove('hidden');
  var past=lsGet('at_events',[]), box=$('past'); box.innerHTML='';
  if(past.length){
    var h=document.createElement('div'); h.style.cssText='color:#94a3b8;font-size:13px;margin-top:8px'; h.textContent='Your recent activities'; box.appendChild(h);
    past.forEach(function(e){
      var b=document.createElement('button'); b.className='btn sec'; b.textContent=e.name||e.id;
      b.onclick=function(){open(e)}; box.appendChild(b);
    });
  }
}
$('mk').onclick=function(){
  var name=$('newname').value.trim()||'Activity';
  $('mk').disabled=true;
  fetch('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,shared:$('shared').checked})})
  .then(function(r){if(!r.ok)throw 0;return r.json()})
  .then(function(d){open({id:d.id,token:d.token,name:name})})
  .catch(function(){toast('Could not create activity');$('mk').disabled=false});
};

function open(e){
  ev=e; remember(e);
  if(!VIEW)history.replaceState(null,'','#id='+e.id+'&t='+e.token+'&n='+encodeURIComponent(e.name||''));
  $('create').classList.add('hidden'); $('app').classList.remove('hidden');
  $('tname').textContent=e.name||'Activity';
  initMap();
  fetch('/api/e/'+e.id+'?t='+e.token).then(function(r){return r.ok?r.json():Promise.reject()}).then(function(d){
    if(VIEW){if(!d.viewer)return viewerFail()}
    else if(!d.host){toast('Host link invalid');forget(e.id);return showCreate()}
    $('tname').textContent=d.name; ev.name=d.name; if(d.viewToken)ev.viewToken=d.viewToken; remember(ev); connect();
  }).catch(function(){if(VIEW)return viewerFail();toast('Activity not found');forget(e.id);showCreate()});
}

function initMap(){
  if(map){setTimeout(function(){map.invalidateSize()},50);return}
  map=L.map('map',{zoomControl:false,attributionControl:true}).setView([20,0],2);
  L.control.zoom({position:'topright'}).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
}

function stateOf(p){return p.stopped?'stopped':(age(p.ts)>90?'stale':'live')}
function iconFor(p){
  var st=stateOf(p), ini=esc((p.name||'?').trim().charAt(0).toUpperCase()||'?');
  var html='<div class="pin" style="background:'+color(p.pid)+'">'+ini+'</div><div class="lbl">'+esc(p.name)+(st==='stopped'?' (stopped)':'')+'</div>';
  return L.divIcon({className:'mk'+(st!=='live'?' stale':''),html:html,iconSize:[0,0]});
}
function upsert(d,appendPt,trail){
  var p=people[d.pid];
  if(!p){p=people[d.pid]={pid:d.pid,trail:trail||[]};
    p.marker=L.marker([d.lat,d.lng],{icon:iconFor(d)}).addTo(map);
    p.line=L.polyline(p.trail,{color:color(d.pid),weight:4,opacity:.7});
    if(showTrails)p.line.addTo(map);
  } else if(trail){p.trail=trail;p.line.setLatLngs(trail)}
  p.name=d.name;p.lat=d.lat;p.lng=d.lng;p.acc=d.acc;p.ts=d.ts;p.stopped=d.stopped;p.cp=d.cp||null;p.lost=!!d.lost;p.visits=d.visits||{};p.where=d.where||'';p.total=d.total||0;p.doing=d.doing||'';
  if(appendPt){p.trail.push([d.lat,d.lng]);if(p.trail.length>MAXT)p.trail.shift();p.line.setLatLngs(p.trail)}
  p.marker.setLatLng([d.lat,d.lng]); p.marker.setIcon(iconFor(p));
}
var MAXT=300;

/* ---- checkpoints (stars + radius circles) ---- */
var CPCOL={'Equipment Pickup':'#22d3ee','FC Retrieval':'#ec4899','FOB Securement':'#fb923c'};
var cpObjs={}, cpData=[], editMode=false;
function cpNameOf(id){for(var i=0;i<cpData.length;i++)if(cpData[i].id===id)return cpData[i].name;return ''}
function starIcon(c){
  var pts=[];for(var i=0;i<14;i++){var r=i%2?7:15,a=-Math.PI/2+i*Math.PI/7;pts.push((17+r*Math.cos(a)).toFixed(1)+','+(17+r*Math.sin(a)).toFixed(1))}
  var svg='<svg width="34" height="34" viewBox="0 0 34 34"><polygon points="'+pts.join(' ')+'" fill="'+(CPCOL[c.type]||'#fff')+'" stroke="#fff" stroke-width="1.5"/></svg>';
  return L.divIcon({className:'cpmk',html:svg+'<div class="cplbl">'+esc(c.name)+'</div>',iconSize:[34,34],iconAnchor:[17,17]});
}
function postCp(body){
  body.id=body.id;
  fetch('/api/e/'+ev.id+'/checkpoints?t='+ev.token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){if(!r.ok)throw 0;toast('Checkpoint saved')}).catch(function(){toast('Could not save checkpoint')});
}
function cpPopup(c){
  var d=document.createElement('div');d.className='cpop';
  var b=document.createElement('b');b.textContent=c.name;d.appendChild(b);
  var t=document.createElement('div');t.className='m';t.textContent=c.type+' · radius '+c.radius+' m';d.appendChild(t);
  if(c.headline){
    var pu=document.createElement('div');pu.className='pup';
    function line(k,v){if(!v)return;var r=document.createElement('div');r.className='m';var s=document.createElement('b');s.textContent=k+' ';s.style.fontSize='13px';r.appendChild(s);r.appendChild(document.createTextNode(v));pu.appendChild(r)}
    var hd=document.createElement('div');hd.className='ph';hd.textContent=c.headline;pu.appendChild(hd);
    line('Activity:',c.operation);line('What happens:',c.what);line('They receive:',c.gets);line('Time:',c.time);line('Done when:',c.done);
    d.appendChild(pu);
  }
  if(editMode){
    var w=document.createElement('div');w.style.marginTop='8px';
    var inp=document.createElement('input');inp.type='number';inp.min=10;inp.max=1000;inp.value=c.radius;
    var sv=document.createElement('button');sv.textContent='Set radius (m)';
    sv.onclick=function(){postCp({id:c.id,radius:Number(inp.value)})};
    w.appendChild(inp);w.appendChild(sv);d.appendChild(w);
    var h=document.createElement('div');h.className='m';h.textContent='Drag the star to move it.';d.appendChild(h);
  }
  return d;
}
function drawCps(list){
  if(!map)return;
  cpData=list||cpData;
  Object.keys(cpObjs).forEach(function(k){map.removeLayer(cpObjs[k].m);map.removeLayer(cpObjs[k].c)});
  cpObjs={};
  cpData.forEach(function(c){
    var col=CPCOL[c.type]||'#fff';
    var circ=L.circle([c.lat,c.lng],{radius:c.radius,color:col,weight:2,opacity:.9,fillOpacity:.12,interactive:false}).addTo(map);
    var mk=L.marker([c.lat,c.lng],{icon:starIcon(c),draggable:editMode,zIndexOffset:-500}).addTo(map);
    mk.bindPopup(function(){return cpPopup(c)});
    mk.on('drag',function(e){circ.setLatLng(e.latlng)});
    mk.on('dragend',function(){var ll=mk.getLatLng();postCp({id:c.id,lat:ll.lat,lng:ll.lng})});
    cpObjs[c.id]={m:mk,c:circ};
  });
}

/* ---- in-app log ---- */
var logData=[];
function fmtT(ts){return new Date(ts).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function logText(e){
  switch(e.type){
    case 'Arrived':return e.visit>1?'arrived at '+e.checkpoint+' again (visit '+e.visit+')':'arrived at '+e.checkpoint;
    case 'Left':return 'left '+e.checkpoint;
    case 'Moved':return 'moved '+e.moved+' m'+(e.checkpoint?' (at '+e.checkpoint+')':'');
    case 'Joined':return 'started sharing'+(e.checkpoint?' (at '+e.checkpoint+')':'');
    case 'Resumed':return 'resumed sharing'+(e.checkpoint?' (at '+e.checkpoint+')':'');
    case 'Lost signal':return 'has no signal (no update for 2+ min)';
    case 'Back online':return 'is back online';
    case 'Stopped':return 'stopped sharing'+(e.checkpoint?' (at '+e.checkpoint+')':'');
    default:return 'still here'+(e.checkpoint?' at '+e.checkpoint:'');
  }
}
function renderLog(){
  if($('logp').classList.contains('hidden'))return;
  fillPeople();
  var f=$('logf').value,who=$('logperson').value;
  var rows=logData.filter(function(e){
    if(who&&e.pid!==who)return false;
    if(f==='cp')return e.type==='Arrived'||e.type==='Left';
    if(f==='problems')return e.type==='Lost signal'||e.type==='Back online'||e.type==='Stopped';
    return true;
  });
  $('logn').textContent='('+rows.length+')';
  var box=$('logl');box.innerHTML='';
  if(!rows.length){var em=document.createElement('div');em.className='empty';em.textContent='Nothing logged yet.';box.appendChild(em);return}
  for(var i=rows.length-1,n=0;i>=0&&n<500;i--,n++){
    var e=rows[i],d=document.createElement('div');d.className='le';
    var tg=document.createElement('span');tg.className='tag '+e.type.replace(/ /g,'');tg.textContent=e.type==='Update'?'Here':e.type;
    var b=document.createElement('b');b.textContent=e.person;
    d.appendChild(tg);d.appendChild(b);d.appendChild(document.createTextNode(' '+logText(e)));
    if(e.status){var st=document.createElement('div');st.className='st'+(e.type==='Arrived'||/^At /.test(e.status)?' at':'');st.textContent=e.status;d.appendChild(st)}
    if(e.purpose){var pr=document.createElement('div');pr.className='pur'+(/HEADS UP/.test(e.purpose)?' warn':'');var pl=document.createElement('b');pl.textContent='Purpose: ';pr.appendChild(pl);pr.appendChild(document.createTextNode(e.purpose));d.appendChild(pr)}
    var a=document.createElement('div');a.className='a';
    a.textContent=fmtT(e.ts)+' ('+agoTxt(age(e.ts))+') · walked '+e.total+' m total'+(e.acc?' · ±'+e.acc+' m':'');
    d.appendChild(a);box.appendChild(d);
  }
}
function pushLog(e){
  for(var i=logData.length-1;i>=0&&i>=logData.length-30;i--){var x=logData[i];if(x.ts===e.ts&&x.pid===e.pid&&x.type===e.type&&x.checkpoint===e.checkpoint)return}
  logData.push(e);if(logData.length>3000)logData.shift();renderLog();
}
function loadLog(){
  fetch('/api/e/'+ev.id+'/log?t='+ev.token).then(function(r){return r.json()}).then(function(d){logData=d.log||[];renderLog()}).catch(function(){});
}
$('logbtn').onclick=function(){
  $('logcsv').href='/api/e/'+ev.id+'/log?format=csv&t='+ev.token;
  $('logp').classList.remove('hidden');loadLog();
};
$('logx').onclick=function(){$('logp').classList.add('hidden')};

/* ---- mission guide (host / view-only only) ---- */
var guide=null;
function renderGuide(){
  var box=$('guideb');box.innerHTML='';
  if(!guide){box.textContent='The guide is not available yet.';return}
  $('guidet').textContent=guide.title||'Mission guide';
  (guide.sections||[]).forEach(function(s){
    var h=document.createElement('h3');h.textContent=s.h;box.appendChild(h);
    var ul=document.createElement('ul');(s.items||[]).forEach(function(t){var li=document.createElement('li');li.textContent=t;ul.appendChild(li)});box.appendChild(ul);
  });
  var h2=document.createElement('h3');h2.textContent='Timeline (20 Nov)';box.appendChild(h2);
  (guide.timeline||[]).forEach(function(r){var d=document.createElement('div');d.className='tl';var a=document.createElement('span');a.textContent=r[0];var b=document.createElement('span');b.textContent=r[1];d.appendChild(a);d.appendChild(b);box.appendChild(d)});
  var h3=document.createElement('h3');h3.textContent='Tip';box.appendChild(h3);
  var tp=document.createElement('div');tp.textContent='Tap any star on the map to see what happens at that stop. Each person’s card, and every log entry, shows their current purpose.';box.appendChild(tp);
}
$('guidebtn').onclick=function(){renderGuide();$('guidep').classList.remove('hidden')};
$('guidex').onclick=function(){$('guidep').classList.add('hidden')};
$('logf').onchange=renderLog;
$('logperson').onchange=renderLog;
function fillPeople(){
  var sel=$('logperson'),cur=sel.value,seen={},names=[];
  logData.forEach(function(e){if(!seen[e.pid]){seen[e.pid]=1}seen[e.pid]=e.person});
  Object.keys(seen).forEach(function(pid){names.push([pid,seen[pid]])});
  names.sort(function(a,b){return String(a[1]).localeCompare(String(b[1]))});
  if(sel.options.length===names.length+1)return;
  sel.innerHTML='';var o=document.createElement('option');o.value='';o.textContent='Everyone';sel.appendChild(o);
  names.forEach(function(x){var op=document.createElement('option');op.value=x[0];op.textContent=x[1];sel.appendChild(op)});
  sel.value=cur;
}
$('spots').onclick=function(){
  editMode=!editMode;$('spots').textContent='Edit spots: '+(editMode?'on':'off');
  if(map)map.closePopup();drawCps();
  if(editMode)toast('Drag a star to its exact spot. Tap it to set the radius.');
};

function connect(){
  if(es)es.close();
  es=new EventSource('/api/e/'+ev.id+'/stream?t='+ev.token);
  es.onopen=function(){$('dot').className=''};
  es.onerror=function(){$('dot').className='off'};
  es.addEventListener('snapshot',function(m){
    var d=JSON.parse(m.data); skew=d.now-Date.now();
    $('tname').textContent=d.name;
    Object.keys(people).forEach(function(k){map.removeLayer(people[k].marker);map.removeLayer(people[k].line);delete people[k]});
    d.people.forEach(function(p){upsert(p,false,p.trail||[])});
    drawCps(d.checkpoints);loadLog();guide=d.guide||guide;
    if(!fitted&&d.people.length){fit();fitted=true}
    else if(!fitted&&cpData.length){map.fitBounds(cpData.map(function(c){return [c.lat,c.lng]}),{padding:[70,70],maxZoom:17})}
    render();
  });
  es.addEventListener('cps',function(m){drawCps(JSON.parse(m.data).checkpoints)});
  es.addEventListener('log',function(m){
    var e=JSON.parse(m.data);pushLog(e);
    if(e.type==='Arrived')toast(e.person+' arrived at '+e.checkpoint);
    else if(e.type==='Left')toast(e.person+' left '+e.checkpoint);
    else if(e.type==='Lost signal')toast('⚠ '+e.person+' has no signal');
    else if(e.type==='Back online')toast(e.person+' is back online');
  });
  es.addEventListener('loc',function(m){
    var d=JSON.parse(m.data); skew=d.now-Date.now();
    var first=!people[d.pid]; upsert(d,d.pt,null);
    if(!fitted){fit();fitted=true}
    else if(first)toast(d.name+' joined');
    render();
  });
  es.addEventListener('ended',function(){es.close();toast('Activity ended');forget(ev.id)});
  es.addEventListener('revoked',function(){es.close();viewerFail('The host replaced this view-only link. Ask them for the new one.')});
}

function fit(){
  var pts=Object.keys(people).filter(function(k){return !people[k].stopped}).map(function(k){return [people[k].lat,people[k].lng]});
  if(!pts.length)pts=Object.keys(people).map(function(k){return [people[k].lat,people[k].lng]});
  if(!pts.length)return;
  if(pts.length===1)map.setView(pts[0],17);
  else map.fitBounds(pts,{padding:[70,70],maxZoom:17});
}

var rq=0;
function render(){ if(rq)return; rq=requestAnimationFrame(function(){rq=0;draw()}) }
var LOSTS=120;
function pstate(p){if(p.stopped)return 'stopped';if(p.lost||age(p.ts)>LOSTS)return 'lost';return p.cp?'at':'enroute'}
function draw(){
  var ids=Object.keys(people),rank={lost:0,at:1,enroute:1,stopped:2},n={at:0,enroute:0,lost:0,stopped:0};
  ids.forEach(function(k){n[pstate(people[k])]++});
  // problems first, finished last, everyone else A-Z (stable, so the list doesn't jump around)
  ids.sort(function(a,b){var A=people[a],B=people[b];return (rank[pstate(A)]-rank[pstate(B)])||String(A.name).localeCompare(String(B.name))});
  $('cnt').textContent=' · '+(n.at+n.enroute)+' live'+(n.lost?' · '+n.lost+' no signal':'');
  $('shl').textContent=ids.length+' people'+(n.at?' · '+n.at+' at a checkpoint':'')+(n.lost?' · '+n.lost+' NO SIGNAL':'');
  var box=$('list'); box.innerHTML='';
  if(!ids.length){var e=document.createElement('div');e.className='empty';e.textContent='Nobody yet. Tap "Share link" and send it to your group.';box.appendChild(e)}
  ids.forEach(function(k){
    var p=people[k],st=pstate(p);
    var r=document.createElement('div');r.className='pc '+st;
    var top=document.createElement('div');top.className='pt';
    var c=document.createElement('span');c.className='c';c.style.background=color(k);
    var nm=document.createElement('span');nm.className='n';nm.textContent=p.name;
    var bd=document.createElement('span');bd.className='bd';
    bd.textContent=st==='at'?'At '+cpNameOf(p.cp):st==='enroute'?'En route':st==='lost'?'No signal '+agoTxt(age(p.ts)).replace(' ago',''):'Stopped sharing';
    top.appendChild(c);top.appendChild(nm);top.appendChild(bd);r.appendChild(top);
    var w=document.createElement('div');w.className='pw';
    w.textContent=(st==='lost'?'Last seen '+agoTxt(age(p.ts)):'Updated '+agoTxt(age(p.ts)))+(p.where?' · '+p.where:'')+(p.total?' · '+p.total+' m walked':'');
    r.appendChild(w);
    if(p.doing&&st!=='stopped'){var dg=document.createElement('div');dg.className='pdo';dg.textContent=p.doing;r.appendChild(dg)}
    r.onclick=function(){map.flyTo([p.lat,p.lng],Math.max(map.getZoom(),17))};
    box.appendChild(r);
  });
}
setInterval(function(){if(ev&&map){Object.keys(people).forEach(function(k){people[k].marker.setIcon(iconFor(people[k]))});draw()}},5000);

$('fit').onclick=fit;
$('trails').onclick=function(){
  showTrails=!showTrails; $('trails').textContent='Trails: '+(showTrails?'on':'off');
  Object.keys(people).forEach(function(k){showTrails?people[k].line.addTo(map):map.removeLayer(people[k].line)});
};
$('sh').onclick=function(){var s=$('sheet');s.classList.toggle('min');$('chev').innerHTML=s.classList.contains('min')?'&#9652;':'&#9662;'};
function shareLink(url,title,text){
  if(navigator.share){navigator.share({title:title,text:text,url:url}).catch(function(){})}
  else if(navigator.clipboard){navigator.clipboard.writeText(url).then(function(){toast('Link copied')},function(){prompt('Copy this link',url)})}
  else prompt('Copy this link',url);
}
$('share').onclick=function(){$('smenu').classList.toggle('hidden')};
$('smx').onclick=function(){$('smenu').classList.add('hidden')};
$('sharep').onclick=function(){
  $('smenu').classList.add('hidden');
  shareLink(location.origin+'/e/'+ev.id,ev.name||'Activity','Tap to share your location for '+(ev.name||'the activity'));
};
$('sharev').onclick=function(){
  if(!ev.viewToken){toast('Not ready yet, try again in a moment');return}
  $('smenu').classList.add('hidden');
  shareLink(location.origin+'/v/'+ev.id+'/'+ev.viewToken,'View: '+(ev.name||'Activity'),'View-only map for '+(ev.name||'the activity'));
};
$('newv').onclick=function(){
  if(!confirm('Make a new view-only link? Anyone using the old one is disconnected immediately and you will need to send them the new one.'))return;
  fetch('/api/e/'+ev.id+'/viewlink?t='+ev.token,{method:'POST'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){
    ev.viewToken=d.viewToken;remember(ev);toast('New view-only link ready. Tap "Share view-only link" to send it.');
  }).catch(function(){toast('Could not make a new link')});
};
if(VIEW){
  document.title='Activity Viewer';
  var ml=document.querySelector('link[rel=manifest]');if(ml)ml.href=location.pathname.replace(/\/$/,'')+'/manifest.webmanifest';
  ['share','spots','end','smenu'].forEach(function(i){$(i).classList.add('hidden')});
  $('share').onclick=null;
  $('vbadge').classList.remove('hidden');
}
$('end').onclick=function(){
  if(!confirm('End this activity? Everyone will stop appearing and the data is deleted.'))return;
  fetch('/api/e/'+ev.id+'?t='+ev.token,{method:'DELETE'}).then(function(){
    forget(ev.id); if(es)es.close(); ev=null; fitted=false; logData=[]; drawCps([]);
    Object.keys(people).forEach(function(k){map.removeLayer(people[k].marker);map.removeLayer(people[k].line);delete people[k]});
    history.replaceState(null,'',location.pathname); $('mk').disabled=false; showCreate();
  });
};

var start=VIEW?{id:VIEW[1],token:VIEW[2],name:''}:(parseHash()||lsGet('at_current',null));
if(start)open(start); else showCreate();
})();
</script>
</body></html>`;

/* ================= PARTICIPANT PAGE ================= */
const JOIN_HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Share location</title>
<meta name="theme-color" content="#0f172a">
<link rel="manifest" href="/e/__ID__/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
${BASE_CSS}
#home{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;text-align:center;min-height:100%}
h1{margin:0;font-size:20px;font-weight:600;color:#cbd5e1}
#name{width:200px;padding:10px 12px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#fff;text-align:center;font-size:16px}
#go{width:220px;height:220px;border-radius:50%;border:0;background:#3b82f6;color:#fff;font-size:24px;font-weight:700;line-height:1.2;cursor:pointer}
#go.on{background:#16a34a;animation:pulse 2s infinite}
#go:disabled{opacity:.5}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(22,163,74,.55)}70%{box-shadow:0 0 0 36px rgba(22,163,74,0)}100%{box-shadow:0 0 0 0 rgba(22,163,74,0)}}
#st{min-height:22px;color:#94a3b8;font-size:15px}
#st.err{color:#f87171}
#stop{background:none;border:0;color:#94a3b8;text-decoration:underline;font-size:15px;cursor:pointer}
.small{font-size:12.5px;color:#64748b;max-width:300px;line-height:1.45}
#inst{background:none;border:1px solid #334155;color:#94a3b8;border-radius:10px;padding:6px 12px;font-size:13px;cursor:pointer}
.hidden{display:none!important}
#live{position:fixed;inset:0;z-index:10}
#map{position:absolute;inset:0}
#bar{position:absolute;top:0;left:0;right:0;z-index:1000;padding:calc(env(safe-area-inset-top) + 8px) 10px 22px;background:linear-gradient(#0f172aee,#0f172a00);display:flex;gap:8px;align-items:center;pointer-events:none}
#bar>*{pointer-events:auto}
#lst{flex:1;min-width:0;font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dot{width:9px;height:9px;border-radius:50%;background:#22c55e;flex:none}
#dot.off{background:#ef4444}
.b{padding:8px 12px;border-radius:10px;border:1px solid #334155;background:#1e293bf0;color:#e2e8f0;font-size:14px;font-weight:600;cursor:pointer}
.b.red{background:#7f1d1d;border-color:#7f1d1d}
.mk .pin{position:absolute;width:30px;height:30px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:#fff;font:700 13px system-ui;transform:translate(-50%,-50%)}
.mk .lbl{position:absolute;transform:translate(-50%,0);top:18px;white-space:nowrap;background:rgba(15,23,42,.88);color:#fff;font:600 11px system-ui;padding:1px 6px;border-radius:8px}
.mk.me .pin{box-shadow:0 0 0 4px rgba(59,130,246,.5),0 1px 6px rgba(0,0,0,.5)}
.cpmk{background:none;border:0}
.cpmk .cplbl{position:absolute;left:50%;top:32px;transform:translateX(-50%);white-space:nowrap;background:rgba(15,23,42,.9);color:#fff;font:700 11px system-ui;padding:1px 6px;border-radius:8px}
.cpmk svg{display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))}
.mk.stale .pin{filter:grayscale(1);opacity:.65}
</style>
</head><body>
<div id="home">
  <h1 id="ev">&nbsp;</h1>
  <input id="name" placeholder="Your name" maxlength="40" autocomplete="given-name">
  <button id="go" disabled>Share<br>location</button>
  <div id="st"></div>
  <button id="stop" class="hidden">Stop sharing</button>
  <div class="small" id="note">The host of this activity will see your live location on a map while you share. You can stop at any time.</div>
  <button id="inst" class="hidden">Install app</button>
  <div class="small hidden" id="ios">To install: tap Share, then "Add to Home Screen".</div>
</div>
<div id="live" class="hidden">
  <div id="map"></div>
  <div id="bar">
    <div id="lst"><span id="dot" class="off"></span><span id="lt">Sharing</span></div>
    <button id="fit" class="b">Fit all</button>
    <button id="stop2" class="b red">Stop</button>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function(){
var ID='__ID__';
var $=function(i){return document.getElementById(i)};
function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
function lsSet(k,v){try{localStorage.setItem(k,v)}catch(e){}}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function color(p){var h=0;for(var i=0;i<p.length;i++)h=(h*31+p.charCodeAt(i))>>>0;return 'hsl('+(h%360)+',70%,45%)'}
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(function(){});

var pid=lsGet('at_pid_'+ID);
if(!pid){pid=(crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+Date.now()).replace(/[^A-Za-z0-9_-]/g,'').slice(0,32);lsSet('at_pid_'+ID,pid)}
$('name').value=lsGet('at_name')||'';

var sharing=false, watchId=null, lastPos=null, lastSent=0, wl=null, hb=null, offline=false, shared=false;
var map=null, ppl={}, es=null, fitted=false, audio=null;
var NOTE_HOST='The host of this activity will see your live location on a map while you share. You can stop at any time.';
var NOTE_ALL='Everyone who is sharing in this activity can see each other’s live location on a map, including the host. You can stop at any time.';
function status(t,err){$('st').textContent=t;$('st').className=err?'err':''}

fetch('/api/e/'+ID).then(function(r){return r.ok?r.json():Promise.reject()}).then(function(d){
  shared=!!d.shared;
  if(d.logging){var REC=' Your location and movement are also recorded in a spreadsheet kept by the host.';NOTE_HOST+=REC;NOTE_ALL+=REC}
  $('note').textContent=shared?NOTE_ALL:NOTE_HOST;
  $('ev').textContent=d.name; document.title=d.name; $('go').disabled=false;
  if(lsGet('at_sharing_'+ID)==='1')startSharing(true);
}).catch(function(){$('ev').textContent='Activity not found';status('This link is no longer active.',true)});

/* ---- keep-alive: near-silent looping audio + media session (best effort, see README) ---- */
function wav(){
  var n=8000,b=new Uint8Array(44+n),v=new DataView(b.buffer);
  function s(o,t){for(var i=0;i<t.length;i++)b[o+i]=t.charCodeAt(i)}
  s(0,'RIFF');v.setUint32(4,36+n,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,8000,true);v.setUint32(28,8000,true);v.setUint16(32,1,true);v.setUint16(34,8,true);s(36,'data');v.setUint32(40,n,true);
  for(var i=0;i<n;i++)b[44+i]=(Math.floor(i/50)%2)?129:127;
  return URL.createObjectURL(new Blob([b],{type:'audio/wav'}));
}
function keepAlive(on){
  try{
    if(on){
      if(!audio){audio=new Audio(wav());audio.loop=true;audio.volume=0.05}
      var pr=audio.play(); if(pr&&pr.catch)pr.catch(function(){});
      if('mediaSession' in navigator&&window.MediaMetadata){
        navigator.mediaSession.metadata=new MediaMetadata({title:'Sharing your location',artist:'Tap Stop in the app to end'});
        try{navigator.mediaSession.setActionHandler('pause',function(){if(audio)audio.play()})}catch(e){}
      }
    } else if(audio){audio.pause()}
  }catch(e){}
}

/* ---- sending my position ---- */
function send(pos){
  var body=JSON.stringify({pid:pid,name:($('name').value||'').trim()||'Guest',lat:pos.lat,lng:pos.lng,acc:pos.acc});
  fetch('/api/e/'+ID+'/loc',{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true})
  .then(function(r){
    if(r.status===404){stopSharing(true);$('ev').textContent='Activity ended';status('The host ended this activity.');return}
    if(!r.ok)throw 0; lastSent=Date.now(); offline=false; showOk();
    if(sharing&&shared&&!es)enterLive();
  }).catch(function(){offline=true;status('No connection. Will keep trying...',true);$('dot').className='off'});
}
function showOk(){ if(sharing&&!offline)status('Sharing your location'+(lastPos&&lastPos.acc?' (±'+Math.round(lastPos.acc)+'m)':'')) }
function onPos(p){
  lastPos={lat:p.coords.latitude,lng:p.coords.longitude,acc:Math.round(p.coords.accuracy||0)};
  if(Date.now()-lastSent>=4000)send(lastPos);
}
function onErr(e){
  if(e.code===1){status('Location is blocked. Allow it in your browser / phone settings, then tap again.',true);stopSharing(true)}
  else status('Waiting for GPS signal...',true);
}
function watch(){
  if(watchId!==null)navigator.geolocation.clearWatch(watchId);
  watchId=navigator.geolocation.watchPosition(onPos,onErr,{enableHighAccuracy:true,maximumAge:3000,timeout:30000});
}
function getWake(){
  if(!sharing||!('wakeLock' in navigator))return;
  navigator.wakeLock.request('screen').then(function(l){wl=l;l.addEventListener('release',function(){wl=null})}).catch(function(){});
}

/* ---- live map of everyone (only when the host enabled it) ---- */
function iconFor(p){
  var me=p.pid===pid, ini=esc((p.name||'?').trim().charAt(0).toUpperCase()||'?');
  var html='<div class="pin" style="background:'+color(p.pid)+'">'+ini+'</div><div class="lbl">'+esc(p.name)+(me?' (you)':'')+'</div>';
  var stale=(Date.now()+skew-p.ts)>90000;
  return L.divIcon({className:'mk'+(me?' me':'')+(stale?' stale':''),html:html,iconSize:[0,0]});
}
var skew=0;
function upsert(d){
  var p=ppl[d.pid];
  if(!p){p=ppl[d.pid]={pid:d.pid};p.marker=L.marker([d.lat,d.lng],{icon:iconFor(d)}).addTo(map)}
  p.name=d.name;p.lat=d.lat;p.lng=d.lng;p.ts=d.ts;
  p.marker.setLatLng([d.lat,d.lng]);p.marker.setIcon(iconFor(p));
}
var CPCOL={'Equipment Pickup':'#22d3ee','FC Retrieval':'#ec4899','FOB Securement':'#fb923c'}, cpObjs={};
function drawCps(list){
  if(!map||!list)return;
  Object.keys(cpObjs).forEach(function(k){map.removeLayer(cpObjs[k].m);map.removeLayer(cpObjs[k].c)});
  cpObjs={};
  list.forEach(function(c){
    var col=CPCOL[c.type]||'#fff',pts=[];
    for(var i=0;i<14;i++){var r=i%2?7:15,a=-Math.PI/2+i*Math.PI/7;pts.push((17+r*Math.cos(a)).toFixed(1)+','+(17+r*Math.sin(a)).toFixed(1))}
    var svg='<svg width="34" height="34" viewBox="0 0 34 34"><polygon points="'+pts.join(' ')+'" fill="'+col+'" stroke="#fff" stroke-width="1.5"/></svg>';
    var ic=L.divIcon({className:'cpmk',html:svg+'<div class="cplbl">'+esc(c.name)+'</div>',iconSize:[34,34],iconAnchor:[17,17]});
    var circ=L.circle([c.lat,c.lng],{radius:c.radius,color:col,weight:2,opacity:.9,fillOpacity:.12,interactive:false}).addTo(map);
    var mk=L.marker([c.lat,c.lng],{icon:ic,interactive:false,zIndexOffset:-500}).addTo(map);
    cpObjs[c.id]={m:mk,c:circ};
  });
}
function drop(pidX){if(ppl[pidX]){map.removeLayer(ppl[pidX].marker);delete ppl[pidX]}}
function clearAll(){Object.keys(ppl).forEach(drop)}
function count(){var n=Object.keys(ppl).length;$('lt').textContent='Sharing live · '+n+' on map'}
function fit(){
  var pts=Object.keys(ppl).map(function(k){return [ppl[k].lat,ppl[k].lng]});
  if(!pts.length)return;
  if(pts.length===1)map.setView(pts[0],16);else map.fitBounds(pts,{padding:[70,70],maxZoom:17});
}
function enterLive(){
  if(!window.L)return;
  $('home').classList.add('hidden');$('live').classList.remove('hidden');
  if(!map){
    map=L.map('map',{zoomControl:false}).setView([20,0],2);
    L.control.zoom({position:'bottomright'}).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
  } else setTimeout(function(){map.invalidateSize()},50);
  connect();
}
function leaveLive(){
  if(es){es.close();es=null}
  clearAll();fitted=false;
  $('live').classList.add('hidden');$('home').classList.remove('hidden');
}
function connect(){
  if(es)es.close();
  es=new EventSource('/api/e/'+ID+'/stream?pid='+encodeURIComponent(pid));
  es.onopen=function(){$('dot').className=''};
  es.onerror=function(){$('dot').className='off'};
  es.addEventListener('snapshot',function(m){
    var d=JSON.parse(m.data);skew=d.now-Date.now();clearAll();
    drawCps(d.checkpoints);
    d.people.forEach(upsert);
    if(!fitted&&d.people.length){fit();fitted=true}
    count();
  });
  es.addEventListener('loc',function(m){
    var d=JSON.parse(m.data);skew=d.now-Date.now();
    if(d.stopped)drop(d.pid);else upsert(d);
    if(!fitted){fit();fitted=true}
    count();
  });
  es.addEventListener('cps',function(m){drawCps(JSON.parse(m.data).checkpoints)});
  es.addEventListener('ended',function(){stopSharing(true);$('ev').textContent='Activity ended';status('The host ended this activity.')});
}
setInterval(function(){if(map)Object.keys(ppl).forEach(function(k){ppl[k].marker.setIcon(iconFor(ppl[k]))})},5000);

/* ---- start / stop ---- */
function startSharing(auto){
  if(!navigator.geolocation){status('This device does not support location.',true);return}
  var nm=($('name').value||'').trim(); lsSet('at_name',nm);
  sharing=true; lsSet('at_sharing_'+ID,'1');
  $('go').classList.add('on'); $('go').innerHTML='Sharing<br>live'; $('go').disabled=true;
  $('stop').classList.remove('hidden'); $('name').classList.add('hidden');
  $('note').textContent='Keep this app open. For best results leave the screen on (you can dim it). Locking your phone can pause sharing.';
  status(auto?'Resuming...':'Getting your location...');
  watch(); getWake(); keepAlive(true);
  clearInterval(hb);
  hb=setInterval(function(){ if(sharing&&lastPos&&Date.now()-lastSent>12000)send(lastPos) },5000);
}
function stopSharing(quiet){
  var was=sharing; sharing=false; lsSet('at_sharing_'+ID,'0');
  if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}
  clearInterval(hb); if(wl){wl.release().catch(function(){});wl=null}
  keepAlive(false); leaveLive();
  $('go').classList.remove('on'); $('go').innerHTML='Share<br>location'; $('go').disabled=false;
  $('stop').classList.add('hidden'); $('name').classList.remove('hidden');
  $('note').textContent=shared?NOTE_ALL:NOTE_HOST;
  if(was&&!quiet)status('Stopped sharing.');
  if(was)fetch('/api/e/'+ID+'/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pid:pid}),keepalive:true}).catch(function(){});
}
$('go').onclick=function(){startSharing(false)};
$('stop').onclick=function(){stopSharing(false)};
$('stop2').onclick=function(){stopSharing(false)};
$('fit').onclick=fit;
$('name').addEventListener('change',function(){lsSet('at_name',($('name').value||'').trim())});

function resume(){
  if(!sharing)return;
  getWake();watch();keepAlive(true);
  if(lastPos)send(lastPos);
  if(shared&&map&&(!es||es.readyState===2))connect();
}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')resume()});
window.addEventListener('online',resume);

var dp=null;
window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();dp=e;$('inst').classList.remove('hidden')});
$('inst').onclick=function(){if(dp){dp.prompt();dp=null;$('inst').classList.add('hidden')}};
var standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone;
if(/iphone|ipad|ipod/i.test(navigator.userAgent)&&!standalone)$('ios').classList.remove('hidden');
})();
</script>
</body></html>`;

/* ================= API ================= */
function api(req, res, id, action, u) {
  const m = req.method;
  const ev = events.get(id);
  if (!ev) return json(res, 404, { error: 'not found' });
  const t = u.searchParams.get('t');

  if (!action && m === 'GET') {
    const role = roleOf(ev, t);
    const info = { name: ev.name, host: role === 'host', viewer: role === 'viewer', shared: ev.shared, logging: !!SHEET_URL };
    if (role === 'host') info.viewToken = ev.viewToken;
    return json(res, 200, info);
  }

  if (!action && m === 'DELETE') {
    if (!tokenOk(ev, t)) return json(res, 403, { error: 'forbidden' });
    endEvent(ev); events.delete(id); dirty = true;
    return json(res, 200, { ok: true });
  }

  if (action === 'stream' && m === 'GET') {
    const role = roleOf(ev, t);
    const host = role !== null;   // viewers get exactly the host's data
    const spid = String(u.searchParams.get('pid') || '');
    if (!host) {
      // Participants may watch only if the host enabled it AND they are currently sharing themselves.
      const sp = ev.shared && ev.people.get(spid);
      if (!sp || sp.stopped) return json(res, 403, { error: 'forbidden' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const people = [...ev.people.values()]
      .filter(p => host || !p.stopped)
      .map(p => host ? Object.assign(pub(p, true, ev), { trail: (p.trail || []).map(x => [x[0], x[1]]) }) : pub(p, false));
    const snap = { name: ev.name, people, now: Date.now() };
    if (host) { snap.checkpoints = pubCps(ev); snap.guide = MISSION_GUIDE; }
    res.write('event: snapshot\ndata: ' + JSON.stringify(snap) + '\n\n');
    res._pid = host ? null : spid;
    res._host = host;
    res._viewer = role === 'viewer';
    ev.clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); ev.clients.delete(res); });
    return;
  }

  if (action === 'loc' && m === 'POST') {
    return readJson(req, (err, b) => {
      if (err) return json(res, 400, { error: 'bad json' });
      const pid = String(b.pid || '');
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(pid)) return json(res, 400, { error: 'bad pid' });
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
        return json(res, 400, { error: 'bad position' });
      let p = ev.people.get(pid);
      if (!p) {
        if (ev.people.size >= MAX_PEOPLE) return json(res, 429, { error: 'full' });
        p = { pid, name: 'Guest', trail: [] };
        ev.people.set(pid, p);
      }
      const now = Date.now();
      p.name = String(b.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Guest';
      p.lat = lat; p.lng = lng;
      p.acc = Number.isFinite(Number(b.acc)) && b.acc !== null ? Math.round(Number(b.acc)) : null;
      const wasStopped = p.stopped === true;
      const wasLost = p.lost === true;
      p.ts = now; p.stopped = false; p.lost = false;
      const lg = p.lg || (p.lg = { ts: 0, lat: null, lng: null, total: 0 });
      let logType = null, movedM = 0;
      if (lg.lat === null) logType = 'Joined';
      else {
        movedM = dist(lg.lat, lg.lng, lat, lng);
        if (wasStopped) logType = 'Resumed';
        else if (wasLost) logType = 'Back online';
        else if (movedM >= MOVE_M) logType = 'Moved';
        else if (now - lg.ts >= UPDATE_MS) logType = 'Update';
      }
      // checkpoint geofence: arriving at / leaving a marked location is always logged
      const prevCp = p.cp || null, newCp = cpAt(ev, p, lat, lng);
      const cpChanged = prevCp !== newCp;
      if (logType || cpChanged) {
        lg.total += movedM; lg.ts = now; lg.lat = lat; lg.lng = lng;
      }
      p.cp = newCp;
      // nearest checkpoint + progress toward it since the last logged entry (positive = got closer)
      const ni = nearest(ev, lat, lng);
      p.nearCur = ni ? {
        id: ni.id, name: ni.name, d: Math.round(ni.d),
        toward: lg.near && lg.near.id === ni.id ? Math.round(lg.near.d - ni.d) : null
      } : null;
      if (logType) logRow(ev, p, logType, movedM, newCp);
      if (cpChanged) {
        if (prevCp) logRow(ev, p, 'Left', logType ? 0 : movedM, prevCp);
        if (newCp) {
          const vs = p.visits || (p.visits = {});
          const v = vs[newCp];
          if (v) { v.count++; v.last = now; } else vs[newCp] = { first: now, last: now, count: 1 };
          logRow(ev, p, 'Arrived', logType || prevCp ? 0 : movedM, newCp);
        }
      }
      if ((logType || cpChanged) && ni) lg.near = { id: ni.id, d: ni.d };
      const last = p.trail[p.trail.length - 1];
      let pt = false;
      if (!last || Math.hypot((lat - last[0]) * 111000, (lng - last[1]) * 111000 * Math.cos(lat * Math.PI / 180)) > 8) {
        p.trail.push([lat, lng, now]); pt = true;
        if (p.trail.length > MAX_TRAIL) p.trail.shift();
      }
      ev.last = now; dirty = true;
      broadcastLoc(ev, p, { pt, now });
      res.writeHead(204); res.end();
    });
  }

  if (action === 'stop' && m === 'POST') {
    return readJson(req, (err, b) => {
      if (err) return json(res, 400, { error: 'bad json' });
      const p = ev.people.get(String(b.pid || ''));
      if (p && p.lat !== undefined) {
        if (!p.stopped) { p.ts = Date.now(); p.lost = false; logRow(ev, p, 'Stopped', 0); }
        p.stopped = true; ev.last = Date.now(); dirty = true;
        broadcastLoc(ev, p, { pt: false, now: Date.now() });
        // someone who stops sharing also stops seeing everyone else
        for (const c of [...ev.clients]) if (c._pid === p.pid) { ev.clients.delete(c); c.end(); }
      }
      res.writeHead(204); res.end();
    });
  }

  // host only: the in-app log (JSON, or ?format=csv to download)
  if (action === 'log' && m === 'GET') {
    if (!roleOf(ev, t)) return json(res, 403, { error: 'forbidden' });
    if (u.searchParams.get('format') === 'csv') {
      const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const lines = ['Time,Person,What happened,Purpose,Location status,Event,Checkpoint,Nearest checkpoint,Distance to nearest (m),Closer by (m),Moved (m),Total (m),Accuracy (m),Latitude,Longitude'];
      for (const e of ev.log) lines.push([q(new Date(e.ts).toISOString()), q(e.person), q(e.text || e.type), q(e.purpose), q(e.status), q(e.type), q(e.checkpoint), q(e.nearest),
        e.nearDist == null ? '' : e.nearDist, e.toward == null ? '' : e.toward, e.moved, e.total, e.acc == null ? '' : e.acc, e.lat, e.lng].join(','));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="activity-log-' + ev.id + '.csv"'
      });
      return res.end(lines.join('\n'));
    }
    return json(res, 200, { log: ev.log, checkpoints: pubCps(ev) });
  }

  // host only: replace the view-only link (the old one stops working at once)
  if (action === 'viewlink' && m === 'POST') {
    if (!tokenOk(ev, t)) return json(res, 403, { error: 'forbidden' });
    ev.viewToken = crypto.randomBytes(16).toString('hex'); dirty = true;
    for (const c of [...ev.clients]) {
      if (c._viewer) { c.write('event: revoked\ndata: {}\n\n'); ev.clients.delete(c); c.end(); }
    }
    return json(res, 200, { viewToken: ev.viewToken });
  }

  // host only: move a checkpoint / change its radius
  if (action === 'checkpoints' && m === 'POST') {
    if (!tokenOk(ev, t)) return json(res, 403, { error: 'forbidden' });
    return readJson(req, (err, b) => {
      if (err) return json(res, 400, { error: 'bad json' });
      const c = ev.checkpoints.find(x => x.id === String(b.id || ''));
      if (!c) return json(res, 404, { error: 'no such checkpoint' });
      const lat = Number(b.lat), lng = Number(b.lng), radius = Number(b.radius);
      if (b.lat !== undefined) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json(res, 400, { error: 'bad position' });
        c.lat = lat; c.lng = lng;
      }
      if (b.radius !== undefined) {
        if (!Number.isFinite(radius) || radius < 10 || radius > 1000) return json(res, 400, { error: 'radius must be 10-1000 m' });
        c.radius = Math.round(radius);
      }
      dirty = true;
      broadcast(ev, 'cps', { checkpoints: pubCps(ev) }, true);
      syncCheckpointsToSheet(ev);
      json(res, 200, { ok: true });
    });
  }

  json(res, 404, { error: 'not found' });
}

/* ================= SERVER ================= */
const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); return res.end(); }
  const p = u.pathname, m = req.method;
  let r;

  if (m === 'GET' && p === '/') return send(res, 'text/html; charset=utf-8', HOST_HTML);
  if (m === 'GET' && p === '/manifest.webmanifest') return send(res, 'application/manifest+json', HOST_MANIFEST);
  if (m === 'GET' && p === '/sw.js') return send(res, 'application/javascript', SW, 'no-cache');
  if (m === 'GET' && p === '/icon-192.png') return send(res, 'image/png', icon(192), 'public, max-age=86400');
  if (m === 'GET' && p === '/icon-512.png') return send(res, 'image/png', icon(512), 'public, max-age=86400');
  if (m === 'GET' && p === '/apple-touch-icon.png') return send(res, 'image/png', icon(180), 'public, max-age=86400');
  if (m === 'GET' && p === '/healthz') return send(res, 'text/plain', 'ok');

  // view-only link: serves the host screen; the page switches itself to view-only mode, the server enforces it
  if (m === 'GET' && (r = p.match(/^\/v\/([a-z2-9]{8})\/([0-9a-f]{32})\/?$/)))
    return send(res, 'text/html; charset=utf-8', HOST_HTML);
  if (m === 'GET' && (r = p.match(/^\/v\/([a-z2-9]{8})\/([0-9a-f]{32})\/manifest\.webmanifest$/))) {
    const ev = events.get(r[1]);
    return send(res, 'application/manifest+json', viewerManifest(r[1], r[2], ev && ev.name));
  }
  if (m === 'GET' && (r = p.match(/^\/e\/([a-z2-9]{8})\/?$/)))
    return send(res, 'text/html; charset=utf-8', JOIN_HTML.replace(/__ID__/g, r[1]));
  if (m === 'GET' && (r = p.match(/^\/e\/([a-z2-9]{8})\/manifest\.webmanifest$/))) {
    const ev = events.get(r[1]);
    return send(res, 'application/manifest+json', joinManifest(r[1], ev && ev.name));
  }

  if (m === 'POST' && p === '/api/events') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    if (rateLimited(ip)) return json(res, 429, { error: 'slow down' });
    return readJson(req, (err, b) => {
      if (err) return json(res, 400, { error: 'bad json' });
      let id; do { id = newId(); } while (events.has(id));
      const ev = {
        id, name: String(b.name || 'Activity').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Activity',
        token: crypto.randomBytes(16).toString('hex'), viewToken: crypto.randomBytes(16).toString('hex'),
        created: Date.now(), last: Date.now(),
        shared: b.shared === true,
        checkpoints: cloneCheckpoints(), log: [],
        people: new Map(), clients: new Set()
      };
      events.set(id, ev); dirty = true;
      syncCheckpointsToSheet(ev);
      json(res, 200, { id, token: ev.token });
    });
  }

  if ((r = p.match(/^\/api\/e\/([a-z2-9]{8})(?:\/(stream|loc|stop|log|checkpoints|viewlink))?$/))) return api(req, res, r[1], r[2], u);

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => console.log('Activity Tracker running on http://localhost:' + PORT));
process.on('SIGTERM', () => {
  dirty = true; save(true); // write to disk before anything else, synchronously
  setTimeout(() => process.exit(0), 4000).unref();
  flushSheet().finally(() => process.exit(0)); // then try to send any rows still queued for the sheet
});
