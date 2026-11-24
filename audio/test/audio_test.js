'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// jap-ridewatch-audio against a fake AudioManager (fake_someip.js -> FAKE_AM here), a fake player and a fake mic lease.
// The helper runs as root (as the unit does) with the shipped defs/ (the fake refuses a method they do not describe), its
// socket handed to uid 4242 (the unit's 3911) and its player run as 4242:audio (the unit's 3911:mgu_alsa). Run as root:
// docker run --rm --network none -v "$PWD:/w" -w /w node:22-alpine node audio/test/audio_test.js
// (and node:8.16.0, the glibc image: the unit runs it on the car's own Node 8)
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HELPER = path.join(__dirname, '..', 'ridewatch-audio.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rwaudio-'));
fs.chmodSync(tmp, 0o755);
const P = (f) => path.join(tmp, f);
// the player's group: 'audio', by name as the unit gives mgu_alsa (alpine 18, debian 29)
const AUDIO_GID = +fs.readFileSync('/etc/group', 'utf8').split('\n').map((l) => l.split(':')).find((f) => f[0] === 'audio')[2];
fs.mkdirSync(P('run')); fs.chownSync(P('run'), 4242, 4242);          // the helper's own: its socket, conn.json, the player's output
const R = (f) => P('run/' + f);
// root's: the socket's folder (0755) and the state folder (0700), as the unit has them
fs.mkdirSync(P('sock')); fs.chmodSync(P('sock'), 0o755); fs.mkdirSync(P('state')); fs.chmodSync(P('state'), 0o700);
const S = (f) => P('sock/' + f), T = (f) => P('state/' + f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms) { const end = Date.now() + (ms || 3000); while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(5); } }
if (!(process.getuid && process.getuid() === 0)) { console.log('audio_test: run as root (the config must be root\'s): skipped'); process.exit(1); }

/* ---- fake AudioManager ---- */
const am = { conns: [], calls: [], next: 100, connectErr: {}, connectSlow: {}, src: {}, hang: false };
am.reset = () => { am.calls = []; [501, 502].forEach((id) => { am.src[id] = { availability: 'A_UNAVAILABLE', availabilityReason: 0 }; }); };
am.reset();
const AV = { A_AVAILABLE: 'avail ', A_UNAVAILABLE: 'unavail ' };
am.names = () => am.calls.filter((c) => !/^getList/.test(c.name)).map((c) => c.name === 'connect' ? 'connect ' + c.args.sourceID + '>' + c.args.sinkID
    : c.name === 'disconnect' ? 'disconnect ' + c.args.mainConnectionID : (AV[c.args.availability.availability] || c.args.availability.availability + ' ') + c.args.sourceID);
function amAnswer(m) {
    am.calls.push(Object.assign({ t: Date.now() }, m));
    const a = m.args;
    if (m.name === 'getListMainConnections') return { listConnections: am.conns.map((c) => Object.assign({}, c)), amError: 'E_OK' };
    if (m.name === 'getListMainSources') return { listMainSources: Object.keys(am.src).map((k) => ({ sourceID: +k, name: 'S' + k, availability: am.src[k], sourceClassID: 1 })), amError: 'E_OK' };
    if (m.name === 'hookSourceAvailablityStatusChange') { am.src[a.sourceID] = a.availability; return {}; }
    if (m.name === 'connect') {
        if (am.connectErr[a.sourceID] === 'E_ALREADY_EXISTS') return { mainConnectionID: 7, amError: 'E_ALREADY_EXISTS' };   // the owner's connection
        if (am.connectErr[a.sourceID]) return { mainConnectionID: 0, amError: am.connectErr[a.sourceID] };
        const c = { mainConnectionID: am.next++, sourceID: a.sourceID, sinkID: a.sinkID, delay: 0, connectionState: 'CS_CONNECTING' };
        am.conns.push(c);
        if (!am.connectSlow[a.sourceID]) setTimeout(() => { c.connectionState = 'CS_CONNECTED'; }, 40);
        return { mainConnectionID: c.mainConnectionID, amError: 'E_OK' };
    }
    if (m.name === 'disconnect') { am.conns = am.conns.filter((c) => c.mainConnectionID !== a.mainConnectionID); return { amError: 'E_OK' }; }
    return {};
}
net.createServer((c) => {
    let b = ''; c.setEncoding('utf8'); c.on('error', () => {});
    c.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const m = JSON.parse(b.slice(0, i)); b = b.slice(i + 1); if (am.hang) { am.calls.push(Object.assign({ t: Date.now(), hung: true }, m)); continue; } c.write(JSON.stringify({ n: m.n, r: amAnswer(m) }) + '\n'); } });
}).listen(P('am.sock'), () => fs.chmodSync(P('am.sock'), 0o666));

/* ---- fake mic lease ---- */
const lease = { got: [], answer: { ev: 'lease', ok: true, rate: 16000, ch: 1, fmt: 's16le', until: 0 }, c: null, closed: 0 };
net.createServer((c) => {
    lease.c = c; let b = ''; c.setEncoding('utf8'); c.on('error', () => {});
    c.on('close', () => { c.gone = true; lease.closed++; });
    c.on('data', (d) => {
        b += d; let i;
        while ((i = b.indexOf('\n')) >= 0) {
            const m = JSON.parse(b.slice(0, i)); b = b.slice(i + 1); lease.got.push(m);
            if (m.cmd === 'lend') { c.write(JSON.stringify(lease.answer) + '\n'); if (!lease.answer.ok) c.end(); else c.write(Buffer.alloc(3200, 7)); }
        }
    });
}).listen(P('lease.sock'), () => fs.chmodSync(P('lease.sock'), 0o666));

/* ---- the helper ---- */
const conf = (o) => { fs.writeFileSync(P('audio.json'), JSON.stringify(Object.assign({
    sources: [{ port: 'Voip_Physical_Source_CF_24_MONO', id: 501 }, { port: 'Media_Overlay_Converter_Source', id: 502 }],
    player: ['/nonexistent/pcmio', 'play', 'plug:smartx:{port}', '{rate}'],
    fallback: [process.execPath, path.join(__dirname, 'fake_player.js'), R('played'), '{port}', '{rate}'] }, o))); fs.chmodSync(P('audio.json'), 0o644); };
let H = null, herr = '';
const ENV = { PATH: process.env.PATH, JAP_RIDEWATCH_AUDIO: S('audio.sock'), JAP_RIDEWATCH_AUDIO_CONF: P('audio.json'), JAP_RIDEWATCH_AUDIO_STATE: T('conn.json'),
    JAP_RIDEWATCH_SOMEIP: path.join(__dirname, 'fake_someip.js'), JAP_RIDEWATCH_AUDIO_IDLE_MS: '400', FAKE_AM: P('am.sock'), JAP_RIDEWATCH_PLAYER_AS: '4242:audio', JAP_RIDEWATCH_AUDIO_CLIENT: '4242' };
function helper(env) {
    try { fs.unlinkSync(R('played')); } catch (e) { /* none */ }
    herr = '';
    H = spawn(process.execPath, [HELPER].concat(env && env.ARGS || []), { env: Object.assign({}, ENV, env || {}), stdio: ['ignore', 'ignore', 'pipe'] });
    H.stderr.on('data', (d) => { herr += d; });
    const h = H;
    h.done = new Promise((r) => h.on('exit', (code, sig) => r(sig || code)));
    return until(() => /up on /.test(herr), 'helper up').then(() => h);
}
/** a stream: its first line, the JSON lines after it (play) or the bytes (mic), its close */
function open(cmd, extra) {
    return new Promise((res, rej) => {
        const s = net.connect(S('audio.sock'));
        const o = { s, first: null, lines: [], bytes: 0, closed: false };
        let b = Buffer.alloc(0);
        s.on('error', rej);
        s.on('close', () => { o.closed = true; if (!o.first) res(o); });
        s.on('connect', () => s.write(JSON.stringify(Object.assign({ cmd }, extra)) + '\n'));
        s.on('data', (d) => {
            if (o.first && cmd === 'mic') { o.bytes += d.length; return; }
            b = Buffer.concat([b, d]); let i;
            while ((i = b.indexOf(10)) >= 0) {
                const m = JSON.parse(b.slice(0, i).toString()); b = b.slice(i + 1);
                if (!o.first) { o.first = m; res(o); if (cmd === 'mic') { o.bytes += b.length; b = Buffer.alloc(0); return; } } else o.lines.push(m);
            }
        });
    });
}
const played = () => { try { return fs.readFileSync(R('played')); } catch (e) { return Buffer.alloc(0); } };
const pcm = (n) => Buffer.alloc(n, 1);

(async () => {
    /* play: available, connect, CS_CONNECTED, then the player (fallback: the first one is not there); close -> disconnect + unavailable */
    conf();
    let h = await helper();
    let o = await open('play', { rate: 24000 });
    assert.deepStrictEqual(o.first, { ev: 'play', ok: true, source: 'Voip_Physical_Source_CF_24_MONO' });
    o.s.write(pcm(4800));
    await until(() => played().length >= 4800 + 1, 'PCM played');
    assert.ok(played().toString().indexOf('Voip_Physical_Source_CF_24_MONO 24000\n') === 0, 'the port and rate given to the player');
    assert.ok(fs.existsSync(T('conn.json')), 'the connection recorded for --sweep');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(T('conn.json'))), { src: 501, id: 100, prior: { availability: 'A_UNAVAILABLE', availabilityReason: 0 } });
    assert.strictEqual(fs.readFileSync(R('played.id'), 'utf8'), '4242:' + AUDIO_GID + ':' + AUDIO_GID, 'the player: uid 4242, its one group audio');
    const ss = fs.lstatSync(S('audio.sock'));
    assert.ok(ss.isSocket() && ss.uid === 4242 && (ss.mode & 0o777) === 0o600, 'audio.sock: 4242\'s, 0600');
    o.s.end();
    await until(() => am.names().indexOf('unavail 501') >= 0, 'released');
    assert.deepStrictEqual(am.names(), ['avail 501', 'connect 501>1024', 'disconnect 100', 'unavail 501'], 'connect and disconnect paired');
    assert.strictEqual(am.conns.length, 0);
    assert.ok(!fs.existsSync(T('conn.json')), 'record gone');
    // odd chunks: whole samples only (an odd byte waits for the next chunk)
    am.reset();
    o = await open('play', {});
    o.s.write(pcm(3)); o.s.write(pcm(3));
    await until(() => played().length === 'Voip_Physical_Source_CF_24_MONO 24000\n'.length + 6, 'two odd chunks = 6 bytes');
    o.s.end();
    await until(() => am.names().length === 4, 'released (2)');
    console.log('ok play: available, connect 501>1024, player (fallback), close = disconnect + unavailable, whole samples');

    /* the first source refused: released, the next one */
    am.reset(); am.connectErr[501] = 'E_NOT_POSSIBLE';
    o = await open('play', {});
    assert.strictEqual(o.first.source, 'Media_Overlay_Converter_Source');
    o.s.end();
    await until(() => am.names().indexOf('unavail 502') >= 0, 'released 502');
    assert.deepStrictEqual(am.names(), ['avail 501', 'connect 501>1024', 'unavail 501', 'avail 502', 'connect 502>1024', 'disconnect ' + (am.next - 1), 'unavail 502']);
    delete am.connectErr[501];
    // never CS_CONNECTED in 3 s: disconnected, unavailable, the next one
    am.reset(); am.connectSlow[501] = true;
    o = await open('play', {});
    assert.strictEqual(o.first.source, 'Media_Overlay_Converter_Source');
    assert.deepStrictEqual(am.names().slice(0, 4), ['avail 501', 'connect 501>1024', 'disconnect ' + (am.next - 2), 'unavail 501'], 'a slow source released');
    o.s.end();
    await until(() => am.conns.length === 0 && am.names().indexOf('unavail 502') >= 0, 'released (slow)');
    delete am.connectSlow[501];
    console.log('ok sources: a refused or slow one released, the next one used');

    /* a call up: refused, AudioManager not touched but for the list */
    for (const c of [{ sourceID: 268, sinkID: 1024 }, { sourceID: 277, sinkID: 1024 }, { sourceID: 288, sinkID: 1024 }, { sourceID: 40, sinkID: 2048 }]) {
        am.reset(); am.conns = [Object.assign({ mainConnectionID: 7, delay: 0, connectionState: 'CS_CONNECTED' }, c)];
        o = await open('play', {});
        assert.deepStrictEqual(o.first, { ev: 'play', ok: false, why: c.sourceID === 268 || c.sourceID === 277 ? 'call' : 'busy' }, JSON.stringify(c));
        assert.deepStrictEqual(am.names(), [], 'nothing connected: ' + JSON.stringify(c));
    }
    // media to 1024 (ducked or not) and BMW speech's standby mic are not busy
    am.reset(); am.conns = [{ mainConnectionID: 8, sourceID: 1046, sinkID: 1024, delay: 0, connectionState: 'CS_SUSPENDED' }, { mainConnectionID: 9, sourceID: 129, sinkID: 387, delay: 0, connectionState: 'CS_CONNECTED' }];
    o = await open('play', {});
    assert.strictEqual(o.first.ok, true, 'media and the standby mic: not busy');
    // a call appearing: torn down within 300 ms (the sound at once, then disconnect + unavailable)
    o.s.write(pcm(4800));
    await until(() => played().length > 4800, 'playing before the call');
    const t0 = Date.now();
    am.conns.push({ mainConnectionID: 10, sourceID: 277, sinkID: 1024, delay: 0, connectionState: 'CS_CONNECTING' });
    await until(() => o.lines.length && am.names().indexOf('unavail 501') >= 0, 'torn down on the call');
    const dt = am.calls.find((c) => c.name === 'disconnect').t - t0;
    assert.ok(dt < 300, 'disconnect ' + dt + ' ms after the call appeared');
    assert.deepStrictEqual(o.lines[0], { ev: 'end', why: 'call' });
    await until(() => o.closed, 'closed after the call');
    am.conns = [];
    console.log('ok calls win: 268 / 277 refused as call, 288 and other sinks as busy, media and 129>387 fine, a call tears down in ' + dt + ' ms');

    /* no mic lease configured: refused, nothing opened */
    o = await open('mic');
    assert.deepStrictEqual(o.first, { ev: 'mic', ok: false, why: 'nomic' });
    await until(() => o.closed, 'mic refused closes');
    /* idle: gone 400 ms (here) after the last session, exit 0 */
    assert.strictEqual(await h.done, 0, 'idle exit');
    assert.ok(/exit \(idle\)/.test(herr));
    console.log('ok mic without a lease: nomic; idle exit');

    /* the config: denied ids and ports, no id, no player */
    conf({ sources: [{ port: 'CarLifeNavigation_CF_24_MONO', id: 288 }, { port: 'X', id: 289 }, { port: 'SpeechSink_CF_2MIC_6REF', id: 600 }, { port: 'Voip_Physical_Source_CF_24_MONO', id: null }] });
    h = await helper(); am.reset();
    o = await open('play', {});
    assert.deepStrictEqual(o.first, { ev: 'play', ok: false, why: 'nosource' });
    conf({ fallback: ['/nonexistent/aplay'] });
    h.kill('SIGTERM'); await h.done;
    h = await helper();
    o = await open('play', {});
    assert.deepStrictEqual(o.first, { ev: 'play', ok: false, why: 'noplayer' });
    assert.deepStrictEqual(am.names(), [], 'no source or no player: AudioManager untouched');
    o = await open('caps');
    assert.deepStrictEqual(o.first, { ev: 'caps', play: false, mic: false }, 'no player: no Listen offered');
    // no player identity (unset, root's, a group that is not there): no player as root, none offered; the mic still is
    conf();
    h.kill('SIGTERM'); await h.done;
    for (const bad of ['', '0:audio', '4242', '4242:nosuchgroup']) {
        h = await helper({ JAP_RIDEWATCH_PLAYER_AS: bad, JAP_RIDEWATCH_MIC_LEASE: P('lease.sock') }); am.reset();
        assert.deepStrictEqual((await open('play', {})).first, { ev: 'play', ok: false, why: 'root' }, 'PLAYER_AS=' + bad);
        assert.deepStrictEqual((await open('caps')).first, { ev: 'caps', play: false, mic: true });
        assert.deepStrictEqual(am.names(), [], 'AudioManager untouched');
        h.kill('SIGTERM'); await h.done;
    }
    // the socket is the access check: one systemd gave that is not the client's 0600, or one the helper cannot hand over
    let b = spawn(process.execPath, [HELPER], { env: Object.assign({}, ENV, { LISTEN_FDS: '1', JAP_RIDEWATCH_AUDIO: P('am.sock') }), stdio: ['ignore', 'ignore', 'pipe'] });
    let be = ''; b.stderr.on('data', (d) => { be += d; });
    assert.strictEqual(await new Promise((r) => b.on('exit', r)), 1, 'a socket not 4242\'s 0600: exits');
    assert.ok(/not serving/.test(be), be);
    fs.mkdirSync(P('o4243')); fs.chownSync(P('o4243'), 4243, 4243); fs.mkdirSync(P('s4243'), 0o700); fs.chownSync(P('s4243'), 4243, 4243);
    b = spawn(process.execPath, [HELPER], { uid: 4243, gid: 4243, env: Object.assign({}, ENV, { JAP_RIDEWATCH_AUDIO: P('o4243/a.sock'), JAP_RIDEWATCH_AUDIO_STATE: P('s4243/conn.json') }), stdio: ['ignore', 'ignore', 'pipe'] });
    be = ''; b.stderr.on('data', (d) => { be += d; });
    assert.strictEqual(await new Promise((r) => b.on('exit', r)), 1, 'chown to 4242 refused: exits');
    assert.ok(/not serving/.test(be), be);
    // a hand start in a folder others can write (a link there would be followed by root's chown), or a linked folder: exits
    fs.mkdirSync(P('open')); fs.chmodSync(P('open'), 0o777); fs.symlinkSync(P('sock'), P('sockln'));
    fs.writeFileSync(P('victim'), 'x'); fs.symlinkSync(P('victim'), P('open/a.sock'));
    for (const sp of [P('open/a.sock'), P('sockln/a.sock')]) {
        b = spawn(process.execPath, [HELPER], { env: Object.assign({}, ENV, { JAP_RIDEWATCH_AUDIO: sp }), stdio: ['ignore', 'ignore', 'pipe'] });
        be = ''; b.stderr.on('data', (d) => { be += d; });
        assert.strictEqual(await new Promise((r) => b.on('exit', r)), 1, sp);
        assert.ok(/its folder is not ours/.test(be), be);
    }
    assert.strictEqual(fs.statSync(P('victim')).uid, 0, 'the link\'s target not chowned');
    // the state folder: a link, open to others, or someone else's: exits (also --sweep)
    fs.symlinkSync(P('state'), P('stateln')); fs.mkdirSync(P('st755')); fs.chmodSync(P('st755'), 0o755); fs.mkdirSync(P('st4242'), 0o700); fs.chownSync(P('st4242'), 4242, 4242);
    for (const sd of ['stateln', 'st755', 'st4242']) for (const args of [[], ['--sweep']]) {
        b = spawn(process.execPath, [HELPER].concat(args), { env: Object.assign({}, ENV, { JAP_RIDEWATCH_AUDIO_STATE: P(sd + '/conn.json') }), stdio: ['ignore', 'ignore', 'pipe'] });
        be = ''; b.stderr.on('data', (d) => { be += d; });
        assert.strictEqual(await new Promise((r) => b.on('exit', r)), 1, sd + ' ' + args);
        assert.ok(/not our own 0700 folder/.test(be), be);
    }
    // a config others can write: ignored (the shipped one: no source ids yet)
    fs.chmodSync(P('audio.json'), 0o666);
    h = await helper();
    o = await open('play', {});
    assert.deepStrictEqual(o.first, { ev: 'play', ok: false, why: 'nosource' }, 'the shipped config');
    assert.deepStrictEqual((await open('caps')).first, { ev: 'caps', play: false, mic: false }, 'the shipped config offers nothing');
    assert.strictEqual(require('../ridewatch-audio.js').config().sources.length, 0, 'the shipped config has no source ids yet');
    assert.ok(/not a root-owned file closed to others/.test(herr));
    h.kill('SIGTERM'); await h.done;
    // the phone's other sources are refused too, as sources and in the call watch
    conf({ sources: [{ port: 'BT_Voice_Recognition_2', id: 278 }, { port: 'X', id: 256 }] });
    assert.strictEqual(require('../ridewatch-audio.js').config().sources.length, 0, '278 and 256 are not sources');
    const ra = require('../ridewatch-audio.js');
    for (const id of [256, 258, 267, 274, 278, 291]) assert.strictEqual(ra.busy([{ mainConnectionID: 5, sourceID: id, sinkID: 1024, connectionState: 'CS_CONNECTED' }]).why, 'call', 'phone source ' + id);
    // whole samples across chunks: a chunk dropped after an odd one never shifts the next
    const wo = { odd: null };
    assert.strictEqual(ra.whole(wo, Buffer.from([1, 2, 3])).length, 2); assert.strictEqual(ra.whole(wo, Buffer.from([4])).length, 2);
    assert.strictEqual(wo.odd, null);
    console.log('ok config: phone/288/289/CarLife/SpeechSink and no id skipped, no player, caps, no player as root, socket not 4242\'s 0600 = exit, a loose file ignored');

    /* caps (what the service may offer); a source made available by its owner is left so; one in use or already connected
       by its owner is not touched; a Listen ends at listenMaxS; a client that says nothing is dropped after 2 s */
    conf({ listenMaxS: 1 });
    h = await helper();
    assert.deepStrictEqual((await open('caps')).first, { ev: 'caps', play: true, mic: false });
    am.reset(); am.src[501] = { availability: 'A_AVAILABLE', availabilityReason: 3 };
    o = await open('play', {});
    assert.strictEqual(o.first.ok, true);
    await until(() => o.closed, 'listenMaxS', 3000);
    assert.deepStrictEqual(o.lines[0], { ev: 'end', why: 'limit' });
    await until(() => am.names().length === 2, 'released (limit)');
    assert.deepStrictEqual(am.names(), ['connect 501>1024', 'disconnect ' + (am.next - 1)], 'available at rest: availability not touched');
    assert.deepStrictEqual(am.src[501], { availability: 'A_AVAILABLE', availabilityReason: 3 });
    am.reset(); am.conns = [{ mainConnectionID: 40, sourceID: 501, sinkID: 1024, delay: 0, connectionState: 'CS_CONNECTED' }];   // 501 playing for its owner: in use
    o = await open('play', {});
    assert.strictEqual(o.first.source, 'Media_Overlay_Converter_Source', 'in use: the next source');
    o.s.end();
    await until(() => am.names().indexOf('unavail 502') >= 0, 'released (in use)');
    assert.ok(am.names().every((n) => !/ 501|501>/.test(n)), 'the busy source untouched: ' + am.names());
    assert.ok(am.conns.some((c) => c.mainConnectionID === 40), 'its connection kept');
    am.reset(); am.conns = []; am.connectErr[501] = 'E_ALREADY_EXISTS';
    o = await open('play', {});
    assert.strictEqual(o.first.source, 'Media_Overlay_Converter_Source', 'E_ALREADY_EXISTS: the next source');
    o.s.end();
    await until(() => am.names().indexOf('unavail 502') >= 0, 'released (exists)');
    assert.deepStrictEqual(am.names().slice(0, 3), ['avail 501', 'connect 501>1024', 'unavail 501'], 'E_ALREADY_EXISTS: never disconnected, availability put back');
    delete am.connectErr[501];
    const t2 = Date.now(), quiet4 = [0, 1, 2, 3].map(() => net.connect(S('audio.sock')));
    await Promise.all(quiet4.map((q) => new Promise((r) => q.on('connect', r))));
    await sleep(100);
    const t5 = Date.now(), fifth = net.connect(S('audio.sock'));
    fifth.on('error', () => {});
    await new Promise((r) => fifth.on('close', r));
    assert.ok(Date.now() - t5 < 1000, 'a 5th connection closed at once (' + (Date.now() - t5) + ' ms)');
    await Promise.all(quiet4.map((q) => new Promise((r) => q.on('close', r))));
    assert.ok(Date.now() - t2 >= 1900 && Date.now() - t2 < 3000, 'silent clients dropped after 2 s (' + (Date.now() - t2) + ' ms)');
    // the first line, strictly: a known command with its own keys only, a known rate
    am.reset();
    const answer = (line) => new Promise((r) => { const q = net.connect(S('audio.sock')); let n = 0; q.on('error', () => {}); q.on('data', (d) => { n += d.length; });
        q.on('connect', () => q.write(line + '\n')); q.on('close', () => r(n)); });
    for (const bad of [{ cmd: 'play', rate: 44100 }, { cmd: 'play', rate: '24000' }, { cmd: 'play', x: 1 }, { cmd: 'caps', rate: 16000 }, { cmd: 'stop', rate: 16000 },
        { cmd: 'mic', rate: 16000 }, { cmd: 'nope' }, ['caps'], 'caps']) assert.strictEqual(await answer(JSON.stringify(bad)), 0, 'closed unanswered: ' + JSON.stringify(bad));
    assert.ok(await answer(JSON.stringify({ cmd: 'caps' })) > 0, 'caps itself answered');
    assert.strictEqual(await answer('{"cmd":"caps"' + ' '.repeat(300) + '}'), 0, 'a first line over 256 bytes, newline in the same chunk');
    assert.deepStrictEqual(am.names(), [], 'none of them touched AudioManager');
    // AudioManager stops answering mid-Listen: ended within ~1 s (no call watch, no sound), logged once
    conf();
    h.kill('SIGTERM'); await h.done;
    h = await helper(); am.reset();
    o = await open('play', {});
    assert.strictEqual(o.first.ok, true);
    am.hang = true;
    const t3 = Date.now();
    await until(() => o.lines.length, 'ended on a silent AudioManager', 3000);
    assert.deepStrictEqual(o.lines[0], { ev: 'end', why: 'busy' });
    assert.ok(Date.now() - t3 < 1500, 'within 1.5 s (' + (Date.now() - t3) + ' ms)');
    assert.strictEqual((herr.match(/AudioManager silent/g) || []).length, 1, 'said once');
    am.hang = false;
    h.kill('SIGKILL'); await h.done;
    // the record cannot be written: no source claimed, AudioManager not changed
    h = await helper({ JAP_RIDEWATCH_AUDIO_STATE: R('nodir/conn.json') }); am.reset();
    o = await open('play', {});
    assert.notStrictEqual(o.first.ok, true, 'no Listen without a record');
    assert.ok(!am.names().some((n) => /^(avail|connect)/.test(n)), 'nothing changed: ' + am.names());
    assert.ok(/no record, next/.test(herr), 'said');
    h.kill('SIGTERM'); await h.done;
    console.log('ok caps, owner\'s availability kept, in-use and E_ALREADY_EXISTS sources untouched, listenMaxS, 2 s first line, silent AudioManager fails closed, no record = no claim');

    /* the mic lease: lend, PCM out; play PCM dropped while it is open, back 300 ms after; lease closed = returned */
    conf();
    h = await helper({ JAP_RIDEWATCH_MIC_LEASE: P('lease.sock') }); am.reset();
    const pl = await open('play', {});
    pl.s.write(pcm(4800));
    await until(() => played().length > 4800, 'listen plays');
    const m = await open('mic');
    assert.deepStrictEqual(m.first, { ev: 'mic', ok: true, rate: 16000, ch: 1, fmt: 's16le', max: 60 });
    assert.deepStrictEqual(lease.got[0], { cmd: 'lend', what: 'mic', who: 'ridewatch', ms: 30000 });
    await until(() => m.bytes >= 3200, 'the lent PCM comes through');
    const before = played().length;
    pl.s.write(pcm(4800));
    await sleep(150);
    assert.strictEqual(played().length, before, 'listen muted while talking');
    lease.c.end();                                                       // the lender takes it back (a wheel press)
    await until(() => m.closed, 'mic closed when the lease is');
    pl.s.write(pcm(480));
    await sleep(100);
    assert.strictEqual(played().length, before, 'still muted inside 300 ms');
    await sleep(300);
    pl.s.write(pcm(480));
    await until(() => played().length === before + 480, 'sound again after 300 ms');
    // the daemon ends the talk: the lease is closed
    const c0 = lease.closed;
    const m2 = await open('mic');
    assert.strictEqual(m2.first.ok, true);
    m2.s.end();
    await until(() => lease.closed === c0 + 1, 'the lease returned on untalk');
    // a refused lease: its why
    lease.answer = { ev: 'lease', ok: false, why: 'busy' };
    const m3 = await open('mic');
    assert.deepStrictEqual(m3.first, { ev: 'mic', ok: false, why: 'busy' });
    lease.answer = { ev: 'lease', ok: true, rate: 16000, ch: 1, fmt: 's16le', until: 0 };
    // a call during the talk: the lease closed too
    const m4 = await open('mic'), lc = lease.c;
    assert.strictEqual(m4.first.ok, true);
    am.conns.push({ mainConnectionID: 77, sourceID: 268, sinkID: 1024, delay: 0, connectionState: 'CS_CONNECTED' });
    await until(() => m4.closed && lc.gone && pl.closed, 'a call ends talk and listen');
    am.conns = [];
    await until(() => am.names().indexOf('unavail 501') >= 0, 'listen released');
    console.log('ok mic lease: lend, PCM out, listen muted while talking and 300 ms after, returned on either close, refused why, a call ends both');

    /* SIGTERM mid-session: released before the exit */
    am.reset();
    o = await open('play', {});
    h.kill('SIGTERM');
    assert.strictEqual(await h.done, 0);
    assert.deepStrictEqual(am.names().slice(-2), ['disconnect ' + (am.next - 1), 'unavail 501'], 'released on SIGTERM');
    /* SIGKILL mid-session: the connection stays; --sweep (ExecStopPost) disconnects it */
    h = await helper(); am.reset();
    o = await open('play', {});
    h.kill('SIGKILL'); await h.done;
    assert.strictEqual(am.conns.length, 1, 'a killed helper leaves its connection');
    const sweepRun = () => { const sw = spawn(process.execPath, [HELPER, '--sweep'], { env: ENV, stdio: 'ignore' }); return new Promise((r) => sw.on('exit', r)); };
    await sweepRun();
    assert.strictEqual(am.conns.length, 0, '--sweep disconnected it');
    assert.deepStrictEqual(am.names().slice(-2), ['disconnect ' + (am.next - 1), 'unavail 501']);
    assert.ok(!fs.existsSync(T('conn.json')));
    // no record: the sweep never touches AudioManager
    am.reset();
    const t4 = Date.now();
    await sweepRun();
    assert.deepStrictEqual(am.calls, [], 'no conn.json: AudioManager untouched');
    assert.ok(Date.now() - t4 < 2000, 'and it returns at once');
    // killed before connect answered (id null): that source's connection to 1024 goes, its availability back
    am.conns = [{ mainConnectionID: 61, sourceID: 501, sinkID: 1024, delay: 0, connectionState: 'CS_CONNECTED' }];
    fs.writeFileSync(T('conn.json'), JSON.stringify({ src: 501, id: null, prior: { availability: 'A_UNAVAILABLE', availabilityReason: 0 } }));
    await sweepRun();
    assert.deepStrictEqual(am.names(), ['disconnect 61', 'unavail 501']);
    // a record naming a source not in the config (or anything else): removed, nothing done
    am.reset(); am.conns = [{ mainConnectionID: 62, sourceID: 1046, sinkID: 1024, delay: 0, connectionState: 'CS_CONNECTED' }];
    fs.writeFileSync(T('conn.json'), JSON.stringify({ src: 1046, id: 62, prior: { availability: 'A_UNAVAILABLE', availabilityReason: 0 } }));
    await sweepRun();
    assert.deepStrictEqual(am.names(), [], 'a foreign source is never swept');
    assert.ok(!fs.existsSync(T('conn.json')) && am.conns.length === 1);
    am.conns = [];
    // every connect paired with a disconnect over the whole run is checked above step by step
    console.log('ok exit: SIGTERM releases, SIGKILL then --sweep releases; no record = no AudioManager; id-less record by source; foreign record ignored');
    console.log('audio_test: all checks passed (' + process.version + ')');
    process.exit(0);
})().catch((e) => { console.error(e); console.error('helper log:\n' + herr); process.exit(1); });
