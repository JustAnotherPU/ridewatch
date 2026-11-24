'use strict';
// Offline smoke test of the built jap_ridewatch app (moonlight's test/smoke.js pattern): a stubbed kit ctx (HMI, display in
// the "fill" placement, speed signal), a fake ridewatchd ctl socket and a fake mgu-render socket (native dialect) for CAM.
// Covers concept A (spot layout, hero, pick, events, banner), the timeline (rows, thumbs, scroll, drag, back) and an
// event's clip on CAM (overlay, progress, ended -> Replay / Live, back to the timeline), the config sent to the service,
// 0.4.0: what runs at boot (hidden), the RING pop-up for rings and opt-in detections, the doorbell's quick replies through
// a fake Home Assistant behind a fake SOCKS5 proxy (the real ha.js).
// Build first (./build.sh), then:
//   node test/smoke.js build/kit/dist/jap_ridewatch <tmpdir>     (Node 8: docker run --rm --network none -v $PWD:/w -w /w node:8.16.0-alpine ...)
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const Module = require('module');

const stage = path.resolve(process.argv[2]), tmp = process.argv[3];
const SRC = path.join(stage, 'source', 'javascript');
const spec = JSON.parse(fs.readFileSync(path.join(SRC, 'kit', 'app-spec.json'), 'utf8'));
const CTL = path.join(tmp, 'ctl.sock'), REN = path.join(tmp, 'render.sock'), VID = path.join(tmp, 'mgu-video-ridewatch');
[CTL, REN].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* none */ } });
fs.writeFileSync(VID, Buffer.alloc(64));
process.env.JAP_RIDEWATCH_CTL = CTL; process.env.MGU_RENDERD_SOCKET = REN; process.env.JAP_RIDEWATCH_VIDEO = VID;
process.env.JAP_RIDEWATCH_POP_SCALE = '0.03';   // the pop-up's timers: retry 60 ms, given up / closed after 0.9 s, speed wait 45 ms
const HAJ = path.join(tmp, 'ha.json');
try { fs.unlinkSync(HAJ); } catch (e) { /* none */ }
const haJson = (o, mode) => { fs.writeFileSync(HAJ, JSON.stringify(o)); fs.chmodSync(HAJ, mode === undefined ? 0o600 : mode); };
// the monotonic clock (the door's arm and lock) moved on by hrSkip s, without waiting
let hrSkip = 0;
const hrt = process.hrtime;
process.hrtime = function (p) { const t = hrt.call(process); t[0] += hrSkip; if (!p) return t; let sec = t[0] - p[0], ns = t[1] - p[1]; if (ns < 0) { sec--; ns += 1e9; } return [sec, ns]; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms) { const end = Date.now() + (ms || 3000); while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(10); } }
const logs = [];
const log = { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m), error: (m, e) => { logs.push('E ' + m + ' ' + (e && e.stack || e || '')); }, debug() {} };

/* ---- fake daemon ---- */
const d = { got: [], c: null };
net.createServer((c) => {
    d.c = c; let b = ''; c.setEncoding('utf8');
    c.on('data', (x) => { b += x; let i; while ((i = b.indexOf('\n')) >= 0) { d.got.push(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); } });
    c.on('error', () => {});
}).listen(CTL);
d.send = (o) => d.c.write(JSON.stringify(o) + '\n');
d.cmds = (cmd) => d.got.filter((m) => m.cmd === cmd);
d.last = () => d.got.filter((m) => m.cmd === 'view' || m.cmd === 'stop').slice(-1)[0];

/* ---- fake Home Assistant behind a fake SOCKS5 proxy (whatever address is asked: the HTTP server here) ---- */
const http = require('http');
const has = { reqs: [], to: [], status: 200, delay: 0 };
const haHttp = http.createServer((q, s) => {
    let b = ''; q.setEncoding('utf8');
    q.on('data', (x) => { b += x; });
    q.on('end', () => {
        has.reqs.push({ m: q.method, url: q.url, auth: q.headers.authorization, type: q.headers['content-type'], body: JSON.parse(b || 'null') });
        setTimeout(() => { s.statusCode = has.status; s.end(has.status < 400 ? '[]' : 'no'); }, has.delay);
    });
}).listen(0, '127.0.0.1');
const haSocks = net.createServer((c) => {
    let b = Buffer.alloc(0), stage = 0;
    c.on('error', () => {});
    c.on('data', function on(x) {
        b = Buffer.concat([b, x]);
        if (stage === 0 && b.length >= 3) { b = b.slice(3); stage = 1; c.write(Buffer.from([5, 0])); }
        if (stage === 1 && b.length >= 10) {
            has.to.push(Array.from(b.slice(4, 8)).join('.') + ':' + b.readUInt16BE(8));
            c.removeListener('data', on);
            const up = net.connect(haHttp.address().port, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); if (b.length > 10) up.write(b.slice(10)); c.pipe(up).pipe(c); });
            up.on('error', () => c.destroy());
        }
    });
}).listen(0, '127.0.0.1');

/* ---- fake renderer (CAM's own connection) ---- */
const r = { msgs: [], c: null, hello: null };
net.createServer((c) => {
    r.c = c; let b = Buffer.alloc(0);
    c.on('data', (x) => {
        b = Buffer.concat([b, x]);
        while (b.length >= 8) {
            const t = b.readUInt32LE(0), n = b.readUInt32LE(4);
            if (b.length < 8 + n) break;
            const p = b.slice(8, 8 + n); b = b.slice(8 + n);
            if (t === 1) {
                r.hello = p.toString();
                const xr = Buffer.alloc(52); xr.writeUInt32LE(1, 0); xr.writeUInt32LE(1, 4); xr.writeUInt32LE(1 | 2 | 8 | 16, 8);
                const rd = Buffer.alloc(12); rd.writeUInt32LE(1920, 4); rd.writeUInt32LE(720, 8);
                [[0x4d520101, xr], [101, rd]].forEach((m) => { const h = Buffer.alloc(8); h.writeUInt32LE(m[0], 0); h.writeUInt32LE(m[1].length, 4); c.write(Buffer.concat([h, m[1]])); });
            } else r.msgs.push({ t, p, at: Date.now() });
        }
    });
    c.on('error', () => {});
}).listen(REN);
r.send = (t, p) => { const h = Buffer.alloc(8); h.writeUInt32LE(t, 0); h.writeUInt32LE(p.length, 4); r.c.write(Buffer.concat([h, p])); };
r.types = (t) => r.msgs.filter((m) => m.t === t);
const shownLayer = () => { const s = r.types(3); return s.length ? s[s.length - 1].p.readUInt32LE(0) : 0; };
const ccu = (seq, knob, press, tilt) => { const p = Buffer.alloc(8); p[0] = seq; p.writeUInt16BE(knob, 1); p[3] = press; p[4] = tilt; r.send(0x4d520103, p); };
// the VIDEO op (19) of a FRAME payload / of a recording: [x, y, w, h] where the stream's frame is drawn
const videoAt = (u, f, n) => { for (let i = 0; i + 6 < n; i++) if (u[i] === 19 && u[i + 6] === 1) return [f[i + 1], f[i + 2], f[i + 3], f[i + 4]].map(Math.round); return null; };
const frameVideo = (p) => { const b = Buffer.from(p); return videoAt(new Uint32Array(b.buffer, b.byteOffset, b.length >> 2), new Float32Array(b.buffer, b.byteOffset, b.length >> 2), b.length >> 2); };
const touch = (ph, x, y) => { const p = Buffer.alloc(12); p.writeUInt32LE(ph, 0); p.writeFloatLE(x, 4); p.writeFloatLE(y, 8); r.send(105, p); };

/* ---- stub kit ---- */
const { Recorder } = require(path.join(SRC, 'kit', 'record'));
const rtext = Recorder.prototype.text;
Recorder.prototype.text = function (s, x, y) { (this.said || (this.said = [])).push(String(s)); (this.at || (this.at = [])).push([String(s), x, y]); return rtext.apply(this, arguments); };
const rstroke = Recorder.prototype.strokeRoundRect;
Recorder.prototype.strokeRoundRect = function (x, y, w, h, rr, lw) { (this.strokes || (this.strokes = [])).push([x, y, w, h, lw]); return rstroke.apply(this, arguments); };
const rfill = Recorder.prototype.fillRect;
Recorder.prototype.fillRect = function (x, y, w, h, c) { (this.rects || (this.rects = [])).push([x, y, w, h, c]); return rfill.apply(this, arguments); };
let camCv = null;                 // CAM's recordings: the ones the app makes itself (not the kit's canvas)
const rvideo = Recorder.prototype.video;
Recorder.prototype.video = function () { if (!this.kitCanvas) camCv = this; return rvideo.apply(this, arguments); };
const PL = { x: 0, y: 0, w: 1920, h: 720, full: true, scale: 1.2, ox: 0, oy: 0, extra: 80, touchX: 84 };   // the kit's "fill" placement
const kv = [];                    // the kit renderer's video calls
const clicks = [];
const display = { _click: (id) => clicks.push(id), place: PL, gpu: { native: true, video: (id, p) => kv.push(['video', id, p]), dropVideo: (id) => kv.push(['drop', id]) } };
const visH = [], loops = {};
let failOpen = 0, stack = [], shot = { said: [], targets: [], video: false };
const top = () => stack[stack.length - 1];
const ui = {
    image: (n, cv) => { assert.strictEqual(n, 'VIEW_GFX'); shot = { cv, rects: cv.rects || [], strokes: cv.strokes || [], said: cv.said || [], at: cv.at || [], targets: cv.targets.slice(), video: !!cv.hasVideo, images: Array.from(cv.images), scroll: cv.scroll }; return Promise.resolve(); },
    open: (n) => { if (failOpen > 0) { failOpen--; return Promise.resolve(); }   // the HMI refused (INVALID_COMPONENTID, 05/11)
        const old = top(); stack.push(n); if (old !== n) { if (old) visH.forEach((f) => f(old, false)); visH.forEach((f) => f(n, true)); } return Promise.resolve(); },
    back: () => { const old = stack.pop(); visH.forEach((f) => f(old, false)); if (top()) visH.forEach((f) => f(top(), true)); },
    isVisible: (n) => top() === n, hasFocus: () => true, onVisible: (fn) => visH.push(fn), onFocus() {},
    text: (n, t) => { ring.texts.push([n, t]); return Promise.resolve(); }, onClick: (n, fn) => { ring.clicks[n] = fn; },
    close: (n) => { ring.closed.push(n); return Promise.resolve(); },
    // the HMI's own calls (the pop-up): RING / VIEW refused n times (INVALID_COMPONENTID: a Check Control message)
    rhmi: { openState: (n) => {
        const no = () => Promise.reject(new Error('INVALID_COMPONENTID'));
        if (n === 'RING') { if (ring.refuse > 0) { ring.refuse--; ring.refused++; return no(); } ring.opened++; return Promise.resolve(); }
        if (ring.refuseView > 0) { ring.refuseView--; return no(); }
        return ui.open(n);
    } },
};
const ring = { texts: [], clicks: {}, closed: [], opened: 0, refused: 0, refuse: 0, refuseView: 0, fronts: 0, bg: [] };
const draw = () => { if (loops.VIEW) loops.VIEW(); return shot; };
const says = (re) => draw().said.some((s) => re.test(s));
const saysExact = (t) => draw().said.indexOf(t) >= 0;
const keys = () => draw().targets.map((x) => x.key);
const picked = (cam, what) => until(() => d.cmds('pick').length && d.cmds('pick').slice(-1)[0].cam === cam, what || 'pick ' + cam);
const tgt = (key) => draw().targets.find((q) => q.key === key);
const tap = (key) => { const x = draw().targets.find((q) => q.key === key); assert.ok(x, 'target ' + key + ' in ' + keys().join(' ')); x.run(); };
const values = {}; spec.settings.forEach((s) => { values[s.key] = s.default; });
assert.strictEqual(values.parkedOnly, true, 'shipped default: parked only');
const listeners = [];
const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; listeners.forEach((f) => f(k, v)); }, onChange: (f) => listeners.push(f) };
const sig = {}, VEH = 'de.bmw.infotainment.vehicle.Vehicle2', sw = { calls: [], on: 0, off: 0 };
// a watch reads the field at once (signals.js fetchAll), then on every notification; stop() counted
const signals = { watch: (iface, inst, h) => {
    sw.calls.push(iface); sig[iface] = h;
    if (iface !== VEH) return Promise.resolve({});
    sw.on++;
    setImmediate(() => { if (kmhNow !== null) h.statusCarSpeed2({ speedVehicleCentreOfGravity: kmhNow / 0.015625 }); });
    return Promise.resolve({ stop: () => { sw.off++; } });
} };
// the car re-reads the speed every 2 s; the kit counts a reading older than 5 s as moving
let kmhNow = null;
const speedNow = () => sig[VEH] && sig[VEH].statusCarSpeed2({ speedVehicleCentreOfGravity: kmhNow / 0.015625 });
const speed = (kmh) => { kmhNow = kmh; speedNow(); };
setInterval(() => { if (kmhNow !== null) speedNow(); }, 1000).unref();
const hooks = {};
// the kit's touchpad pointer (display.js pointerMove / pointerTap), reduced: screen px, the smallest target under it
// gets the controller (told 'pointer'), a tap runs it; ctx.scroll reaches onScroll on a cv.scroll page
const ptr = { x: 960, y: 360, moved: 0, taps: 0 };
const pointed = () => { let b = null; draw().targets.forEach((t) => { const k = PL.scale; if (ptr.x >= t.x * k && ptr.x < (t.x + t.w) * k && ptr.y >= t.y * k && ptr.y < (t.y + t.h) * k && (!b || t.w * t.h < b.w * b.h)) b = t; }); return b; };
const pointAt = (t) => { ptr.x = (t.x + t.w / 2) * PL.scale; ptr.y = (t.y + t.h / 2) * PL.scale; if (hooks.focus) hooks.focus(t.key, 'pointer'); };
const pointer = { move: (dx, dy) => { ptr.x += dx; ptr.y += dy; ptr.moved++; const t = pointed(); if (hooks.focus) hooks.focus(t ? t.key : null, 'pointer'); },
    tap: () => { ptr.taps++; const t = pointed(); if (t) t.run(); return !!t; } };
// the controller's touchpad (ZBETouchFrontSide in touch mode): f1, f2 = [x, y] pad units or null; none = lifted
const padAt = (f1, f2) => sig['de.bmw.infotainment.ControllerElements'].ZBETouchFrontSide({ statusSystemModeFrontSide: 3, touchCoordinatesZ1FrontSide: 0,
    touchCoordinatesX1FrontSide: f1 ? f1[0] : 0, touchCoordinatesY1FrontSide: f1 ? f1[1] : 0, touchCcoordinatesX2FrontSide: f2 ? f2[0] : 0, touchCoordinatesY2FrontSide: f2 ? f2[1] : 0 });
const padTap = () => { padAt([200, 200]); padAt(null, null); };
const ctx = {
    ui, settings, log, spec, signals, dataDir: tmp, display,
    canvas: (w, h) => { const c = new Recorder(w, h, { textScale: PL.scale }); c.kitCanvas = true; c.own = true; c.place = PL; if (rawXf) c.xf = function () { return this; }; const v = c.video; c.video = function () { c.hasVideo = true; return v.apply(c, arguments); }; return c; },
    loop: (n, fps, fn) => { loops[n] = fn; },
    onPageFocus: (fn) => { hooks.focus = fn; }, onLayout() {}, focus: (k) => { hooks.focused = k; },
    onTouch: (fn) => { hooks.touch = fn; }, onBack: (fn) => { hooks.back = fn; },
    pointer, scroll: (dy) => !!(shot.scroll && hooks.scroll && hooks.scroll(dy)), onScroll: (fn) => { hooks.scroll = fn; },
    background: (n, on) => ring.bg.push([n, on]), front: () => { ring.fronts++; return ui.open('VIEW'); },
};
// SMOKE_SHOTS=<dir>: snap(name) writes VIEW as <dir>/<name>.png (the kit's software playback; xf() kept out of the
// recording, so the screen-px drawing plays at 1:1 onto a screen-sized canvas)
let rawXf = false;
async function snap(name) {
    if (!process.env.SMOKE_SHOTS) return;
    rawXf = true; await sleep(300); const cv = draw().cv; rawXf = false;
    const { Canvas } = require(path.join(SRC, 'kit', 'canvas')), out = new Canvas(PL.w, PL.h);
    require(path.join(SRC, 'kit', 'record')).play(cv.words(), out);
    fs.writeFileSync(path.join(process.env.SMOKE_SHOTS, name + '.png'), out.png());
}
const realLoad = Module._load;
Module._load = function (req) {
    if (req === './kit/mgu') return { run: (impl) => impl.start(ctx), log };
    return realLoad.apply(this, arguments);
};

(async () => {
    const { doorStep, gapRing } = require(path.join(SRC, 'app.js'));
    // doorStep (Open: arm, a reflex second tap under 0.5 s ignored, sent inside 4 s, armed again after; one at a time;
    // a clock stepped back arms again, never sends)
    const D0 = 1e6;
    assert.deepStrictEqual([doorStep('coming', 0, null, D0), doorStep('open', 0, null, D0), doorStep('open', D0, null, D0 + 400),
        doorStep('open', D0, null, D0 + 600), doorStep('open', D0, null, D0 + 3999), doorStep('open', D0, null, D0 + 4000), doorStep('wait', 0, 'open', D0),
        doorStep('open', D0, 'coming', D0 + 600), doorStep('open', D0, null, D0 - 1), doorStep('open', D0, null, D0 - 3600000 + 600)],
    ['send', 'arm', null, 'send', 'send', 'arm', null, null, 'arm', 'arm'], 'doorStep');
    // gapRing: a listed ring newer than the newest seen and under 60 s old (either way: a clock off fails closed)
    const G0 = 5e6, ringAt = (ts, type) => ({ type: type || 'ring', ts });
    assert.deepStrictEqual([gapRing(ringAt(G0 - 5000), G0 - 6000, G0), gapRing(ringAt(G0 - 5000), null, G0), gapRing(ringAt(G0 - 6000), G0 - 6000, G0),
        gapRing(ringAt(G0 - 5000, 'person'), G0 - 6000, G0), gapRing(ringAt(G0 - 60000), G0 - 70000, G0), gapRing(ringAt(G0 + 30000), G0, G0),
        gapRing(ringAt(G0 + 60000), G0, G0)], [true, false, false, false, false, true, false], 'gapRing');
    // ha.js: an IPv4 host with every octet 0-255, a port 1-65535 (none: 8123); anything else throws (no chips)
    const { Ha } = require(path.join(SRC, 'ha.js'));
    const haOk = (host, port) => { try { return new Ha({ host, port, token: 't' }).port; } catch (e) { return null; } };
    assert.deepStrictEqual([haOk('192.0.2.20'), haOk('192.0.2.20', 1), haOk('255.255.255.255', 65535), haOk('300.1.1.1'), haOk('1.2.3.256'), haOk('01.2.3.4'),
        haOk('1.2.3'), haOk(' 1.2.3.4'), haOk(16909060), haOk('192.0.2.20', 0), haOk('192.0.2.20', 70000), haOk('192.0.2.20', 8123.5),
        haOk('192.0.2.20', '8123'), haOk('192.0.2.20', null), haOk('192.0.2.20', -1)],
    [8123, 1, 65535, null, null, null, null, null, null, null, null, null, null, null, null], 'Ha host and port');
    // boot (autostart, hidden): ctl.sock only, the service told the app is hidden; no speed, no touchpad, no renderer
    await until(() => d.cmds('status').length && d.cmds('list').length, 'status + list on connect');
    await sleep(300);
    assert.deepStrictEqual(d.cmds('stop'), [{ cmd: 'stop', why: 'hidden' }], 'hidden at start: the service redials the feed slowly');
    assert.deepStrictEqual(ring.bg, [['ring', true]], 'kept running while hidden');
    assert.deepStrictEqual([sw.calls, d.cmds('view').length, r.hello, loops.VIEW ? 1 : 0], [[], 0, null, 1], 'boot: no signal watched, no view, no renderer connection');
    assert.ok(logs.every((l) => !/ha\.json/.test(l)), 'boot: ha.json not read');
    console.log('ok boot: ctl.sock only (no speed, touchpad, renderer, timers, ha.json)');
    stack = ['VIEW']; visH.forEach((f) => f('VIEW', true));
    assert.strictEqual(spec.screens.filter((s) => s.kind === 'canvas')[0].name, 'VIEW', 'VIEW is the first canvas screen (the kit draws it)');
    await until(() => r.hello && r.hello.indexOf('jap_ridewatch\0proto=mgu-render/1') === 0, 'native HELLO');
    assert.deepStrictEqual([sw.on, sw.calls.indexOf('de.bmw.infotainment.ControllerElements') >= 0], [1, true], 'on screen: one speed watch, the touchpad');
    // the settings go to the service first: defaults (no address yet), then again on a change
    assert.deepStrictEqual(d.cmds('config')[0], { cmd: 'config', host: [0, 0, 0, 0], port: 18640, socks: 1065, socksFallback: 1055, lat: 0, lon: 0 }, 'config on connect: jap-wireproxy first, Tailscale second');
    settings.set('server1', 192); settings.set('server2', 0); settings.set('server3', 2); settings.set('server4', 10); settings.set('lat', 51);
    await until(() => d.cmds('config').length >= 5, 'config on every change');
    assert.deepStrictEqual(d.cmds('config').slice(-1)[0], { cmd: 'config', host: [192, 0, 2, 10], port: 18640, socks: 1065, socksFallback: 1055, lat: 51, lon: 0 });
    const LABELS = ['Door', 'Garage', 'Yard', 'Drive', 'Street', 'Side', 'Garden', 'Patio 360', 'Shed', 'Porch', 'Attic'];
    d.send({ ev: 'state', state: 'idle', view: null, msg: null });
    d.send({ ev: 'list', cams: LABELS.map((label, i) => ({ i, name: 'Cam ' + i, label, roles: i ? [] : ['door'] })) });

    // parked only, strict: no speed read yet = moving -> no stream, the notice
    await sleep(400);
    assert.strictEqual(d.cmds('view').length, 0, 'no view before a speed');
    assert.ok(says(/^Available only while parked$/), 'parked-only notice: ' + draw().said.join(' | '));
    speed(0);
    await until(() => d.cmds('view').length === 1, 'view once parked');
    assert.deepStrictEqual(d.cmds('view')[0], { cmd: 'view', view: 'spot', rect: '1920x720' }, 'the spot at the placement size');
    d.send({ ev: 'state', state: 'connecting', view: 'spot', msg: null });
    await until(() => says(/^Connecting…$/), 'connecting');
    assert.deepStrictEqual(keys(), ['settings'], 'no targets before the picture but Settings');
    tap('settings');
    assert.deepStrictEqual(clicks, ['BTN_SETTINGS'], 'full screen: the app\'s Settings button opens the settings');

    // the spot layout is data (the server's rects): hero 3 (day default), the pane's wide / tall / round tiles
    const now = Date.now();
    const evs = [
        { id: 'y1', cam: 6, label: 'Garden', type: 'animal', ts: new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() - 6 * 3600000, count: 1, thumb: false },
        { id: 'm1', cam: 2, label: 'Yard', type: 'motion', ts: now - 400000, count: 1, thumb: false },
    ];
    for (let k = 0; k < 9; k++) evs.push({ id: 't' + k, cam: k % 11, label: LABELS[k % 11], type: ['person', 'vehicle', 'package'][k % 3], ts: Math.max(new Date(now).setHours(0, 0, 0, 0) + 1000 * k, now - 3600000 * (9 - k)), count: 1 + (k % 2), thumb: k === 8 });
    evs.sort((a, b) => a.ts - b.ts);
    d.send({ ev: 'events', list: evs });
    d.send({ ev: 'hero', hero: 3, why: 'default', event: null, night: false, home: true });
    const tile = (i, x, y, w, h, shape) => ({ i, name: 'x', label: LABELS[i], x, y, w, h, shape });
    const L = { ev: 'layout', w: 1920, h: 720, hero: 3, heroRect: { x: 0, y: 0, w: 1280, h: 720 }, pane: { x: 1280, y: 0, w: 640, h: 720 },
        tiles: [tile(0, 1280, 0, 320, 180, 'wide'), tile(1, 1600, 0, 320, 180, 'wide'), tile(8, 1280, 540, 136, 180, 'tall'), tile(10, 1424, 550, 160, 160, 'round')] };
    d.send(L);
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null });
    await until(() => keys().indexOf('cam:10') >= 0, 'spot targets');
    assert.deepStrictEqual(keys(), ['hero', 'cam:0', 'cam:1', 'cam:8', 'cam:10', 'tab:live', 'tab:past', 'tab:settings'], 'the knob\'s order: hero, pane tiles, tabs');
    assert.strictEqual(draw().at.filter((a) => /^\d\d:\d\d$/.test(a[0])).map((a) => a[2]).slice(-1)[0], 66, 'a wide hero: the clock beside the tabs');
    // taps start at touchX: right of the HMI's back column (84 screen px), unless every renderer gives the app x < 84
    const leftmost = () => Math.min.apply(null, draw().targets.map((t) => t.x * PL.scale));
    assert.ok(leftmost() >= 84, 'every target right of x 84: ' + leftmost());
    assert.deepStrictEqual([tgt('tab:live').x * PL.scale, tgt('hero').x * PL.scale].map(Math.round), [84 + 22, 84], 'the tabs and the hero inset by touchX');
    PL.touchX = 0;
    await sleep(300);
    assert.deepStrictEqual([tgt('tab:live').x * PL.scale, tgt('hero').x * PL.scale].map(Math.round), [22, 0], 'touchX 0: the whole width');
    delete PL.touchX;
    await sleep(300);
    assert.ok(leftmost() >= 84, 'no touchX (an older kit): x 84 kept clear');
    PL.touchX = 84;
    const r1 = tgt('cam:1');
    assert.deepStrictEqual([r1.x, r1.y, r1.w, r1.h].map(Math.round), [1333, 0, 267, 150], 'stream px -> page px (1.2)');
    assert.ok(says(/^Drive$/) && says(/^Day · car at home$/) && says(/^\d\d:\d\d$/), 'hero name, context, clock');
    // the clock: the unit's own time (getHours) until the service's hello says the server's offset, then the server's
    // wall clock (347 min: no real zone, so never the host's own); back to the unit's when the offset is unknown again
    const p2 = (n) => ('0' + n).slice(-2);
    const own = () => [0, 60000].map((k) => { const t = new Date(Date.now() + k); return p2(t.getHours()) + ':' + p2(t.getMinutes()); });
    const home = (z) => [0, 60000].map((k) => { const t = new Date(Date.now() + k + z * 60000); return p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes()); });
    const clockIs = (a) => says(new RegExp('^(' + a.join('|') + ')$'));
    assert.deepStrictEqual(d.cmds('hello'), [{ cmd: 'hello', app: spec.version }], 'hello to the service on connect');
    assert.ok(clockIs(own()), 'no offset yet: the unit\'s own time');
    d.send({ ev: 'hello', daemon: '0.4.0', proto: 2, caps: [], tz: 347 });
    await until(() => clockIs(home(347)), 'the server\'s wall clock');
    assert.ok(!clockIs(own()), 'not the unit\'s time any more');
    d.send({ ev: 'hello', daemon: '0.4.0', proto: 1, caps: [], tz: null });
    await until(() => clockIs(own()), 'unknown offset: the unit\'s time again');
    d.send({ ev: 'hello', daemon: '0.4.0', proto: 2, caps: [], tz: 9999 });
    await sleep(300);
    assert.ok(clockIs(own()), 'a bad offset is ignored');
    d.send({ ev: 'error', cmd: 'hello', msg: 'unknown cmd' });   // an older service
    await sleep(300);
    assert.ok(clockIs(own()), 'an older service: the unit\'s time');
    console.log('ok clock (the unit\'s time, then the server\'s offset from hello)');
    assert.ok(says(/^Door$/) && says(/^Garage$/) && says(/^Shed$/) && says(/^Attic$/), 'tile labels');
    assert.ok(!says(/Connecting/), 'no state line while playing');
    await until(() => kv.some((c) => c[0] === 'video' && c[2] === VID), 'kit renderer told the video file');
    assert.ok(draw().video, 'VIEW frame draws the video (op 19)');

    // a tap on a pane tile: that camera becomes the hero (the daemon's pick), no CAM
    tap('cam:1');
    await picked(1);
    assert.strictEqual(top(), 'VIEW');
    // the daemon's new hero: its name at once, the old picture (layout) until the new spot's first frame
    d.send({ ev: 'hero', hero: 1, why: 'picked', event: null, night: false, home: true });
    await until(() => says(/^Garage$/) && tgt('hero'), 'new hero name');
    // a ring at the door: the ring, "Ring · Door", a banner (a live event)
    d.send({ ev: 'event', id: 'r1', cam: 0, label: 'Door', type: 'ring', ts: Date.now(), count: 1, thumb: false });
    d.send({ ev: 'hero', hero: 0, why: 'ring', event: { id: 'r1', cam: 0, type: 'ring', ts: Date.now() }, night: true, home: false });
    await until(() => says(/^Ring · Door$/) && says(/^Night · car away$/), 'ring title');
    assert.ok(says(/^just now$/), 'ring sub line');
    assert.deepStrictEqual(draw().strokes.filter((q) => q[4] > 6), [], 'no frame drawn round the door picture (0.5.4 had a gold ring there)');

    // a tap on the hero: CAM with it
    tap('hero');
    assert.strictEqual(top(), 'CAM');
    await until(() => d.last().view === 0, 'view 0');
    assert.deepStrictEqual(d.last(), { cmd: 'view', view: 0, rect: '1920x720' });
    await until(() => shownLayer() === 1 && r.types(13).length, 'CAM layer shown, video named');
    assert.ok(r.types(13)[0].p.slice(4).toString().indexOf(VID) === 0, 'VIDEO names the frame file');
    d.send({ ev: 'state', state: 'connecting', view: 0, msg: null });
    await until(() => camCv && (camCv.said || []).indexOf('Connecting…') >= 0, 'CAM connecting');
    d.send({ ev: 'state', state: 'playing', view: 0, msg: null });
    await until(() => camCv && (camCv.said || []).indexOf('Connecting…') < 0, 'CAM playing');
    assert.ok((camCv.said || []).indexOf('Door') >= 0, 'camera name on CAM');
    const f0 = r.types(7).length;
    await sleep(2100);
    const nf = r.types(7).length - f0;
    assert.ok(nf >= 3, 'keepalive frames on CAM: ' + nf + ' in 2.1 s');
    const fr = r.types(7)[r.types(7).length - 1].p;
    assert.deepStrictEqual(frameVideo(fr), [-480, -180, 2880, 1080], 'CAM fills the screen: the 16:9 picture at 1.5x, centred');
    // a finger drags: the picture pans (no back); the chip: the whole picture; the controller: fill again, pan up
    touch(1, 900, 300); touch(2, 900, 350); touch(2, 900, 400);
    await until(() => (frameVideo(r.types(7).slice(-1)[0].p) || [])[1] === -80, 'panned 100 px down');
    touch(3, 900, 400);
    await sleep(100);
    assert.strictEqual(top(), 'CAM', 'a drag is no tap');
    touch(1, 1700, 650); touch(3, 1700, 650);
    await until(() => String(frameVideo(r.types(7).slice(-1)[0].p)) === '0,0,1920,720', 'chip: the whole picture');
    assert.ok((camCv.said || []).indexOf('Fill the screen') >= 0, 'the chip says what it does next');
    ccu(1, 100, 0, 0); ccu(2, 100, 0, 4);
    await until(() => String(frameVideo(r.types(7).slice(-1)[0].p)) === '-480,-180,2880,1080', 'pushed right: fill again, centred');
    ccu(3, 100, 0, 0); ccu(4, 100, 0, 1);
    await until(() => String(frameVideo(r.types(7).slice(-1)[0].p)) === '-480,0,2880,1080', 'pushed up: the top (clamped)');
    assert.strictEqual(top(), 'CAM');

    // the controller: a turn = the next camera, a press = back to the spot
    ccu(1, 100, 0, 0); ccu(2, 101, 0, 0);
    await until(() => d.last().view === 1, 'turn: next camera (0 -> 1)');
    ccu(3, 101, 1, 0); ccu(4, 101, 0, 0);
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'press: spot');
    await until(() => shownLayer() === 0, 'CAM layer hidden');
    assert.deepStrictEqual(keys(), [], 'no targets until the daemon plays the spot again (the camera picture is still up)');
    const spot = () => { d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null }); return until(() => keys().indexOf('hero') >= 0, 'spot back'); };
    await spot();
    // the HMI's BACK on CAM, and a tap on CAM: back on VIEW
    tap('hero');
    await until(() => d.last().view === 0, 'view 0 again');
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: spot');
    await spot();
    tap('hero');
    await until(() => d.last().view === 0 && shownLayer() === 1, 'view 0 shown');
    touch(1, 900, 300); touch(3, 900, 300);
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'tap on CAM: spot');
    await spot();
    // CAM of the spot's hero: the spot stream already playing, framed on its hero (no new view: at once)
    d.send(Object.assign({}, L, { hero: 0 }));
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    await sleep(150);                                     // (the layout and the state in)
    const nv = d.cmds('view').length;
    tap('hero');
    await until(() => shownLayer() === 1 && String(frameVideo(r.types(7).slice(-1)[0].p)) === '0,-180,2880,1080', 'CAM on the spot\'s hero');
    await sleep(300);
    assert.strictEqual(d.cmds('view').length, nv, 'no new stream for the hero\'s CAM: ' + JSON.stringify(d.cmds('view').slice(nv - 1)));
    assert.ok((camCv.said || []).indexOf('Connecting…') < 0, 'nothing to wait for');
    touch(1, 900, 300); touch(3, 900, 300);
    await until(() => top() === 'VIEW' && shownLayer() === 0, 'back');
    await sleep(300);
    assert.strictEqual(d.cmds('view').length, nv, 'and back without a new stream');
    d.send(L);
    console.log('ok spot: layout, hero, pick, ring, CAM (fill, pan, whole, controller; the hero\'s at once) and back');

    // drag and drop on "En direct": held 0.45 s it lifts, dropped on a tile of its shape or on the hero: a swap
    await until(() => keys().indexOf('cam:10') >= 0, 'layout back');
    const picks = d.cmds('pick').length;
    assert.strictEqual(hooks.touch(1, 1440, 90), false, 'down on a tile: still the kit\'s (a tap may come)');
    assert.strictEqual(hooks.touch(2, 1445, 92), false, 'a small move: not lifted');
    await sleep(550);
    assert.strictEqual(hooks.touch(2, 1700, 90), true, 'held: lifted, ours');
    draw();
    assert.strictEqual(hooks.touch(3, 1760, 90), true, 'dropped');
    await until(() => d.cmds('swap').length === 1, 'swap sent');
    assert.deepStrictEqual(d.cmds('swap')[0], { cmd: 'swap', a: 0, b: 1 });
    hooks.touch(1, 1348, 630); assert.strictEqual(hooks.touch(2, 600, 400), true, 'dragged off at once: lifted');
    hooks.touch(3, 600, 400);
    await until(() => d.cmds('swap').length === 2, 'second swap');
    assert.deepStrictEqual(d.cmds('swap')[1], { cmd: 'swap', a: 8, b: 3 }, 'the door onto the hero');
    hooks.touch(1, 1500, 630); hooks.touch(2, 1440, 90); hooks.touch(3, 1440, 90);
    await sleep(100);
    assert.strictEqual(d.cmds('swap').length, 2, 'a round 360 on a wide tile: no swap');
    hooks.touch(1, 1440, 90);
    assert.strictEqual(hooks.touch(3, 1440, 90), false, 'a quick tap: the kit\'s (its pick)');
    assert.strictEqual(d.cmds('pick').length, picks, 'no pick from a drag');
    d.send(L);
    console.log('ok drag and drop (swap within a shape, onto the hero)');

    // "What happened": rows newest first (never motion), day headers, a thumb asked for a drawn row with one
    const views = d.cmds('view').length;
    tap('tab:past');
    await until(() => keys().some((k) => k.indexOf('ev:') === 0), 'timeline rows');
    const evKeys = () => keys().filter((k) => k.indexOf('ev:') === 0);
    assert.deepStrictEqual(evKeys(), ['ev:r1'].concat(evs.filter((e) => e.type !== 'motion').reverse().map((e) => 'ev:' + e.id)), 'newest first, no motion');
    assert.ok(keys().indexOf('cam:0') < 0, 'the pane tiles are under the panel');
    assert.ok(says(/^Today$/) && says(/^Ring$/) && says(/^Package · ×2$/) && says(/^just now$/), 'header, types, counts, times: ' + draw().said.filter((x) => /yesterday|Today|×/.test(x)).join(' | '));
    assert.strictEqual(d.cmds('view').length, views, 'the hero stays live: no new view');
    await until(() => d.cmds('thumb').length, 'thumb asked');
    assert.deepStrictEqual(d.cmds('thumb').map((m) => m.id), ['t8'], 'only rows with a picture');
    const rgba = Buffer.alloc(160 * 90 * 4, 200);
    d.send({ ev: 'thumb', id: 't8', w: 160, h: 90, rgba: rgba.toString('base64') });
    await until(() => draw().images.length === 1, 'thumb drawn');
    // a row without a picture yet: asked once its update says it has one
    d.send({ ev: 'event', id: 'r1', cam: 0, label: 'Door', type: 'ring', ts: Date.now(), count: 1, thumb: true });   // (its picture: no new ring)
    await until(() => draw() && d.cmds('thumb').some((m) => m.id === 'r1'), 'r1 thumb asked after its update');
    d.send({ ev: 'thumb', id: 'r1', none: true });
    assert.deepStrictEqual(evKeys().slice(0, 1), ['ev:r1'], 'the update kept one row');

    // the scroll bar, a drag, a flick's inertia, the controller's row brought into view
    const lastKey = evKeys().slice(-1)[0], y0 = tgt(lastKey).y, picks0 = d.cmds('pick').length;
    assert.ok(y0 * 1.2 > 720, 'the last row starts below the screen');
    hooks.touch(1, 1500, 600);
    hooks.touch(2, 1500, 560); hooks.touch(2, 1500, 500);
    const y1 = tgt(lastKey).y;
    assert.ok(Math.abs((y0 - y1) * 1.2 - 100) < 2, 'the list follows the finger: ' + (y0 - y1) * 1.2);
    await sleep(20);
    hooks.touch(2, 1500, 440);
    const y2 = tgt(lastKey).y;            // where the finger left it (not at the list's end: 160 of ~670 px)
    hooks.touch(3, 1500, 440);
    await sleep(200);
    const y3 = tgt(lastKey).y;
    assert.ok(y3 < y2, 'inertia after the release: ' + y2 + ' -> ' + y3);
    assert.strictEqual(d.cmds('pick').length, picks0, 'a drag is no tap');
    hooks.focus(evKeys()[0]);
    await until(() => tgt(evKeys()[0]).y * 1.2 >= 0, 'the first row back into view');
    hooks.focus(lastKey);
    await until(() => { const t = tgt(lastKey); return (t.y + t.h) * 1.2 <= 720; }, 'the last row into view');
    assert.ok(says(/^Yesterday$/) && says(/^yesterday \d\d:\d\d$/), 'yesterday\'s header and time');
    // the controller's touchpad: two fingers scroll the list (cv.scroll tiles), one finger moves the kit's pointer
    // (its focus does not scroll the list), a tap on the pad runs what the pointer is on: a row's clip
    assert.deepStrictEqual(draw().scroll, { tiles: true }, 'the timeline is a cv.scroll tiles page');
    hooks.focus(evKeys()[0]);
    await until(() => tgt(evKeys()[0]).y * 1.2 >= 0, 'the top of the list');
    await sleep(400);
    const ya = tgt(lastKey).y;
    padAt([200, 100], [260, 100]);
    for (let k = 1; k <= 10; k++) padAt([200, 100 + 8 * k], [260, 100 + 8 * k]);
    padAt(null, null);
    const yb = tgt(lastKey).y;
    assert.ok(ya - yb > 40, 'two fingers up: further down the list (' + ya + ' -> ' + yb + ')');
    padAt([200, 200]); await sleep(250); padAt([240, 200]); padAt([260, 210]); padAt(null, null);
    assert.ok(ptr.moved > 0 && ptr.taps === 0, 'one finger moved the pointer, no tap');
    const pr = draw().targets.filter((t) => t.key.indexOf('ev:') === 0).find((t) => t.y * 1.2 > 40 && (t.y + t.h) * 1.2 < 700);
    hooks.focus(evKeys()[0], 'pointer');                 // (a row off the screen: the controller would bring it in)
    await sleep(300);
    assert.strictEqual(tgt(lastKey).y, yb, 'the pointer\'s focus: the list stays');
    pointAt(pr);
    padTap();
    assert.strictEqual(ptr.taps, 1, 'a short touch on the pad is a tap');
    await until(() => top() === 'CAM' && d.last().view === 'clip' && 'ev:' + d.last().id === pr.key, 'the pointer\'s row: its clip');
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: the spot');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    hooks.focus(lastKey);
    await until(() => { const t = tgt(lastKey); return (t.y + t.h) * 1.2 <= 720; }, 'the last row into view again');
    // a tap on a row: that event's clip on CAM (no pick yet)
    const lr = tgt(lastKey), tapY = (lr.y + lr.h / 2) * 1.2, old = evs.filter((e) => e.type !== 'motion')[0];
    const picks1 = d.cmds('pick').length;
    hooks.touch(1, 1500, tapY); hooks.touch(3, 1500, tapY);
    await until(() => top() === 'CAM' && d.last().view === 'clip', 'tap on the oldest row: its clip');
    assert.deepStrictEqual(d.last(), { cmd: 'view', view: 'clip', id: old.id, rect: '1920x720' });
    assert.strictEqual(d.cmds('pick').length, picks1, 'a clip is no pick');
    await until(() => shownLayer() === 1 && camCv && (camCv.said || []).indexOf('Connecting…') >= 0, 'CAM layer, connecting');
    const T0 = { person: 'Person', vehicle: 'Vehicle', package: 'Package', animal: 'Animal' }[old.type] + ' · ' + LABELS[old.cam] + ' · ';
    d.send({ ev: 'state', state: 'connecting', view: 'clip', msg: null, shows: 'spot' });
    d.send({ ev: 'clip', id: old.id, cam: old.cam, label: LABELS[old.cam], type: old.type, start: old.ts - 5000, dur: 1500 });
    d.send({ ev: 'state', state: 'playing', view: 'clip', msg: null, shows: 'clip' });
    await until(() => (camCv.said || []).some((x) => x.indexOf(T0) === 0) && (camCv.said || []).indexOf('Connecting…') < 0, 'clip overlay: ' + T0);
    assert.deepStrictEqual(frameVideo(r.types(7).slice(-1)[0].p), [-480, -180, 2880, 1080], 'the clip fills the screen as a camera');
    assert.ok((camCv.said || []).indexOf('Whole picture') < 0 && (camCv.said || []).indexOf('Replay') < 0, 'no chip, no buttons while it plays');
    const fc = r.types(7).length;
    await sleep(500);
    assert.ok(r.types(7).length - fc >= 5, 'the progress bar redraws: ' + (r.types(7).length - fc) + ' frames in 0.5 s');
    d.send({ ev: 'state', state: 'ended', view: 'clip', msg: null, shows: 'clip' });
    await until(() => ['Replay', 'Live'].every((x) => (camCv.said || []).indexOf(x) >= 0), 'ended: Replay, Live');
    assert.strictEqual(top(), 'CAM', 'the last frame stays');
    const nv1 = d.cmds('view').length;
    touch(1, 800, 650); touch(3, 800, 650);
    await until(() => d.cmds('view').length === nv1 + 1, 'Replay: the clip again');
    assert.deepStrictEqual(d.last(), { cmd: 'view', view: 'clip', id: old.id, rect: '1920x720' });
    d.send({ ev: 'state', state: 'connecting', view: 'clip', msg: null, shows: null });
    d.send({ ev: 'state', state: 'ended', view: 'clip', msg: null, shows: 'clip' });
    await until(() => (camCv.said || []).indexOf('Replay') >= 0, 'ended again');
    touch(1, 1100, 650); touch(3, 1100, 650);
    await until(() => d.last().view === old.cam, 'Live: that camera live');
    await picked(old.cam, 'Live picks it');
    assert.strictEqual(top(), 'CAM');
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: the spot');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    await until(() => keys().indexOf('ev:t8') >= 0, 'the timeline again');
    // a press with the controller (the kit runs the target): the clip; an error said; BACK to the timeline
    tgt('ev:t8').run();
    await until(() => top() === 'CAM' && d.last().view === 'clip' && d.last().id === 't8', 'press on a row: its clip');
    d.send({ ev: 'state', state: 'error', view: 'clip', msg: 'Video unavailable' });
    await until(() => (camCv.said || []).indexOf('Video unavailable') >= 0, 'clip error shown');
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: the spot');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    await until(() => keys().indexOf('ev:t8') >= 0, 'still on the timeline');
    // the spot's picture away (back from a clip, a stall): the timeline stays and a finger's tap still plays;
    // the HMI refusing to open CAM once: asked again
    d.send({ ev: 'state', state: 'connecting', view: 'spot', msg: null, shows: 'clip' });
    await until(() => keys().indexOf('ev:t8') >= 0, 'the timeline without the spot\'s picture');
    const t8 = tgt('ev:t8'), y8 = (t8.y + t8.h / 2) * 1.2;
    failOpen = 1;
    hooks.touch(1, 1500, y8); hooks.touch(3, 1500, y8);
    await until(() => top() === 'CAM' && d.last().view === 'clip' && d.last().id === 't8', 'a finger on a row with no picture, CAM refused once: its clip', 4000);
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: the spot');
    failOpen = 2;                                    // refused twice: given up, said, the next tap works
    hooks.touch(1, 1500, y8); hooks.touch(3, 1500, y8);
    await until(() => says(/did not open/), 'a clip that did not open is said', 5000);
    assert.strictEqual(top(), 'VIEW');
    hooks.touch(1, 1500, y8); hooks.touch(3, 1500, y8);
    await until(() => top() === 'CAM' && d.last().view === 'clip', 'the next tap plays', 4000);
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: the spot');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    // pushed left: back to "En direct"
    assert.strictEqual(hooks.back(false), true, 'onBack took it');
    await until(() => keys().indexOf('cam:0') >= 0, 'live tab again');
    assert.strictEqual(hooks.back(false), false, 'on the live tab the kit\'s back');
    hooks.touch(1, 1500, 300);
    assert.strictEqual(hooks.touch(3, 1500, 300), false, 'a tap on the pane on the live tab is the kit\'s (its targets)');
    // the pointer on a tab, a tap on the pad: that tab
    pointAt(tgt('tab:past')); padTap();
    await until(() => keys().some((k) => k.indexOf('ev:') === 0), 'the pointer on "What happened", a tap');
    pointAt(tgt('tab:live')); padTap();
    await until(() => keys().indexOf('cam:0') >= 0, 'the pointer on "Live", a tap');
    console.log('ok touchpad: two fingers scroll the timeline, the pointer and a tap play a row\'s clip, open a tab');
    console.log('ok timeline: rows, headers, thumbs, drag + inertia, controller, clip (overlay, Replay, Live, error, no picture, CAM refused), back');

    // the daemon's error, shown as it says
    d.send({ ev: 'state', state: 'error', view: 'spot', msg: 'connection lost - retry in 2 s' });
    await until(() => says(/^connection lost - retry in 2 s$/), 'error message');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null });

    // the doorbell's quick replies (the "door" camera as the hero): no ha.json, or none naming a script = no chips
    const doorKeys = () => keys().filter((k) => k.indexOf('door:') === 0);
    await until(() => keys().indexOf('hero') >= 0, 'the spot again');
    assert.deepStrictEqual(doorKeys(), [], 'no ha.json: no chips');
    haJson({ host: '192.0.2.20', token: 'tok' });
    visH.forEach((f) => f('VIEW', true));                       // (ha.json is read when VIEW shows)
    await until(() => logs.some((l) => /ha\.json: no script/.test(l)), 'no script said');
    assert.deepStrictEqual(doorKeys(), [], 'no script: no chips');
    // readable by the apps' group or by every app: refused, said once
    for (const mode of [0o640, 0o640, 0o644]) {
        haJson({ host: '192.0.2.20', token: 'tok', script: 'script.my_doorbell_reply' }, mode);
        visH.forEach((f) => f('VIEW', true));
        await sleep(50);
    }
    assert.deepStrictEqual(logs.filter((l) => /ha\.json: mode/.test(l)), ['W ha.json: mode 640, must be 0600 (chmod 600): no doorbell buttons',
        'W ha.json: mode 644, must be 0600 (chmod 600): no doorbell buttons'], 'a loose mode said once');
    assert.deepStrictEqual(doorKeys(), [], 'a loose mode: no chips');
    // another uid's file: refused, the uid named (process.getuid stubbed for one read)
    haJson({ host: '192.0.2.20', token: 'tok', script: 'script.my_doorbell_reply' });
    const realUid = process.getuid, me = realUid();
    process.getuid = () => me + 1;
    visH.forEach((f) => f('VIEW', true));
    await until(() => logs.some((l) => l.indexOf('ha.json: owner uid ' + me + ', must be this app (chown ' + (me + 1) + ')') >= 0), 'another owner: said');
    process.getuid = realUid;
    assert.deepStrictEqual(doorKeys(), [], 'another owner: no chips');
    // a link, even to a good file: refused (O_NOFOLLOW)
    haJson({ host: '192.0.2.20', token: 'tok', script: 'script.my_doorbell_reply' });
    fs.renameSync(HAJ, HAJ + '.real'); fs.symlinkSync(HAJ + '.real', HAJ);
    visH.forEach((f) => f('VIEW', true));
    await until(() => logs.some((l) => /ha\.json: ELOOP \(this app is uid \d+\)/.test(l)), 'a link: said, with the uid');
    assert.deepStrictEqual(doorKeys(), [], 'a link: no chips');
    fs.unlinkSync(HAJ); fs.renameSync(HAJ + '.real', HAJ);
    haJson({ host: '192.0.2.20', port: '8123', token: 'tok', script: 'script.my_doorbell_reply' });
    visH.forEach((f) => f('VIEW', true));
    await until(() => logs.some((l) => /ha\.json: port must be a number/.test(l)), 'a port as text: said');
    assert.deepStrictEqual(doorKeys(), [], 'a bad port: no chips');
    haJson({ host: '192.0.2.20', token: 'tok', script: 'script.my_doorbell_reply' }, 0o600);
    settings.set('socks', 1); settings.set('socksFallback', haSocks.address().port);   // the first proxy refuses: the second
    visH.forEach((f) => f('VIEW', true));
    await until(() => doorKeys().length === 5, 'chips once ha.json names a script');
    assert.deepStrictEqual(keys().slice(0, 6), ['door:coming', 'door:parcel', 'door:busy', 'door:wait', 'door:open', 'hero'], 'chips before the hero, Open last for the knob');
    // the portrait doorbell: the chips wrap inside its 540 px, right of x 84, as tall as Cameras' (64 px)
    d.send(Object.assign({}, L, { hero: 0, heroRect: { x: 0, y: 0, w: 540, h: 720 } }));
    await until(() => tgt('hero') && Math.abs((tgt('hero').x + tgt('hero').w) * 1.2 - 540) < 1 && doorKeys().length === 5, 'chips on the portrait doorbell');
    const clockY = () => draw().at.filter((a) => /^\d\d:\d\d$/.test(a[0])).map((a) => a[2]).slice(-1)[0];
    assert.strictEqual(clockY(), 140, 'the portrait doorbell: the clock goes under the tabs (Settings reached it)');
    doorKeys().forEach((k) => { const q = tgt(k); assert.ok(q.x * 1.2 >= 84 && (q.x + q.w) * 1.2 <= 540.01 && q.h * 1.2 >= 63.9, 'chip inside the doorbell: ' + k + ' ' + [q.x, q.w, q.h]); });
    // 0.5.5: the server's controls column beside the doorbell (540-960): the chips there, off the picture
    const COL = { pane: { x: 540, y: 0, w: 1380, h: 720 }, controls: { x: 540, y: 0, w: 420, h: 720 } };
    d.send(Object.assign({}, L, { hero: 0, heroRect: { x: 0, y: 0, w: 540, h: 720 } }, COL));
    await until(() => doorKeys().length === 5 && tgt('door:coming').x * 1.2 >= 540, 'chips in the column');
    doorKeys().forEach((k) => { const q = tgt(k); assert.ok(q.x * 1.2 >= 540 && (q.x + q.w) * 1.2 <= 960.01 && q.y * 1.2 >= 88, 'chip in the column: ' + k + ' ' + [q.x, q.y, q.w]); });
    {
        const ys = doorKeys().map((k) => tgt(k)), top = Math.min.apply(null, ys.map((q) => q.y)), bot = Math.max.apply(null, ys.map((q) => q.y + q.h));
        assert.ok(Math.abs((top + bot) / 2 * 1.2 - 360) < 2, 'no Listen/Talk: the chips centred in the column ' + [top, bot]);
    }
    const rowsCentred = () => {
        const rows = {};
        doorKeys().forEach((k) => { const q = tgt(k), r = rows[q.y] || (rows[q.y] = [1e9, -1e9]); r[0] = Math.min(r[0], q.x); r[1] = Math.max(r[1], q.x + q.w); });
        Object.keys(rows).forEach((y) => assert.ok(Math.abs((rows[y][0] + rows[y][1]) / 2 * 1.2 - 750) <= 4, 'chip row centred in the column (750): ' + rows[y].map((v) => v * 1.2)));
        assert.ok(Object.keys(rows).length >= 2, 'several chip rows');
    };
    rowsCentred();
    assert.deepStrictEqual(keys().filter((k) => /^tab:/.test(k)), ['tab:live', 'tab:past', 'tab:settings'], 'Settings: the gear after the tabs');
    assert.ok(!says(/^Settings$/), 'a gear, no "Settings" text on the tabs');
    tap('tab:settings');
    assert.deepStrictEqual(clicks.slice(-1), ['BTN_SETTINGS'], 'the gear opens the settings');
    d.send(Object.assign({}, L, { hero: 0, heroRect: { x: 0, y: 0, w: 540, h: 720 } }));
    await until(() => doorKeys().length === 5 && tgt('door:coming').x * 1.2 < 540, 'an older server (no column): the chips on the doorbell');
    const ACTS = { coming: ['DOORBELL_COMING', 'Sent to the doorbell: "I\'m coming right away"'], parcel: ['DOORBELL_PARCEL', 'Sent to the doorbell: "Leave the parcel"'],
        busy: ['DOORBELL_BUSY', 'Sent to the doorbell: "Not available right now"'], wait: ['DOORBELL_WAIT', 'Sent to the doorbell: "One moment, please"'] };
    for (const k of Object.keys(ACTS)) {
        const n = has.reqs.length;
        tap('door:' + k);
        await until(() => has.reqs.length === n + 1 && saysExact(ACTS[k][1]), k + ' sent and said');
        assert.deepStrictEqual(has.reqs[n], { m: 'POST', url: '/api/services/script/my_doorbell_reply', auth: 'Bearer tok', type: 'application/json', body: { door: ACTS[k][0] } }, k);
    }
    assert.ok(has.to.length === 4 && has.to.every((t) => t === '192.0.2.20:8123'), 'ha.json\'s host, port 8123 by default: ' + has.to);
    // one at a time: a second chip while the first is on its way does nothing
    has.delay = 300;
    let n0 = has.reqs.length;
    tap('door:coming'); tap('door:wait');
    await until(() => has.reqs.length === n0 + 1 && saysExact(ACTS.coming[1]), 'the first one only');
    await sleep(200);
    assert.strictEqual(has.reqs.length, n0 + 1, 'the second chip sent nothing');
    has.delay = 0;
    // Open: the first tap arms it ("Confirm?", nothing sent), a reflex second tap under 0.5 s does nothing, then it sends
    n0 = has.reqs.length;
    tap('door:open');
    await until(() => saysExact('Confirm?'), 'Open armed');
    tap('door:open');
    await sleep(600);
    assert.strictEqual(has.reqs.length, n0, 'the first tap and a reflex second one send nothing');
    tap('door:open');
    await until(() => has.reqs.length === n0 + 1 && saysExact('Opening requested…'), 'Open sent');
    assert.deepStrictEqual(has.reqs[n0].body, { door: 'DOORBELL_OPEN' });
    assert.ok(!saysExact('Confirm?') && saysExact('Open'), 'disarmed after sending');
    // locked 10 s after an Open: four steady taps 0.6 s apart send exactly one Open (a toggle-type door stays open)
    hrSkip += 11;
    n0 = has.reqs.length;
    for (let k = 0; k < 4; k++) { tap('door:open'); await sleep(600); }
    await sleep(200);
    assert.deepStrictEqual(has.reqs.slice(n0).map((q) => q.body.door), ['DOORBELL_OPEN'], 'four steady taps: one Open');
    assert.ok(!saysExact('Confirm?'), 'locked: not armed again');
    // the clock stepped back an hour while Open is armed: the arm still ends after 4 s, a single tap later arms again
    hrSkip += 11;
    n0 = has.reqs.length;
    tap('door:open');
    await until(() => saysExact('Confirm?'), 'Open armed again');
    const realNow = Date.now;
    Date.now = () => realNow() - 3600000;
    hrSkip += 5;
    assert.ok(!saysExact('Confirm?') && saysExact('Open'), 'a clock stepped back: the arm ended after 4 s');
    tap('door:open');
    await sleep(100);
    Date.now = realNow;
    assert.ok(saysExact('Confirm?') && has.reqs.length === n0, 'one tap after it arms, sends nothing');
    hrSkip += 5;
    n0 = has.reqs.length - 1;
    // refused (HTTP): said as Cameras says it; Open refused is never sent again
    has.status = 401;
    tap('door:coming');
    await until(() => has.reqs.length === n0 + 2 && saysExact('The house refused (HTTP 401 (token refused))'), 'refusal said');
    tap('door:open'); await sleep(600); tap('door:open');
    await until(() => has.reqs.length === n0 + 3, 'Open asked');
    await sleep(600);
    assert.ok(saysExact('The house refused (HTTP 401 (token refused))'), 'Open refused: said');
    assert.strictEqual(has.reqs.filter((q) => q.body.door === 'DOORBELL_OPEN').length, 3, 'Open never retried');
    has.status = 200;
    // no proxy answers: "did not answer", nothing sent
    settings.set('socksFallback', 0);
    n0 = has.reqs.length;
    tap('door:wait');
    await until(() => says(/^The house did not answer \(/), 'no answer said');
    assert.strictEqual(has.reqs.length, n0, 'nothing reached the house');
    settings.set('socks', haSocks.address().port);
    // French: the chips and what they say, as Cameras has them
    settings.set('french', true);
    await until(() => ['J\'arrive', 'Déposez le colis', 'Pas disponibles', 'Un instant', 'Ouvrir'].every(saysExact), 'French chips: ' + draw().said.join(' | '));
    tap('door:wait');
    await until(() => saysExact('Envoyé à la sonnette : « Un instant, s\'il vous plaît »'), 'French said');
    settings.set('french', false);
    d.send(L);
    console.log('ok doorbell quick replies: no ha.json / no script = none, five chips, HA request bodies, one at a time, Open armed, refusal, no answer, French');

    // 0.5.0, the doorbell's sound: Listen and Talk on the door camera's view once the service's hello lists them
    const audioKeys = () => keys().filter((k) => k.indexOf('audio:') === 0);
    const lastCmd = () => d.got.filter((m) => /^(un)?(listen|talk)$/.test(m.cmd)).slice(-1)[0];
    const sentNow = (o, what) => until(() => JSON.stringify(lastCmd()) === JSON.stringify(o), what || JSON.stringify(o));
    const audioEv = (o) => d.send(Object.assign({ ev: 'audio', state: 'off', listen: 'off', talk: 'off', cam: 0, why: null, max: 60 }, o));
    assert.deepStrictEqual(audioKeys(), [], 'an older service (no "audio" in hello): no Listen, no Talk');
    d.send({ ev: 'hello', daemon: '0.5.0', proto: 2, caps: ['listen', 'talk'], tz: null, audio: ['listen', 'talk'] });
    await until(() => audioKeys().length === 2, 'Listen and Talk');
    assert.deepStrictEqual(audioKeys(), ['audio:listen', 'audio:talk']);
    assert.strictEqual(doorKeys().length, 5, 'the quick replies stay beside them');
    {
        const lt = tgt('audio:listen'), tt = tgt('audio:talk'), top = Math.min.apply(null, doorKeys().map((k) => tgt(k).y));
        assert.ok(lt.x * 1.2 >= 84 && (tt.x + tt.w) * 1.2 <= 1280 && (tt.y + tt.h) < top && (lt.x + lt.w) <= tt.x, 'Listen left of Talk, inside the hero, above the chips');
        assert.ok(tt.w * 1.2 >= 111 && tt.hold, 'Talk: a big round button (112 px) that tells a hold');
    }
    await snap('door-audio');
    // Listen: on / off
    tap('audio:listen');
    await sentNow({ cmd: 'listen', cam: 0 });
    audioEv({ state: 'listening', listen: 'on' });
    await until(() => saysExact('Listening'), 'listening shown');
    d.send({ ev: 'level', v: 0.6 });
    // Talk held by a finger: talk at once, still held past the tile lift time (no drag of the hero), untalk on the let go
    let tt = tgt('audio:talk');
    const TX = (tt.x + tt.w / 2) * 1.2, TY = (tt.y + tt.h / 2) * 1.2;
    assert.strictEqual(hooks.touch(1, TX, TY), false, 'down on Talk: the kit\'s (its hold)');
    tt.hold(true);
    await sentNow({ cmd: 'talk', cam: 0 }, 'a finger down: talk');
    audioEv({ state: 'talking', listen: 'on', talk: 'on' });
    await sleep(600);
    assert.strictEqual(hooks.touch(2, TX + 3, TY + 2), false, 'held 0.6 s: Talk never lifts the hero');
    await until(() => says(/^Talking · (59|60) s$/), 'the countdown: ' + draw().said.join(' | '));
    await snap('door-talking');
    hooks.touch(3, TX, TY); tt.hold(false, true);
    await sentNow({ cmd: 'untalk' }, 'let go: untalk');
    audioEv({ state: 'listening', listen: 'on', talk: 'off' });
    await until(() => saysExact('Hold to talk'), 'talk off');
    // the controller: a press starts it, its release does nothing, the next press ends it; a touchpad tap toggles too
    tgt('audio:talk').hold(true);
    await sentNow({ cmd: 'talk', cam: 0 }, 'a knob press: talk');
    tgt('audio:talk').hold(false, true);
    await sleep(100);
    assert.deepStrictEqual(lastCmd(), { cmd: 'talk', cam: 0 }, 'its release: still talking');
    audioEv({ state: 'talking', listen: 'on', talk: 'on' });
    await until(() => says(/^Talking · /), 'talking (knob)');
    tgt('audio:talk').hold(true);
    await sentNow({ cmd: 'untalk' }, 'the next press: untalk');
    tgt('audio:talk').hold(false, true);
    audioEv({ state: 'listening', listen: 'on', talk: 'off' });
    // 60 s: a knob talk left on ends by itself
    tgt('audio:talk').hold(true);
    await sentNow({ cmd: 'talk', cam: 0 }, 'a knob press: talk (cap)');
    tgt('audio:talk').hold(false, true);
    audioEv({ state: 'talking', listen: 'on', talk: 'on' });
    await until(() => says(/^Talking · (59|60) s$/), 'talking (cap)');
    hrSkip += 61;                                      // (no frame drawn: the 250 ms sync ends it)
    await sentNow({ cmd: 'untalk' }, '60 s: untalk by itself');
    audioEv({ state: 'listening', listen: 'on', talk: 'off', why: 'max' });
    await until(() => saysExact('Hold to talk'), 'cap: talk off');
    // Talk never outlives its button: a knob talk, then CAM (the hero pressed); then the picture going away
    tgt('audio:talk').hold(true);
    await sentNow({ cmd: 'talk', cam: 0 }, 'a knob press: talk (CAM)');
    tgt('audio:talk').hold(false, true);
    audioEv({ state: 'talking', listen: 'on', talk: 'on' });
    await until(() => says(/^Talking · /), 'talking (CAM)');
    tap('hero');
    assert.strictEqual(top(), 'CAM');
    await sentNow({ cmd: 'untalk' }, 'CAM: untalk');
    audioEv({ state: 'listening', listen: 'on', talk: 'off' });
    ui.back();
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null });
    await until(() => audioKeys().length === 2, 'back on VIEW: the buttons');
    await sleep(1100);                                 // (one untalk a second at most)
    tgt('audio:talk').hold(true);
    await sentNow({ cmd: 'talk', cam: 0 }, 'a knob press: talk (stall)');
    tgt('audio:talk').hold(false, true);
    audioEv({ state: 'talking', listen: 'on', talk: 'on' });
    d.send({ ev: 'state', state: 'idle', view: null, msg: null });   // the stream dropped: no picture under the buttons
    await sentNow({ cmd: 'untalk' }, 'the picture gone: untalk');
    audioEv({ state: 'listening', listen: 'on', talk: 'off' });
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null });
    await until(() => audioKeys().length === 2, 'the picture back: the buttons');
    await sleep(1100);
    // the mic taken back by a wheel press (the service's why "returned"): talk off, nothing said
    audioEv({ state: 'talking', listen: 'on', talk: 'on' });
    await until(() => says(/^Talking · /), 'talking (3)');
    audioEv({ state: 'listening', listen: 'on', talk: 'off', why: 'returned' });
    await until(() => saysExact('Hold to talk'), 'returned: talk off');
    tap('audio:talk');
    await sentNow({ cmd: 'talk', cam: 0 }, 'a touchpad tap: talk');
    audioEv({ state: 'listening', listen: 'on', talk: 'off', why: 'nospeaker' });
    await until(() => saysExact('This camera has no speaker'), 'a refusal said');
    tap('audio:listen');
    await sentNow({ cmd: 'unlisten' });
    audioEv({});
    // French
    settings.set('french', true);
    await until(() => saysExact('Maintenir pour parler') && saysExact('Écouter'), 'French: ' + draw().said.join(' | '));
    settings.set('french', false);
    // the portrait doorbell: both inside its 540 px
    d.send(Object.assign({}, L, { hero: 0, heroRect: { x: 0, y: 0, w: 540, h: 720 } }));
    await until(() => tgt('hero') && Math.abs((tgt('hero').x + tgt('hero').w) * 1.2 - 540) < 1 && audioKeys().length === 2, 'portrait');
    audioKeys().forEach((k) => { const q = tgt(k); assert.ok(q.x * 1.2 >= 84 && (q.x + q.w) * 1.2 <= 540.01, 'inside the portrait doorbell: ' + k); });
    await snap('door-audio-portrait');
    // with the server's column: Listen and Talk at its top, the chips under them, nothing on the doorbell's picture
    d.send(Object.assign({}, L, { hero: 0, heroRect: { x: 0, y: 0, w: 540, h: 720 } }, COL));
    await until(() => audioKeys().length === 2 && tgt('audio:talk').x * 1.2 >= 540, 'Listen and Talk in the column');
    {
        const lt = tgt('audio:listen'), tt = tgt('audio:talk'), top = Math.min.apply(null, doorKeys().map((k) => tgt(k).y));
        audioKeys().concat(doorKeys()).forEach((k) => { const q = tgt(k); assert.ok(q.x * 1.2 >= 540 && (q.x + q.w) * 1.2 <= 960.01, 'in the column: ' + k); });
        assert.ok((tt.y + tt.h) < top && (lt.x + lt.w) <= tt.x && lt.y * 1.2 >= 88, 'Listen left of Talk, under the tabs, above the chips');
        assert.ok(Math.abs((lt.x + tt.x + tt.w) / 2 * 1.2 - 750) <= 4, 'Listen and Talk centred in the column: ' + [lt.x * 1.2, (tt.x + tt.w) * 1.2]);
        rowsCentred();
        assert.strictEqual(clockY(), 66, 'nothing over the doorbell: the clock at the top right as on any hero');
    }
    await snap('door-column');
    d.send(L);
    // the door no longer the hero while listening: unlisten, and no buttons
    tap('audio:listen');
    audioEv({ state: 'listening', listen: 'on' });
    d.send({ ev: 'hero', hero: 1, why: 'picked', event: null, night: true, home: false });
    await until(() => audioKeys().length === 0 && lastCmd().cmd === 'unlisten', 'another hero: unlisten');
    audioEv({});
    d.send({ ev: 'hero', hero: 0, why: 'ring', event: { id: 'r1', cam: 0, type: 'ring', ts: Date.now() }, night: true, home: false });
    await until(() => audioKeys().length === 2, 'the door again');
    // moving: hidden (the service stops the sound itself on the stop it gets)
    speed(30);
    await until(() => audioKeys().length === 0, 'no Listen / Talk while moving');
    speed(0);
    await until(() => audioKeys().length === 2, 'back once parked');
    console.log('ok doorbell sound: Listen / Talk only with the service\'s audio, a finger holds Talk, the knob toggles, countdown, the 60 s cap, CAM and a lost picture end Talk, whys, French, portrait, other hero, moving');

    // the QR against an independent encoder, OpenCV 4.12's QRCodeEncoder (byte mode, level L; it chose mask 2): every
    // module the same but one of the 7 remainder bits, which OpenCV sets and ISO 18004 (7.7.3) wants 0. The mask qr.js
    // picks itself: the matrix OpenCV's QRCodeDetector read back as the URL, by its SHA-256
    {
        const qr = require(path.join(SRC, 'qr.js')), url = 'https://192.0.2.10:18642/pair#h=2356329028e8ba9d57b3f7b33fef1b1f6d35dc228c095c4959bb873738fc2f3c';
        const bits = (m) => m.map((r) => r.map((b) => (b ? '1' : '0')).join('')).join('');
        const hexBits = (h, n) => h.split('').map((c) => ('000' + parseInt(c, 16).toString(2)).slice(-4)).join('').slice(0, n * n);
        [[5, url, [28, 1], 'fe2a3d23fc152c42d06e82ab46bb75db9095dba4237a2ec16fb42907faaaaaafe00e62c600fbd4ea45556950ad63bf9958ae1ba8545840a72ad60d3e88b34f9219fb6589ccfb9a07d0c906376b5be8ac46ad61bbb9e8162e99d2796799f4ec0c2bc8b01f96288ff7a37a7c8270f209db95e8d3be2450bb63a3c16825a76b526d679d60ee35fa00602ed463fb7ca82bf042308119ba9deadfedd650a9552eb961b31f05b43d349fe8f435038'],
         [6, url + '&x=padding-to-reach-version-six-0123', [32, 1], 'fe3cd7a93fc154816e106e92a3ec0bb75fe818d5dba12910d2ec145c26f107faaaaaaafe00c40e0400fbff7157d502124dc49676ea739fb6539b04f20499315d2fec708f45f909c75e9f314969d2532952f2ae04c976d658bf1be4b4ce8ae3a50611a440a239a3b0d42d75624010eb6d4758e5a248e850254806c26efee05e57dc780df494ecaa588f9d9c1206c52203e0d40ee567e054cb0d5eeb17b2f321597118449aeac44257fa005d5cd2c57fb27984ead04650f0511baa552f4fb5d4d5f8560aeba71947bf05766d1722feeee85e160']
        ].forEach(([v, text, rem, hex]) => {
            const m = qr.encode(text, { mask: 2 }), n = 17 + 4 * v, got = bits(m), cv = hexBits(hex, n), diff = [];
            assert.strictEqual(m.length, n, 'version ' + v);
            for (let i = 0; i < n * n; i++) if (got[i] !== cv[i]) diff.push([Math.floor(i / n), i % n]);
            assert.deepStrictEqual(diff, [rem], 'v' + v + '-L mask 2: OpenCV\'s matrix but its remainder bit');
            assert.strictEqual(got[rem[0] * n + rem[1]], '0', 'the remainder bit is 0');
        });
        const auto = qr.encode(url).map((r) => r.map((b) => (b ? '1' : '0')).join('')).join('\n');
        assert.strictEqual(require('crypto').createHash('sha256').update(auto).digest('hex'), '523a0cfbe18cf879a8a50dea4a684deef3e3b480fa31bfb438817f0a0416a2ad', 'the pairing QR as OpenCV read it');
        console.log('ok QR known answers: v5-L and v6-L against OpenCV\'s encoder, the pairing URL as OpenCV decoded it');
    }

    // the server refuses this car: the QR of its setup page, the terminal way beside it, Settings; kept while connecting
    // between retries, gone once it plays (the car added there), not shown while moving
    const CODE = 'ABCD-EFGH-JKLM-NPQR', PAIR = 'https://192.0.2.10:18642/pair#h=2356329028e8ba9d57b3f7b33fef1b1f6d35dc228c095c4959bb873738fc2f3c';
    const SCAN = 'Scan with your phone to add this car', TERM = 'Or on the server: configure.py --add-car ' + CODE;
    const refused = (state) => d.send({ ev: 'state', state, view: 'spot', shows: null, msg: state === 'error' ? 'Server refused this car: add code ' + CODE + ' on the server - retry in 2 s' : null, pair: PAIR, fp: '2356 32', code: CODE });
    // the QR: a white square (4-module quiet zone) with its dark runs inside, right of the back column, left of the text
    const qrBox = () => {
        const sh = draw(), sq = sh.rects.filter((q) => q[4] === '#ffffff' && q[2] === q[3] && q[2] >= 400)[0];
        if (!sq) return null;
        const dark = sh.rects.filter((q) => q[4] === '#000000' && q[0] >= sq[0] && q[1] >= sq[1] && q[0] + q[2] <= sq[0] + sq[2] && q[1] + q[3] <= sq[1] + sq[3]);
        return { x: sq[0], y: sq[1], side: sq[2], dark: dark.length, text: (sh.at.find((a) => a[0] === SCAN) || [])[1] };
    };
    refused('error');
    await until(() => saysExact(SCAN), 'refused: the QR');
    let qb = qrBox();
    assert.ok(qb && qb.dark > 100 && qb.x >= 84 && qb.x + qb.side < qb.text && qb.y >= 0 && qb.y + qb.side <= 720, 'the QR drawn: ' + JSON.stringify(qb));
    assert.ok(saysExact(TERM) && !says(/^Server refused/), 'the terminal way, no note: ' + draw().said.join(' | '));
    const chk = draw().at.find((a) => a[0] === 'Check: 2356 32');
    assert.ok(chk && chk[2] > qb.y + qb.side && chk[2] <= 720 && Math.abs(chk[1] - (qb.x + qb.side / 2)) < 1, 'the fingerprint under the QR: ' + JSON.stringify([chk, qb]));
    assert.deepStrictEqual(keys(), ['settings'], 'refused: only Settings');
    assert.ok(tgt('settings').x * PL.scale >= qb.x + qb.side, 'Settings beside the QR, not on it');
    assert.ok(logs.every((l) => l.indexOf(CODE) < 0), 'the code not in the app log');
    await snap('car-qr');
    refused('connecting');
    await sleep(50);
    assert.ok(saysExact(SCAN) && !saysExact('Connecting…'), 'connecting between retries: the QR stays');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null });
    await until(() => !saysExact(SCAN), 'accepted: the QR goes');
    assert.strictEqual(qrBox(), null, 'no QR once playing');
    refused('error');
    await until(() => saysExact(SCAN), 'refused again');
    speed(10);
    await until(() => says(/^Available only while parked$/), 'moving: no QR', 6000);
    assert.ok(!saysExact(SCAN) && qrBox() === null, 'moving: no QR');
    speed(0);
    await until(() => saysExact(SCAN), 'parked: the QR again');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null });
    await until(() => !saysExact(SCAN), 'accepted again');
    d.send(L);
    console.log('ok refused car: QR (' + qb.side + ' px, ' + qb.dark + ' dark runs), terminal way, kept while connecting, gone once playing, not while moving');

    // driving: stop + notice; parked again: the spot again
    speed(10);
    await until(() => d.last().cmd === 'stop', 'stop above 3 km/h');
    assert.strictEqual(d.last().why, 'moving', 'driving off: the daemon keeps the pick');
    await until(() => says(/^Available only while parked$/), 'parked-only notice (after the door\'s 5 s note)', 6000);
    assert.deepStrictEqual(keys(), [], 'no targets while driving');
    d.send({ ev: 'state', state: 'idle', view: null, msg: null });
    speed(2);
    await until(() => d.last().cmd === 'view' && d.last().view === 'spot', 'view again when parked');
    // Parked only switched off: the risk page first; Cancel puts it back on
    const risk = () => until(() => says(/^Cameras while driving$/) && tgt('risk:ok'), 'the risk page');
    settings.set('parkedOnly', false);
    await risk();
    assert.deepStrictEqual(keys(), ['risk:ok', 'risk:cancel'], 'only I agree and Cancel');
    await until(() => hooks.focused === 'risk:cancel', 'the knob starts on Cancel, not on I agree');
    assert.ok(leftmost() >= 84, 'the risk page\'s buttons right of x 84');
    const wcv = ctx.canvas(1600, 520), long = draw().said.filter((x) => x.length > 30);
    assert.ok(long.length >= 3 && long.every((x) => wcv.textWidth(x, 30, { literal: true }) <= 1920 - 84 - 40), 'the risk lines fit between x 84 and the right edge: '
        + long.map((x) => Math.round(wcv.textWidth(x, 30, { literal: true }))).join(' '));
    tap('risk:cancel');
    assert.strictEqual(values.parkedOnly, true, 'Cancel: parked only again');
    speed(50);
    await until(() => d.last().cmd === 'stop', 'cancelled: no picture while driving');
    speed(2);
    await until(() => d.last().cmd === 'view', 'parked: the picture');
    // the controller pushed left on the risk page: Cancel
    settings.set('parkedOnly', false);
    await risk();
    assert.strictEqual(hooks.back(false), true, 'BACK on the risk page is the app\'s');
    assert.strictEqual(values.parkedOnly, true, 'BACK: parked only again');
    // switched off while parked and agreed: plays while driving
    settings.set('parkedOnly', false);
    await risk();
    tap('risk:ok');
    assert.strictEqual(values.parkedOnly, false);
    assert.strictEqual(values._drivingAgreed, true, 'the answer is kept with the settings');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    speed(50);
    await sleep(400);
    assert.strictEqual(d.last().cmd, 'view', 'agreed while parked: plays while driving');
    // the drive lock: switched on while moving stops at once; switched off again while moving, agreed or not,
    // the picture waits for a stop
    settings.set('parkedOnly', true);
    await until(() => d.last().cmd === 'stop', 'parked only on while moving: stop at once');
    assert.strictEqual(values._drivingAgreed, false, 'switched on: the answer is forgotten');
    settings.set('parkedOnly', false);
    await risk();
    tap('risk:ok');
    await sleep(600);
    assert.strictEqual(d.last().cmd, 'stop', 'switched off while moving: no picture');
    assert.ok(says(/^Cameras while driving start once parked$/), 'the notice says why: ' + draw().said.join(' | '));
    d.send({ ev: 'state', state: 'idle', view: null, msg: null });
    speed(0);
    await until(() => d.last().cmd === 'view', 'stopped: the picture');
    speed(50);
    await sleep(400);
    assert.strictEqual(d.last().cmd, 'view', 'after that stop: plays while driving');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    await until(() => keys().indexOf('hero') >= 0, 'the spot while driving (agreed)');
    assert.deepStrictEqual(doorKeys(), [], 'no chips while moving, also with Parked only off');
    settings.set('parkedOnly', true); speed(0);
    await until(() => d.last().cmd === 'view', 'parked');
    console.log('ok parked only off: the risk page (Cancel, BACK, I agree), the drive lock');

    // the risk page left without an answer (the app hidden): parked only again
    settings.set('parkedOnly', false);
    await risk();

    // hidden (Home, another app): stop
    const s0 = d.cmds('stop').length;
    const was = top(); stack = []; visH.forEach((f) => f(was, false));   // (the stub's stack holds every open; the HMI's does not)
    await until(() => d.cmds('stop').length === s0 + 1, 'stop when hidden');
    await sleep(600);
    assert.strictEqual(d.cmds('stop').length, s0 + 1, 'stop once');
    assert.strictEqual(d.cmds('stop').slice(-1)[0].why, 'hidden', 'left the app: the pick goes');
    assert.strictEqual(values.parkedOnly, true, 'the risk page left unanswered: parked only again');

    // hidden for 1 s: the speed watch and the timers stop
    await until(() => logs.some((l) => /hidden: timers off/.test(l)) && sw.off === sw.on, 'hidden: no speed watch, no timers', 3000);
    console.log('ok hidden: no speed watch, no timers');

    // a ring while hidden -> the RING pop-up once per hit, its text, closed by itself; View -> VIEW
    const hasLog = (re) => logs.some((l) => re.test(l));
    const ev = (id, type, cam, count) => d.send({ ev: 'event', id, cam: cam || 0, label: LABELS[cam || 0], type: type || 'ring', ts: Date.now(), count: count || 1, thumb: false });
    const popText = () => ring.texts.filter((t) => t[0] === 'RING_TEXT' && t[1]).map((t) => t[1]).slice(-1)[0];
    const closed = (re) => until(() => hasLog(re), 'pop-up closed: ' + re, 3000);
    const hide = async () => { const w = top(); stack = []; visH.forEach((f) => f(w, false)); await until(() => d.last().cmd === 'stop', 'hidden'); await sleep(1100); };
    const v0 = d.cmds('view').length;
    speed(0);
    const on0 = sw.on;
    ev('h1');
    await until(() => ring.opened === 1 && popText() === 'Doorbell · Door', 'ring hidden: the pop-up, its text');
    assert.ok(sw.on === on0 + 1 && sw.off === on0, 'the speed read for the pop-up only: watched while it shows');
    ev('h1b');
    await until(() => hasLog(/h1b#1: a pop-up is already up \(h1#1\)/), 'not stacked');
    await closed(/pop-up h1#1 closed \(30 s\)/);
    assert.strictEqual(sw.off, sw.on, 'closed: the speed watch stopped');
    assert.ok(ring.closed.indexOf('RING') >= 0, 'closed in the HMI');
    ev('h1');
    await sleep(200);
    assert.strictEqual(ring.opened, 1, 'the same hit again (its picture): no pop-up');
    ev('h1', 'ring', 0, 2);                               // pressed again within 120 s: the same row, count 2
    await until(() => ring.opened === 2, 'a second ring in the same row: a pop-up again');
    await closed(/pop-up h1#2 closed \(30 s\)/);
    // a row the events list already had (an app restart): the same count is no new ring, a later hit is
    d.send({ ev: 'events', list: [{ id: 'h2', cam: 0, label: 'Door', type: 'ring', ts: Date.now() - 60000, count: 3, thumb: false }] });
    await sleep(100);
    ev('h2', 'ring', 0, 3); await sleep(200);
    assert.strictEqual(ring.opened, 2, 'a listed ring updated: no pop-up');
    ev('h2', 'ring', 0, 4);
    await until(() => ring.opened === 3, 'a listed row rung again: the pop-up');
    await closed(/pop-up h2#4 closed/);
    // a Check Control message on screen: asked every 2 s (60 ms here), given up after 30 s; refused twice, then shown
    ring.refuse = 1000;
    ev('h3');
    await until(() => hasLog(/pop-up h3#1: none \(refused \(INVALID_COMPONENTID\), try \d+: given up after 30 s\)/), 'refused: given up', 5000);
    assert.ok(ring.refused > 3, 'retried: ' + ring.refused);
    const n3 = ring.refused; await sleep(300);
    assert.strictEqual(ring.refused, n3, 'no tries after giving up');
    assert.strictEqual(sw.off, sw.on, 'given up: the speed watch stopped');
    ring.refuse = 2;
    ev('h4');
    await until(() => ring.opened === 4 && hasLog(/pop-up h4#1 open ok \(try 3\)/), 'refused twice, then the pop-up');
    assert.strictEqual(d.cmds('view').length, v0, 'no stream for the pop-up');
    ring.clicks.RING_OK();
    await until(() => top() === 'VIEW' && hasLog(/view opened \(openState VIEW\)/) && hasLog(/pop-up h4#1 closed \(tap\)/), 'View: VIEW', 3000);
    await until(() => d.last().cmd === 'view' && d.last().view === 'spot', 'View: the spot');
    // on screen: no pop-up, the Live tab (the service's hero is the doorbell)
    d.send(L); d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    await until(() => keys().indexOf('tab:past') >= 0, 'the spot drawn');
    tap('tab:past');
    await until(() => keys().indexOf('cam:0') < 0, 'the timeline');
    ev('h5');
    await until(() => hasLog(/h5#1: the app is on screen, no pop-up/) && keys().indexOf('cam:0') >= 0, 'a ring on screen: Live, no pop-up');
    assert.strictEqual(ring.opened, 4, 'on screen: no pop-up');
    await hide();
    ring.refuseView = 1;                                  // VIEW refused: ctx.front() (the tile tap's path)
    ev('h6');
    await until(() => ring.opened === 5, 'h6 pop-up');
    ring.clicks.RING_OK();
    await until(() => top() === 'VIEW' && hasLog(/view opened \(front\(\)\)/) && ring.fronts === 1, 'VIEW refused: front()', 5000);
    await hide();
    // never while moving or with no speed, Parked only off or not (D11)
    speed(10);
    ev('h7');
    await until(() => hasLog(/pop-up h7#1: none \(moving\)/), 'moving: no pop-up');
    values.parkedOnly = false; values._drivingAgreed = true;
    ev('h8');
    await until(() => hasLog(/pop-up h8#1: none \(moving\)/), 'moving with Parked only off and agreed: no pop-up');
    values.parkedOnly = true; values._drivingAgreed = false;
    kmhNow = null;
    ev('h9');
    await until(() => hasLog(/pop-up h9#1: none \(no speed reading\)/), 'no speed: no pop-up');
    assert.strictEqual(ring.opened, 5, 'none of them');
    assert.strictEqual(sw.off, sw.on, 'the speed watch stopped after each');
    speed(0);
    d.send({ ev: 'event', id: 'h13', cam: 40, label: 'Gate', type: 'ring', ts: Date.now(), count: 1, thumb: false });   // a camera the list lacks
    await until(() => popText() === 'Doorbell · Gate', 'the event row\'s own label');
    await closed(/pop-up h13#1 closed/);
    // shown, then the car moves off: closed at once (D11)
    let o = ring.opened, nc = ring.closed.length;
    ev('h14');
    await until(() => ring.opened === o + 1 && popText() === 'Doorbell · Door', 'h14 pop-up');
    speed(10);
    await closed(/pop-up h14#1 closed \(moving\)/);
    assert.ok(ring.closed.slice(nc).indexOf('RING') >= 0 && sw.off === sw.on, 'moving: closed in the HMI, the speed watch stopped');
    speed(0);
    // a ring while the feed was redialled: the events list after it has a ring newer than the last one seen, under
    // 60 s old: it pops up once; an older listed ring, or the same list again, does not
    o = ring.opened;
    const gap = [{ id: 'g0', cam: 0, label: 'Door', type: 'ring', ts: Date.now() - 30000, count: 1, thumb: false },
        { id: 'g1', cam: 0, label: 'Door', type: 'ring', ts: Date.now(), count: 1, thumb: false }];
    d.send({ ev: 'events', list: gap });
    await until(() => ring.opened === o + 1 && hasLog(/ring g1#1 received/), 'a ring from the gap: its pop-up');
    assert.ok(!hasLog(/ring g0#1 received/), 'a ring older than the last one seen: none');
    await closed(/pop-up g1#1 closed \(30 s\)/);
    d.send({ ev: 'events', list: gap });
    await sleep(200);
    assert.strictEqual(ring.opened, o + 1, 'the same list again: no pop-up');
    settings.set('alertRing', false);
    ev('h10');
    await until(() => hasLog(/h10#1: pop-ups for ring are off/), 'rings off: none');
    settings.set('alertRing', true);
    console.log('ok ring pop-up: once per hit, a second ring in the same row, text, auto-close, not stacked, a listed row, refused -> retries -> given up, View -> VIEW (and front()), on screen -> Live, moving, Parked only off, no speed, off');

    // person, vehicle, package, animal: off by default, each its own setting; a cooldown per camera and type
    const TYPES = [['person', 'alertPerson', 'Person'], ['vehicle', 'alertVehicle', 'Vehicle'], ['package', 'alertPackage', 'Package'], ['animal', 'alertAnimal', 'Animal']];
    assert.deepStrictEqual(TYPES.map((t) => values[t[1]]).concat(values.alertCooldown), [false, false, false, false, 5], 'detections off by default, 5 min');
    settings.set('alertCooldown', 1);                     // 1 min (x 0.03: 1.8 s)
    let opened = ring.opened;
    for (const t of TYPES) {
        ev('a-' + t[0], t[0], 1);
        await until(() => hasLog(new RegExp('a-' + t[0] + '#1: pop-ups for ' + t[0] + ' are off')), t[0] + ' off: none');
        settings.set(t[1], true);
        ev('b-' + t[0], t[0], 1);
        await until(() => ring.opened === opened + 1 && popText() === t[2] + ' · Garage', t[0] + ' on: its pop-up');
        opened++;
        if (t[0] === 'person') {
            ev('c1', 'person', 1);                        // the same camera and type within the cooldown
            await until(() => hasLog(/c1#1: person pop-up for this camera in the last/), 'cooldown: none');
        }
        await closed(new RegExp('pop-up b-' + t[0] + '#1 closed \\(30 s\\)'));
    }
    ev('c2', 'person', 1);                                // the cooldown over
    await until(() => ring.opened === opened + 1 && popText() === 'Person · Garage', 'after the cooldown: a pop-up');
    opened++;
    ev('h11');                                            // a ring takes a detection's place
    await until(() => hasLog(/pop-up c2#1 closed \(a ring takes its place\)/) && ring.opened === opened + 1 && popText() === 'Doorbell · Door', 'a ring replaces the detection');
    opened++;
    ev('c3', 'vehicle', 2);
    await until(() => hasLog(/c3#1: a pop-up is already up \(h11#1\)/), 'a detection never replaces a ring');
    await closed(/pop-up h11#1 closed \(30 s\)/);
    // French: the pop-up and its button
    settings.set('french', true);
    ev('h12');
    await until(() => popText() === 'Sonnette · Door' && ring.texts.some((t) => t[0] === 'RING_OK' && t[1] === 'Voir'), 'French pop-up');
    await closed(/pop-up h12#1 closed/);
    settings.set('french', false);
    assert.strictEqual(sw.off, sw.on, 'no speed watch left');
    console.log('ok detection pop-ups: off by default, each on, the cooldown, a ring takes their place; French');

    const errs = logs.filter((l) => l[0] === 'E');
    assert.deepStrictEqual(errs, [], 'no errors logged');
    console.log('smoke: all checks passed (' + process.version + ')');
    process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.error(logs.slice(-30).join('\n')); process.exit(1); });
