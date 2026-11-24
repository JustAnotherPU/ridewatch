'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/**
 * ridewatch-audio.js - jap-ridewatch-audio, the car's sound for RideWatch's Listen and Talk. Started by its socket
 * (jap-ridewatch-audio.socket, /run/jap-ridewatch/audio.sock 0600, owned by RideWatch's own uid 3911: only the service,
 * ridewatchd.js, connects, and root) and gone 60 s after its last session. Runs on the unit's own Node (/usr/bin/node:
 * someip.node is built for it); ES2017. Runs as root: the car's SOME/IP policy lets root reach AudioManager and has no
 * entry for 3911 (the car's own voice helper is root for the same reason). What it starts, the player, runs as
 * JAP_RIDEWATCH_PLAYER_AS (3911:mgu_alsa), never as root. It serves only a socket that is 3911's and 0600 (it checks; it
 * makes it so when it binds it itself): Node 8 cannot read the peer's uid (no SO_PEERCRED without native code), so the
 * socket's owner and mode are the access check.
 *
 * One connection = one stream, 4 at once at most. The first line says what (at most 256 bytes, within 2 s), and only
 * these keys; anything else closes the connection:
 *   {"cmd":"caps"}               -> {"ev":"caps","play":bool,"mic":bool}: what a session could do (config, player,
 *                                   lease); AudioManager is not touched
 *   {"cmd":"play","rate":24000}  -> {"ev":"play","ok":true,"source":"<port>"} then the connection's bytes (s16le mono)
 *                                   go to the player; or {"ev":"play","ok":false,"why":"call|busy|nosource|noplayer|root|error"}
 *   {"cmd":"mic"}                -> {"ev":"mic","ok":true,"rate":16000,"ch":1,"fmt":"s16le","max":60} then the mic's
 *                                   PCM; or {"ev":"mic","ok":false,"why":"nomic|call|busy|<the lease's why>|error"}
 *   {"cmd":"stop"}               -> every session ends, {"ev":"stop","ok":true}
 * A play session ends with {"ev":"end","why"} and the close (why "limit": the config's listenMaxS, 300 s by default), a
 * mic session with the close alone (its PCM runs that way); closing it from the other side ends it too.
 *
 * Play: a source of the config's list, only if AudioManager lists it with no connection of its own, made available if
 *   it was not (RoutingControlObserver.hookSourceAvailablityStatusChange) and connected to the main sink 1024
 *   (CommandControl.connect: E_OK only; E_ALREADY_EXISTS is someone else's connection, never used nor disconnected),
 *   then the player (pcmio or aplay) on plug:smartx:<port>. Ending: player killed, CommandControl.disconnect, the
 *   availability read at the start put back. STATE records the source, its prior availability and the connection,
 *   written (atomically) before anything changes; after a kill --sweep (the unit's ExecStopPost) undoes what it says,
 *   for a source of the config only. Every AudioManager change runs one at a time (two plays back to back never cross).
 * Mic: only through a lease (JAP_RIDEWATCH_MIC_LEASE: a socket whose owner keeps the mic device and lends its PCM):
 *   {"cmd":"lend","what":"mic","who":"ridewatch","ms":30000} -> {"ev":"lease","ok":true,"rate":16000,"ch":1,
 *   "fmt":"s16le","until":ms} then PCM; renewed every 20 s, 60 s at most; a close returns it. No lease: refused (this
 *   version never opens the mic device itself). It connects to the lender as root: a lender that admits one uid (3911)
 *   keeps other users out, root gets in anyway.
 * Half duplex: while a mic session is open the play PCM is dropped (whole samples), sound again 300 ms after it ends.
 * Calls win: no start while a phone source (calls, rings, phone assistants), BMW speech or another voice is up
 *   (busy()); one appearing ends every session (polled every 100 ms while a session runs: torn down within 300 ms). No
 *   answer from AudioManager for 1 s ends every session too (why busy): no call watch, no sound.
 *
 * Environment (the car's defaults):
 *   JAP_RIDEWATCH_AUDIO_CONF   /var/opt/jap-ridewatch/audio.json (root's own, optional; else audio.json beside this file)
 *   JAP_RIDEWATCH_AUDIO_STATE  /run/jap-ridewatch-audio/conn.json   JAP_RIDEWATCH_MIC_LEASE  (none)
 *   JAP_RIDEWATCH_SOMEIP       /usr/lib/someip.node                 JAP_RIDEWATCH_AM_DEFS    defs/ beside this file
 *   JAP_RIDEWATCH_AUDIO        /run/jap-ridewatch/audio.sock (outside systemd; under it the socket is fd 3)
 *   JAP_RIDEWATCH_PLAYER_AS    uid:group the player runs as when the helper is root (none: no player as root)
 *   JAP_RIDEWATCH_AUDIO_CLIENT 3911: the uid audio.sock must belong to
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const spawn = require('child_process').spawn;

const E = process.env;
const CONF = E.JAP_RIDEWATCH_AUDIO_CONF || '/var/opt/jap-ridewatch/audio.json';
const STATE = E.JAP_RIDEWATCH_AUDIO_STATE || '/run/jap-ridewatch-audio/conn.json';
const SOCK = E.JAP_RIDEWATCH_AUDIO || '/run/jap-ridewatch/audio.sock';
const CLIENT = +E.JAP_RIDEWATCH_AUDIO_CLIENT || 3911;       // the one uid the socket is for (ridewatchd)
const LEASE = E.JAP_RIDEWATCH_MIC_LEASE || '';
const SOMEIP = E.JAP_RIDEWATCH_SOMEIP || '/usr/lib/someip.node';
// our own trimmed copies of the two schemas (only the calls below): MainApp's src-gen has no RoutingControlObserver
const DEFS = E.JAP_RIDEWATCH_AM_DEFS || path.join(__dirname, 'defs');
const IDLE_MS = +E.JAP_RIDEWATCH_AUDIO_IDLE_MS || 60000;
const SINK = 1024, POLL_MS = 100, SILENT_MS = 1000, UNMUTE_MS = 300, MIC_MAX_MS = 60000, RENEW_MS = 20000, LEASE_MS = 30000;
const FIRST_MS = 2000, SWEEP_MS = 15000, MAX_CONNS = 4;
// the first line: these commands with these keys only
const KEYS = { caps: [], stop: [], mic: [], play: ['rate'] };
// the phone's sources: HFP calls 256/257, rings 258-260/264, service and e-call 261/262, CarPlay telephony 267 and Siri
// 268, Android Auto voice 274, BT voice recognition 277/278, e-SIM call 291
const PHONE = [256, 257, 258, 259, 260, 261, 262, 264, 267, 268, 274, 277, 278, 291];
// never ours, whatever a config says: the phone's, BMW speech (276), another voice's 288/289
const DENY = PHONE.concat([276, 288, 289]), DENY_PORT = /CarLifeNavigation|SpeechSink/i;
const AVAIL = ['A_UNKNOWN', 'A_AVAILABLE', 'A_UNAVAILABLE'];
const RATES = [16000, 24000, 48000];

const log = (m) => console.error(new Date().toISOString() + ' ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout'); })]);
const quiet = (p) => Promise.resolve(p).catch((e) => 'ERR ' + ((e && e.message) || e));
const W = (why) => Object.assign(new Error(why), { why });
const isRoot = () => !!(process.getuid && process.getuid() === 0);

/**
 * The player's identity when the helper is root: JAP_RIDEWATCH_PLAYER_AS uid:group (a name from /etc/group or a gid).
 * -> { uid, gid } | null (unset, root, or a group not found: no player then). Node's spawn drops the supplementary
 * groups when it sets uid and gid, so the group given is the player's only one.
 */
let childAs;
function playerAs() {
    if (childAs !== undefined) return childAs;
    childAs = null;
    const m = /^(\d+):([A-Za-z0-9_-]+)$/.exec(E.JAP_RIDEWATCH_PLAYER_AS || '');
    if (!m) return childAs;
    let gid = /^\d+$/.test(m[2]) ? +m[2] : -1;
    if (gid < 0) {
        try {
            const l = fs.readFileSync('/etc/group', 'utf8').split('\n').map((x) => x.split(':')).find((f) => f[0] === m[2]);
            if (l && /^\d+$/.test(l[2])) gid = +l[2];
        } catch (e) { /* below */ }
    }
    if (+m[1] > 0 && gid > 0) childAs = { uid: +m[1], gid };
    else log('JAP_RIDEWATCH_PLAYER_AS=' + E.JAP_RIDEWATCH_PLAYER_AS + ': not a uid:group without root, no player');
    return childAs;
}
/** a player may start: as root only with its own identity */
const canSpawn = () => !isRoot() || !!playerAs();

/* ---------- config: root's file or the one shipped beside this file ---------- */
function config() {
    let f = path.join(__dirname, 'audio.json');
    try {
        const st = fs.lstatSync(CONF);
        // it names the commands this runs: root's, a plain file, written by no one else
        if (st.isFile() && st.uid === 0 && !(st.mode & 0o022)) f = CONF;
        else log(CONF + ': not a root-owned file closed to others, ignored');
    } catch (e) { /* none: the shipped one */ }
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    const sources = (Array.isArray(c.sources) ? c.sources : []).filter((s) => s && typeof s.port === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(s.port))
        .filter((s) => Number.isInteger(s.id) && s.id > 0 && s.id < 65536 && DENY.indexOf(s.id) < 0 && !DENY_PORT.test(s.port));
    const argv = (a) => (Array.isArray(a) && a.length && a.every((x) => typeof x === 'string') ? a : null);
    const max = Number.isInteger(c.listenMaxS) && c.listenMaxS > 0 && c.listenMaxS <= 3600 ? c.listenMaxS : 300;
    return { sources, players: [argv(c.player), argv(c.fallback)].filter(Boolean), playMaxMs: max * 1000 };
}
/** the first player whose binary is there, its {port} and {rate} filled in; null: none */
function playerFor(conf, port, rate) {
    for (const a of conf.players) {
        try { fs.accessSync(a[0], fs.constants.X_OK); } catch (e) { continue; }
        return a.map((x) => x.replace('{port}', port).replace('{rate}', String(rate)));
    }
    return null;
}
/** s16le: whole samples only; an odd byte waits in o.odd for the next chunk (so a dropped chunk never shifts the rest) */
function whole(o, d) {
    if (o.odd) { d = Buffer.concat([o.odd, d]); o.odd = null; }
    if (d.length & 1) { o.odd = d.slice(d.length - 1); d = d.slice(0, d.length - 1); }
    return d;
}

/* ---------- AudioManager (CommandControl + RoutingControlObserver over SOME/IP) ---------- */
let am = null, amP = null;          // module-level: a proxy held only by a local is collected and dies silently
async function proxy(someip, name) {
    const p = await someip.buildProxy(JSON.parse(fs.readFileSync(path.join(DEFS, name + '.json'), 'utf8')), '1');
    await p.init();
    const up = () => Promise.resolve(p.isAvailable ? p.isAvailable() : true);
    for (let i = 0; i < 50 && !(await up()); i++) await sleep(100);
    if (!(await up())) throw new Error(name + ' not available after 5 s');
    return p;
}
function amUp() {
    if (am) return Promise.resolve(am);
    if (!amP) {
        amP = (async () => {
            const someip = require(SOMEIP);
            const cc = await proxy(someip, 'org_genivi_am_commandinterface_CommandControl');
            const ro = await proxy(someip, 'org_genivi_am_routinginterface_RoutingControlObserver');
            am = { cc, ro };
            await quiet(serial(sweep));  // what a killed run left (no ExecStopPost: a power cut mid-session)
            return am;
        })();
        amP.catch(() => { amP = null; });
    }
    return amP;
}
const arr = (r, k) => (r && Array.isArray(r[k]) ? r[k] : Array.isArray(r) ? r : []);
async function list() {
    return arr(await am.cc.callMethod('getListMainConnections', {}, 3000), 'listConnections').filter((c) => c && Number.isInteger(c.sourceID));
}
async function sources() {
    return arr(await am.cc.callMethod('getListMainSources', {}, 3000), 'listMainSources').filter((s) => s && Number.isInteger(s.sourceID) && s.availability);
}
const avail = (id, a) => am.ro.callMethod('hookSourceAvailablityStatusChange', { sourceID: id, availability: a }, 3000);
const disconnect = (id) => am.cc.callMethod('disconnect', { mainConnectionID: id }, 3000);
const short = (l) => l.map((c) => c.sourceID + '>' + c.sinkID + (c.connectionState === 'CS_CONNECTED' ? '' : ':' + c.connectionState)).join(',');
// one AudioManager change at a time: a release always lands before the next claim
let amQ = Promise.resolve();
function serial(fn) { const p = amQ.then(fn, fn); amQ = p.catch(() => {}); return p; }

/**
 * src -> 1024 when the source is free (listed, no connection of its own): made available if it was not, connected,
 * CS_CONNECTED within 3 s. -> null (not free, nothing changed) or C = { src, id, prior, ok } for release(C).
 */
async function claimNow(src, isDone) {
    const s = (await sources()).find((x) => x.sourceID === src);
    if (!s) { log(src + ': not listed by AudioManager, next'); return null; }
    if ((await list()).some((c) => c.sourceID === src)) { log(src + ': in use, next'); return null; }
    const a = s.availability;
    const C = { src, id: null, prior: { availability: AVAIL.indexOf(a.availability) >= 0 ? a.availability : 'A_UNKNOWN', availabilityReason: a.availabilityReason | 0 }, ok: false };
    if (!record(C)) { log(src + ': no record, next'); return null; }   // before anything changes: a kill from here on is swept
    try {
        if (C.prior.availability !== 'A_AVAILABLE') await avail(src, { availability: 'A_AVAILABLE', availabilityReason: 0 });
        const r = await am.cc.callMethod('connect', { sourceID: src, sinkID: SINK }, 3000);
        if (!r || r.amError !== 'E_OK') { log('connect ' + src + ': ' + (r && r.amError) + ', next'); return C; }   // E_ALREADY_EXISTS: not ours
        C.id = r.mainConnectionID;
        record(C);
        for (let i = 0; i < 60 && !isDone(); i++) {
            const c = (await list()).find((x) => x.mainConnectionID === C.id);
            if (c && c.connectionState === 'CS_CONNECTED') { C.ok = true; return C; }
            await sleep(50);
        }
        if (!isDone()) log(src + ' (' + C.id + '): not CS_CONNECTED in 3 s, next');
    } catch (e) { log('claim ' + src + ': ' + e.message); }
    return C;
}
/** ours gone: our connection disconnected, the availability read at the claim put back (each call capped) */
async function releaseNow(C) {
    const d = C.id === null ? null : await quiet(within(disconnect(C.id), 3000));
    const a = C.prior.availability === 'A_AVAILABLE' ? 'kept' : await quiet(within(avail(C.src, C.prior), 3000));
    record(null);
    log('released ' + C.src + (C.id === null ? '' : ' (' + C.id + ' disconnect ' + JSON.stringify(d) + ')') + ', ' + C.prior.availability + ' ' + JSON.stringify(a));
}
const claim = (src, isDone) => serial(() => claimNow(src, isDone));
const release = (C) => serial(() => releaseNow(C));
/** -> false when o could not be written (the claim must not go on: a kill would leave nothing to sweep) */
function record(o) {
    try {
        if (o) { fs.writeFileSync(STATE + '.tmp', JSON.stringify({ src: o.src, id: o.id, prior: o.prior }), { mode: 0o600 }); fs.renameSync(STATE + '.tmp', STATE); }
        else fs.unlinkSync(STATE);
        return true;
    } catch (e) { if (o || e.code !== 'ENOENT') log('state file: ' + e.message); return false; }
}
/**
 * What a killed run recorded, only for a source of the config: its connection disconnected (the recorded id; recorded
 * before connect answered: that source's connection to 1024, the source having had none when it was claimed), its
 * availability put back.
 */
async function sweep() {
    let o = null;
    try { o = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') record(null); return; }
    const ids = config().sources.map((s) => s.id);
    const p = o && o.prior;
    if (!o || ids.indexOf(o.src) < 0 || !(o.id === null || Number.isInteger(o.id)) || !p || AVAIL.indexOf(p.availability) < 0 || !Number.isInteger(p.availabilityReason)) {
        log('sweep: ' + STATE + ' does not name a source of the config, removed');
        return record(null);
    }
    const c = (await list()).find((x) => x.sourceID === o.src && x.sinkID === SINK && (o.id === null || x.mainConnectionID === o.id));
    log('sweep: ' + o.src + '>' + SINK + ' (' + o.id + ') ' + (c ? 'still there' : 'gone'));
    await releaseNow({ src: o.src, id: c ? c.mainConnectionID : null, prior: { availability: p.availability, availabilityReason: p.availabilityReason } });
}

/**
 * What forbids a session (or ends one): a phone source, BMW speech (276) or another voice (288/289) to any sink, or
 * anything to a sink other than 1024. Left out: BMW speech's standby mic (129>387), our own connection, and media to
 * 1024 whatever its state (our own connection ducks or suspends it). -> { why: 'call' | 'busy', what } | null
 */
function busy(l, own) {
    const b = l.filter((c) => !(c.sourceID === 129 && c.sinkID === 387) && c.mainConnectionID !== own && c.connectionState !== 'CS_DISCONNECTED')
        .filter((c) => DENY.indexOf(c.sourceID) >= 0 || c.sinkID !== SINK);
    if (!b.length) return null;
    return { why: b.some((c) => PHONE.indexOf(c.sourceID) >= 0) ? 'call' : 'busy', what: short(b) };
}

/* ---------- sessions ---------- */
let play = null, mic = null, unmuteAt = 0, conns = 0, idleT = null, stopping = false, conf = null;
const muted = () => mic !== null || Date.now() < unmuteAt;
const reply = (s, o) => { if (!s.destroyed) s.write(JSON.stringify(o) + '\n'); };
const held = (w) => (w.writableLength !== undefined ? w.writableLength : w._writableState ? w._writableState.length : 0);

async function startPlay(s, m, rest) {
    if (play) endPlay(play, 'replaced');
    const rate = RATES.indexOf(m.rate) >= 0 ? m.rate : 24000;
    const P = play = { s, done: false, src: null, C: null, ch: null, odd: null, rate, timer: null };
    s.on('close', () => endPlay(P, 'closed'));
    try {
        if (!conf.sources.length) throw W('nosource');
        const argv0 = playerFor(conf, conf.sources[0].port, rate);
        if (!argv0) throw W('noplayer');                    // checked before AudioManager is touched
        if (!canSpawn()) throw W('root');                   // never a player as root
        await amUp();
        const b = busy(await list(), null);
        if (b) { log('play refused: ' + b.what); throw W(b.why); }
        for (const src of conf.sources) {
            if (P.done) return;
            const C = await claim(src.id, () => P.done);
            if (!C) continue;
            if (C.ok && !P.done) { P.src = src; P.C = C; break; }
            await release(C);                               // (also when the stream closed meanwhile: endPlay had nothing to release)
        }
        if (P.done) return;
        if (!P.src) throw W('nosource');
        const argv = playerFor(conf, P.src.port, rate);
        if (!argv) throw W('noplayer');
        const ch = P.ch = spawn(argv[0], argv.slice(1), Object.assign({ stdio: ['pipe', 'ignore', 'pipe'] }, isRoot() ? playerAs() : {}));
        ch.stdin.on('error', () => {});
        ch.stderr.on('data', (d) => log('player: ' + String(d).trim().slice(0, 200)));
        ch.on('error', (e) => endPlay(P, 'player: ' + e.message));
        ch.on('exit', (code, sig) => endPlay(P, 'player exit ' + (sig || code)));
        P.timer = setTimeout(() => endPlay(P, 'limit'), conf.playMaxMs);
        log('play ' + P.src.port + ' (' + P.src.id + '>' + SINK + ', connection ' + P.C.id + ') at ' + rate + ' Hz');
        reply(s, { ev: 'play', ok: true, source: P.src.port });
        s.on('data', (d) => feed(P, d));
        if (rest.length) feed(P, rest);
        poll();
    } catch (e) {
        const why = e.why || 'error';
        if (!e.why) log('play: ' + e.message);
        reply(s, { ev: 'play', ok: false, why });
        endPlay(P, why);
    }
}
/** whole samples to the player; dropped while muted (half duplex) and while the player holds 0.5 s (live, not late) */
function feed(P, d) {
    if (P.done || !P.ch) return;
    d = whole(P, d);
    if (muted() || !d.length || held(P.ch.stdin) >= P.rate) return;
    P.ch.stdin.write(d);
}
function endPlay(P, why) {
    if (P.done) return;
    P.done = true;
    clearTimeout(P.timer);
    if (play === P) play = null;
    if (P.ch && P.ch.exitCode === null) P.ch.kill('SIGKILL');   // the sound stops now; AudioManager follows
    log('play end (' + why + ')');
    reply(P.s, { ev: 'end', why });
    P.s.end();
    P.end = P.C ? release(P.C) : Promise.resolve();
    idle();
}

async function startMic(s) {
    if (mic) endMic(mic, 'replaced');
    const M = mic = { s, done: false, lease: null, timers: [], odd: null };
    s.on('close', () => endMic(M, 'closed'));
    try {
        if (!LEASE) throw W('nomic');                      // shortcut: no own capture, only a lent mic; add one when a car has no lender
        await amUp();
        const b = busy(await list(), play && play.C && play.C.id);
        if (b) { log('mic refused: ' + b.what); throw W(b.why); }
        const L = M.lease = net.connect(LEASE);
        L.on('error', (e) => { if (!M.done) log('lease: ' + e.message); });
        const first = await new Promise((res, rej) => {
            let buf = Buffer.alloc(0);
            const t = setTimeout(() => rej(W('nomic')), 3000);
            L.on('connect', () => L.write(JSON.stringify({ cmd: 'lend', what: 'mic', who: 'ridewatch', ms: LEASE_MS }) + '\n'));
            L.on('close', () => { clearTimeout(t); rej(W(M.done ? 'closed' : 'nomic')); });
            L.on('data', function on(d) {
                buf = Buffer.concat([buf, d]);
                const k = buf.indexOf(10);
                if (k < 0) { if (buf.length > 512) { clearTimeout(t); rej(W('error')); } return; }
                clearTimeout(t);
                L.removeListener('data', on);
                res({ line: buf.slice(0, k).toString('utf8'), rest: buf.slice(k + 1) });
            });
        });
        let o = null;
        try { o = JSON.parse(first.line); } catch (e) { throw W('error'); }
        if (!o || o.ev !== 'lease') throw W('error');
        if (o.ok !== true) throw W(/^[a-z]{1,16}$/.test(o.why) ? o.why : 'refused');
        if (o.rate !== 16000 || o.ch !== 1 || o.fmt !== 's16le') throw W('format');
        if (M.done) return;
        L.removeAllListeners('close');
        L.on('close', () => endMic(M, 'returned'));
        reply(s, { ev: 'mic', ok: true, rate: 16000, ch: 1, fmt: 's16le', max: MIC_MAX_MS / 1000 });
        const out = (d) => { if (M.done) return; d = whole(M, d); if (d.length && held(s) < 32000) s.write(d); };   // live: over 1 s behind, dropped
        if (first.rest.length) out(first.rest);
        L.on('data', out);
        const t0 = Date.now();
        M.timers.push(setInterval(() => {
            const left = MIC_MAX_MS - (Date.now() - t0);
            if (left > 0 && !L.destroyed) L.write(JSON.stringify({ cmd: 'renew', ms: Math.min(LEASE_MS, left) }) + '\n');
        }, RENEW_MS));
        M.timers.push(setTimeout(() => endMic(M, 'max'), MIC_MAX_MS));
        log('mic lent');
        poll();
    } catch (e) {
        const why = e.why || 'error';
        if (!e.why) log('mic: ' + e.message);
        reply(s, { ev: 'mic', ok: false, why });
        endMic(M, why);
    }
}
function endMic(M, why) {
    if (M.done) return;
    M.done = true;
    if (mic === M) { mic = null; unmuteAt = Date.now() + UNMUTE_MS; }
    M.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    if (M.lease) M.lease.destroy();                         // the close returns the mic
    log('mic end (' + why + ')');
    M.s.end();                                              // (no end line: PCM flows that way; the why is in the log)
    idle();
}
function endAll(why) {
    if (play) endPlay(play, why);
    if (mic) endMic(mic, why);
}

/**
 * While a session runs: a call or a voice appearing ends them all (100 ms + the list's answer: well under 300 ms).
 * Fails closed: no list answered for 1 s ends them too. Logged: the first failure and the recovery only.
 */
let pollT = null, polling = false, lastOk = 0, failing = false;
function poll() {
    if (pollT || !am) return;
    lastOk = Date.now();
    pollT = setInterval(() => {
        if (!play && !mic) { clearInterval(pollT); pollT = null; return; }
        if (Date.now() - lastOk > SILENT_MS) { log('AudioManager silent for ' + SILENT_MS + ' ms: no call watch, sessions ended'); lastOk = Date.now(); return endAll('busy'); }
        if (polling) return;
        polling = true;
        list().then((l) => {
            lastOk = Date.now();
            if (failing) { failing = false; log('poll: AudioManager answers again'); }
            const b = busy(l, play && play.C && play.C.id);
            if (b) { log('torn down: ' + b.what); endAll(b.why); }
        }, (e) => { if (!failing) { failing = true; log('poll: ' + e.message); } }).then(() => { polling = false; });
    }, POLL_MS);
}

function idle() {
    clearTimeout(idleT);
    idleT = null;
    if (play || mic || conns || stopping) return;
    idleT = setTimeout(() => shutdown(0, 'idle'), IDLE_MS);
}

function serve(srv) {
    srv.on('connection', (s) => {
        if (conns >= MAX_CONNS) return s.destroy();
        conns++;
        clearTimeout(idleT); idleT = null;
        s.on('error', () => {});
        s.on('close', () => { conns--; idle(); });
        let buf = Buffer.alloc(0);
        const late = setTimeout(() => s.destroy(), FIRST_MS);    // a client that never says what it wants holds nothing
        s.on('data', function first(d) {
            buf = Buffer.concat([buf, d]);
            const k = buf.indexOf(10);
            if (k < 0 ? buf.length > 256 : k > 256) return s.destroy();
            if (k < 0) return;
            clearTimeout(late);
            s.removeListener('data', first);
            let m = null;
            try { m = JSON.parse(buf.slice(0, k).toString('utf8')); } catch (e) { /* below */ }
            const rest = buf.slice(k + 1);
            const keys = m && typeof m === 'object' && !Array.isArray(m) && Object.prototype.hasOwnProperty.call(KEYS, m.cmd) ? KEYS[m.cmd] : null;
            if (!keys || Object.keys(m).some((k) => k !== 'cmd' && keys.indexOf(k) < 0) || (m.rate !== undefined && RATES.indexOf(m.rate) < 0) || stopping) return s.destroy();
            if (conf === null) try { conf = config(); } catch (e) { log('config: ' + e.message); conf = { sources: [], players: [], playMaxMs: 300000 }; }
            if (m.cmd === 'caps') {
                reply(s, { ev: 'caps', play: conf.sources.length > 0 && !!playerFor(conf, conf.sources[0].port, 24000) && canSpawn(), mic: !!LEASE });
                return s.end();
            }
            if (m.cmd === 'play') return startPlay(s, m, rest);
            if (m.cmd === 'mic') return startMic(s);
            endAll('stop'); reply(s, { ev: 'stop', ok: true }); s.end();
        });
    });
}

async function shutdown(code, why) {
    if (stopping) return;
    stopping = true;
    log('exit (' + why + ')');
    setTimeout(() => process.exit(code), 4000).unref();     // inside the unit's TimeoutStopSec whatever AudioManager does
    const p = play;
    endAll('exit');
    if (p && p.end) await p.end;
    process.exit(code);
}

/**
 * Root writes and renames in the state folder and the sweep acts on what is in it: only a real folder of our own (root's
 * under the unit), 0700. Missing is allowed (nothing can be recorded then, so nothing is claimed). Else: exit 1.
 */
function stateDirOk() {
    let st;
    try { st = fs.lstatSync(path.dirname(STATE)); } catch (e) { return e.code === 'ENOENT'; }
    return st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o777) === 0o700;
}
function main() {
    process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
    process.on('SIGINT', () => shutdown(0, 'SIGINT'));
    process.on('uncaughtException', (e) => { log('uncaught ' + ((e && e.stack) || e)); shutdown(1, 'uncaught'); });
    process.on('unhandledRejection', (e) => log('unhandled rejection ' + ((e && e.stack) || e)));
    const srv = net.createServer();
    serve(srv);
    srv.on('error', (e) => { log('listen: ' + e.message); process.exit(1); });
    // the socket is the access check: CLIENT's, 0600, or nothing is served
    const mine = () => { const st = fs.lstatSync(SOCK); return st.isSocket() && st.uid === CLIENT && (st.mode & 0o777) === 0o600; };
    const refuse = (why) => { log(SOCK + ': ' + why + ', not serving'); process.exit(1); };
    if (E.LISTEN_FDS) {
        try { if (!mine()) refuse('not ' + CLIENT + "'s 0600"); } catch (e) { refuse(e.message); }
        srv.listen({ fd: 3 }, () => log('up on fd 3'));
    } else {
        // a hand start: the socket's folder must be ours and closed to others, or the chown below could follow a link put
        // there (Node 8 has no lchown on Linux)
        try {
            const d = fs.lstatSync(path.dirname(SOCK));
            if (!d.isDirectory() || d.uid !== process.getuid() || (d.mode & 0o022)) refuse('its folder is not ours and closed to others');
        } catch (e) { refuse(e.message); }
        try { fs.unlinkSync(SOCK); } catch (e) { /* none */ }
        const um = process.umask(0o177);                    // 0600 from the bind on, before the chown
        srv.listen(SOCK, () => {
            process.umask(um);
            try { fs.chownSync(SOCK, CLIENT, CLIENT); fs.chmodSync(SOCK, 0o600); if (!mine()) throw new Error('not ' + CLIENT + "'s 0600"); } catch (e) { refuse(e.message); }
            log('up on ' + SOCK);
        });
    }
    idle();
}

if (require.main === module) {
    if (!stateDirOk()) { log(path.dirname(STATE) + ': not our own 0700 folder, not serving'); process.exit(1); }
    if (process.argv[2] === '--sweep') {
        // ExecStopPost, after every run: only when a run left a record does it touch AudioManager (15 s at most, inside
        // the unit's TimeoutStopSec=20)
        if (!fs.existsSync(STATE)) process.exit(0);
        within(amUp(), SWEEP_MS).then(() => amQ).then(() => process.exit(0), (e) => { log('sweep: ' + e.message); process.exit(0); });
    } else main();
}
module.exports = { busy, config, playerFor, whole, DENY, PHONE };
