'use strict';
process.env.JAP_RIDEWATCH_TEST_AS_ROOT = '1';   // these run as root in Docker; the daemon refuses root without it
// The control socket for the RideWatch app alone: socklock.sh is mgu-apps' (tools/socklock, tested there under
// BusyBox) byte for byte, the units wire it as designed, and ridewatchd.js serves the fd systemd passes without
// touching the socket file.   node daemon/test/socklock_test.js
const test = require('node:test');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// mgu-apps tools/socklock/socklock.sh; a new copy there gets a new pin here
const SOCKLOCK_SHA256 = 'b5f2178f7f4b5e87f805c3127ca9cebfef9ce985d8d080e0844257aad90e8763';
const ROOT = path.join(__dirname, '..', '..'), TOOL = path.join(ROOT, 'tools', 'jap-ridewatch');
const APP = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'jap_ridewatch', 'app.json'), 'utf8')).id;
const unit = (n) => fs.readFileSync(path.join(TOOL, 'systemd', n), 'utf8');
const BASE = 'jap-ridewatch', SOCK = '/run/' + BASE + '/ctl.sock';

test('socklock.sh is mgu-apps\' copy', () => {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(TOOL, 'socklock.sh'))).digest('hex');
    assert.strictEqual(h, SOCKLOCK_SHA256);
});

test('units: root\'s 0600 socket, the daemon on it with no runtime folder of its own, the lock for this app', () => {
    const s = unit(BASE + '.socket'), d = unit(BASE + '.service'), l = unit(BASE + '-lock.service');
    assert.match(s, new RegExp('^ListenStream=' + SOCK + '$', 'm'));
    assert.match(s, /^SocketMode=0600$/m);
    assert.doesNotMatch(s, /^Socket(User|Group)=/m);
    assert.ok(s.includes("\nExecStartPost=-/bin/sh -c 'f=/var/opt/jap-ridewatch/current/socklock.sh; [ -f $$f ] && SOCKLOCK_ONCE=1 exec /bin/sh $$f " + SOCK + ' ' + APP + "; true'\n"),
        'one pass as soon as it listens');
    assert.match(s, /^WantedBy=sockets\.target$/m);
    assert.doesNotMatch(d, /^RuntimeDirectory/m);
    assert.ok(d.includes('\nRequires=' + BASE + '.socket\n'));
    assert.match(d, new RegExp('^After=.* ' + BASE + '\\.socket$', 'm'));
    const lock = '/bin/sh /var/opt/jap-ridewatch/current/socklock.sh ' + SOCK + ' ' + APP;
    assert.ok(d.includes("ExecStartPre=-/bin/sh -c 'SOCKLOCK_ONCE=1 exec " + lock + "'"), 'one pass before each daemon start');
    assert.ok(l.includes('\nExecStart=' + lock + '\n'));
    assert.ok(l.includes('\nWants=' + BASE + '.socket\nAfter=' + BASE + '.socket\n'));
    assert.doesNotMatch(l, /^(BindsTo|Requires|PartOf)=/m, 'a socket stop or restart never leaves the lock stopped');
    assert.match(l, /^Restart=always$/m);
    const c = JSON.parse(fs.readFileSync(path.join(TOOL, 'component.json'), 'utf8'));
    assert.ok(c.files.some((f) => f.path === 'socklock.sh' && f.from === 'socklock.sh'));
    const names = c.units.map((u) => u.name);
    for (const u of [BASE + '.socket', BASE + '.service', BASE + '-lock.service']) assert.ok(names.includes(u), u + ' installed');
    for (const [u, t] of [[BASE + '.socket', 'sockets.target'], [BASE + '.service', 'multi-user.target'], [BASE + '-lock.service', 'multi-user.target']]) {
        assert.ok(c.enable.some((e) => e.unit === u && e.target === t), u + ' enabled for ' + t);
    }
    assert.ok(c.restart.includes(BASE + '-lock.service'));
});

test('LISTEN_FDS: the daemon serves fd 3 and leaves the socket file as systemd made it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socklock-'));
    const p = path.join(dir, 'ctl.sock'), own = path.join(dir, 'own.sock');
    const srv = net.createServer();
    await new Promise((r) => srv.listen(p, r));
    fs.chmodSync(p, 0o600);
    const before = fs.statSync(p);
    const d = spawn(process.execPath, [path.join(ROOT, 'daemon', 'ridewatchd.js')], { stdio: ['ignore', 'pipe', 'pipe', srv._handle.fd],
        env: Object.assign({}, process.env, { JAP_RIDEWATCH_CTL: own, JAP_RIDEWATCH_CONF: path.join(dir, 'server.json'), JAP_CAMDEC: '/nonexistent', JAP_RIDEWATCH_VIDEO: path.join(dir, 'video'), MGU_UPLINK: path.join(dir, 'status.json') }, { LISTEN_FDS: '1' }) });
    let log = '';
    d.stdout.on('data', (s) => { log += s; });
    d.stderr.on('data', (s) => { log += s; });
    // ours closed without unlinking the name (libuv unlinks the name it bound): the daemon's copy alone listens
    fs.renameSync(p, p + '.x');
    await new Promise((r) => srv.close(r));
    fs.renameSync(p + '.x', p);
    try {
        await new Promise((resolve, reject) => {
            const c = net.connect(p, () => c.write(JSON.stringify({ cmd: 'status' }) + '\n'));
            let buf = '';
            c.setEncoding('utf8');
            c.on('data', (s) => {
                buf += s;
                for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
                    if (JSON.parse(buf.slice(0, i)).ev === 'state') { c.destroy(); return resolve(); }
                }
            });
            c.on('error', reject);
            setTimeout(() => reject(new Error('no answer on fd 3\n' + log)), 5000).unref();
        });
        const after = fs.statSync(p);
        assert.strictEqual(after.ino, before.ino, 'the socket file is still systemd\'s');
        assert.strictEqual(after.mode & 0o777, 0o600, 'its mode untouched');
        assert.ok(!fs.existsSync(own), 'no socket of its own at its ctl path');
        assert.match(log, /ctl on fd 3/);
    } finally {
        d.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
