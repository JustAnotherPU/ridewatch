'use strict';
// kit/runtime/parked.js: strict mode counts no speed, and a speed older than STALE_MS, as moving.
//   node kit/tools/test_parked.js
const assert = require('assert');
const path = require('path');
const { watch, STALE_MS } = require(path.join(__dirname, '..', 'runtime', 'parked.js'));

let cb = null, t = 0;
const ctx = { signals: { watch: (iface, inst, h) => { cb = h.statusCarSpeed2; return Promise.resolve({}); } } };
const strict = watch(ctx, null, { strict: true, now: () => t });
assert.strictEqual(strict.moving(), true, 'strict: no speed yet = moving');
cb({ speedVehicleCentreOfGravity: 0 });
assert.strictEqual(strict.moving(), false, 'parked');
t += STALE_MS + 1;
assert.strictEqual(strict.moving(), true, 'strict: stale reading = moving');
cb({ speedVehicleCentreOfGravity: 0 });
assert.strictEqual(strict.moving(), false, 'fresh again');
cb({ speedVehicleCentreOfGravity: 64 * 10 });
assert.strictEqual(strict.moving(), true, '10 km/h = moving');
const lax = watch(ctx, null, { now: () => t });
assert.strictEqual(lax.moving(), false, 'not strict: no speed = parked');
cb({ speedVehicleCentreOfGravity: 0 }); t += STALE_MS * 3;
assert.strictEqual(lax.moving(), false, 'not strict: quiet after standing = parked');
// readable(): strict needs a fresh speed, lax any speed once read
const r = watch(ctx, null, { strict: true, now: () => t });
assert.strictEqual(r.readable(), false, 'strict: no speed = unreadable');
cb({ speedVehicleCentreOfGravity: 64 * 10 });
assert.strictEqual(r.readable(), true, 'strict: fresh speed = readable (even when moving)');
t += STALE_MS + 1;
assert.strictEqual(r.readable(), false, 'strict: stale speed = unreadable');
const rl = watch(ctx, null, { now: () => t });
assert.strictEqual(rl.readable(), false, 'lax: no speed = unreadable');
cb({ speedVehicleCentreOfGravity: 0 }); t += STALE_MS * 3;
assert.strictEqual(rl.readable(), true, 'lax: an old speed still counts');
// a clock stepped back while the signal is quiet: the old 0 km/h is not fresh for the size of the step
const cs = watch(ctx, null, { strict: true, now: () => t });
cb({ speedVehicleCentreOfGravity: 0 });
t -= STALE_MS * 4;
assert.strictEqual(cs.moving(), true, 'strict: a clock stepped back = stale = moving');
// a NaN speed is not a speed: it never reads as standing
const nn = watch(ctx, null, { strict: true, now: () => t });
cb({ speedVehicleCentreOfGravity: NaN });
assert.strictEqual(nn.moving(), true, 'strict: NaN = no speed = moving');

// stop(): unsubscribes and ends the 2 s re-read, also when called before watch() has subscribed; no speed counts after it.
// signals.js against a fake someip binding (a copy in a temp app tree, so it finds an interface config there)
const fs = require('fs');
const os = require('os');
const Module = require('module');
const IFACE = 'de.bmw.infotainment.vehicle.Vehicle2';
const fake = { unsub: [], gets: 0, shutdowns: 0, inTick: [] };
// native calls must run in their own setImmediate tick (signals.js nativeTick), never inline in a promise chain
let inTick = false;
const setImm = global.setImmediate;
global.setImmediate = (fn, ...a) => setImm(() => { inTick = true; try { fn(...a); } finally { inTick = false; } });
const proxy = {
    init: () => Promise.resolve(),
    subscribeToAvailability: () => Promise.resolve(),
    subscribe: () => Promise.resolve(7),
    unsubscribe: (id) => { fake.unsub.push(id); return Promise.resolve(); },
    getValue: () => { fake.gets++; return Promise.resolve({ speedVehicleCentreOfGravity: 0 }); },
    isAvailable: () => true,
    shutdown: () => { fake.shutdowns++; fake.inTick.push(inTick); return Promise.resolve(); },
};
const load = Module._load;
Module._load = function (req) { return req === 'someip' ? { buildProxy: () => Promise.resolve(proxy) } : load.apply(this, arguments); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parked-'));
const made = ['someipInterfaces', 'a', 'a/b', 'a/b/c'].map((d) => path.join(tmp, d));   // Node 8: no recursive mkdir/rm
made.forEach((d) => fs.mkdirSync(d));
const files = [path.join(made[0], IFACE.replace(/\./g, '_') + '.json'), path.join(made[3], 'signals.js')];
fs.writeFileSync(files[0], JSON.stringify({ fields: { statusCarSpeed2: { getter: true, event: true } } }));
fs.writeFileSync(files[1], fs.readFileSync(path.join(__dirname, '..', 'runtime', 'signals.js')));
const signals = require(files[1]);
Module._load = load;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// a chain that hangs lets node exit quietly with 0: count that as a failure
let done = false;
process.on('exit', (c) => { if (!c && !done) { console.error('parked: did not finish (a stop() hung)'); process.exitCode = 1; } });

// a stub without stop(): stop() still resolves, and later speeds no longer count
const ns = watch(ctx, null, { now: () => t });
cb({ speedVehicleCentreOfGravity: 0 });
Promise.resolve()
    .then(() => ns.stop())
    .then(() => {
        cb({ speedVehicleCentreOfGravity: 64 * 50 });
        assert.strictEqual(ns.speed(), 0, 'stopped: a speed that still arrives does not count');
        assert.strictEqual(ns.moving(), false, 'lax, stopped: the last speed stays');
        return signals.watch(IFACE, '1', { statusCarSpeed2: () => {} }, null, { pollMs: 10 });
    })
    .then((s) => wait(45).then(() => {
        assert.ok(fake.gets >= 3, 'pollMs re-reads (' + fake.gets + ')');
        return s.stop();
    }))
    .then(() => {
        const gets = fake.gets;
        assert.deepStrictEqual(fake.unsub, [7], 'signals.stop: unsubscribed the field');
        assert.strictEqual(fake.shutdowns, 1, 'signals.stop: proxy shut down');
        assert.deepStrictEqual(fake.inTick, [true], 'signals.stop: shutdown in its own tick (nativeTick)');
        return wait(40).then(() => assert.strictEqual(fake.gets, gets, 'signals.stop: no re-read after it'));
    })
    .then(() => {
        // parked over the real signals.js, stopped before its watch() has subscribed
        fake.unsub = [];
        let tt = 0;
        const p = watch({ signals }, null, { strict: true, now: () => tt });
        return p.stop().then(() => {
            assert.deepStrictEqual(fake.unsub, [7], 'parked.stop before subscribed: unsubscribed once it was');
            assert.strictEqual(fake.shutdowns, 2, 'parked.stop: proxy shut down');
            tt += STALE_MS + 1;
            assert.strictEqual(p.moving(), true, 'strict, stopped: no fresh speed = moving');
        });
    })
    .then(() => {
        // a shutdown that never settles: stop() still ends (2 s) and the next native call is not held up
        proxy.shutdown = () => new Promise(() => {});
        return signals.watch(IFACE, '1', { statusCarSpeed2: () => {} }, null, { pollMs: 1000 })
            .then((s) => s.stop())
            .then(() => signals.watch(IFACE, '1', { statusCarSpeed2: () => {} }, null, { pollMs: 1000 }))
            .then((s) => { proxy.shutdown = () => Promise.resolve(); return s.stop(); });
    })
    .then(() => { files.forEach((f) => fs.unlinkSync(f)); [tmp].concat(made).reverse().forEach((d) => fs.rmdirSync(d)); done = true; console.log('parked: OK'); })   // a leaked timer keeps node from exiting
    .catch((e) => { console.error(e); process.exit(1); });
