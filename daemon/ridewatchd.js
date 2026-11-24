'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/**
 * ridewatchd.js - the jap-ridewatch service on the car (Node 22, jap-node22). Serves ctl.sock to the RideWatch app (Node 8),
 * fetches the H.264 stream from the RideWatch server through a local SOCKS5 proxy (the car has no TUN: jap-wireproxy
 * offers one on 127.0.0.1:1065, IterioDev's Tailscale on 127.0.0.2:1055) and feeds it to camdec's stdin (camdec
 * writes the MGVF frames the app's layer shows). While an app is connected it also holds the server's event feed
 * and picks the spot view's hero camera.
 *
 * Environment (defaults are the car's):
 *   JAP_RIDEWATCH_CONF   /var/opt/jap-ridewatch/state/server.json (0600), written here: {"host","port","socks":"127.0.0.1:1065",
 *                   optional "socksFallback" (a second SOCKS proxy, tried when "socks" fails, then used first for a
 *                   minute), "lat", "lon" (night = sunset..sunrise; none: always day), "token" (the car's code, made
 *                   here at the first start), optional "homeSsid" (the home Wi-Fi, by hand: "car at home")}.
 *                   The app's settings set host, port, socks, socksFallback, lat and lon ({"cmd":"config"}).
 *   JAP_RIDEWATCH_CTL    /run/jap-ridewatch/ctl.sock               MGU_UPLINK /run/mgu-uplink/status.json (mgu-uplink's Wi-Fi state)
 *                   (on the car ctl.sock comes as fd 3 from jap-ridewatch.socket: LISTEN_FDS set, the path unused)
 *   JAP_CAMDEC      /var/opt/jap-ridewatch/current/camdec      JAP_RIDEWATCH_VIDEO /dev/shm/mgu-video-ridewatch
 *
 * App -> daemon: {"cmd":"list"} {"cmd":"view","view":"spot"|"mosaic"|i,"rect":"WxH"} {"cmd":"pick","cam":i}
 *   {"cmd":"config","host":[a,b,c,d],"port","socks","socksFallback","lat","lon"} (0.0.0.0 keeps the address in
 *       server.json; socksFallback 0: none; lat 0 and lon 0: no night rule)
 *   {"cmd":"view","view":"clip","id","rect":"WxH"} (an event's recording, `<token> clip <id> WxH`: played once,
 *       then state "ended" with its last frame kept; never reconnected. The same command again replays it)
 *   {"cmd":"thumb","id"} (an event's picture: fetched `<token> thumb <id>`, JPEG decoded here, kept in an LRU of 60)
 *   {"cmd":"stop","why":"hidden"|"moving"} (moving keeps the pick) {"cmd":"status"}
 *   {"cmd":"swap","a":i,"b":j} (the user dropped camera a on b, b may be the hero: then a becomes the picked hero):
 *       the pane's order, kept in order.json beside server.json and sent with every spot (`o=`)
 *   {"cmd":"hello","app":"0.4.0"} (an older daemon: {"ev":"error","cmd":"hello","msg":"unknown cmd"})
 *   {"cmd":"listen","cam":i} {"cmd":"unlisten"} {"cmd":"talk","cam":i} {"cmd":"untalk"} (0.5.0; only what hello's "audio"
 *       lists, refused while stopped for moving or hidden)
 * Daemon -> app: {"ev":"list","cams":[{i,name,label,shape,w,h,roles}]} {"ev":"state","state":"idle|connecting|playing|ended|error","view":..,"msg":..,"shows":..}
 *   while the server refuses this car, also "pair" (https://<host>:18642/pair#h=<sha256 hex of the code>, the server's
 *       setup page: the app's QR), "fp" (the hash's first 6 hex, upper case, "7F3A 9C": the check the page shows too)
 *       and "code" (on the error state and the connecting ones between
 *       retries; gone once playing, stopped or failing for another reason)
 *   {"ev":"clip",id,cam,label,type,start,dur}  the server's line for a clip (ms), sent when its picture starts
 *   {"ev":"layout","w","h","hero","heroRect","tiles":[{i,name,label,x,y,w,h,shape}]}  the server's line for the
 *       picture now shown (stream px), sent when the stream switches to it
 *   {"ev":"hero","hero":i,"why":"ring|person|event|picked|default","event":{..}|null,"night":bool,"home":bool|null}
 *       sent as soon as the choice changes (the new stream follows ~1 s later)
 *   {"ev":"events","list":[{id,cam,label,type,ts,first,count,thumb}]} (newest last; on connect and status)
 *   {"ev":"event",id,cam,label,type,ts,first,count,thumb} (live: an id already listed updates that row, the server's burst)
 *   {"ev":"thumb","id","w":160,"h":90,"rgba":base64} | {"ev":"thumb","id","none":true}  to the asker only
 *   {"ev":"stats",...camdec's stats,"kbps"}  {"ev":"error","cmd":..,"msg"}
 *   {"ev":"hello","daemon","proto":1|2|null,"caps":[..],"tz":min|null,"audio":["listen","talk"]}  to the asker, and to all when it changes:
 *       the server's protocol (null: not known yet, 1: an older server), what it offers, its offset from UTC in
 *       minutes (east positive; the car's clock is UTC; null: unknown, the app keeps the unit's own time); audio: what
 *       the server offers of listen / talk and this car can do (the sound helper's caps: listen needs a source id and
 *       a player in its config, talk a mic lease; no helper socket = neither)
 *   {"ev":"audio","state":"off|listening|talking","listen":"off|starting|on","talk":"off|starting|on","cam":i|null,
 *       "why":null|"<short reason>","max":60}  on every change; why says what ended or refused the last one
 *       (the server's: forbidden, nouser, nospeaker, ...; the helper's: call, busy, nosource, noplayer, nomic, ...;
 *       here: moving, hidden, gone, tunnel, server, helper, max)
 *   {"ev":"level","v":0..1}  the sound's level while listening or talking (5 a second at most)
 *
 * Hero (chooseHero), from the camera roles the server lists (set on the server, server/configure.py; all optional):
 * a doorbell ring, or a person at the "door" camera, in the last 2 min -> the door camera (a ring without one: the
 * ringing camera); else the camera the user picked (until the app stops the view; a ring clears it); else the latest
 * person / vehicle / animal / package in the last 10 min (not the "garage" camera while the car is home); else the
 * "night" camera at night, the "day" camera otherwise, else the first camera.
 *
 * Audio (0.5.0): `<token> listen <cam>` -> {"ev":"listen","rate","ch":1,"fmt":"s16le"} then PCM, sent to the sound
 * helper (jap-ridewatch-audio, /run/jap-ridewatch/audio.sock: {"cmd":"play"} then the PCM, 0.5 s held at most, live);
 * `<token> talk <cam>` -> {"ev":"talk","ok":true,...,"max":60} then the helper's {"cmd":"mic"} PCM goes to the server
 * until untalk (the server's end: EOF), the server's or the helper's close, or 61 s. The server first: a refused talk
 * never borrows the mic. stop() (moving, hidden, the last app gone, another server, SIGTERM) ends both.
 *
 * A view: SOCKS5 connect, `<token> spot <hero> WxH` / `mosaic2 WxH` (the server's layout line first, then Annex-B)
 * or `<token> cam i WxH` or `<token> clip <id> WxH` (its {"ev":"clip"} line first, or {"ev":"clip","error"}).
 * Switching: camdec keeps running and its stdin moves to the new connection once that one's first IDR is in (camdec
 * resets on the new SPS and keeps its last frame meanwhile, so the old picture stays; a restarted camdec would re-init
 * the MSDK and could recreate the MGVF file, a black flash). While the new one connects, the old stream is cut at NAL
 * boundaries so camdec never gets a half NAL before the new SPS.
 * Drops reconnect after 1, 2, 4, 8, 10 s (not a clip: its end is "ended", its failure "error"), and so does a live
 * stream whose bytes keep coming while camdec shows no new picture for 5 s (watchdog(): on a new camdec); the last app
 * connection gone stops everything at once (camdec killed after 1 s if stdin EOF did not end it). The event feed
 * redials after 1 .. 10 s, after 10 s .. 5 min while the app is hidden ({"cmd":"stop","why":"hidden"}), and a 30 s
 * watchdog dials it again if it is down with no redial planned. The token is never
 * logged (the app shows it while the server refuses the car, so that it can be added there). Never exits on an error.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const socks = require('./socks');
const decodeJpeg = require('./vendor/jpeg-js/decoder.js');

/**
 * Started as root (systemd 237 takes no User= for a uid without an account): drop to JAP_RIDEWATCH_RUNAS
 * (uid:gid[:group,...], the unit's 3911:3911:video) before anything else is read; any doubt = exit.
 */
(function dropRoot() {
    const R = process.env.JAP_RIDEWATCH_RUNAS;
    if (process.getuid() !== 0) return;
    // root without the unit's line: refused, but for the tests and check.sh, which say so
    if (!R && process.env.JAP_RIDEWATCH_TEST_AS_ROOT === '1') return;
    if (!R) { console.error('ridewatchd: root without JAP_RIDEWATCH_RUNAS, not starting'); process.exit(1); }
    const m = /^(\d+):(\d+)(?::([\w,-]+))?$/.exec(R), uid = m ? +m[1] : 0, gid = m ? +m[2] : 0;
    const die = (w) => { console.error('JAP_RIDEWATCH_RUNAS=' + R + ': ' + w); process.exit(1); };
    if (!uid || !gid) die('want uid:gid[:group,...], not root');
    try {
        process.setgroups([gid].concat(m[3] ? m[3].split(',').map((g) => (/^\d+$/.test(g) ? +g : g)) : []));
        process.setgid(gid);
        process.setuid(uid);
    } catch (e) { die(e.message); }
    if (process.getuid() !== uid || process.geteuid() !== uid || process.getgid() !== gid || process.getgroups().indexOf(0) >= 0) die('still root');
})();

const CONF = process.env.JAP_RIDEWATCH_CONF || '/var/opt/jap-ridewatch/state/server.json';
const ORDER = require('path').join(require('path').dirname(CONF), 'order.json');   // the state dir: ours (3911), 0700
const CTL = process.env.JAP_RIDEWATCH_CTL || '/run/jap-ridewatch/ctl.sock';
const BIN = process.env.JAP_CAMDEC || '/var/opt/jap-ridewatch/current/camdec';
const VIDEO = process.env.JAP_RIDEWATCH_VIDEO || '/dev/shm/mgu-video-ridewatch';
const UPLINK = process.env.MGU_UPLINK || '/run/mgu-uplink/status.json';
const AUDIO = process.env.JAP_RIDEWATCH_AUDIO || '/run/jap-ridewatch/audio.sock';
const VERSION = '0.5.4';
const BACKOFF = [1000, 2000, 4000, 8000, 10000];
const BACKOFF_HIDDEN = [10000, 30000, 60000, 120000, 300000];   // the event feed while the app is hidden
const FIRST_MS = 10000;          // connect to first IDR (measured 0.2 s cam, 0.5 s mosaic, 0.8-1.4 s spot)
const CLIP_FIRST_MS = 40000;     // a clip: Protect login + export (0.5 s for 8 s measured, the server waits 30 s at most)
// the server's clip error codes (serve.py clip()), as the app shows them
const CLIP_ERR = { event: 'Event not found', config: 'Protect is not set up on the server', unreachable: 'Protect unreachable',
    login: 'Protect refused the login', cameras: 'Camera not found in Protect', camera: 'Camera not found in Protect',
    export: 'Recording unavailable' };
const SILENT_MS = 5000;          // a live stream quiet this long is a drop (a half-open tunnel)
const STALL_MS = 5000;           // a live stream whose bytes still come with no new picture this long is a drop too
const EVENTS_SILENT_MS = 40000;  // the event feed pings every 15 s
const MAX_PENDING = 4 << 20;     // bytes held before the first IDR
const TYPES = ['person', 'vehicle', 'animal', 'package', 'motion', 'ring'];
const SHAPES = ['wide', 'tall', 'round'];
const ROLES = ['door', 'garage', 'day', 'night'];
const THUMB_W = 160, THUMB_H = 90, THUMB_LRU = 60, THUMB_MAX = 1 << 20, THUMB_JOBS = 2;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;   // an event id goes into a request line

const log = (...a) => console.log(new Date().toISOString(), ...a);
const clients = new Set();
const send = (c, o) => c.write(JSON.stringify(o) + '\n');
const broadcast = (o) => { for (const c of clients) send(c, o); };

let want = null;      // { view, rect }: what the app asked for
let cur = null;       // the connection camdec reads
let next = null;      // the connection being opened: its bytes held until its first IDR
let dec = null, paused = false;
let tries = 0, retryT = null;
let state = 'idle', msg = null, layout = null, rx = 0, rxT = Date.now();
let stall = null;     // the frame watchdog: { shown, bytes, t, first } at camdec's last new picture (the stream's bytes then)
let cams = [], events = [], picked = null, hero = null, hidden = false;

// shows: the view camdec is fed now (the old one until the new one's first IDR): what the app draws over
let pair = null;      // while the server refuses this car: { pair, fp, code } (see pairOf)
const stateEv = () => Object.assign({ ev: 'state', state, view: want ? want.view : null, msg, shows: cur ? cur.w.view : state === 'ended' ? 'clip' : null }, pair);
// connecting keeps the refused car's QR up between retries
function setState(s, m, p) { state = s; msg = m || null; if (s !== 'connecting') pair = p || null; broadcast(stateEv()); }

const REFUSED = 'server refused this car';
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // no 0/O or 1/I: read off the screen, typed on the server
/** The car's code: the token the server knows this car by, 16 characters from CODE (80 bits) in groups of 4. */
const newCode = () => Array.from(require('crypto').randomBytes(16), (b) => CODE[b & 31]).join('').replace(/(.{4})(?=.)/g, '$1-');
function readConf() {
    let t;
    try { t = fs.readFileSync(CONF, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    try { return JSON.parse(t); } catch (e) { throw new Error('server.json unreadable'); }   // (the parse error quotes the file: the code)
}
function writeConf(c) {
    fs.writeFileSync(CONF + '.tmp', JSON.stringify(c, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(CONF + '.tmp', CONF);
}
/** The refused car's pairing link: the server's setup page with the code's SHA-256 (no bit of the code in the URL), and
 *  that hash's short fingerprint, shown by the car under the QR and by the page before it adds the car. */
const pairOf = (c) => {
    const h = require('crypto').createHash('sha256').update(c.token, 'utf8').digest('hex');
    return { pair: 'https://' + c.host + ':18642/pair#h=' + h, fp: h.slice(0, 4).toUpperCase() + ' ' + h.slice(4, 6).toUpperCase(), code: c.token };
};
/** server.json as a checked config; makes the car's code at the first start. */
function conf() {
    let c = readConf();
    if (typeof c.token !== 'string' || !/^\S+$/.test(c.token)) { c.token = newCode(); writeConf(c); log('made the car\'s code'); }
    const st = fs.statSync(CONF);
    if (st.mode & 0o077) { fs.chmodSync(CONF, 0o600); log('server.json was readable by others: now 0600'); }
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/, hp = (v) => { const a = String(v).split(':'); return a.length === 2 && +a[1] > 0 && +a[1] < 65536 ? a : null; };
    const sk = hp(c.socks || '127.0.0.1:1065'), fb = c.socksFallback ? hp(c.socksFallback) : null;
    if (!c.host || c.host === '0.0.0.0') throw new Error('no server address: set it in Settings');
    if (!ip.test(c.host) || !(c.port > 0 && c.port < 65536) || !sk || (c.socksFallback && !fb)) throw new Error('server.json needs host (IPv4), port and socks host:port');
    const ll = typeof c.lat === 'number' && typeof c.lon === 'number' && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180;
    return { host: c.host, port: c.port, token: c.token, socksHost: sk[0], socksPort: +sk[1], fbHost: fb && fb[0], fbPort: fb && +fb[1],
        homeSsid: typeof c.homeSsid === 'string' ? c.homeSsid : null, lat: ll ? c.lat : null, lon: ll ? c.lon : null };
}
// IterioDev's Tailscale serves its SOCKS5 on 127.0.0.2 (port 1055 by convention); jap-wireproxy and the others on 127.0.0.1
const socksAt = (port) => (port === 1055 ? '127.0.0.2:' : '127.0.0.1:') + port;
/** {"cmd":"config"} from the app's settings: merged into server.json (the token and homeSsid stay). */
function configure(m) {
    const n = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!(Array.isArray(m.host) && m.host.length === 4 && m.host.every((v) => n(v, 0, 255))) || !n(m.port, 1, 65535) || !n(m.socks, 1, 65535) ||
        !n(m.socksFallback, 0, 65535) || !n(m.lat, -90, 90) || !n(m.lon, -180, 180)) throw new Error('bad config');
    const c = readConf(), before = JSON.stringify(c), host = m.host.join('.');
    if (host !== '0.0.0.0') c.host = host;
    c.port = m.port;
    c.socks = socksAt(m.socks);
    if (m.socksFallback) c.socksFallback = socksAt(m.socksFallback); else delete c.socksFallback;
    if (m.lat || m.lon) { c.lat = m.lat; c.lon = m.lon; } else { delete c.lat; delete c.lon; }
    if (JSON.stringify(c) === before) return;
    const moved = JSON.parse(before || '{}').host !== c.host || JSON.parse(before || '{}').port !== c.port;
    writeConf(c);
    log('config: server ' + (c.host || 'not set') + ':' + c.port + ', socks ' + c.socks + (c.socksFallback ? ', fallback ' + c.socksFallback : ''));
    if (!moved) return rehero();
    cams = [];                                         // another server: its cameras, its events
    if (clients.size) { eventsClose(); eventsOpen(); list().then((l) => { cams = l; broadcast({ ev: 'list', cams }); greet(); rehero(); }, (e) => log('list:', e.message)); }
    if (want) { const w = want; stop('server changed', true); want = w; go(); }
}
// socksFallback: a second tunnel. A dead one costs socks.js' 5 s timeout once, then the fallback is used first for a
// minute so each view does not pay it again.
let fbUntil = 0, fbSaid = false;                       // fbSaid: the switch logged once per outage
function dial(c) {
    const main = () => socks.connect(c.socksHost, c.socksPort, c.host, c.port);
    if (!c.fbPort) return main();
    const fb = () => socks.connect(c.fbHost, c.fbPort, c.host, c.port).then((r) => { fbUntil = Date.now() + 60000; return r; });
    if (Date.now() < fbUntil) return fb().catch(() => { fbUntil = 0; return main(); });
    return main().then((r) => { fbSaid = false; return r; }, (e) => {
        if (!fbSaid) { fbSaid = true; log('tunnel ' + c.socksPort + ': ' + e.message + ', trying ' + c.fbPort); }
        return fb();
    });
}

/* ---- the camera list: one request, the answer until the server closes ---- */
async function list() {
    const c = conf();
    const { sock, rest } = await dial(c);
    sock.write(c.token + ' list\n');
    return new Promise((resolve, reject) => {
        const bufs = [rest];
        let n = rest.length;
        sock.setTimeout(10000, () => sock.destroy(new Error('no answer')));
        sock.on('data', (d) => { bufs.push(d); if ((n += d.length) > 1048576) sock.destroy(new Error('camera list too big')); });
        sock.on('error', reject);
        sock.on('close', () => {
            const b = Buffer.concat(bufs);
            if (!b.length) return reject(new Error(REFUSED));
            try {
                const a = JSON.parse(b.toString('utf8'));
                if (!Array.isArray(a)) throw new Error();
                resolve(a.filter((x) => x && Number.isInteger(x.i)).map((x) => ({ i: x.i, name: str(x.name), label: str(x.label || x.name),
                    shape: SHAPES.indexOf(x.shape) >= 0 ? x.shape : 'wide', w: px(x.w), h: px(x.h),
                    roles: Array.isArray(x.roles) ? ROLES.filter((r) => x.roles.indexOf(r) >= 0) : [] })));
            } catch (e) { reject(new Error('bad answer from the server')); }
        });
    });
}
const str = (v) => String(v == null ? '' : v).slice(0, 60);

/* ---- the server's hello, asked once per server and code after a list it answered ---- */
let srvInfo = null, srvKey = null, srvTz = null;    // srvInfo: { proto, caps } ({} while asked)
const tzOk = (v) => Number.isInteger(v) && Math.abs(v) <= 840;
const helloEv = () => ({ ev: 'hello', daemon: VERSION, proto: srvInfo && srvInfo.proto ? srvInfo.proto : null, caps: srvInfo && srvInfo.caps ? srvInfo.caps : [], tz: srvTz, audio: audioCaps() });
/** what the car can do of the server's listen / talk: the sound helper's socket is there (the tool installs it) */
/** listen / talk: the server able to, and the sound helper able to (its config's sources and player, a mic lease) */
function audioCaps() {
    const caps = srvInfo && srvInfo.caps ? srvInfo.caps : [];
    return ['listen', 'talk'].filter((x) => caps.indexOf(x) >= 0 && (x === 'listen' ? hlpCaps.play : hlpCaps.mic));
}
/** asks the helper what it could do, at each app's hello and the server's (no socket: nothing, not installed or not enabled) */
let hlpCaps = { play: false, mic: false };
function helperCaps() {
    const set = (c) => { if (c.play === hlpCaps.play && c.mic === hlpCaps.mic) return; hlpCaps = c; broadcast(helloEv()); };
    if (!fs.existsSync(AUDIO)) return set({ play: false, mic: false });
    const h = net.connect(AUDIO);
    h.on('error', () => {});
    h.on('connect', () => h.write(JSON.stringify({ cmd: 'caps' }) + '\n'));
    firstLine(h, 3000, (e, o) => { h.destroy(); set(!e && o && o.ev === 'caps' ? { play: o.play === true, mic: o.mic === true } : { play: false, mic: false }); });
}
function setTz(v) { if (tzOk(v) && v !== srvTz) { srvTz = v; broadcast(helloEv()); } }
/** After a list that worked: no bytes to hello = an older server (proto 1); a refused car never gets here. */
function greet() {
    let c;
    try { c = conf(); } catch (e) { return; }
    const key = c.host + ':' + c.port + ' ' + c.token;
    if (srvKey === key) return;
    srvKey = key; srvInfo = {}; srvTz = null;
    ask('hello', 65536).then((b) => {
        if (srvKey !== key) return;
        let o = null;
        try { o = b.length ? JSON.parse(b.toString('utf8')) : null; } catch (e) { /* proto 1 */ }
        const v2 = o && o.ev === 'hello' && Number.isInteger(o.proto) && o.proto >= 2;
        srvInfo = { proto: v2 ? o.proto : 1, caps: v2 && Array.isArray(o.caps) ? o.caps.filter((x) => typeof x === 'string').slice(0, 16).map(str) : [] };
        if (v2 && tzOk(o.tz)) srvTz = o.tz;
        log('server: proto ' + srvInfo.proto + (srvTz === null ? '' : ', tz ' + srvTz));
        helperCaps();
        broadcast(helloEv());
    }, (e) => { if (srvKey === key) srvKey = null; log('hello:', e.message); });
}
const px = (v) => (Number.isInteger(v) && v > 0 && v <= 16384 ? v : null);       // null: an older server (no size)

/* ---- the pane's order (serve.py arrange()): order[0] the camera at home in the hero's place, then the pane ---- */
/** The order with the hero in front, as the server arranges it (the hero and order[0] trade places). */
function effective(order, hero) {
    const p = order.slice(), k = p.indexOf(hero);
    if (k > 0) { p[k] = p[0]; p[0] = hero; }
    return p;
}
/** The order after camera a was dropped on b (ids: every camera, hero: the one shown big): a and b trade places as
 *  the user sees them; kept with the hero in front so that it reads the same whatever the hero is later. */
function swapped(order, ids, hero, a, b) {
    // none yet: the server's own (the hero, then the others in camera order)
    const base = (order || [hero]).filter((i, k, o) => ids.indexOf(i) >= 0 && o.indexOf(i) === k);
    ids.forEach((i) => { if (base.indexOf(i) < 0) base.push(i); });
    const p = effective(base, hero);
    const ka = p.indexOf(a), kb = p.indexOf(b);
    if (ka < 0 || kb < 0 || a === b) return p;
    p[ka] = b; p[kb] = a;
    return p;
}
let order = null;
try { const o = JSON.parse(fs.readFileSync(ORDER, 'utf8')); if (Array.isArray(o) && o.every(Number.isInteger)) order = o.slice(0, 64); } catch (e) { /* none yet */ }
function saveOrder(o) {
    order = o;
    try { fs.writeFileSync(ORDER + '.tmp', JSON.stringify(o), { mode: 0o600 }); fs.renameSync(ORDER + '.tmp', ORDER); } catch (e) { log('order.json:', e.message); }
}

/* ---- the hero: pure, so the test can call it ---- */
/** Night = before sunrise or after sunset (NOAA's approximation without the equation of time: a few minutes off). */
function isNight(d, lat, lon) {
    const r = Math.PI / 180;
    const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
    const decl = 23.44 * r * Math.sin(2 * Math.PI * (284 + doy) / 365);
    const cosH = (Math.sin(-0.833 * r) - Math.sin(lat * r) * Math.sin(decl)) / (Math.cos(lat * r) * Math.cos(decl));
    if (cosH <= -1) return false;                       // midnight sun
    if (cosH >= 1) return true;                         // polar night
    const half = Math.acos(cosH) / r / 15, noon = 12 - lon / 15, h = d.getUTCHours() + d.getUTCMinutes() / 60;
    return h < noon - half || h > noon + half;
}
/** { hero, why, event } from the events (newest last), the cameras (their roles), the user's pick, home (bool | null). */
function chooseHero(evs, list, pick, home, now, night) {
    const role = (r) => { const c = list.find((x) => (x.roles || []).indexOf(r) >= 0); return c ? c.i : null; };
    const doorCam = role('door');
    const latest = (ms, f) => { for (let k = evs.length - 1; k >= 0; k--) if (now - evs[k].ts <= ms && f(evs[k])) return evs[k]; return null; };
    const door = latest(120000, (e) => e.type === 'ring' || (e.type === 'person' && doorCam !== null && e.cam === doorCam));
    if (door && (door.type === 'ring' || pick === null)) return { hero: doorCam !== null ? doorCam : door.cam, why: door.type === 'ring' ? 'ring' : 'person', event: door };
    if (pick !== null) return { hero: pick, why: 'picked', event: null };
    const garage = home === true ? role('garage') : null;
    const e = latest(600000, (x) => ['person', 'vehicle', 'animal', 'package'].indexOf(x.type) >= 0 && x.cam !== garage);
    if (e) return { hero: e.cam, why: 'event', event: e };
    const d = night && role('night') !== null ? role('night') : role('day');
    return { hero: d !== null ? d : 0, why: 'default', event: null };
}
/** The car on the home Wi-Fi (mgu-uplink's status.json): true / false, null when unknown (no homeSsid, no file). */
function atHome(c) {
    if (!c || !c.homeSsid) return null;
    try {
        const w = JSON.parse(fs.readFileSync(UPLINK, 'utf8')).wifi || {};
        return (w.link === 'online' || w.link === 'connected') && w.ssid === c.homeSsid;
    } catch (e) { return null; }
}
function rehero() {
    if (!cams.length && !(want && want.view === 'spot')) return;     // the rules need the roles (the list comes first)
    let c = null;
    try { c = conf(); } catch (e) { /* defaults */ }
    const now = Date.now(), home = atHome(c), night = !!(c && c.lat !== null) && isNight(new Date(now), c.lat, c.lon);
    const h = Object.assign(chooseHero(events, cams, picked, home, now, night), { night, home });
    if (!hero || ['hero', 'why', 'night', 'home'].some((k) => h[k] !== hero[k]) || (h.event && h.event.ts) !== (hero.event && hero.event.ts)) {
        if (!hero || h.hero !== hero.hero) log('hero', h.hero, '(' + h.why + ')');
        hero = h;
        broadcast(Object.assign({ ev: 'hero' }, hero));
    }
    if (want && want.view === 'spot' && !retryT) go();
}

/* ---- the event feed: one long connection while an app is connected ---- */
let evSock = null, evTimer = null, evTries = 0, evGen = 0;
const event = (e) => (e && Number.isInteger(e.cam) && TYPES.indexOf(e.type) >= 0 && typeof e.ts === 'number' && (e.id === undefined || ID.test(String(e.id)))
    ? { id: e.id === undefined ? null : String(e.id), cam: e.cam, label: str(e.label), type: e.type, ts: e.ts, first: typeof e.first === 'number' ? e.first : e.ts, count: Number.isInteger(e.count) && e.count > 0 ? e.count : 1, thumb: e.thumb === true } : null);
/** A live event in the list: one with the same id (a burst that grew, its picture came) takes that row's place. */
function merge(e) {
    const k = e.id === null ? -1 : events.findIndex((x) => x.id === e.id);
    if (k >= 0) { if (e.thumb && !events[k].thumb) thumbs.delete(e.id); events.splice(k, 1); }
    events = events.concat(e).sort((a, b) => a.ts - b.ts).slice(-50);
}
function eventsOpen() {
    if (!clients.size || evSock || evTimer) return;
    let c;
    try { c = conf(); } catch (e) { return eventsLater(); }
    const gen = ++evGen;
    evSock = 'dialing';
    dial(c).then(({ sock, rest }) => {
        if (gen !== evGen) return sock.destroy();
        evSock = sock;
        sock.write(c.token + ' events\n');
        sock.setTimeout(EVENTS_SILENT_MS, () => sock.destroy());
        let buf = '', got = false, bad = false;
        const data = (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                let m; try { m = JSON.parse(line); } catch (x) { continue; }
                got = true;
                if (tzOk(m.tz)) setTz(m.tz);                   // (a v2 server: the first line and every ping)
                if (m.ev === 'events' && Array.isArray(m.list)) { events = m.list.map(event).filter(Boolean).sort((x, y) => x.ts - y.ts).slice(-50); broadcast({ ev: 'events', list: events }); } else if (m.ev === 'event') {
                    const e = event(m);
                    if (!e) continue;
                    merge(e);
                    broadcast(Object.assign({ ev: 'event' }, e));
                    if (e.type === 'ring' && picked !== null) { log('doorbell: the camera picked gives way'); picked = null; }
                }
                rehero();
            }
            if (buf.length > 1 << 20) buf = '';
        };
        // close and error first, then the bytes: a line that throws closes the feed, which is dialed again (it used to
        // throw before the handlers were on, leaving evSock set and the feed dead)
        const take = (d) => { try { data(d); } catch (e) { bad = true; log('events: bad line:', e.message); sock.destroy(); } };
        sock.setEncoding('utf8');
        sock.on('error', () => {});
        sock.on('close', () => { if (gen !== evGen) return; log('events: feed closed'); evSock = null; if (got && !bad) evTries = 0; eventsLater(); });
        sock.on('data', take);
        if (rest.length) take(rest.toString('utf8'));
    }, (e) => { if (gen === evGen) { log('events: dial failed:', e && e.message); evSock = null; eventsLater(); } });
}
/** The feed's watchdog (every 30 s): an app connected, no redial planned, and no feed (or a dead one, or a dial stuck
 *  over 30 s) -> dial again. */
let evDialT = 0;
function eventsWatch() {
    if (!clients.size || evTimer) return;
    if (evSock === 'dialing') {
        if (!evDialT) evDialT = Date.now();
        else if (Date.now() - evDialT > 30000) { log('events: watchdog, dial stuck'); evGen++; evSock = null; evDialT = 0; eventsOpen(); }
        return;
    }
    evDialT = 0;
    if (evSock && !evSock.destroyed) return;
    log('events: watchdog, feed was ' + (evSock ? 'a dead socket' : 'down') + ', dialing');
    evSock = null; eventsOpen();
}
function eventsLater() {
    if (!clients.size || evTimer) return;
    const B = hidden ? BACKOFF_HIDDEN : BACKOFF, ms = B[Math.min(evTries++, B.length - 1)];
    evTimer = setTimeout(() => { evTimer = null; eventsOpen(); }, ms);
}
function eventsClose() {
    evGen++;
    clearTimeout(evTimer); evTimer = null;
    if (evSock && evSock !== 'dialing') evSock.destroy();
    evSock = null; evTries = 0;
}

/* ---- an event's picture: `<token> thumb <id>` -> JPEG then close (nothing: none); 160x90 RGBA for the app ---- */
const thumbs = new Map();        // id -> Buffer (RGBA) | null (none): an LRU, the most recent last
const thumbWait = new Map();     // id -> [ctl connections] waiting for it
const thumbQ = [];
let thumbJobs = 0;
function thumbSend(c, id, rgba) {
    if (c.destroyed) return;
    send(c, rgba ? { ev: 'thumb', id, w: THUMB_W, h: THUMB_H, rgba: rgba.toString('base64') } : { ev: 'thumb', id, none: true });
}
function thumb(c, id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('bad thumb id');
    const e = events.find((x) => x.id === id);
    if (e && !e.thumb) return thumbSend(c, id, null);                // the server has none (yet: an update says)
    if (thumbs.has(id) && (thumbs.get(id) || !e)) { const v = thumbs.get(id); thumbs.delete(id); thumbs.set(id, v); return thumbSend(c, id, v); }
    if (thumbWait.has(id)) return thumbWait.get(id).push(c);
    thumbWait.set(id, [c]);
    thumbQ.push(id);
    thumbRun();
}
function thumbRun() {
    while (thumbJobs < THUMB_JOBS && thumbQ.length) {
        const id = thumbQ.shift();
        thumbJobs++;
        ask('thumb ' + id, THUMB_MAX).then((jpeg) => (jpeg.length ? scale(decodeJpeg(jpeg, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 2, maxMemoryUsageInMB: 32 })) : null))
            .catch((e) => { log('thumb', id + ':', e.message); return undefined; })
            .then((v) => {
                thumbJobs--;
                if (v !== undefined) { thumbs.set(id, v); while (thumbs.size > THUMB_LRU) thumbs.delete(thumbs.keys().next().value); }
                const cs = thumbWait.get(id) || [];
                thumbWait.delete(id);
                cs.forEach((c) => thumbSend(c, id, v || null));
                thumbRun();
            });
    }
}
/** `<token> <req>`: the whole answer, until the server closes (at most max bytes). */
async function ask(req, max) {
    const c = conf();
    const { sock, rest } = await dial(c);
    sock.write(c.token + ' ' + req + '\n');
    return new Promise((resolve, reject) => {
        const bufs = [rest];
        let n = rest.length;
        sock.setTimeout(10000, () => sock.destroy(new Error('no answer')));
        sock.on('data', (d) => { n += d.length; if (n > max) sock.destroy(new Error('over ' + max + ' bytes')); else bufs.push(d); });
        sock.on('error', reject);
        sock.on('close', (err) => { if (!err) resolve(Buffer.concat(bufs)); });
    });
}
/** A decoded picture (any size) as THUMB_W x THUMB_H RGBA, each pixel the mean of its box. */
function scale(img) {
    const out = Buffer.alloc(THUMB_W * THUMB_H * 4), sw = img.width, sh = img.height, d = img.data;
    for (let y = 0; y < THUMB_H; y++) {
        const y0 = Math.floor(y * sh / THUMB_H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / THUMB_H));
        for (let x = 0; x < THUMB_W; x++) {
            const x0 = Math.floor(x * sw / THUMB_W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / THUMB_W));
            let r = 0, g = 0, b = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const s = (yy * sw + xx) * 4; r += d[s]; g += d[s + 1]; b += d[s + 2]; }
            const k = (x1 - x0) * (y1 - y0), o = (y * THUMB_W + x) * 4;
            out[o] = r / k; out[o + 1] = g / k; out[o + 2] = b / k; out[o + 3] = 255;
        }
    }
    return out;
}

/* ---- Listen and Talk: the server's PCM <-> the sound helper (jap-ridewatch-audio) ---- */
const AUDIO_HELD = 24000;        // 0.5 s of 24 kHz s16le held toward the helper; more is dropped (live sound)
const TALK_HELD = 32000;         // 1 s of 16 kHz toward the server
const TALK_MS = 61000;           // backstop: the server ends a talk after its max (60 s)
const AUDIO_FIRST_MS = 15000;    // the server sends its listen line once sound flows (10 s at most)
const BUSY_RETRY_MS = 5000, BUSY_FOR_MS = 75000;   // a listen the server still holds (a dead tunnel's, until TCP keepalive)
const WHY = /^[a-z]{1,16}$/;
const aud = { listen: null, talk: null };
let audWhy = null, levelT = 0, levelSq = 0, levelN = 0, halted = null;   // halted: stopped for moving / hidden (no sound then)
const phase = (a) => (!a ? 'off' : a.up ? 'on' : 'starting');
const audioEv = () => ({ ev: 'audio', state: aud.talk && aud.talk.up ? 'talking' : aud.listen && aud.listen.up ? 'listening' : 'off',
    listen: phase(aud.listen), talk: phase(aud.talk), cam: (aud.talk || aud.listen || { cam: null }).cam, why: audWhy, max: TALK_MS / 1000 - 1 });
/** s16le: whole samples only; an odd byte waits in o.odd for the next chunk */
function whole(o, d) {
    if (o.odd) { d = Buffer.concat([o.odd, d]); o.odd = null; }
    if (d.length & 1) { o.odd = d.slice(d.length - 1); d = d.slice(0, d.length - 1); }
    return d;
}
/** the level of what is piped (s16le), sent 5 times a second at most */
function level(b) {
    for (let i = 0; i + 1 < b.length; i += 8) { const v = b.readInt16LE(i); levelSq += v * v; levelN++; }
    const now = Date.now();
    if (now - levelT < 200 || !levelN) return;
    broadcast({ ev: 'level', v: Math.min(1, Math.round(Math.sqrt(levelSq / levelN) / 3277 * 100) / 100) });
    levelT = now; levelSq = 0; levelN = 0;
}
/** one JSON line from sock (at most 4 KiB, within ms), then cb(err, obj, rest) with the bytes after it */
function firstLine(sock, ms, cb) {
    let buf = Buffer.alloc(0), done = false;
    const end = (e, o, rest) => { if (done) return; done = true; clearTimeout(t); sock.removeListener('data', on); cb(e, o, rest); };
    const t = setTimeout(() => end(new Error('timeout')), ms);
    const on = (d) => {
        buf = Buffer.concat([buf, d]);
        const k = buf.indexOf(10);
        if (k < 0) { if (buf.length > 4096) end(new Error('line too long')); return; }
        let o = null;
        try { o = JSON.parse(buf.slice(0, k).toString('utf8')); } catch (e) { return end(new Error('not JSON')); }
        end(null, o, buf.slice(k + 1));
    };
    sock.on('data', on);
    sock.on('close', () => end(new Error('closed')));
}
function audioStart(kind, cam) {
    if (audioCaps().indexOf(kind) < 0) throw new Error('no ' + kind + ' on this server or car');
    if (!Number.isInteger(cam) || cam < 0 || cam >= 64) throw new Error('bad camera');
    if (halted) { audWhy = halted; return broadcast(audioEv()); }
    const was = aud[kind];
    if (was && was.cam === cam) return broadcast(audioEv());
    if (was) audioEnd(was, null);
    const a = aud[kind] = { kind, cam, srv: null, hlp: null, up: false, done: false, t0: Date.now(), tOk: 0, timer: null, odd: null };
    audWhy = null;
    broadcast(audioEv());
    audioDial(a);
}
function audioDial(a) {
    let c;
    try { c = conf(); } catch (e) { return audioEnd(a, 'server'); }
    log(a.kind, a.cam);
    dial(c).then(({ sock, rest }) => {
        if (a.done) return sock.destroy();
        a.srv = sock;
        sock.on('error', () => {});
        sock.write(c.token + ' ' + a.kind + ' ' + a.cam + '\n');
        firstLine(sock, AUDIO_FIRST_MS, (e, o, more) => {
            if (a.done) return;
            if (e) return audioEnd(a, 'server');
            if (!o || o.ev !== a.kind) return audioEnd(a, 'server');
            if (o.error !== undefined) {
                const why = WHY.test(o.error) ? o.error : 'server';
                // busy right after a drop: the server still holds the dead tunnel's listen; again in 5 s, for 75 s
                if (why === 'busy' && a.kind === 'listen' && Date.now() - a.t0 < BUSY_FOR_MS) {
                    sock.destroy(); a.srv = null;
                    log('listen: busy on the server, again in ' + BUSY_RETRY_MS / 1000 + ' s');
                    a.timer = setTimeout(() => { if (!a.done) audioDial(a); }, BUSY_RETRY_MS);
                    return;
                }
                return audioEnd(a, why);
            }
            const rate = a.kind === 'talk' ? 16000 : o.rate;
            if ((a.kind === 'talk' && o.ok !== true) || [16000, 24000, 48000].indexOf(o.rate) < 0 || o.ch !== 1 || o.fmt !== 's16le' || o.rate !== rate) return audioEnd(a, 'server');
            // a talk the server closed at its cap (60 s from its answer) said as max; any other close: server
            sock.on('close', () => audioEnd(a, a.kind === 'talk' && Date.now() - a.tOk >= 59000 ? 'max' : 'server'));
            a.tOk = Date.now();
            audioHelper(a, rate, Buffer.concat([rest, more]));
        });
    }, () => audioEnd(a, 'tunnel'));
}
function audioHelper(a, rate, early) {
    const h = a.hlp = net.connect(AUDIO);
    h.on('error', () => {});
    h.on('connect', () => h.write(JSON.stringify(a.kind === 'listen' ? { cmd: 'play', rate } : { cmd: 'mic' }) + '\n'));
    firstLine(h, 10000, (e, o, more) => {
        if (a.done) return;
        if (e || !o || o.ev !== (a.kind === 'listen' ? 'play' : 'mic')) return audioEnd(a, 'helper');
        if (o.ok !== true) return audioEnd(a, WHY.test(o.why) ? o.why : 'helper');
        a.up = true;
        broadcast(audioEv());
        log(a.kind, a.cam, 'on');
        if (a.kind === 'listen') {
            // the helper's lines from now on: its end ({"ev":"end","why"}); the server's PCM goes to it
            firstLine(h, 24 * 3600e3, (e2, o2) => { if (!e2 && o2 && o2.ev === 'end') audioEnd(a, WHY.test(o2.why) ? o2.why : 'helper'); });
            // whole samples before any drop (an odd chunk dropped would shift every sample after it)
            const pipe = (d) => { if (a.done) return; d = whole(a, d); level(d); if (d.length && h.writableLength < AUDIO_HELD) h.write(d); };
            if (early.length) pipe(early);
            a.srv.on('data', pipe);
        } else {
            const pipe = (d) => { if (a.done) return; d = whole(a, d); level(d); if (d.length && a.srv.writableLength < TALK_HELD) a.srv.write(d); };
            if (more.length) pipe(more);
            h.on('data', pipe);
            a.timer = setTimeout(() => audioEnd(a, 'max'), TALK_MS);
        }
        h.on('close', () => audioEnd(a, a.kind === 'talk' ? 'returned' : 'helper'));
    });
}
/** why: null for an end asked by the app (unlisten, untalk, another camera) */
function audioEnd(a, why) {
    if (a.done) return;
    a.done = true;
    clearTimeout(a.timer);
    if (aud[a.kind] === a) aud[a.kind] = null;
    if (a.hlp) a.hlp.destroy();                        // the helper's end: player stopped and released, the mic returned
    // talk: EOF, the server finishes what it got; listen: the close ends the server's ffmpeg
    if (a.srv) { if (a.kind === 'talk') { const s = a.srv; s.end(); setTimeout(() => s.destroy(), 2000).unref(); } else a.srv.destroy(); }
    if (why !== undefined) audWhy = why;
    log(a.kind, a.cam, 'off' + (why ? ' (' + why + ')' : ''));
    broadcast(audioEv());
}
function audioStop(why) { ['talk', 'listen'].forEach((k) => { if (aud[k]) audioEnd(aud[k], why); }); }

/* ---- Annex-B: start codes (00 00 01; a 4-byte one's leading zero counts as the NAL before's trailing zero) ---- */
/** [{ at, type }] of the start codes in b whose type byte is in b, from index `from`. */
function starts(b, from) {
    const r = [];
    for (let i = from; i + 3 < b.length; i++) {
        if (b[i + 2] > 1) { i += 2; continue; }
        if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) r.push({ at: i, type: b[i + 3] & 0x1f });
    }
    return r;
}
/** Index of the last start code in b at or after `from`, -1 if none (its type byte may still be coming). */
function lastStart(b, from) {
    for (let i = b.length - 3; i >= from; i--) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) return i;
    return -1;
}

/** Layout line from the server (trust boundary): numbers and short strings only. */
function parseLayout(s) {
    const o = JSON.parse(s), n = (v) => typeof v === 'number' && isFinite(v);
    const rect = (r) => (r && n(r.x) && n(r.y) && n(r.w) && n(r.h) ? { x: r.x, y: r.y, w: r.w, h: r.h } : null);
    if (!o || !n(o.w) || !n(o.h) || !Array.isArray(o.tiles)) throw new Error('bad layout');
    const tiles = o.tiles.filter((t) => t && Number.isInteger(t.i) && rect(t)).map((t) => Object.assign({ i: t.i, name: str(t.name), label: str(t.label || t.name) },
        rect(t), { shape: SHAPES.indexOf(t.shape) >= 0 ? t.shape : 'wide' }));
    return { w: o.w, h: o.h, hero: Number.isInteger(o.hero) ? o.hero : null, heroRect: rect(o.heroRect), pane: rect(o.pane), tiles };
}
/** A clip's line from the server (trust boundary): { error: code } or { id, cam, label, type, start, dur }. */
function parseClip(s) {
    const o = JSON.parse(s), n = (v) => typeof v === 'number' && isFinite(v);
    if (!o || o.ev !== 'clip') throw new Error('bad clip line');
    if (o.error !== undefined) return { error: str(o.error) };
    if (!n(o.start) || !n(o.dur) || o.dur <= 0) throw new Error('bad clip line');
    return { id: str(o.id), cam: Number.isInteger(o.cam) ? o.cam : null, label: str(o.label), type: TYPES.indexOf(o.type) >= 0 ? o.type : null, start: o.start, dur: o.dur };
}

/* ---- a view's connection ---- */
/** The request (without the token) for a view: the spot's hero is ours. */
function reqOf(w) {
    if (w.view === 'clip') return 'clip ' + w.id + ' ' + w.rect;
    if (w.view === 'spot') return 'spot ' + (hero ? hero.hero : 0) + ' ' + (order ? 'o=' + order.join(',') + ' ' : '') + w.rect;
    return (w.view === 'mosaic' ? 'mosaic2 ' : 'cam ' + w.view + ' ') + w.rect;
}
function open(w) {
    const req = reqOf(w);
    const conn = next = { w, req, sock: null, line: /^(spot|mosaic2|clip) /.test(req) ? [] : null, lineLen: 0, layout: null, parts: [], len: 0, carry: null, sps: -1, held: null, why: null, bytes: 0 };
    setState('connecting');
    let c;
    try { c = conf(); } catch (e) { return closed(conn, e.message); }
    log('view', req);
    dial(c).then(({ sock, rest }) => {
        if (next !== conn) return sock.destroy();
        conn.sock = sock;
        const first = w.view === 'clip' ? CLIP_FIRST_MS : FIRST_MS;
        sock.setTimeout(first, () => { conn.why = conn.why || (conn === cur ? 'stream stalled' : 'no picture from the server in ' + first / 1000 + ' s'); sock.destroy(); });
        sock.on('data', (d) => onData(conn, d));
        sock.on('error', (e) => { conn.why = conn.why || e.message; });
        sock.on('close', () => closed(conn, conn.why || (conn.bytes ? 'connection lost' : REFUSED)));
        sock.write(c.token + ' ' + req + '\n');
        if (rest.length) onData(conn, rest);
    }, (e) => closed(conn, 'tunnel: ' + e.message));
}

function fail(conn, why) { conn.why = why; if (conn.sock) conn.sock.destroy(); else closed(conn, why); }

function onData(conn, d) {
    conn.bytes += d.length;
    if (conn === cur) { rx += d.length; return live(d); }
    if (conn !== next) return;
    if (conn.line) {                                   // spot / mosaic2 / clip: the server's line before the H.264
        const k = d.indexOf(10);
        if (k < 0) {
            conn.line.push(d); conn.lineLen += d.length;
            if (conn.lineLen > 65536) fail(conn, 'bad layout from the server');
            return;
        }
        conn.line.push(d.slice(0, k));
        const txt = Buffer.concat(conn.line).toString('utf8');
        if (conn.w.view === 'clip') {
            try { conn.clip = parseClip(txt); } catch (e) { conn.clipErr = 'Video unavailable (bad answer from the server)'; return fail(conn, 'bad clip line'); }
            if (conn.clip.error) { conn.clipErr = CLIP_ERR.hasOwnProperty(conn.clip.error) ? CLIP_ERR[conn.clip.error] : 'Video unavailable'; return fail(conn, 'server: ' + conn.clip.error); }
        } else {
            try { conn.layout = parseLayout(txt); } catch (e) { return fail(conn, 'bad layout from the server'); }
        }
        conn.line = null;
        d = d.slice(k + 1);
    }
    // held until the first IDR; the start codes found across chunks (carry: the last 3 bytes)
    const base = conn.len - (conn.carry ? conn.carry.length : 0), s = conn.carry ? Buffer.concat([conn.carry, d]) : d;
    conn.parts.push(d); conn.len += d.length;
    conn.carry = s.slice(Math.max(0, s.length - 3));
    for (const n of starts(s, 0)) {
        if (n.type === 7) conn.sps = base + n.at;
        if (n.type === 5 && conn.sps >= 0) return switchTo(conn, Buffer.concat(conn.parts).slice(conn.sps));
    }
    if (conn.len > MAX_PENDING) fail(conn, 'no picture start from the server');
}

/** The new stream's first IDR is in: camdec reads it from its SPS on, the old connection goes. */
function switchTo(conn, data) {
    const old = cur;
    cur = conn; next = null;
    conn.parts = null; conn.carry = null;
    if (old) old.sock.destroy();                       // (its rest after the last start code is dropped)
    paused = false;
    conn.sock.setTimeout(SILENT_MS);
    layout = conn.layout;
    if (layout) broadcast(Object.assign({ ev: 'layout' }, layout));
    if (conn.clip) broadcast(Object.assign({ ev: 'clip' }, conn.clip));
    decoder();
    stall = { shown: -1, bytes: conn.bytes, t: Date.now(), first: true };   // (a new stream: from its first IDR)
    rx = data.length; rxT = Date.now();
    write(data);
    setState('playing');
    log('playing', conn.req);
}

/** Bytes of the live stream; while another view connects, only whole NALs (cut before the last start code). */
function live(d) {
    if (!next) {
        if (cur.held) { d = Buffer.concat([cur.held, d]); cur.held = null; }
        return write(d);
    }
    const b = cur.held ? Buffer.concat([cur.held, d]) : d;
    const k = lastStart(b, cur.held ? 1 : 0);
    if (k < 0) { cur.held = b; return; }
    write(b.slice(0, k));
    cur.held = b.slice(k);
}

function write(b) {
    if (!dec || !b.length) return;
    if (dec.stdin.write(b) || !cur || paused) return;
    paused = true;
    const s = cur.sock;
    s.pause();
    dec.stdin.once('drain', () => { paused = false; s.resume(); });
}

/** A connection ended: ours (the one shown or the one opening) -> retry with backoff; the picture stays meanwhile. */
function closed(conn, why) {
    if (conn !== cur && conn !== next) return;
    const played = conn === cur;
    if (conn === cur) cur = null; else next = null;
    if (!want || next) return;                         // stopped, or another one is on its way
    if (conn.w.view === 'clip') {                      // a recording plays once: its end (or a drop) is the end
        log('clip', conn.req, played ? 'ended' : 'failed: ' + why);
        return played ? setState('ended') : setState('error', conn.clipErr || 'Video unavailable (' + why + ')');
    }
    log('view', conn.req, 'ended:', why);
    retry(why);
}
function retry(why) {
    const ms = BACKOFF[Math.min(tries, BACKOFF.length - 1)];
    tries++;
    let say = why, p = null;                           // the refused car's code: shown, never logged
    if (why === REFUSED) try { const c = conf(); p = pairOf(c); say = 'Server refused this car: add code ' + c.token + ' on the server'; } catch (e) { /* the why */ }
    setState('error', say + ' - retry in ' + ms / 1000 + ' s', p);
    clearTimeout(retryT);
    retryT = setTimeout(() => { retryT = null; if (want && !next && !cur) open(want); else if (want) go(); }, ms);
}

/* ---- camdec ---- */
const EXIT = { 1: 'decoder init failed', 2: 'decoder: bad arguments or video file not writable', 70: 'decoder crashed' };
function decoder() {
    if (dec) return;
    const c = dec = spawn(BIN, ['--out', VIDEO], { stdio: ['pipe', 'pipe', 'inherit'] });
    let ended = false;
    const end = (code) => {
        if (ended) return;
        ended = true;
        const mine = dec === c;                        // (not one stopped or let go by the watchdog)
        if (mine) { dec = null; paused = false; }
        log('camdec exited', code);
        if (mine && want && cur && cur.sock) fail(cur, EXIT[code] || 'decoder exited (' + code + ')');   // a fresh connection: a fresh IDR
    };
    c.stdin.on('error', () => { /* it died: exit says */ });
    let buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let e; try { e = JSON.parse(line); } catch (x) { continue; }
            if (e.ev === 'stats') {
                if (c !== dec) continue;
                if (stall && e.shown !== stall.shown) {
                    const pic = stall.shown >= 0;              // (not the first stats since the switch)
                    if (cur && pic) tries = 0;                 // a picture shown: the backoff starts again from 1 s
                    stall = { shown: e.shown, bytes: cur ? cur.bytes : 0, t: Date.now(), first: stall.first && !pic };
                }
                const now = Date.now(), kbps = Math.round(rx * 8 / Math.max(1, now - rxT));
                rx = 0; rxT = now;
                broadcast(Object.assign({}, e, { ev: 'stats', kbps }));
            } else if (e.ev === 'ready') log('camdec ready', e.w + 'x' + e.h, e.fps + ' fps');
            else if (e.ev === 'error') log('camdec:', String(e.msg).slice(0, 200));
        }
        if (buf.length > 1 << 16) buf = '';
    });
    c.on('exit', (code, sig) => end(sig || code));
    c.on('error', (e) => { log('camdec spawn failed:', e.message); end(-1); });
}

/**
 * The frame watchdog (RideTube's idea): camdec's `shown` flat for STALL_MS while the stream's bytes still came (a
 * stream it cannot decode, or camdec stuck: a hung one prints no stats either) -> the stream fails and reconnects with
 * the backoff, on a new camdec. shortcut: clips are not watched (closed() would say a cut clip "ended"); add a clip
 * error there if a recording ever stalls.
 */
function watchdog() {
    if (!cur || !cur.sock || !dec || !stall || state !== 'playing' || cur.w.view === 'clip') return;
    // a new stream's first picture gets FIRST_MS (a new camdec's MSDK start is not measured on the car)
    if (Date.now() - stall.t < (stall.first ? FIRST_MS : STALL_MS) || cur.bytes === stall.bytes) return;
    log('watchdog: no new picture for ' + STALL_MS / 1000 + ' s while the stream sends (' + (cur.bytes - stall.bytes) + ' bytes)');
    const c = dec;
    dec = null; paused = false; stall = null;
    fail(cur, 'picture stalled');
    c.kill('SIGKILL');
}

/* ---- commands ---- */
function stop(why, keepPick, audioWhy) {
    audioStop(audioWhy || 'gone');
    if (why && (want || dec)) log('stop:', why);
    want = null;
    if (!keepPick) picked = null;                      // the pick lasts while the user is in the app (driving off keeps it)
    clearTimeout(retryT); retryT = null;
    for (const c of [cur, next]) if (c && c.sock) c.sock.destroy();
    cur = next = null; layout = null;
    if (dec) {
        const c = dec;
        dec = null;
        c.stdin.end();
        setTimeout(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); }, 1000);
    }
    if (state !== 'idle') setState('idle');
}

/** Bring the stream to what `want` asks now (a new view, or the spot's new hero). */
function go() {
    const req = reqOf(want);
    if (next && next.req === req) return;
    if (cur && cur.req === req && !next) return;
    tries = 0;
    clearTimeout(retryT); retryT = null;
    if (next) { const n = next; next = null; if (n.sock) n.sock.destroy(); }
    if (cur && cur.req === req) {                                   // back to what still plays
        if (cur.held) { write(cur.held); cur.held = null; }
        if (layout) broadcast(Object.assign({ ev: 'layout' }, layout));
        return setState('playing');
    }
    open(want);
}

function view(m) {
    const v = m.view === 'mosaic' || m.view === 'spot' || m.view === 'clip' ? m.view : Number.isInteger(m.view) && m.view >= 0 && m.view < 64 ? m.view : null;
    const r = /^(\d{2,4})x(\d{2,4})$/.exec(String(m.rect || ''));
    if (v === null || !r || +r[1] > 2048 || +r[2] > 2048 || r[1] % 2 || r[2] % 2) throw new Error('bad view or rect');
    const id = v === 'clip' ? m.id : undefined;
    if (v === 'clip' && (typeof id !== 'string' || !ID.test(id))) throw new Error('bad clip id');
    if (want && want.view === v && want.id === id && want.rect === r[0] && (cur || next || retryT)) return;   // already there or on its way
    want = { view: v, rect: r[0], id };
    halted = null;
    if (hidden) { hidden = false; if (evTimer) { clearTimeout(evTimer); evTimer = null; evTries = 0; eventsOpen(); } }   // shown again: the feed now
    if (v === 'spot' && !hero) rehero();
    go();
}

async function handle(c, m) {
    switch (m.cmd) {
    case 'status':
        send(c, stateEv());
        if (layout && cur) send(c, Object.assign({ ev: 'layout' }, layout));
        if (hero) send(c, Object.assign({ ev: 'hero' }, hero));
        send(c, audioEv());
        return send(c, { ev: 'events', list: events });
    case 'list': cams = await list(); broadcast({ ev: 'list', cams }); greet(); return rehero();
    case 'hello': helperCaps(); return send(c, helloEv());
    case 'view': return view(m);
    case 'config': return configure(m);
    case 'pick':
        if (!Number.isInteger(m.cam) || m.cam < 0 || m.cam >= 64) throw new Error('bad camera');
        picked = m.cam;
        return rehero();
    case 'thumb': return thumb(c, m.id);
    case 'swap': {
        const ids = cams.map((x) => x.i), h = hero ? hero.hero : null;
        if (!Number.isInteger(m.a) || !Number.isInteger(m.b) || ids.indexOf(m.a) < 0 || ids.indexOf(m.b) < 0 || h === null) throw new Error('bad swap');
        saveOrder(swapped(order, ids, h, m.a, m.b));
        log('order', order.join(','));
        if (m.b === h || m.a === h) picked = m.a === h ? m.b : m.a;     // onto the hero (or the hero onto a tile): the new hero
        return rehero();
    }
    case 'stop':
        hidden = m.why === 'hidden';
        halted = m.why === 'moving' || m.why === 'hidden' ? m.why : null;
        return stop('asked' + (m.why ? ' (' + String(m.why).slice(0, 20) + ')' : ''), m.why === 'moving', halted);
    case 'listen': case 'talk': return audioStart(m.cmd, m.cam);
    case 'unlisten': case 'untalk': { const a = aud[m.cmd.slice(2)]; if (a) audioEnd(a, null); else broadcast(audioEv()); return; }
    default: throw new Error('unknown cmd');
    }
}

function serve() {
    const srv = net.createServer((c) => {
        clients.add(c);
        eventsOpen();
        // the roles the hero's rules use: before a spot is asked
        if (!cams.length) list().then((l) => { cams = l; greet(); rehero(); }, (e) => log('list:', e.message));
        c.setEncoding('utf8');
        let buf = '';
        c.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                let m; try { m = JSON.parse(line); } catch (e) { continue; }
                if (!m || typeof m.cmd !== 'string') continue;
                handle(c, m).catch((e) => { log(m.cmd, 'failed:', e.message); broadcast({ ev: 'error', cmd: m.cmd, msg: e.message }); });
            }
            if (buf.length > 1 << 16) buf = '';
        });
        c.on('error', () => {});
        c.on('close', () => { clients.delete(c); if (!clients.size) { stop('last app connection gone'); eventsClose(); } });
    });
    srv.on('error', (e) => log('ctl listen failed:', e.message));
    // on the car jap-ridewatch.socket passes ctl.sock as fd 3: root's, for the RideWatch app's uid alone (socklock.sh);
    // a path of its own only outside systemd (tests)
    const fds = process.env.LISTEN_FDS;
    for (const k of ['LISTEN_FDS', 'LISTEN_PID', 'LISTEN_FDNAMES']) delete process.env[k];   // not camdec's
    if (fds) srv.listen({ fd: 3 }, () => log('ctl on fd 3 (' + CTL + ')'));
    else {
        try { fs.unlinkSync(CTL); } catch (e) { /* none */ }
        srv.listen(CTL, () => { try { fs.chmodSync(CTL, 0o660); } catch (e) { /* tmpfs without chmod */ } log('ctl on', CTL); });
    }
    // windows expire and night falls without any event
    setInterval(() => { if (clients.size) rehero(); }, 30000).unref();
    setInterval(watchdog, 1000).unref();
    setInterval(eventsWatch, 30000).unref();
}

if (require.main === module) {
    process.on('uncaughtException', (e) => log('uncaught:', e.stack || e));
    process.on('unhandledRejection', (e) => log('unhandled:', e && e.stack || e));
    process.on('SIGTERM', () => { stop('SIGTERM'); eventsClose(); setTimeout(() => process.exit(0), 1200); });
    try { conf(); } catch (e) { /* no address yet: the code is made all the same */ }
    serve();
}
module.exports = { chooseHero, isNight, parseLayout, scale, effective, swapped, newCode };
