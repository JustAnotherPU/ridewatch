'use strict';
/**
 * parked.js - "parked only" for games and anything else that mustn't run while driving.
 *
 *   const parked = require('./kit/parked').watch(ctx, log);
 *   parked.moving()   // true while the car drives (above MAX_KMH)
 *   parked.speed()    // km/h last read, or null (no speed: a VM / bench)
 *   parked.readable() // a speed is known (strict: and fresh): false says "speed unreadable", not "moving"
 *   parked.stop()     // unsubscribe and end the 2 s re-read (an app that only needs the speed while shown);
 *                     // after it no speed is read: strict counts as moving once STALE_MS passed, lax keeps the last speed
 *
 * Needs "de.bmw.infotainment.vehicle.Vehicle2": { "statusCarSpeed2": "rs" } in app.json "signals".
 * Every game has a setting "parkedOnly" (bool, on by default) and checks it with moving().
 *
 * Speed from Vehicle2.statusCarSpeed2, also re-read every 2 s: a car standing still may not
 * notify a speed that doesn't change. When the signal goes quiet, the last speed it read counts:
 * quiet after standing = parked (counting quiet as moving blocked a parked car in Doom 1.4.0),
 * quiet after driving = moving (the safe side) until a speed is read again. Without any real speed
 * (a VM or a bench: none, or "invalid" 65535) the car counts as parked, unless opts.strict:
 * then no speed counts as moving (video: a failed subscription must not show it while driving), and so does a
 * speed read more than STALE_MS ago (the signal and the 2 s re-read both gone quiet).
 */
const MAX_KMH = 3, STALE_MS = 5000;

function watch(ctx, log, opts) {
    const strict = !!(opts && opts.strict), now = (opts && opts.now) || Date.now;
    let speed = null, at = 0, stopped = false;
    const stale = () => Math.abs(now() - at) > STALE_MS;   // abs: a clock stepped back does not keep an old speed fresh
    const sub = ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
        statusCarSpeed2: (v) => {
            const k = v && v.speedVehicleCentreOfGravity;
            if (!stopped && typeof k === 'number' && isFinite(k) && k !== 65535) { speed = k * 0.015625; at = now(); }
        },
    }, log, { pollMs: 2000 });
    sub.then((s) => log && log.info('parked check: speed ' + (s.error ? 'error: ' + s.error : 'subscribed')));
    return {
        moving: () => (speed === null || (strict && stale()) ? strict : speed > MAX_KMH),
        speed: () => speed,
        readable: () => speed !== null && (!strict || !stale()),
        // also before watch() has subscribed: it then stops as soon as it has
        stop: () => { stopped = true; return sub.then((s) => s && s.stop && s.stop()).catch(() => {}); },
    };
}

module.exports = { watch, MAX_KMH, STALE_MS };
