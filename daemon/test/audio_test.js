'use strict';
process.env.JAP_RIDEWATCH_TEST_AS_ROOT = '1';   // these run as root in Docker; the daemon refuses root without it
// SPDX-License-Identifier: GPL-3.0-or-later
// ridewatchd's Listen and Talk: a fake SOCKS5 + RideWatch server (serve.py's listen / talk lines) and a fake sound helper
// (the jap-ridewatch-audio protocol). Covers caps (hello's audio), listen piping server -> helper, talk piping helper ->
// server (the server first; EOF on untalk), refusals and their why, busy after a drop retried, moving / hidden / the last
// app gone ending both, and the refusal while stopped.
//   docker run --rm --network none -v "$PWD:/w" -w /w node:22-alpine node daemon/test/audio_test.js
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ridewatchd-audio-'));
const CTL = path.join(tmp, 'ctl.sock'), CONF = path.join(tmp, 'server.json'), AUD = path.join(tmp, 'audio.sock');
const TOKEN = 'tok-audio';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms) { const end = Date.now() + (ms || 5000); while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(10); } }

/* ---- fake server: list, hello (caps), events, listen, talk ---- */
const srv = { conns: [], caps: ['rtsp', 'listen', 'talk'], listenErr: [], talkErr: null, listenDelay: 50, chunk: 961 };
const server = net.createServer((s) => {
    let st = 0, buf = Buffer.alloc(0);
    const conn = { req: null, s, got: Buffer.alloc(0), ended: false, closed: false };
    srv.conns.push(conn);
    s.on('error', () => {});
    s.on('end', () => { conn.ended = true; });
    s.on('close', () => { conn.closed = true; });
    s.on('data', function on(d) {
        buf = Buffer.concat([buf, d]);
        if (st === 0 && buf.length >= 3) { buf = buf.slice(3); s.write(Buffer.from([5, 0])); st = 1; }
        if (st === 1 && buf.length >= 10) { buf = buf.slice(10); s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); st = 2; }
        const k = st === 2 ? buf.indexOf(10) : -1;
        if (k < 0) return;
        s.removeListener('data', on);
        const w = buf.slice(0, k).toString().split(' ');
        conn.req = w.slice(1).join(' ');
        const rest = buf.slice(k + 1);
        if (w[0] !== TOKEN) return s.end();
        if (w[1] === 'list') return s.end(JSON.stringify([{ i: 0, name: 'Door', roles: ['door'] }, { i: 1, name: 'Yard' }]) + '\n');
        if (w[1] === 'hello') return s.end(JSON.stringify({ ev: 'hello', proto: 2, server: '0.5.0', tz: 60, caps: srv.caps }) + '\n');
        if (w[1] === 'events') return s.write(JSON.stringify({ ev: 'events', list: [] }) + '\n');
        if (w[1] === 'listen') {
            const err = srv.listenErr.shift();
            if (err) return s.end(JSON.stringify({ ev: 'listen', error: err }) + '\n');
            // the line once sound flows, then PCM every 20 ms until the car closes (its write side stays open)
            return setTimeout(() => {
                if (s.destroyed) return;
                s.write(JSON.stringify({ ev: 'listen', rate: 24000, ch: 1, fmt: 's16le' }) + '\n');
                conn.timer = setInterval(() => { if (!s.destroyed) s.write(Buffer.alloc(srv.chunk, 3)); }, 20);
                s.on('close', () => clearInterval(conn.timer));
            }, srv.listenDelay);
        }
        if (w[1] === 'talk') {
            if (srv.talkErr) return s.end(JSON.stringify({ ev: 'talk', error: srv.talkErr }) + '\n');
            s.write(JSON.stringify({ ev: 'talk', ok: true, rate: 16000, ch: 1, fmt: 's16le', max: 60 }) + '\n');
            conn.got = rest;
            return s.on('data', (x) => { conn.got = Buffer.concat([conn.got, x]); });
        }
        s.end();
    });
});

/* ---- fake sound helper ---- */
const hlp = { conns: [], playErr: null, micErr: null, caps: { play: true, mic: true } };
const helper = net.createServer((c) => {
    const h = { cmd: null, got: Buffer.alloc(0), closed: false, c };
    hlp.conns.push(h);
    let b = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('close', () => { h.closed = true; clearInterval(h.timer); });
    c.on('data', function on(d) {
        b = Buffer.concat([b, d]);
        const k = b.indexOf(10);
        if (k < 0) return;
        c.removeListener('data', on);
        h.cmd = JSON.parse(b.slice(0, k).toString());
        h.got = b.slice(k + 1);
        if (h.cmd.cmd === 'caps') { c.write(JSON.stringify(Object.assign({ ev: 'caps' }, hlp.caps)) + '\n'); return c.end(); }
        if (h.cmd.cmd === 'play') {
            if (hlp.playErr) { c.write(JSON.stringify({ ev: 'play', ok: false, why: hlp.playErr }) + '\n'); return c.end(); }
            c.write(JSON.stringify({ ev: 'play', ok: true, source: 'Voip_Physical_Source_CF_24_MONO' }) + '\n');
            c.on('data', (x) => { h.got = Buffer.concat([h.got, x]); });
        } else if (h.cmd.cmd === 'mic') {
            if (hlp.micErr) { c.write(JSON.stringify({ ev: 'mic', ok: false, why: hlp.micErr }) + '\n'); return c.end(); }
            c.write(JSON.stringify({ ev: 'mic', ok: true, rate: 16000, ch: 1, fmt: 's16le', max: 60 }) + '\n');
            h.timer = setInterval(() => { if (!c.destroyed) c.write(Buffer.alloc(640, 5)); }, 20);
        }
    });
});

let daemon, out = '';
function app() {
    const a = { evs: [], s: net.createConnection(CTL) };
    let b = '';
    a.s.setEncoding('utf8');
    a.s.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { a.evs.push(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); } });
    a.send = (o) => a.s.write(JSON.stringify(o) + '\n');
    a.of = (ev) => a.evs.filter((e) => e.ev === ev);
    a.audio = () => a.of('audio').slice(-1)[0] || {};
    return a;
}
const reqs = (r) => srv.conns.filter((c) => c.req === r);
const lastReq = (r) => reqs(r).slice(-1)[0];
const hl = (cmd) => hlp.conns.filter((h) => h.cmd && h.cmd.cmd === cmd).slice(-1)[0];

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    fs.writeFileSync(CONF, JSON.stringify({ host: '192.0.2.10', port: 18640, token: TOKEN, socks: '127.0.0.1:' + server.address().port }), { mode: 0o600 });
    daemon = cp.spawn(process.execPath, [path.join(__dirname, '..', 'ridewatchd.js')], {
        env: Object.assign({}, process.env, { JAP_RIDEWATCH_CONF: CONF, JAP_RIDEWATCH_CTL: CTL, JAP_RIDEWATCH_AUDIO: AUD, JAP_CAMDEC: path.join(__dirname, 'fake_camdec.js'),
            JAP_RIDEWATCH_VIDEO: path.join(tmp, 'mgu-video-ridewatch'), MGU_UPLINK: path.join(tmp, 'status.json') }),
        stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout.on('data', (d) => { out += d; });
    daemon.stderr.on('data', (d) => { out += d; });
    await until(() => fs.existsSync(CTL), 'ctl.sock');
    let a = app();
    await new Promise((r) => a.s.on('connect', r));

    // no helper socket: hello's audio is empty and listen is refused
    await until(() => a.of('hello').length, 'hello');
    assert.deepStrictEqual(a.of('hello').slice(-1)[0].audio, [], 'no helper: no audio');
    a.send({ cmd: 'listen', cam: 0 });
    await until(() => a.of('error').length, 'listen refused');
    assert.deepStrictEqual(a.of('error')[0], { ev: 'error', cmd: 'listen', msg: 'no listen on this server or car' });
    await new Promise((r) => helper.listen(AUD, r));
    const lastHello = () => a.of('hello').slice(-1)[0].audio;
    // the helper's caps decide: no player or no source id = no Listen; no mic lease = no Talk
    hlp.caps = { play: false, mic: false };
    a.send({ cmd: 'hello', app: '0.5.4' });
    await until(() => hlp.conns.some((h) => h.cmd && h.cmd.cmd === 'caps'), 'caps asked');
    await sleep(200);
    assert.deepStrictEqual(lastHello(), [], 'a helper that can do nothing: no buttons');
    hlp.caps = { play: true, mic: false };
    a.send({ cmd: 'hello', app: '0.5.4' });
    await until(() => JSON.stringify(lastHello()) === '["listen"]', 'listen only (no lease)');
    a.send({ cmd: 'talk', cam: 0 });
    await until(() => a.of('error').length === 2, 'talk refused without the helper\'s mic');
    hlp.caps = { play: true, mic: true };
    a.send({ cmd: 'hello', app: '0.5.4' });
    await until(() => JSON.stringify(lastHello()) === '["listen","talk"]', 'server caps and the helper\'s');
    console.log('ok caps: hello\'s audio = the server\'s listen / talk and what the helper says it can do');

    // listen: the server's PCM to the helper's play; the car's write side stays open
    a.send({ cmd: 'view', view: 'spot', rect: '1920x720' });
    a.send({ cmd: 'listen', cam: 0 });
    await until(() => a.audio().listen === 'starting', 'starting');
    await until(() => a.audio().state === 'listening', 'listening');
    assert.deepStrictEqual(a.audio(), { ev: 'audio', state: 'listening', listen: 'on', talk: 'off', cam: 0, why: null, max: 60 });
    assert.deepStrictEqual(hl('play').cmd, { cmd: 'play', rate: 24000 });
    await until(() => hl('play').got.length >= 9600, 'PCM reached the helper');
    assert.strictEqual(lastReq('listen 0').ended, false, 'the car never ends its write side on a listen');
    await until(() => a.of('level').length, 'a level');
    assert.ok(a.of('level').every((l) => l.v >= 0 && l.v <= 1));
    hl('play').writes = [];
    hl('play').c.on('data', (x) => hl('play').writes.push(x.length));
    await until(() => hl('play').writes.length >= 5, 'more PCM');
    assert.strictEqual(hl('play').got.length % 2, 0, 'odd chunks from the server reach the helper as whole samples');
    console.log('ok listen: server line, PCM to the helper (' + hl('play').got.length + ' B, from 961 B chunks: whole samples), write side open, levels');

    // talk: the server's ok first, then the helper's mic PCM to the server; listen kept (the helper mutes it)
    a.send({ cmd: 'talk', cam: 0 });
    await until(() => a.audio().state === 'talking', 'talking');
    assert.strictEqual(a.audio().listen, 'on');
    const tk = lastReq('talk 0');
    await until(() => tk.got.length >= 6400, 'mic PCM reached the server');
    a.send({ cmd: 'untalk' });
    await until(() => tk.ended && hl('mic').closed, 'untalk: EOF to the server, the helper\'s mic closed');
    await until(() => a.audio().state === 'listening' && a.audio().talk === 'off', 'back to listening');
    assert.strictEqual(a.audio().why, null, 'untalk: no reason');
    console.log('ok talk: server first, mic PCM to the server (' + tk.got.length + ' B), untalk = EOF + mic returned');

    // the server closing a talk long before its 60 s: said as server, not max
    a.send({ cmd: 'talk', cam: 0 });
    await until(() => a.audio().state === 'talking', 'talking (server close)');
    lastReq('talk 0').s.destroy();
    await until(() => a.audio().talk === 'off' && a.audio().why === 'server', 'an early close is not max');
    // the mic returned by its lender (a wheel press): the talk ends, why returned
    a.send({ cmd: 'talk', cam: 0 });
    await until(() => a.audio().state === 'talking', 'talking (2)');
    hl('mic').c.destroy();
    await until(() => a.audio().talk === 'off' && a.audio().why === 'returned', 'returned');
    // refusals: the server's (talk before any mic), the helper's
    const nm = hlp.conns.filter((h) => h.cmd && h.cmd.cmd === 'mic').length;
    srv.talkErr = 'nospeaker';
    a.send({ cmd: 'talk', cam: 1 });
    await until(() => a.audio().why === 'nospeaker' && a.audio().talk === 'off', 'nospeaker');
    assert.strictEqual(hlp.conns.filter((h) => h.cmd && h.cmd.cmd === 'mic').length, nm, 'a refused talk never borrows the mic');
    srv.talkErr = null; hlp.micErr = 'nomic';
    a.send({ cmd: 'talk', cam: 0 });
    await until(() => a.audio().why === 'nomic', 'nomic');
    assert.ok(lastReq('talk 0').ended, 'the server\'s talk closed when the mic is refused');
    hlp.micErr = null;
    console.log('ok talk refusals: returned, nospeaker (no mic asked), nomic');

    // moving: both end, then refused until a view comes
    a.send({ cmd: 'talk', cam: 0 });
    await until(() => a.audio().state === 'talking', 'talking (3)');
    const lp = hl('play');
    a.send({ cmd: 'stop', why: 'moving' });
    await until(() => a.audio().listen === 'off' && a.audio().talk === 'off' && a.audio().why === 'moving', 'moving stops both');
    await until(() => lp.closed && hl('mic').closed && lastReq('listen 0').closed, 'helper and server connections closed');
    a.send({ cmd: 'listen', cam: 0 });
    await sleep(200);
    assert.strictEqual(a.audio().listen, 'off', 'no listen while stopped for moving');
    assert.strictEqual(a.audio().why, 'moving');
    a.send({ cmd: 'view', view: 'spot', rect: '1920x720' });
    a.send({ cmd: 'listen', cam: 0 });
    await until(() => a.audio().state === 'listening', 'listening after the stop');
    // hidden: the same
    a.send({ cmd: 'stop', why: 'hidden' });
    await until(() => a.audio().listen === 'off' && a.audio().why === 'hidden', 'hidden stops listen');
    console.log('ok moving / hidden end both and refuse until a view');

    // busy right after a drop: retried in 5 s; the helper's refusal; the server's close
    a.send({ cmd: 'view', view: 'spot', rect: '1920x720' });
    srv.listenErr = ['busy'];
    const n0 = reqs('listen 0').length;
    a.send({ cmd: 'listen', cam: 0 });
    await until(() => a.audio().state === 'listening', 'busy, then listening', 9000);
    assert.strictEqual(reqs('listen 0').length, n0 + 2, 'asked again after busy');
    lastReq('listen 0').s.destroy();
    await until(() => a.audio().listen === 'off' && a.audio().why === 'server', 'the server\'s close');
    await until(() => hl('play').closed, 'the helper released on the server\'s close');
    srv.listenErr = ['noaudio'];
    a.send({ cmd: 'listen', cam: 0 });
    await until(() => a.audio().why === 'noaudio', 'noaudio');
    hlp.playErr = 'call';
    a.send({ cmd: 'listen', cam: 0 });
    await until(() => a.audio().why === 'call' && a.audio().listen === 'off', 'the helper refuses: call');
    hlp.playErr = null;
    console.log('ok listen: busy retried, server close, noaudio, call');

    // the last app gone: everything ends
    a.send({ cmd: 'listen', cam: 0 });
    await until(() => a.audio().state === 'listening', 'listening (end)');
    const lp2 = hl('play');
    a.s.destroy();
    await until(() => lp2.closed && lastReq('listen 0').closed, 'last app gone: listen closed');
    console.log('ok last app gone ends the listen');

    // started as root with JAP_RIDEWATCH_RUNAS (the unit): runs as that uid with only the groups given; a bad one exits
    if (process.getuid() === 0) {
        const D2 = path.join(tmp, 'd2'); fs.mkdirSync(D2); fs.chmodSync(D2, 0o777); fs.chmodSync(tmp, 0o711);
        const run = (r) => cp.spawn(process.execPath, [path.join(__dirname, '..', 'ridewatchd.js')], { env: Object.assign({}, process.env, { JAP_RIDEWATCH_RUNAS: r,
            JAP_RIDEWATCH_CONF: path.join(D2, 'server.json'), JAP_RIDEWATCH_CTL: path.join(D2, 'ctl.sock'), JAP_RIDEWATCH_AUDIO: path.join(D2, 'audio.sock') }), stdio: 'ignore' });
        for (const bad of ['0:0', '4242', '4242:0']) { const d = run(bad); assert.strictEqual(await new Promise((r) => d.on('exit', r)), 1, 'RUNAS ' + bad); }
        const bare = cp.spawn(process.execPath, [path.join(__dirname, '..', 'ridewatchd.js')], { env: Object.assign({}, process.env, { JAP_RIDEWATCH_TEST_AS_ROOT: '',
            JAP_RIDEWATCH_CONF: path.join(D2, 'server.json'), JAP_RIDEWATCH_CTL: path.join(D2, 'ctl.sock'), JAP_RIDEWATCH_AUDIO: path.join(D2, 'audio.sock') }), stdio: 'ignore' });
        assert.strictEqual(await new Promise((r) => bare.on('exit', r)), 1, 'root without RUNAS nor the test opt-in');
        const d = run('4242:4242:27');
        await until(() => fs.existsSync(path.join(D2, 'ctl.sock')), 'the dropped daemon listens');
        const st = fs.readFileSync('/proc/' + d.pid + '/status', 'utf8');
        assert.ok(/\nUid:\t4242\t4242\t4242\t4242\n/.test(st) && /\nGid:\t4242\t4242\t4242\t4242\n/.test(st) && /\nGroups:\t(4242 27|27 4242) ?\n/.test(st), st);
        d.kill('SIGTERM'); await new Promise((r) => d.on('exit', r));
        console.log('ok the drop: uid 4242, groups 4242 + 27 only; root, a bad spec or no spec (no opt-in) exits');
    }

    daemon.kill('SIGTERM');
    await new Promise((r) => daemon.on('exit', r));
    console.log('audio_test (daemon): all checks passed (' + process.version + ')');
    process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.error(out); if (daemon) daemon.kill('SIGKILL'); process.exit(1); });
