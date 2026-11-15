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

/* ---------- persistence (simple JSON snapshot) ---------- */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const e of raw) {
      events.set(e.id, {
        id: e.id, name: e.name, token: e.token, created: e.created, last: e.last, shared: e.shared === true,
        people: new Map(e.people.map(p => [p.pid, p])), clients: new Set()
      });
    }
  } catch (_) { /* first run */ }
}
function save() {
  if (!dirty) return;
  dirty = false;
  const out = [...events.values()].map(e => ({
    id: e.id, name: e.name, token: e.token, created: e.created, last: e.last, shared: e.shared,
    people: [...e.people.values()]
  }));
  fs.writeFile(DATA_FILE, JSON.stringify(out), () => {});
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
function tokenOk(ev, t) {
  if (!t || typeof t !== 'string' || t.length !== ev.token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ev.token));
}
function broadcast(ev, type, data) {
  const msg = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of ev.clients) c.write(msg);
}
function endEvent(ev) {
  broadcast(ev, 'ended', {});
  for (const c of ev.clients) c.end();
  ev.clients.clear();
}
function pub(p) {
  return { pid: p.pid, name: p.name, lat: p.lat, lng: p.lng, acc: p.acc, ts: p.ts, stopped: !!p.stopped };
}
/* ---------- accountability log -> Google Sheet (via Apps Script web app) ---------- */
const SHEET_URL = process.env.SHEET_WEBHOOK_URL || '';
const SHEET_SECRET = process.env.SHEET_SECRET || '';
const MOVE_M = 30;            // log a "Moved" row after this many metres
const CHECKPOINT_MS = 300000; // and a "Checkpoint" row at least this often while sharing
const sheetQ = [];
let flushing = false;
function dist(aLat, aLng, bLat, bLng) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function logRow(ev, p, type, moved) {
  if (!SHEET_URL) return;
  sheetQ.push({
    ts: new Date(p.ts || Date.now()).toISOString(), activity: ev.name, activityId: ev.id,
    person: p.name, pid: p.pid, type, lat: p.lat, lng: p.lng, acc: p.acc,
    moved: Math.round(moved || 0), total: Math.round((p.lg && p.lg.total) || 0)
  });
  if (sheetQ.length > 5000) sheetQ.splice(0, sheetQ.length - 5000);
}
async function flushSheet() {
  if (!SHEET_URL || flushing || !sheetQ.length) return;
  flushing = true;
  const batch = sheetQ.splice(0, 200);
  try {
    const r = await fetch(SHEET_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: SHEET_SECRET, rows: batch }), redirect: 'follow'
    });
    const txt = await r.text();
    if (!r.ok || !/"ok"\s*:\s*true/.test(txt)) throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 120));
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
#sheet{position:absolute;left:0;right:0;bottom:0;z-index:1000;background:#0f172af2;border-radius:18px 18px 0 0;max-height:42vh;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom)}
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
    <div id="title"><span id="dot" class="off"></span><span id="tname">Activity</span><span id="cnt" style="font-weight:400;color:#94a3b8"></span></div>
    <button id="share" class="btn sm">Share link</button>
    <button id="fit" class="btn sm sec">Fit all</button>
    <button id="trails" class="btn sm sec">Trails: on</button>
    <button id="end" class="btn sm danger">End</button>
  </div>
  <div id="sheet">
    <div id="sh"><span id="shl">People</span><span id="chev">&#9662;</span></div>
    <div id="list"></div>
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

function remember(e){
  lsSet('at_current',e);
  var list=lsGet('at_events',[]).filter(function(x){return x.id!==e.id});
  list.unshift(e); lsSet('at_events',list.slice(0,10));
}
function forget(id){
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
  history.replaceState(null,'','#id='+e.id+'&t='+e.token+'&n='+encodeURIComponent(e.name||''));
  $('create').classList.add('hidden'); $('app').classList.remove('hidden');
  $('tname').textContent=e.name||'Activity';
  initMap();
  fetch('/api/e/'+e.id+'?t='+e.token).then(function(r){return r.ok?r.json():Promise.reject()}).then(function(d){
    if(!d.host){toast('Host link invalid');forget(e.id);return showCreate()}
    $('tname').textContent=d.name; ev.name=d.name; remember(ev); connect();
  }).catch(function(){toast('Activity not found');forget(e.id);showCreate()});
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
  p.name=d.name;p.lat=d.lat;p.lng=d.lng;p.acc=d.acc;p.ts=d.ts;p.stopped=d.stopped;
  if(appendPt){p.trail.push([d.lat,d.lng]);if(p.trail.length>MAXT)p.trail.shift();p.line.setLatLngs(p.trail)}
  p.marker.setLatLng([d.lat,d.lng]); p.marker.setIcon(iconFor(p));
}
var MAXT=300;

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
    if(!fitted&&d.people.length){fit();fitted=true}
    render();
  });
  es.addEventListener('loc',function(m){
    var d=JSON.parse(m.data); skew=d.now-Date.now();
    var first=!people[d.pid]; upsert(d,d.pt,null);
    if(!fitted){fit();fitted=true}
    else if(first)toast(d.name+' joined');
    render();
  });
  es.addEventListener('ended',function(){es.close();toast('Activity ended');forget(ev.id)});
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
function draw(){
  var ids=Object.keys(people).sort(function(a,b){return people[b].ts-people[a].ts});
  var live=ids.filter(function(k){return stateOf(people[k])==='live'}).length;
  $('cnt').textContent=' · '+live+' live';
  $('shl').textContent='People ('+ids.length+')';
  var box=$('list'); box.innerHTML='';
  if(!ids.length){var e=document.createElement('div');e.className='empty';e.textContent='Nobody yet. Tap "Share link" and send it to your group.';box.appendChild(e)}
  ids.forEach(function(k){
    var p=people[k],st=stateOf(p);
    var r=document.createElement('div');r.className='row'+(st!=='live'?' stale':'');
    var c=document.createElement('span');c.className='c';c.style.background=color(k);
    var n=document.createElement('span');n.className='n';n.textContent=p.name;
    var t=document.createElement('span');t.className='t';
    t.textContent=st==='stopped'?'stopped sharing':agoTxt(age(p.ts))+(p.acc?' · ±'+p.acc+'m':'');
    r.appendChild(c);r.appendChild(n);r.appendChild(t);
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
$('share').onclick=function(){
  var link=location.origin+'/e/'+ev.id;
  if(navigator.share){navigator.share({title:ev.name||'Activity',text:'Tap to share your location for '+(ev.name||'the activity'),url:link}).catch(function(){})}
  else if(navigator.clipboard){navigator.clipboard.writeText(link).then(function(){toast('Link copied')},function(){prompt('Copy this link',link)})}
  else prompt('Copy this link',link);
};
$('end').onclick=function(){
  if(!confirm('End this activity? Everyone will stop appearing and the data is deleted.'))return;
  fetch('/api/e/'+ev.id+'?t='+ev.token,{method:'DELETE'}).then(function(){
    forget(ev.id); if(es)es.close(); ev=null; fitted=false;
    Object.keys(people).forEach(function(k){map.removeLayer(people[k].marker);map.removeLayer(people[k].line);delete people[k]});
    history.replaceState(null,'',location.pathname); $('mk').disabled=false; showCreate();
  });
};

var start=parseHash()||lsGet('at_current',null);
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

  if (!action && m === 'GET') return json(res, 200, { name: ev.name, host: tokenOk(ev, t), shared: ev.shared, logging: !!SHEET_URL });

  if (!action && m === 'DELETE') {
    if (!tokenOk(ev, t)) return json(res, 403, { error: 'forbidden' });
    endEvent(ev); events.delete(id); dirty = true;
    return json(res, 200, { ok: true });
  }

  if (action === 'stream' && m === 'GET') {
    const host = tokenOk(ev, t);
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
      .map(p => host ? Object.assign(pub(p), { trail: (p.trail || []).map(x => [x[0], x[1]]) }) : pub(p));
    res.write('event: snapshot\ndata: ' + JSON.stringify({ name: ev.name, people, now: Date.now() }) + '\n\n');
    res._pid = host ? null : spid;
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
      p.ts = now; p.stopped = false;
      const lg = p.lg || (p.lg = { ts: 0, lat: null, lng: null, total: 0 });
      let logType = null, movedM = 0;
      if (lg.lat === null) logType = 'Joined';
      else {
        movedM = dist(lg.lat, lg.lng, lat, lng);
        if (wasStopped) logType = 'Resumed';
        else if (movedM >= MOVE_M) logType = 'Moved';
        else if (now - lg.ts >= CHECKPOINT_MS) logType = 'Checkpoint';
      }
      if (logType) {
        lg.total += movedM; lg.ts = now; lg.lat = lat; lg.lng = lng;
        logRow(ev, p, logType, movedM);
      }
      const last = p.trail[p.trail.length - 1];
      let pt = false;
      if (!last || Math.hypot((lat - last[0]) * 111000, (lng - last[1]) * 111000 * Math.cos(lat * Math.PI / 180)) > 8) {
        p.trail.push([lat, lng, now]); pt = true;
        if (p.trail.length > MAX_TRAIL) p.trail.shift();
      }
      ev.last = now; dirty = true;
      broadcast(ev, 'loc', Object.assign(pub(p), { pt, now }));
      res.writeHead(204); res.end();
    });
  }

  if (action === 'stop' && m === 'POST') {
    return readJson(req, (err, b) => {
      if (err) return json(res, 400, { error: 'bad json' });
      const p = ev.people.get(String(b.pid || ''));
      if (p && p.lat !== undefined) {
        if (!p.stopped) { p.ts = Date.now(); logRow(ev, p, 'Stopped', 0); }
        p.stopped = true; ev.last = Date.now(); dirty = true;
        broadcast(ev, 'loc', Object.assign(pub(p), { pt: false, now: Date.now() }));
        // someone who stops sharing also stops seeing everyone else
        for (const c of [...ev.clients]) if (c._pid === p.pid) { ev.clients.delete(c); c.end(); }
      }
      res.writeHead(204); res.end();
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
        token: crypto.randomBytes(16).toString('hex'), created: Date.now(), last: Date.now(),
        shared: b.shared === true,
        people: new Map(), clients: new Set()
      };
      events.set(id, ev); dirty = true;
      json(res, 200, { id, token: ev.token });
    });
  }

  if ((r = p.match(/^\/api\/e\/([a-z2-9]{8})(?:\/(stream|loc|stop))?$/))) return api(req, res, r[1], r[2], u);

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => console.log('Activity Tracker running on http://localhost:' + PORT));
process.on('SIGTERM', () => { dirty = true; save(); flushSheet().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 4000).unref(); });
