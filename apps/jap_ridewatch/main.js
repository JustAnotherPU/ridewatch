'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/**
 * RideWatch (jap_ridewatch) - the UniFi Protect cameras on the whole screen, parked. The jap-ridewatch tool does the work
 * (ridewatchd.js, Node 22: the stream from the RideWatch server, camdec decoding it into /dev/shm/mgu-video-ridewatch, the
 * event feed and the choice of the hero camera); this app is its face over ctl.js. The server draws the pictures at
 * exactly the size asked here (rect(): the kit's placement), so the stream's pixels are the screen's: the overlay is
 * drawn in screen px (xf(1, 0, 0)), the targets in the kit's page px.
 *
 * Screens:
 *   VIEW  the spot view, drawn by the kit (first canvas screen, "fill": the whole screen): the server's spot picture
 *         (the hero big on the left, the other cameras in the pane on the right, all in the video) and over it, from
 *         the daemon's {"ev":"layout"} (the server's rects: nothing here assumes them) and {"ev":"hero"}: the hero's
 *         name and its last event bottom left, the clock and Day/Night top right, each pane tile's label, a golden
 *         ring round the hero for a ring or a person at the door, a banner for a live event (both fade).
 *         Two tabs top left, drawn here ("fill" has no kit header): "Live" and "What happened" (the timeline: a
 *         panel over the pane, every interesting event newest first, thumbnails, day headers, a gold scroll bar; a
 *         finger drags it with inertia, the controller goes row by row). The hero stays live on both.
 *         Tap / press a pane tile: that camera becomes the hero (the daemon's sticky pick). A timeline row: its clip.
 *         Tap / press the hero: CAM. Controller pushed left on the timeline: back to "Live".
 *         Hold a tile (0.45 s) or drag it: it lifts (a live ghost under the finger); dropped on a tile of the same
 *         shape the two trade places, on the hero it becomes the hero ({"cmd":"swap"}: the daemon keeps the order).
 *   CAM   one camera on the whole screen: the app's own mgu-render connection (mgu_render_client.js, Moonride's
 *         GAME pattern: layer mode, PLACE + CLAIM the whole screen, VIDEO id 1, op 19). Its own screen so that the
 *         HMI's BACK comes back to VIEW; a tap or a press does the same, a turn goes to the next / previous camera.
 *         The picture fills the screen (frame.js: the stream's frame scaled, the renderer clips it), a finger or
 *         the controller pushed up / down pans it; the chip bottom right (or the controller pushed right) shows it
 *         whole. The hero's CAM is the spot stream already playing (its hero is the same 1280x720 picture): no new
 *         stream, so it opens at once; another camera keeps the last picture, dimmed, until its own is in.
 *         An event's clip ({"cmd":"view","view":"clip","id"}: its recording from Protect, played once) on the
 *         same screen: "Person · Door · 14:32" and a gold progress bar from the clip's `dur`; at the end the last
 *         frame stays with "Replay" (the clip again) and "Live" (that camera live, CAM as above, and the pick).
 * States: connecting (only while there is no picture yet: a new view keeps the old one until its first real
 * picture), the daemon's error message, "parked only", the service not running. Parked only (setting parkedOnly, on
 * by default): above 3 km/h, or no speed at all, no stream. Switched off, it counts once "I agree" is pressed on the
 * risk page and from the next stop on (the drive lock: switched off while moving, the picture waits for a stop).
 * Taps start at the kit's touchX (right of the HMI's back column unless every renderer gives it to the app); the
 * controller's touchpad moves the kit's pointer and scrolls the timeline with two fingers. Hidden (life.js:
 * INACTIVE) -> {"cmd":"stop"} (the daemon then forgets the pick). The settings' server address, ports and location go to the daemon as
 * {"cmd":"config"} when it connects and on every change. Never exits on an error.
 * 0.4.0: autostart, kept running while hidden (ctx.background) with only ctl.sock open, so the service keeps the event
 *   feed. A doorbell ring then opens the RING pop-up "Doorbell · <camera>" over any app (30 s; "View" opens VIEW, whose
 *   hero the service makes the doorbell); person, vehicle, package and animal can do the same (settings, off by default,
 *   a cooldown per camera and type). Never while moving or with no speed reading, Parked only off or not: the speed
 *   is read for the pop-up only. A ring while the app is on screen: the Live tab, no pop-up.
 *   The camera with the "door" role as the hero: five quick replies (Open, two taps; I'm coming, Leave the parcel, Not
 *   available, One moment), each a call to the Home Assistant script named in <data>/ha.json with {"door": KEY}
 *   (ha.js, through the same SOCKS5 proxies). No ha.json or no script: no chips. Hidden while moving.
 * 0.4.3: the server refusing this car (the daemon's state with "pair"), parked: a QR of the server's setup page
 *   (https://<server>:18642/pair#h=<the code's SHA-256>) to scan with a phone, and the terminal way beside it
 *   (configure.py --add-car <code>). Gone once the stream plays (the car was added) or while moving.
 * 0.4.4: under the QR "Check: 7F3A 9C", the hash's fingerprint (the daemon's "fp"), which the page shows before it
 *   adds the car. An older daemon sends none: no check line.
 * 0.5.0: the doorbell's sound, on the spot view while the "door" camera is the hero (also after the pop-up's View) and
 *   the service's hello lists it ("audio": the server offers it and the car has the sound helper): a speaker button
 *   (Listen: the door's sound in the car, on / off) and a big round Talk button. A finger holds Talk to speak (let go
 *   = end); the controller's press starts it and the next press ends it. 60 s at most, a ring counts down; the sound's
 *   level glows round the button in use. The service stops both while moving or hidden; a steering-wheel press during
 *   a talk ends it (the mic's lender does that: the app shows the state). None on CAM.
 * 0.5.1: "audio" lists only what the sound helper says it can do (no buttons that always fail). Talk ends in sync()
 *   (every 250 ms, whatever is drawn) as soon as its button is not on the screen: CAM, a clip, the risk page, the
 *   picture gone, another hero; the 60 s cap there too.
 * 0.5.5: the doorbell hero at the left edge as the server now places it, its Listen, Talk and quick replies in the free
 *   column the server leaves beside it ("controls"), never on the picture; no ring drawn round the door picture; a gear
 *   for Settings after the tabs.
 */
const fs = require('fs');
const mgu = require('./kit/mgu');
const record = require('./kit/record');
const { Recorder, setImage } = record;
const Parked = require('./kit/parked');
const { Ctl } = require('./ctl');
const { RenderClient } = require('./mgu_render_client');
const F = require('./frame');
const qr = require('./qr');
const { Ha } = require('./ha');
const VERSION = require('./kit/app-spec.json').version;

const W = 1600, H = 520;                 // the kit's page ("fill": scaled over the whole screen)
const VID = 1, VPATH = process.env.JAP_RIDEWATCH_VIDEO || '/dev/shm/mgu-video-ridewatch';
const KEEPALIVE_MS = 500;                // the renderer hides an app silent for 3 s
const POOL0 = 8, POOL = 24;              // picture ids for the timeline's thumbs (the renderer holds 64 an app)
const LIT = { literal: true }, BOLD = { literal: true, font: 'bold' };
const GOLD = '#F0C068', DOT = '#E8B45A', SUB = '#ffffffd1', DIM = '#ffffff99';
const TYPE = { person: 'Person', vehicle: 'Vehicle', animal: 'Animal', package: 'Package', motion: 'Motion', ring: 'Ring' };
const TIMELINE = ['person', 'vehicle', 'animal', 'package', 'ring'];   // what the timeline lists (never plain motion)
const RECENT_MS = 600000;                // the gold dot: an event of the last 10 min
const TOP = 24, ROW = 114, HEAD = 52;    // the timeline: list top, row and day header heights (screen px)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Parked only switched off: the risk page (lines as drawn, 30 px)
const RISK = ['Watching the cameras while driving is only for passengers, in a car coded for video in motion.',
    'The driver must never watch. Follow the law where you drive. You switch this on at your own risk:',
    'the authors of RideWatch are not responsible for any misuse, accident, fine or damage.',
    'It takes effect once the car has stopped.'];
// where taps may start (screen px): the kit's touchX, else the HMI's back column (84) is kept clear
const touchX = (pl) => (pl && typeof pl.touchX === 'number' ? pl.touchX : 84);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// the pop-ups and the doorbell's buttons in English, or French with the "french" setting (read at draw time); the rest
// of the app stays English
let lang = () => 'en';
const isFr = () => lang() === 'fr';
const FR = {
    Person: 'Personne', Vehicle: 'Véhicule', Animal: 'Animal', Package: 'Colis', Doorbell: 'Sonnette', View: 'Voir',
    'Confirm?': 'Confirmer ?', Open: 'Ouvrir', 'Opening requested…': 'Ouverture demandée…',
    'I\'m coming': 'J\'arrive', 'Sent to the doorbell: "I\'m coming right away"': 'Envoyé à la sonnette : « J\'arrive tout de suite »',
    'Leave the parcel': 'Déposez le colis', 'Sent to the doorbell: "Leave the parcel"': 'Envoyé à la sonnette : « Déposez le colis »',
    'Not available': 'Pas disponibles', 'Sent to the doorbell: "Not available right now"': 'Envoyé à la sonnette : « Pas disponibles pour le moment »',
    'One moment': 'Un instant', 'Sent to the doorbell: "One moment, please"': 'Envoyé à la sonnette : « Un instant, s\'il vous plaît »',
    'The house refused': 'La maison a refusé', 'The house did not answer': 'La maison n\'a pas répondu',
    Listen: 'Écouter', Listening: 'À l\'écoute', 'Hold to talk': 'Maintenir pour parler',
    'Talking': 'Vous parlez', 'Connecting…': 'Connexion…',
    'A call is on: no doorbell sound': 'Appel en cours : pas de son de la sonnette', 'The car\'s audio is busy': 'L\'audio de la voiture est occupé',
    'This camera has no speaker': 'Cette caméra n\'a pas de haut-parleur', 'The server may not talk at the door': 'Le serveur ne peut pas parler à la porte',
    'No sound from this camera': 'Pas de son de cette caméra', 'The car\'s mic is not available': 'Le micro de la voiture n\'est pas disponible',
    'Talk ended after 60 s': 'Fin de la parole après 60 s', 'The doorbell is already in use, try again': 'La sonnette est déjà utilisée, réessayez',
    'Sound unavailable': 'Son indisponible',
    'Listen ended (time limit)': 'Écoute arrêtée (durée maximale)',
};
const tr = (s) => (isFr() && FR[s]) || s;
// the service's why (audio events) as said over the picture; none: nothing said (moving, hidden: the note says it)
const AUDIO_WHY = { call: 'A call is on: no doorbell sound', busy: 'The car\'s audio is busy', nospeaker: 'This camera has no speaker',
    nouser: 'The server may not talk at the door', forbidden: 'The server may not talk at the door', noaudio: 'No sound from this camera',
    nomic: 'The car\'s mic is not available', max: 'Talk ended after 60 s', limit: 'Listen ended (time limit)' };
const QUIET_WHY = ['moving', 'hidden', 'gone', 'returned'];
const TALK_S = 60;                       // the server's cap: the countdown ring
// the pop-up's first word per event type
const POP_TYPE = { ring: 'Doorbell', person: 'Person', vehicle: 'Vehicle', package: 'Package', animal: 'Animal' };
// the doorbell's quick replies: [key, chip, the {door} the Home Assistant script gets, what is said after]
const ARM_MS = 4000, ARMED = 'Confirm?';
const DOOR_ACTS = [
    ['open', 'Open', 'DOORBELL_OPEN', 'Opening requested…'],
    ['coming', 'I\'m coming', 'DOORBELL_COMING', 'Sent to the doorbell: "I\'m coming right away"'],
    ['parcel', 'Leave the parcel', 'DOORBELL_PARCEL', 'Sent to the doorbell: "Leave the parcel"'],
    ['busy', 'Not available', 'DOORBELL_BUSY', 'Sent to the doorbell: "Not available right now"'],
    ['wait', 'One moment', 'DOORBELL_WAIT', 'Sent to the doorbell: "One moment, please"'],
];
const LOCK_MS = 10000;                    // after an Open is sent, Open does nothing for 10 s (a toggle-type door)
/** what pressing a chip does now: 'arm' (Open's first tap), 'send', or null (one on its way; a reflex second tap
 *  under 0.5 s, before "Confirm?" could be read). armT and now on the monotonic clock; a negative age arms again */
function doorStep(key, armT, busy, now) {
    if (busy) return null;
    if (key !== 'open') return 'send';
    const age = armT ? now - armT : -1;
    if (age >= 0 && age < 500) return null;
    return age >= 0 && age < ARM_MS ? 'send' : 'arm';
}
// the monotonic clock in ms (Node 8: no hrtime.bigint): Open's arm and lock, which a clock step must not stretch
const mono = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; };
/** a ring from an events list (after a feed redial) that still pops up: newer than the newest ring seen and under
 *  60 s old by the car's clock (abs: a clock off by more fails closed) */
const gapRing = (e, lastTs, now) => e.type === 'ring' && lastTs !== null && e.ts > lastTs && Math.abs(now - e.ts) < 60000;

const pad = (n) => (n < 10 ? '0' : '') + n;
const hexA = (a) => ('0' + Math.max(0, Math.min(255, Math.round(a * 255))).toString(16)).slice(-2);
// the server's offset from UTC in minutes (the service's hello): the car's clock is UTC, the times shown are the home's.
// null (an older server or service): the unit's own time, as before
let tz = null;
/** t as a Date to read with the getUTC* getters: the wall clock at home (or the unit's own) */
const loc = (t) => new Date(t + (tz !== null ? tz : -new Date(t).getTimezoneOffset()) * 60000);
const hhmm = (t) => { const d = loc(t); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };
const dayOf = (t) => { const d = loc(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };   // a day's label, to compare
const yesterday = (now) => dayOf(now) - 864e5;
/** "just now", "4 min ago", "14:02" (today), "yesterday 21:14", "3 Nov 08:10" (loc()'s time) */
function rel(t, now) {
    const s = (now - t) / 1000, day = dayOf(t);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (day === dayOf(now)) return hhmm(t);
    if (day === yesterday(now)) return 'yesterday ' + hhmm(t);
    const d = loc(t);
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + hhmm(t);
}
function dayName(t, now) {
    const day = dayOf(t), d = loc(t);
    if (day === dayOf(now)) return 'Today';
    if (day === yesterday(now)) return 'Yesterday';
    return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS_LONG[d.getUTCMonth()];
}

process.on('uncaughtException', (e) => { try { mgu.log.error('uncaught', e); } catch (x) { /* nothing left to log with */ } });
process.on('unhandledRejection', (e) => { try { mgu.log.error('unhandled rejection: ' + ((e && e.stack) || e)); } catch (x) { /* idem */ } });

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const safe = (what, fn) => function () { try { return fn.apply(null, arguments); } catch (e) { log.error(what, e); } };
        lang = () => (settings.get('french') === true ? 'fr' : 'en');
        // autostart: kept running while hidden for the ring pop-up (ctl.sock stays open, so the service keeps the event
        // feed); hidden, nothing else runs: no speed, no timers, no renderer connection
        if (ctx.background) ctx.background('ring', true);
        // the speed, read only while someone needs it (on screen, a pop-up being decided or shown): a watch per need, stopped
        // when the last one goes. None = no speed = moving (strict)
        let watch = null;
        const needs = new Set(), NOSPEED = { moving: () => true, readable: () => false, speed: () => null };
        const parked = { moving: () => (watch || NOSPEED).moving(), readable: () => (watch || NOSPEED).readable() };
        function needSpeed(why, on) {
            if (on) needs.add(why); else needs.delete(why);
            if (needs.size && !watch) { watch = Parked.watch(ctx, log, { strict: true }); log.info('speed watch on (' + why + ')'); }
            else if (!needs.size && watch) { watch.stop(); watch = null; log.info('speed watch off'); }
        }
        // the drive lock (RideTube's): Parked only switched off counts once agreed to (the risk page) and only from a
        // stop, so switching it off while moving cannot bring the picture up; switching it on works at once. The answer
        // is kept (_drivingAgreed, saved with the settings): off without it (a car that had it off before 0.3.4, a page
        // left unanswered by a restart) asks at the start
        let driveOk = false, riskAgreed = settings.get('parkedOnly') === false && settings.get('_drivingAgreed') === true;
        let riskAsk = settings.get('parkedOnly') === false && !riskAgreed, riskSeen = false;
        const offOk = () => settings.get('parkedOnly') === false && riskAgreed;
        const moving = () => {
            const mv = parked.moving();
            driveOk = mv ? driveOk && offOk() : offOk();
            return mv && !driveOk;
        };

        /* ---------- the daemon ---------- */
        const st = { up: false, state: 'idle', view: null, shows: undefined, msg: null, cams: [], layout: null, pic: false, hero: null, events: [], pair: null };
        // the doorbell's sound: listen / talk: 'off' | 'starting' | 'on' as the service says (set here at once on a press); held: a finger holds Talk
        const au = { caps: [], listen: 'off', talk: 'off', why: null, lv: 0, t0: 0, held: false };
        const thumbs = {}, asked = new Set(), none = new Set();     // id -> { w, h, buf }; ids asked; ids with no picture
        let sent = null, dirty = true;           // sent: the last view asked ("spot 1920x720"), 'stop:moving' | 'stop:hidden' or null
        const stopped = () => sent === 'stop:moving' || sent === 'stop:hidden';
        let heroT = 0, banner = null;            // when the hero changed (its name fades in); the live event's banner
        const ctl = new Ctl(log);
        // the settings the service needs (ridewatchd.js configure()): sent first, so the list goes to the right server
        const num = (k) => (Number.isInteger(settings.get(k)) ? settings.get(k) : 0);
        const config = () => ctl.send({ cmd: 'config', host: [num('server1'), num('server2'), num('server3'), num('server4')], port: num('port') || 18640,
            socks: num('socks') || 1065, socksFallback: num('socksFallback'), lat: num('lat'), lon: num('lon') });
        ctl.on('up', safe('ctl up', () => {
            st.up = true; sent = null; asked.clear(); config(); ctl.send({ cmd: 'hello', app: VERSION }); ctl.send({ cmd: 'status' }); ctl.send({ cmd: 'list' }); dirty = true;
            // started hidden (autostart at boot): the service redials the feed slowly while hidden, once told so
            if (!onScreen()) { ctl.send({ cmd: 'stop', why: 'hidden' }); sent = 'stop:hidden'; }
        }));
        ctl.on('down', safe('ctl down', () => { au.listen = 'off'; au.talk = 'off'; au.held = false; st.up = false; st.state = 'idle'; st.pic = false; st.pair = null; sent = null; dirty = true; }));
        const isEv = (e) => e && typeof e.id === 'string' && Number.isInteger(e.cam) && !!TYPE[e.type] && typeof e.ts === 'number';
        ctl.on('msg', safe('ctl msg', (m) => {
            if (m.ev === 'state') {
                // (a refused car's message holds its code: not logged)
                if (m.state !== st.state) log.info('jap-ridewatch: ' + m.state + (m.pair ? ' (server refused this car)' : m.msg ? ' (' + m.msg + ')' : ''));
                st.state = m.state; st.view = m.view; st.msg = m.msg || null;
                // the daemon sends it while refused (connecting between retries too) and drops it once accepted
                st.pair = typeof m.pair === 'string' && m.pair.length <= 134
                    ? { url: m.pair, code: String(m.code || ''), fp: /^[0-9A-F]{4} [0-9A-F]{2}$/.test(m.fp) ? m.fp : '' } : null;
                if ('shows' in m) st.shows = m.shows;
                if (m.state === 'playing') { st.pic = true; if (!st.cams.length) ctl.send({ cmd: 'list' }); }
                if (m.state === 'idle') { st.pic = false; if (!stopped()) sent = null; }   // stopped under us: asked again
                if (clip) clip.ended = m.state === 'ended';
                camRec = null; setImmediate(safe('sync', sync));    // CAM's framing follows the stream at once, not at the next tick
            } else if (m.ev === 'hello') {
                tz = Number.isInteger(m.tz) && Math.abs(m.tz) <= 840 ? m.tz : null;
                au.caps = Array.isArray(m.audio) ? m.audio.filter((x) => x === 'listen' || x === 'talk') : [];   // an older service: none
            } else if (m.ev === 'audio') {
                const ph = (v) => (v === 'on' || v === 'starting' ? v : 'off'), was = au.talk;
                au.listen = ph(m.listen); au.talk = ph(m.talk);
                if (au.talk !== 'off' && was === 'off') au.t0 = mono();
                if (au.talk === 'off') au.held = false;
                const w = typeof m.why === 'string' ? m.why : null;
                if (w && w !== au.why && QUIET_WHY.indexOf(w) < 0) {
                    log.info('audio: ' + w);
                    say(AUDIO_WHY[w] ? tr(AUDIO_WHY[w]) : w === 'busy' && m.listen === 'off' ? tr('The doorbell is already in use, try again') : tr('Sound unavailable') + ' (' + w + ')');
                }
                au.why = w;
            } else if (m.ev === 'level') { au.lv = typeof m.v === 'number' ? Math.max(0, Math.min(1, m.v)) : 0; if (!onScreen()) return; }
            else if (m.ev === 'list') st.cams = (Array.isArray(m.cams) ? m.cams : []).filter((c) => c && Number.isInteger(c.i));
            else if (m.ev === 'clip') { if (clip && m.id === clip.e.id && m.dur > 0) { clip.info = m; clip.t0 = Date.now(); } camRec = null; }
            else if (m.ev === 'layout') { st.layout = Array.isArray(m.tiles) && m.w > 0 && m.h > 0 ? m : null; swapAsk = null; camRec = null; }
            else if (m.ev === 'hero') {
                if (!Number.isInteger(m.hero)) return;
                if (!st.hero || st.hero.hero !== m.hero || st.hero.why !== m.why) heroT = Date.now();
                st.hero = m;
            } else if (m.ev === 'events') {
                st.events = (Array.isArray(m.list) ? m.list : []).filter(isEv); prune();
                // known rows: only a later hit of one pops up; a ring that came while the feed was redialled still does
                const was = lastRing, now = Date.now();
                if (lastRing === null) lastRing = 0;                 // the first list since the start: nothing pops up
                st.events.forEach((e) => { if (gapRing(e, was, now)) popEv(Object.assign({}, e, { count: e.count || 1 })); else newHit(e.id, e.count || 1); seenRing(e); });
            } else if (m.ev === 'event') {
                if (!isEv(m)) return;
                const e = { id: m.id, cam: m.cam, label: m.label, type: m.type, ts: m.ts, first: m.first, count: m.count || 1, thumb: !!m.thumb };
                popEv(e); seenRing(e);
                const k = st.events.findIndex((x) => x.id === e.id);
                if (k >= 0) {
                    if (e.thumb && none.has(e.id)) none.delete(e.id);          // its picture came: asked again
                    st.events.splice(k, 1);
                } else if (TIMELINE.indexOf(e.type) >= 0) banner = { e, t0: Date.now() };
                st.events = st.events.concat(e).sort((a, b) => a.ts - b.ts).slice(-50);
                prune();
            } else if (m.ev === 'thumb') {
                asked.delete(m.id);
                if (m.none) { none.add(m.id); return; }
                const buf = typeof m.rgba === 'string' ? Buffer.from(m.rgba, 'base64') : null;
                if (!buf || m.w !== 160 || m.h !== 90 || buf.length !== 160 * 90 * 4 || !st.events.some((e) => e.id === m.id)) return;
                thumbs[m.id] = { w: m.w, h: m.h, buf };
            } else if (m.ev === 'error') log.warn('jap-ridewatch: ' + m.cmd + ': ' + m.msg);
            else if (m.ev === 'stats') return;
            dirty = true;
        }));
        // the thumbs of events no longer listed go
        function prune() { Object.keys(thumbs).forEach((id) => { if (!st.events.some((e) => e.id === id)) delete thumbs[id]; }); }
        // a row drawn asks for its picture (at most 4 on their way)
        function wantThumb(e) {
            if (!e.thumb || thumbs[e.id] || asked.has(e.id) || none.has(e.id) || asked.size >= 4) return;
            if (ctl.send({ cmd: 'thumb', id: e.id })) asked.add(e.id);
        }
        ctl.connect();
        const name = (i) => {
            const c = st.cams.find((x) => x.i === i), t = st.layout && st.layout.tiles.find((x) => x.i === i);
            return c && (c.label || c.name) ? c.label || c.name : t && t.label ? t.label : 'Camera ' + (i + 1);
        };
        const lastOf = (i) => { for (let k = st.events.length - 1; k >= 0; k--) if (st.events[k].cam === i && TIMELINE.indexOf(st.events[k].type) >= 0) return st.events[k]; return null; };

        /* ---------- the pop-up: a ring (and the detections the settings ask for) while RideWatch is hidden ---------- */
        const RT = +process.env.JAP_RIDEWATCH_POP_SCALE || 1;     // (test/app/smoke.js shrinks the timers; 1 on the car)
        const POP_RETRY_MS = 2000 * RT, POP_TRY_MS = 30000 * RT, POP_SHOW_MS = 30000 * RT, SPEED_WAIT_MS = 1500 * RT, OPEN_WAIT_MS = 4000 * RT;
        const ALERT = { ring: 'alertRing', person: 'alertPerson', vehicle: 'alertVehicle', package: 'alertPackage', animal: 'alertAnimal' };
        const hits = new Map();                  // event id -> the count last seen (the newest 100)
        let lastRing = null;                     // the newest ring's ts seen (server time); null before the first list
        const seenRing = (e) => { if (e.type === 'ring' && lastRing !== null && e.ts > lastRing) lastRing = e.ts; };
        const coolT = {};                        // 'cam:type' -> when its last detection asked a pop-up
        let pop = null;                          // the pop-up being decided or shown: { id, e, ring, t0, n: tries, timer, shown }
        let popOkSet = false;                    // RING_OK's text written at run time (the language)
        const why = (e) => (e && e.message) || String(e);
        const onScreen = () => ui.isVisible('VIEW') || ui.isVisible('CAM');
        /** true for a row not seen before, or a later hit of one: the server merges hits of the same camera and type
         *  within 120 s into one row, count + 1 (a second press of the doorbell); the same count again (its picture) is not */
        function newHit(id, n) {
            const was = hits.get(id);
            hits.delete(id); hits.set(id, Math.max(n, was || 0));
            if (hits.size > 100) hits.delete(hits.keys().next().value);
            return was === undefined || n > was;
        }
        function popEv(e) {
            if (!ALERT[e.type] || !newHit(e.id, e.count)) return;
            const ring = e.type === 'ring', id = e.id + '#' + e.count, c = e.cam + ':' + e.type;
            // (a live line is a hit now whatever the car's clock says: never dropped on its age)
            log.info(e.type + ' ' + id + ' received (age ' + Math.round((Date.now() - e.ts) / 1000) + ' s)');
            if (onScreen()) { if (ring) toLive(); return log.info(id + ': the app is on screen, no pop-up'); }
            if (settings.get(ALERT[e.type]) !== true) return log.info(id + ': pop-ups for ' + e.type + ' are off');
            const cool = (Number.isInteger(settings.get('alertCooldown')) ? settings.get('alertCooldown') : 5) * 60000 * RT;
            if (!ring && Date.now() - coolT[c] < cool) return log.info(id + ': ' + e.type + ' pop-up for this camera in the last ' + cool / 60000 + ' min, none');
            if (pop && (!ring || pop.ring)) return log.info(id + ': a pop-up is already up (' + pop.id + '), not stacked');
            if (pop) closePop('a ring takes its place');
            if (!ring) coolT[c] = Date.now();
            const p = pop = { id, e, ring, t0: Date.now(), n: 0, timer: null, shown: false };
            // the speed, read for this pop-up only: no reading within 1.5 s = none
            needSpeed('pop', true);
            if (parked.readable()) tryPop(p);
            else p.timer = setTimeout(safe('pop speed', () => tryPop(p)), SPEED_WAIT_MS);
        }
        // ui.open swallows a refusal: ask the HMI directly; the HMI refuses every app's pop-up while a Check Control
        // message fills the screen (INVALID_COMPONENTID)
        const openPop = () => (!ui.rhmi ? Promise.resolve('no rhmi') : Promise.race([
            new Promise((res) => res(ui.rhmi.openState('RING'))).then(() => null),
            new Promise((r) => setTimeout(() => r('no answer in 4 s'), OPEN_WAIT_MS))]).catch(why));
        function tryPop(p) {
            if (pop !== p) return;
            // no pop-up while moving or with no speed, also with Parked only off (fail closed)
            if (onScreen() || parked.moving()) return closePop(onScreen() ? 'the app is on screen' : parked.readable() ? 'moving' : 'no speed reading');
            p.n++;
            openPop().then(safe('pop-up', (err) => {
                if (pop !== p) { if (!err) ui.close('RING'); return; }   // closed meanwhile
                if (!err) {
                    p.shown = true;
                    // the speed stays watched while it shows: moving closes it (D11, fail closed)
                    p.mv = setInterval(safe('pop moving', () => { if (pop === p && parked.moving()) closePop('moving'); }), 1000 * RT);
                    log.info('pop-up ' + p.id + ' open ok (try ' + p.n + ')');
                    // the camera's name from the list, else the event row's own (a hidden boot whose list failed)
                    const c = st.cams.find((x) => x.i === p.e.cam), label = (c && (c.label || c.name)) || p.e.label || name(p.e.cam);
                    ui.text('RING_TEXT', tr(POP_TYPE[p.e.type]) + ' · ' + label);   // (after the open: text sent before is refused)
                    if (isFr() || popOkSet) { popOkSet = true; ui.text('RING_OK', tr('View')); }   // app.json's button is "View"
                    p.timer = setTimeout(safe('pop close', () => closePop('30 s')), POP_SHOW_MS);
                    return;
                }
                if (err === 'no answer in 4 s') ui.close('RING');
                if (Date.now() - p.t0 + POP_RETRY_MS > POP_TRY_MS) return closePop('refused (' + err + '), try ' + p.n + ': given up after 30 s');
                log.info('pop-up ' + p.id + ' refused (' + err + '), try ' + p.n + ': again in 2 s');
                p.timer = setTimeout(safe('pop retry', () => tryPop(p)), POP_RETRY_MS);
            }));
        }
        function closePop(how) {
            const p = pop;
            if (!p) return;
            pop = null; clearTimeout(p.timer); clearInterval(p.mv);
            needSpeed('pop', false);
            if (p.shown) { ui.text('RING_TEXT', ''); ui.close('RING'); }
            log.info('pop-up ' + p.id + (p.shown ? ' closed (' : ': none (') + how + ')');
        }
        // closed by the HMI (BACK): forgotten, so the next one shows (a pop-up is not one of the kit's tracked screens);
        // deferred: the hide can come around the press itself
        const popState = ui.comp && ui.comp('RING');
        if (popState && popState.on) popState.on('visible', safe('pop visible', (ev) => {
            if (!ev || ev.visible !== false) return;
            const p = pop;
            setTimeout(safe('pop hidden', () => { if (p && p.shown && pop === p) closePop('closed by the HMI'); }), 300);
        }));
        // "View": VIEW as BACK does it (openState); refused or not in front -> ctx.front() (the tile tap's), then openState
        // once more. Each step checked 1.5 s on (playClip's pattern). The service's hero is already the doorbell on a ring
        ui.onClick('RING_OK', safe('pop tap', () => {
            log.info('pop-up: tap View');
            closePop('tap');
            toLive();
            const steps = ['openState VIEW'].concat(ctx.front ? ['front()'] : [], ['openState VIEW']);
            const next = (k) => {
                const how = steps[k];
                const p = how === 'front()' ? Promise.resolve().then(() => ctx.front())
                    : ui.rhmi ? new Promise((res) => res(ui.rhmi.openState('VIEW'))) : Promise.resolve(ui.open('VIEW'));
                p.then(() => log.info('view: ' + how + ' answered ok'), (e) => log.warn('view: ' + how + ' refused (' + why(e) + ')'))
                    .then(() => setTimeout(safe('pop view', () => {
                        if (onScreen()) return log.info('view opened (' + how + ')');
                        if (k + 1 < steps.length) { log.warn('view: not on screen after ' + how + ', next: ' + steps[k + 1]); return next(k + 1); }
                        log.warn('view: not opened, given up');
                    }), 1500));
            };
            next(0);
        }));

        /* ---------- what is shown, what is asked ---------- */
        let cam = null;                          // the camera CAM shows
        let clip = null, clipCam = null, clipSel = 0;   // CAM's clip ({ e, n: replays, info, t0, ended }); its camera; the knob's button
        let tab = 'live';                        // VIEW's tab: 'live' | 'past'
        const shown = (n) => ui.isVisible(n) && (!ui.hasFocus || ui.hasFocus(n));
        // the size the server encodes at: the kit's placement (the whole screen), as the YouTube app's rect()
        function rect() {
            const pl = (ctx.display && ctx.display.place && ctx.display.place.full ? ctx.display.place : null) || gpu.placement || { w: 1920, h: 720 };
            const even = (v) => Math.min(2048, Math.max(16, Math.round(v / 2) * 2));
            return even(pl.w) + 'x' + even(pl.h);
        }
        const frameSize = () => { const m = rect().split('x'); return { w: +m[0], h: +m[1] }; };   // every view's frame
        const camOf = (i) => st.cams.find((c) => c.i === i) || {};
        const camW = (i) => camOf(i).w, camH = (i) => camOf(i).h;
        // CAM's camera is the picked hero: back on VIEW it is the one shown big, and no event takes it away meanwhile
        function open(i) { camTo(i); ui.open('CAM'); sync(); }
        function back() { if (ui.isVisible('CAM')) ui.open('VIEW'); }
        function pick(i, id) { ctl.send({ cmd: 'pick', cam: i }); sel = id || null; dirty = true; }
        function turn(d) {
            const ids = st.cams.length ? st.cams.map((c) => c.i) : (st.layout ? st.layout.tiles.map((t) => t.i) : []);
            if (!ids.length) return;
            const k = ids.indexOf(cam);
            camTo(ids[((k < 0 ? 0 : k + d) % ids.length + ids.length) % ids.length]);
            sync();
        }
        function camTo(i) { cam = i; camPan = { x: 0, y: 0 }; wake(); ctl.send({ cmd: 'pick', cam: i }); }
        // a timeline row: its clip on CAM (no pick: "Direct" does that)
        // on the car openState('CAM') once failed (INVALID_COMPONENTID) and the clip stayed half-open: check, retry once
        function playClip(e, how) {
            clip = { e, n: 0, info: null, t0: 0, ended: false }; clipCam = cam = e.cam; clipSel = 0; sel = e.id; camPan = { x: 0, y: 0 }; flash = null; wake();
            log.info('clip ' + e.id + ' (' + (how || 'target') + ')');
            const c = clip, opened = () => ui.isVisible('CAM') || clip !== c;
            const check = (again) => setTimeout(safe('clip open', () => {
                if (opened()) return;
                if (again) { log.warn('clip ' + e.id + ': CAM did not open, again'); Promise.resolve(ui.open('CAM')).then(() => check(false)); return; }
                log.warn('clip ' + e.id + ': CAM did not open'); clip = null; flash = { s: 'The clip did not open, tap it again', t: Date.now() }; dirty = true; sync();
            }), 1500);
            Promise.resolve(ui.open('CAM')).then(() => check(true));
            sync();
        }
        function replay() { clip.n++; clip.info = null; clip.ended = false; wake(); sync(); }
        function direct() { const i = clip.e.cam; clip = null; camTo(i); sync(); }
        function setTab(t) { if (t !== tab) { tab = t; vel = 0; scrollTo = null; dirty = true; } }
        // a ring on screen, or the pop-up's View: the spot's Live tab, whose hero the service makes the doorbell
        function toLive() { setTab('live'); dnd = null; drag = null; dirty = true; if (ui.isVisible('CAM')) ui.open('VIEW'); }

        /* ---------- VIEW: concept A, drawn by the kit ---------- */
        const kgpu = () => (ctx.display && ctx.display.gpu && ctx.display.gpu.native ? ctx.display.gpu : null);
        let kIno = null, last = null, lastT = 0, focus = null, sel = null;
        let flash = null;                        // a short message over VIEW ({ s, t }), 5 s
        const say = (s) => { flash = { s, t: Date.now() }; dirty = true; };
        /* ---------- the doorbell's quick replies: a Home Assistant script ---------- */
        // <data>/ha.json { "host": IPv4, "port": 8123, "token", "script": "script.<name>" }, owned by the app's uid, 0600:
        // read when VIEW shows, until it is found and valid. None, or no script: no chips
        let ha = null, haScript = null, haNote = '', doorArm = 0, doorBusy = null, doorRects = [], doorLock = 0, chipHero = null, chipTop = 0;
        function haLoad() {
            if (ha) return;
            let c = null, bad = null;
            const f = require('path').join(ctx.dataDir, 'ha.json');
            let fd = null;
            try {
                // the token is full access for its Home Assistant user, and the apps share one group: this app's own
                // file, 0600, no link (O_NOFOLLOW), checked on the open file itself
                fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);   // a FIFO: no hang
                const st = fs.fstatSync(fd), mode = st.mode & 0o777;
                if (!st.isFile()) bad = 'not a plain file';
                else if (st.uid !== process.getuid()) bad = 'owner uid ' + st.uid + ', must be this app (chown ' + process.getuid() + ')';
                else if (mode & 0o177) bad = 'mode ' + mode.toString(8) + ', must be 0600 (chmod 600)';
                else c = JSON.parse(fs.readFileSync(fd, 'utf8'));
            } catch (e) { bad = (e.code || 'unreadable') + ' (this app is uid ' + process.getuid() + ')'; }
            if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* closed */ }
            const m = !bad && c && typeof c.script === 'string' ? /^script\.([a-z0-9_]+)$/.exec(c.script) : null;
            if (!bad && !m) bad = 'no script ("script": "script.<name>")';
            if (!bad) {
                try { ha = new Ha({ host: c.host, port: c.port, token: c.token }); haScript = m[1]; log.info('ha.json loaded'); return; } catch (e) { bad = e.message; }
            }
            if (haNote !== bad) log.warn('ha.json: ' + bad + ': no doorbell buttons');
            haNote = bad;
        }
        // the app's proxies, as the service uses them (the Tailscale SOCKS proxy on 127.0.0.2:1055)
        const proxies = () => [num('socks') || 1065, num('socksFallback')].filter((p) => p > 0).map((p) => [p === 1055 ? '127.0.0.2' : '127.0.0.1', p]);
        const doorCam = (i) => (camOf(i).roles || []).indexOf('door') >= 0;
        const chipsOn = (i) => !!ha && i !== null && doorCam(i) && !parked.moving();
        // never retried: a lost answer may still have opened the door
        function doorAct(a) {
            if (!ha || parked.moving() || (a[0] === 'open' && mono() < doorLock)) return;
            const step = doorStep(a[0], doorArm, doorBusy, mono());
            if (step === 'arm') { doorArm = mono(); dirty = true; return; }
            if (!step) return;
            doorArm = 0; doorBusy = a[0]; dirty = true;
            if (a[0] === 'open') doorLock = mono() + LOCK_MS;
            log.info('door: ' + a[2]);
            ha.socks = proxies();
            ha.call('script', haScript, { door: a[2] })
                .then(() => say(tr(a[3])), (e) => {
                    const m = (e && e.message) || '?';
                    log.warn('door ' + a[2] + ': ' + m);
                    // an HTTP refusal did nothing; a timeout may have (Open: nothing is sent again)
                    say(tr(/^HTTP /.test(m) ? 'The house refused' : 'The house did not answer') + ' (' + m + ')');
                })
                .then(() => { doorBusy = null; dirty = true; });
        }
        /* ---------- the doorbell's sound: Listen and Talk (the service and its sound helper) ---------- */
        let auRects = [], auStopT = 0;
        const audioOn = (i) => au.caps.length > 0 && st.up && i !== null && doorCam(i) && !moving();
        function listenTap(i) {
            if (!audioOn(i)) return;
            const on = au.listen === 'off';
            ctl.send(on ? { cmd: 'listen', cam: i } : { cmd: 'unlisten' });
            au.listen = on ? 'starting' : 'off'; dirty = true;
        }
        function talkSet(i, on) {
            if (on && !audioOn(i)) return;
            if (on === (au.talk !== 'off')) return;
            ctl.send(on ? { cmd: 'talk', cam: i } : { cmd: 'untalk' });
            au.talk = on ? 'starting' : 'off'; au.t0 = mono(); if (!on) au.held = false; dirty = true;
            log.info(on ? 'talk' : 'untalk');
        }
        // the kit's hold: a finger going down holds Talk until it lets go; the controller's press toggles it (its release does nothing)
        const talkHold = (i) => (down) => {
            if (down) { au.held = finger; return talkSet(i, finger ? true : au.talk === 'off'); }
            if (au.held) talkSet(i, false);
        };
        let scrollY = 0, scrollTo = null, vel = 0, drag = null, rows = [], listH = 0, frameT = Date.now();
        // the pane: the server's, else right of the hero
        const pane = () => {
            const L = st.layout;
            if (L && L.pane) return L.pane;
            const x = L && L.heroRect ? L.heroRect.x + L.heroRect.w : L && L.tiles.length ? Math.min.apply(null, L.tiles.map((t) => t.x)) : 1280;
            return { x, y: 0, w: (L ? L.w : 1920) - x, h: L ? L.h : 720 };
        };
        // shortcut: the timeline and its touch use the layout's px as screen px (true while rect() asks the server for
        // exactly the placement's size); scale by pl.w / L.w like drawSpot if that ever differs
        const viewH = () => pane().h - TOP;
        const maxScroll = () => Math.max(0, listH - viewH() + 12);
        const clampScroll = () => { scrollY = Math.max(0, Math.min(maxScroll(), scrollY)); };
        if (ctx.onPageFocus) ctx.onPageFocus(safe('focus', (k, how) => {
            focus = k; dirty = true;
            // (the touchpad's pointer: the list stays where it is under it)
            const r = how !== 'pointer' && k && k.indexOf('ev:') === 0 && rows.find((x) => x.key === k);
            if (r) {   // the controller's row into view
                if (r.y - (r.head ? HEAD : 0) < scrollY + 10) scrollTo = Math.max(0, r.y - (r.head ? HEAD : 0) - 10);
                else if (r.y + ROW > scrollY + viewH() - 20) scrollTo = Math.min(maxScroll(), r.y + ROW - viewH() + 20);
            }
        }));
        if (ctx.onLayout) ctx.onLayout(() => { dirty = true; });
        if (ctx.onBack) ctx.onBack(safe('back', () => { if (riskAsk) { riskEnd(false); return true; } if (tab !== 'past') return false; setTab('live'); return true; }));
        /* "En direct": a tile (or the hero) held or dragged lifts; dropped on another it trades places (dnd). Until it
           lifts the gesture stays the kit's, so a plain tap still picks (a tile) or opens CAM (the hero). */
        const LIFT_MS = 450, LIFT_PX = 20;
        let dnd = null, swapAsk = null;          // the lifted tile; the swap asked (its tiles glow until the new layout)
        const heroBox = () => { const L = st.layout, hr = L && L.heroRect; return hr ? { x: hr.x, y: hr.y + 120, w: hr.w, h: hr.h - 120, i: L.hero, hero: true } : null; };
        // what is under the finger: a pane tile ({i, x, y, w, h, shape}) or the hero (hero: true)
        function under(x, y) {
            const L = st.layout, inR = (r) => r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
            const t = L && L.tiles.find(inR);
            if (t) return t;
            const h = heroBox();
            return inR(h) && Number.isInteger(h.i) ? h : null;
        }
        // tiles trade places within a shape (the server fills each shape's slots in order); anything onto the hero
        const canDrop = (a, b) => !!(a && b && a.i !== b.i && (a.hero || b.hero || a.shape === b.shape));
        function lift() { if (dnd && !dnd.lifted) { dnd.lifted = true; dirty = true; } }
        function dropDnd(x, y) {
            const to = under(x, y);
            if (canDrop(dnd.src, to)) {
                ctl.send({ cmd: 'swap', a: dnd.src.i, b: to.i });
                swapAsk = { a: dnd.src.i, b: to.i, t0: Date.now() };
                log.info('swap ' + dnd.src.i + ' -> ' + to.i);
            }
        }
        function dndTouch(ph, x, y) {
            if (ph === 1) {
                const onChip = doorRects.concat(auRects).some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);   // a held chip (or Talk) never lifts the hero
                const src = tab === 'live' && overlay() && !onChip ? under(x, y) : null;
                dnd = src ? { src, x0: x, y0: y, x, y, lifted: false, t: setTimeout(safe('lift', lift), LIFT_MS) } : null;
                return false;                                    // (the kit still sees a tap coming)
            }
            if (!dnd) return false;
            dnd.x = x; dnd.y = y;
            if (!dnd.lifted && Math.abs(x - dnd.x0) + Math.abs(y - dnd.y0) > LIFT_PX) lift();
            if (ph === 3) {
                clearTimeout(dnd.t);
                const was = dnd;
                if (was.lifted) dropDnd(x, y);
                dnd = null; dirty = true;
                return was.lifted;                               // not lifted: the kit's tap
            }
            if (dnd.lifted) dirty = true;
            return dnd.lifted;
        }
        // a finger on the timeline's panel is ours (a drag with inertia, a tap selects its row); on "En direct" dndTouch;
        // anywhere else the kit's
        let finger = false;                      // a finger on the screen (its drags are ours or the kit's, never onScroll's)
        if (ctx.onTouch) ctx.onTouch(safe('touch', (ph, x, y) => {
            const p = pane();
            finger = ph !== 3;
            if (riskAsk) return false;                                   // the risk page: the kit's targets
            if (ph === 1) {
                drag = pastOn() && x >= p.x ? { y0: y, y, t: Date.now(), moved: false, v: 0 } : null;
                if (tab === 'past' && !drag && x >= p.x) log.info('timeline touch ignored: ' + JSON.stringify({ layout: !!st.layout, layer: kIno !== null, pic: st.pic, moving: moving(), shows: showing() }));
                if (drag) { vel = 0; scrollTo = null; dnd = null; return true; }
                return dndTouch(ph, x, y);
            }
            if (!drag) return dndTouch(ph, x, y);
            if (ph === 2) {
                const now = Date.now(), dy = y - drag.y;
                if (Math.abs(y - drag.y0) > 14) drag.moved = true;
                if (drag.moved) { scrollY -= dy; clampScroll(); drag.v = 0.6 * drag.v + 0.4 * (-dy / Math.max(1, now - drag.t)); dirty = true; }
                drag.y = y; drag.t = now;
            } else if (ph === 3) {
                if (drag.moved) vel = Date.now() - drag.t < 100 ? drag.v : 0;      // (a finger held still: no flick)
                else {
                    const r = rows.find((q) => y >= p.y + TOP + q.y - scrollY && y < p.y + TOP + q.y - scrollY + ROW);
                    if (r) playClip(r.e, 'touch'); else log.info('timeline tap on no row at y ' + Math.round(y));
                }
                drag = null; dirty = true;
            }
            return true;
        }));
        settings.onChange((key) => {
            if (key === '_drivingAgreed') return;
            dirty = true; camRec = null; config();
            if (key !== 'parkedOnly') return;
            if (settings.get('parkedOnly') !== false) {
                riskAgreed = false; riskAsk = false; riskSeen = false;
                if (settings.get('_drivingAgreed')) settings.set('_drivingAgreed', false);
            } else if (!riskAgreed) riskAsk = true;
        });
        // the risk page's answer: I agree makes Parked only off count (from the next stop); Cancel, BACK or leaving puts it on
        function riskEnd(ok) {
            riskAsk = false; riskSeen = false; dirty = true;
            if (ok) { riskAgreed = true; settings.set('_drivingAgreed', true); log.info('cameras while driving: agreed'); } else if (settings.get('parkedOnly') === false) settings.set('parkedOnly', true);
            sync();
        }
        // two fingers on the controller's touchpad: the timeline (cv.scroll { tiles: true }); dy page px, scrollY screen px
        if (ctx.onScroll) ctx.onScroll(safe('scroll', (dy) => {
            if (finger || !pastOn() || riskAsk) return false;
            const was = scrollY;
            scrollY += dy * (last && last.place ? last.place.scale : 1); vel = 0; scrollTo = null;
            clampScroll();
            if (scrollY !== was) dirty = true;
            return scrollY !== was;
        }));
        // the view in the decoder now (an older daemon does not say: the one asked)
        const showing = () => (st.shows !== undefined ? st.shows : st.view);
        const overlay = () => !!(st.layout && kIno !== null && st.pic && !moving() && showing() === 'spot');
        // the timeline stays drawn and touchable while the spot's picture is away (a stall, back from a clip): taps
        // on a timeline left on screen did nothing
        const pastOn = () => tab === 'past' && !!st.layout && !moving();
        // the state line over the picture (null: nothing to say)
        function note() {
            if (flash && Date.now() - flash.t < 5000) return flash.s;
            if (!st.up) return 'The RideWatch service is not answering';
            if (moving()) return offOk() ? 'Cameras while driving start once parked' : 'Available only while parked';
            if (st.state === 'error') return st.msg || 'Error';
            if ((st.state === 'connecting' || st.state === 'idle') && !overlay()) return 'Connecting…';
            return null;
        }
        function drawNote(cv, s, x, y, size) {
            const w = cv.textWidth(s, size, LIT) + size * 2;
            cv.roundRect(x - w / 2, y - size * 1.4, w, size * 2.2, size * 1.1, '#000000b0');
            if (s === 'Connecting…') cv.arc(x - w / 2 + size, y - size * 0.3, size * 0.35, size * 0.5, (Date.now() / 3) % 360, (Date.now() / 3) % 360 + 270, '#ffffff');
            cv.text(s, x + (s === 'Connecting…' ? size * 0.4 : 0), y, size, '#ffffff', Object.assign({ align: 'center' }, LIT));
        }
        // text with concept A's shadow (CSS: 0 1px 3px rgba(0,0,0,.8))
        function sh(cv, s, x, y, size, c, o) {
            cv.text(s, x, y + 2, size, '#000000a0', o);
            return cv.text(s, x, y, size, c, o);
        }
        const dot = (cv, x, y, r, c) => { cv.circle(x, y, r * 2.2, (c || DOT) + '30'); cv.circle(x, y, r, c || DOT); };

        // thumbs: a pool of picture ids by event, least recently drawn reused (the YouTube app's)
        const pool = new Map(), free = Array.from({ length: POOL }, (_, i) => POOL0 + i);
        let frameNo = 0;
        function slot(id, th) {
            let e = pool.get(id);
            if (!e) {
                let pid = free.pop();
                if (pid === undefined) {
                    let old = null;
                    pool.forEach((x, k) => { if (x.t < frameNo && (!old || x.t < pool.get(old).t)) old = k; });
                    if (!old) return null;                 // all drawn in this frame already
                    pid = pool.get(old).pid; pool.delete(old);
                }
                pool.set(id, e = { pid, th: null, t: 0 });
            }
            if (e.th !== th) { e.th = th; setImage(e.pid, th.w, th.h, th.buf); }
            e.t = frameNo;
            return e.pid;
        }

        /** concept A over the spot picture; true while something moves (a fade, the halo, the list gliding) */
        function drawSpot(cv, now) {
            const pl = cv.place, s = pl.scale, L = st.layout, kx = pl.w / L.w, ky = pl.h / L.h;
            const T = (x, y, w, h, run, key, r, turn, hold) => cv.target((x - pl.ox) / s, (y - pl.oy) / s, w / s, h / s, run, key, r, turn, hold);
            const hr = L.heroRect ? { x: L.heroRect.x * kx, y: L.heroRect.y * ky, w: L.heroRect.w * kx, h: L.heroRect.h * ky } : { x: 0, y: 0, w: pane().x * kx, h: pl.h };
            // taps start at touchX (the kit: 0 where every renderer gives the app the back column, else 84, the HMI's,
            // whose tap closes the app): the hero's target, the tabs and the texts start right of it
            const lx = Math.max(hr.x, touchX(pl));
            // the hero: the daemon's choice at once (the picture follows when the new spot's first frame is in)
            const H0 = st.hero, hero = H0 ? H0.hero : Number.isInteger(L.hero) ? L.hero : null;
            const door = H0 && (H0.why === 'ring' || H0.why === 'person') && H0.event ? H0.event : null;
            // 0.5.5: the server's free column beside the doorbell (its Listen, Talk and quick replies go there, never on
            // the picture); an older server has none: they go over the hero as before
            const col = L.controls ? { x: L.controls.x * kx, y: L.controls.y * ky, w: L.controls.w * kx, h: L.controls.h * ky } : null;
            let anim = false;
            // the light: a golden wash from the top (0.5.5: no ring drawn round the door picture any more)
            cv.gradientRect(hr.x, hr.y, hr.w, hr.h / 2, [[0, '#F0C06824'], [1, '#F0C06800']]);
            cv.gradientRect(hr.x, hr.y, hr.w, 150, [[0, '#000000a0'], [1, '#00000000']]);
            cv.gradientRect(hr.x, hr.y + hr.h - 200, hr.w, 200, [[0, '#00000000'], [1, '#000000c7']]);
            // the tabs (top left)
            let tx = lx + 36;
            const tabs = [];
            [['live', 'Live'], ['past', 'What happened']].forEach((q) => {
                const on = tab === q[0], w = cv.textWidth(q[1], 26, BOLD);
                sh(cv, q[1], tx, 62, 26, on ? '#ffffff' : '#ffffffa8', BOLD);
                if (on) cv.roundRect(tx, 74, w, 3, 1.5, GOLD);
                tabs.push([tx - 14, 24, w + 28, 64, () => setTab(q[0]), 'tab:' + q[0], 10]);
                tx += w + 44;
            });
            // Settings: a gear after the tabs
            {
                const gx = tx + 6, gy = 56, gk = 1.2, gc = focus === 'tab:settings' ? GOLD : '#ffffffa8';
                cv.arc(gx, gy, 9 * gk, 12 * gk, 0, 360, gc); cv.circle(gx, gy, 4 * gk, gc);
                for (let n = 0; n < 8; n++) { const q = n * Math.PI / 4; cv.line(gx + Math.cos(q) * 11 * gk, gy + Math.sin(q) * 11 * gk, gx + Math.cos(q) * 16 * gk, gy + Math.sin(q) * 16 * gk, 4 * gk, gc); }
                tabs.push([gx - 40, 24, 80, 64, openSettings, 'tab:settings', 10]);
                tx = gx + 20 + 44;
            }
            const tabTargets = () => tabs.forEach((a) => T.apply(null, a));   // last in the knob's order
            // the clock and the context (top right of the hero; beside the doorbell: of its free column)
            const right = (col || hr).x + (col || hr).w - 40;
            // a narrow hero (the portrait doorbell): the tabs reach the clock, which then goes under them
            const cy = tx - 20 > right - cv.textWidth(hhmm(now), 40, BOLD) ? 140 : 66;
            // the portrait doorbell with Listen and Talk over it (no column): their place (no room for the clock under the tabs)
            const small = !col && cy === 140 && audioOn(hero);
            if (!small) sh(cv, hhmm(now), right, cy, 40, '#ffffff', Object.assign({ align: 'right' }, BOLD));
            const where = H0 && H0.home === true ? ' · car at home' : H0 && H0.home === false ? ' · car away' : '';
            if (H0 && !small) sh(cv, (H0.night ? 'Night' : 'Day') + where, right, cy + 38, 24, SUB, Object.assign({ align: 'right' }, LIT));
            // the doorbell's chips while it is the hero (rung or not), before the hero's target (the first hit wins)
            doorRects = [];
            if (!chipsOn(hero) || hero !== chipHero) doorArm = 0;
            chipHero = hero;
            // in the column: Listen and Talk at its top (under the tabs' height), the chips under them; no audio: the
            // chips centred in it (-1)
            const ctop = col ? (audioOn(hero) ? col.y + 300 : -1) : null;
            chipTop = col ? ctop - 8 : hr.y + hr.h - 190 + 10;
            if (chipsOn(hero)) anim = drawChips(cv, col || hr, col ? col.x : lx, now, T, ctop) || anim;
            // Listen and Talk above the chips (the door camera as the hero, the service and server able to)
            auRects = [];
            if (audioOn(hero)) anim = drawAudio(cv, col || hr, hero, chipTop - 18, T, small, !!col) || anim;
            else if (au.listen !== 'off' && now - auStopT > 1000) {   // the door is no longer the hero: its sound stops (Talk: sync())
                auStopT = now;
                ctl.send({ cmd: 'unlisten' }); au.listen = 'off';
            }
            // the hero: a target (press = that camera alone), its name and what happened there (fading in on a change)
            if (hero !== null) {
                T(lx, hr.y + 120, hr.x + hr.w - lx, hr.h - 120, () => open(hero), 'hero', 0);
                const a = Math.min(1, (now - heroT) / 400);
                if (a < 1) { anim = true; cv.alpha(a); }
                if (door) {
                    dot(cv, lx + 50, hr.y + hr.h - 146, 8);
                    sh(cv, TYPE[door.type] + ' · ' + name(hero), lx + 72, hr.y + hr.h - 130, 48, '#ffffff', BOLD);
                    sh(cv, rel(door.ts, now) + (door.type === 'person' ? ' · doorbell not pressed' : ''), lx + 40, hr.y + hr.h - 64, 28, SUB, LIT);
                } else {
                    sh(cv, name(hero), lx + 40, hr.y + hr.h - 116, 46, '#ffffff', BOLD);
                    const e = H0 && H0.event && H0.event.cam === hero ? H0.event : lastOf(hero);
                    if (e) {
                        const recent = now - e.ts < RECENT_MS;
                        if (recent) dot(cv, lx + 47, hr.y + hr.h - 65, 6);
                        sh(cv, TYPE[e.type] + ' · ' + (now - e.ts < 3600000 ? hhmm(e.ts) + ' · ' : '') + rel(e.ts, now), lx + (recent ? 64 : 40), hr.y + hr.h - 56, 28, SUB, LIT);
                    } else sh(cv, 'Live', lx + 40, hr.y + hr.h - 56, 28, SUB, LIT);
                }
                if (a < 1) cv.alpha(1);
            }
            // a live event: a golden banner over the hero for 6 s (in over 0.3 s, out over the last second)
            if (banner) {
                const age = now - banner.t0;
                if (age > 6000) banner = null;
                else {
                    anim = true;
                    const a = Math.min(1, age / 300, (6000 - age) / 1000), s1 = TYPE[banner.e.type] + ' · ' + name(banner.e.cam), w = cv.textWidth(s1, 26, BOLD) + 76;
                    const bx = hr.x + hr.w / 2 - w / 2;
                    cv.alpha(a);
                    cv.roundRect(bx, 120, w, 52, 26, '#1a1408d8');
                    cv.strokeRoundRect(bx, 120, w, 52, 26, 2, GOLD + 'c0');
                    dot(cv, bx + 30, 146, 7);
                    cv.text(s1, bx + 50, 155, 26, '#ffffff', BOLD);
                    cv.alpha(1);
                }
            }
            if (tab === 'past') { const g = drawTimeline(cv, now, T); tabTargets(); return g || anim; }
            // the pane: a target and a label per tile, as the server placed them; the gold dot for a recent event
            L.tiles.forEach((t) => {
                const x = t.x * kx, y = t.y * ky, w = t.w * kx, h = t.h * ky, label = t.label || name(t.i), round = t.shape === 'round';
                T(x, y, w, h, () => pick(t.i), 'cam:' + t.i, round ? w / 2 : 6);
                if (focus === 'cam:' + t.i) cv.strokeRoundRect(x - 3, y - 3, w + 6, h + 6, round ? w / 2 + 3 : 9, 6, GOLD + '50');   // the glow round the kit's ring
                if (round) { sh(cv, label, x + w / 2, y + h - 30, 20, '#ffffff', Object.assign({ align: 'center' }, BOLD)); return; }
                const size = t.shape === 'tall' ? 20 : 24, e = t.shape === 'tall' ? null : lastOf(t.i), gh = Math.min(h, size * 3.4);
                cv.gradientRect(x, y + h - gh, w, gh, [[0, '#00000000'], [1, '#000000c7']]);
                sh(cv, label, x + 14, y + h - size * (e ? 1.75 : 0.65), size, '#ffffff', BOLD);
                if (e) {
                    const recent = now - e.ts < RECENT_MS;
                    if (recent) dot(cv, x + 19, y + h - size * 0.62 - 6, 4.5);
                    sh(cv, TYPE[e.type] + ' ' + (dayOf(e.ts) === dayOf(now) ? hhmm(e.ts) : rel(e.ts, now)), x + (recent ? 32 : 14), y + h - size * 0.35, size * 0.85, SUB, LIT);
                }
            });
            tabTargets();
            return drawDnd(cv, now, kx, ky) || anim;
        }

        /** the doorbell's chips: right-aligned rows over the hero's name and event line, wrapped to the hero's width right
         *  of lx (the portrait doorbell: ~540 px); top: their block's top (the server's controls column; -1: centred in
         *  hr), else over the name; true while Open is armed (its bar) */
        function drawChips(cv, hr, lx, now, T, top) {
            let anim = false;
            const age = mono() - doorArm, armed = !!doorArm && age >= 0 && age < ARM_MS, hh = 64, gap = 10, right = hr.x + hr.w - 32, room = right - lx - 32;
            const lab = (a) => tr(a[0] === 'open' && armed ? ARMED : a[1]);
            const lead = (a) => a[0] === 'open' && !armed;                 // Open's gold dot
            // Open keeps one width armed or not: the second tap finds it where the first one was
            const ws = DOOR_ACTS.map((a) => Math.min(room, 60 + (a[0] === 'open' ? Math.max(cv.textWidth(tr(a[1]), 26, BOLD) + 20, cv.textWidth(tr(ARMED), 26, BOLD)) : cv.textWidth(tr(a[1]), 26, BOLD))));
            const rows = [];
            ws.forEach((w, k) => { const r = rows[rows.length - 1]; if (r && r.w + gap + w <= room) { r.k.push(k); r.w += gap + w; } else rows.push({ k: [k], w }); });
            const bh = rows.length * (hh + gap) - gap;
            const by0 = top == null ? hr.y + hr.h - 190 - bh : top < 0 ? hr.y + (hr.h - bh) / 2 : top;   // the block's bottom clears the name
            chipTop = by0 - 8;
            const pos = [];
            rows.forEach((r, j) => {
                const by = by0 + j * (hh + gap);
                let x = top != null ? hr.x + (hr.w - r.w) / 2 : right - r.w;   // the column: each row centred in it
                cv.roundRect(x - 8, by - 8, r.w + 16, hh + 16, (hh + 16) / 2, '#0b0b0e9e');
                r.k.forEach((k) => { pos[k] = { x, by }; x += ws[k] + gap; });
            });
            DOOR_ACTS.forEach((a, k) => {
                const w = ws[k], x = pos[k].x, by = pos[k].by, key = 'door:' + a[0], on = a[0] === 'open' && armed, f = focus === key;
                doorRects.push({ x, y: by, w, h: hh, run: () => doorAct(a), key });
                cv.roundRect(x, by, w, hh, hh / 2, on ? GOLD : '#ffffff1f');
                cv.strokeRoundRect(x, by, w, hh, hh / 2, f ? 3 : 1.5, f || on ? GOLD : '#ffffff40');
                if (lead(a)) dot(cv, x + 30, by + hh / 2, 5);
                cv.text(lab(a), x + w / 2 + (lead(a) ? 10 : 0), by + hh / 2 + 9, 26, on ? '#1a1408' : doorBusy === a[0] || (a[0] === 'open' && mono() < doorLock) ? DIM : '#ffffff', Object.assign({ align: 'center' }, BOLD));
                if (on) { cv.roundRect(x + 28, by + hh - 10, Math.max(0, (w - 56) * (1 - age / ARM_MS)), 3, 1.5, '#1a140880'); anim = true; }
            });
            // targets with Open last: the knob's first turn lands on a message, never on the door
            doorRects.slice(1).concat(doorRects[0]).forEach((r) => T(r.x, r.y, r.w, r.h, r.run, r.key, hh / 2));
            return anim;
        }

        /** Listen (a round speaker button) and Talk (a big round mic button) right-aligned, their bottom at y; their labels
         *  under them. Talk talking: gold, the 60 s ring counting down; the button in use glows with the sound's level.
         *  true while something moves */
        function drawAudio(cv, hr, hero, y, T, small, mid) {
            const R = small ? 44 : 56, r = small ? 32 : 40, right = mid ? hr.x + (hr.w + 2 * R + 28 + 2 * r) / 2 : hr.x + hr.w - 32, cyT = y - 26 - R, cxT = right - R, cxL = cxT - R - 28 - r, cyL = cyT + R - r;
            const talking = au.talk !== 'off', listening = au.listen !== 'off', on = au.caps.indexOf('talk') >= 0, lon = au.caps.indexOf('listen') >= 0;
            const glow = (cx, cy, rr) => { const g = 4 + au.lv * 16; cv.arc(cx, cy, rr, rr + g, 0, 360, GOLD + hexA(0.25 + 0.5 * au.lv)); };
            cv.roundRect(cxL - r - 14, cyT - R - 14, right + 14 - (cxL - r - 14), 2 * R + 28 + 34, 30, '#0b0b0e9e');
            let anim = false;
            if (lon) {
                if (listening && !talking) glow(cxL, cyL, r);
                cv.circle(cxL, cyL, r, listening ? '#ffffff' : '#ffffff1f');
                cv.arc(cxL, cyL, r - 1.5, r, 0, 360, focus === 'audio:listen' ? GOLD : '#ffffff40');
                if (focus === 'audio:listen') cv.arc(cxL, cyL, r, r + 3, 0, 360, GOLD);
                const c = listening ? '#1a1408' : '#ffffff';
                cv.fillRect(cxL - 15, cyL - 6, 8, 12, c);
                cv.quad([[cxL - 8, cyL - 6], [cxL + 3, cyL - 15], [cxL + 3, cyL + 15], [cxL - 8, cyL + 6]], c);
                cv.arc(cxL + 4, cyL, 8, 10.5, 50, 130, listening ? c : c + '60', { round: true });
                cv.arc(cxL + 4, cyL, 14, 16.5, 45, 135, listening ? c : c + '60', { round: true });
                sh(cv, tr(au.listen === 'on' ? 'Listening' : au.listen === 'starting' ? 'Connecting…' : 'Listen'), cxL, cyT + R + 34, small ? 18 : 20, listening ? GOLD : SUB, Object.assign({ align: 'center' }, BOLD));
                if (au.listen === 'starting') anim = true;
                T(cxL - r, cyL - r, 2 * r, 2 * r, () => listenTap(hero), 'audio:listen', r);
                auRects.push({ x: cxL - r, y: cyL - r, w: 2 * r, h: 2 * r });
            }
            if (on) {
                const left = Math.max(0, TALK_S - (mono() - au.t0) / 1000);   // (the 60 s cap itself: sync())
                if (talking) { glow(cxT, cyT, R + 6); anim = true; }
                cv.circle(cxT, cyT, R, talking ? GOLD : '#ffffff1f');
                cv.arc(cxT, cyT, R - 2, R, 0, 360, focus === 'audio:talk' || talking ? GOLD : '#ffffff60');
                if (focus === 'audio:talk') cv.arc(cxT, cyT, R + 1, R + 4, 0, 360, GOLD);
                // the countdown ring: what is left of the 60 s
                if (talking) cv.arc(cxT, cyT, R + 6, R + 10, 0, 360 * left / TALK_S, '#ffffff', { round: true });
                const c = talking ? '#1a1408' : '#ffffff';
                cv.roundRect(cxT - 11, cyT - 30, 22, 38, 11, c);
                cv.arc(cxT, cyT - 4, 19, 23, 90, 270, c, { round: true });
                cv.line(cxT, cyT + 19, cxT, cyT + 30, 4, c);
                cv.line(cxT - 11, cyT + 30, cxT + 11, cyT + 30, 4, c);
                const lab = au.talk === 'on' ? tr('Talking') + ' · ' + Math.ceil(left) + ' s' : au.talk === 'starting' ? tr('Connecting…') : tr('Hold to talk');
                sh(cv, lab, cxT, cyT + R + 34, small ? 18 : 20, talking ? GOLD : SUB, Object.assign({ align: 'center' }, BOLD));
                T(cxT - R, cyT - R, 2 * R, 2 * R, () => talkSet(hero, au.talk === 'off'), 'audio:talk', R, undefined, talkHold(hero));
                auRects.push({ x: cxT - R, y: cyT - R, w: 2 * R, h: 2 * R });
            }
            return anim;
        }

        /** the lifted tile: its place dimmed, the drop target ringed in gold, a live ghost of it under the finger;
         *  after a drop the two tiles glow until the server's new layout (or 4 s); true while something shows */
        function drawDnd(cv, now, kx, ky) {
            const R = (r) => ({ x: r.x * kx, y: r.y * ky, w: r.w * kx, h: r.h * ky, r: r.shape === 'round' ? r.w * kx / 2 : r.hero ? 0 : 6 });
            const ring = (r, a) => [[18, 0.12], [10, 0.22], [4, 0.95]].forEach((q) => cv.strokeRoundRect(r.x - q[0] / 2, r.y - q[0] / 2, r.w + q[0], r.h + q[0], r.r + q[0] / 2, q[0], GOLD + hexA(q[1] * a)));
            if (swapAsk && now - swapAsk.t0 > 4000) swapAsk = null;
            if (swapAsk) {
                const a = 0.55 + 0.45 * Math.cos((now - swapAsk.t0) / 250 * Math.PI);
                [swapAsk.a, swapAsk.b].forEach((i) => { const t = st.layout.tiles.find((q) => q.i === i) || (i === st.layout.hero ? heroBox() : null); if (t) ring(R(t), a); });
            }
            if (!dnd || !dnd.lifted) return !!swapAsk;
            const s = R(dnd.src), to = under(dnd.x, dnd.y);
            cv.roundRect(s.x, s.y, s.w, s.h, s.r, '#000000b0');
            cv.strokeRoundRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2, s.r, 2, '#ffffff70');
            if (canDrop(dnd.src, to)) {
                const t = R(to);
                ring(t, 1);
                if (to.hero) {
                    const msg = 'Show big', w = cv.textWidth(msg, 28, BOLD) + 60;
                    cv.roundRect(t.x + t.w / 2 - w / 2, t.y + t.h / 2 - 36, w, 64, 32, '#1a1408e0');
                    cv.text(msg, t.x + t.w / 2, t.y + t.h / 2 + 8, 28, '#ffffff', Object.assign({ align: 'center' }, BOLD));
                }
            }
            // the ghost: the tile's own live picture (the frame drawn shifted and scaled under a clip), 10 % bigger
            const k = dnd.src.hero ? 360 / s.w : 1.1, gw = s.w * k, gh = s.h * k, gx = dnd.x - gw / 2, gy = dnd.y - gh / 2;
            cv.roundRect(gx + 6, gy + 10, gw, gh, s.r * k, '#00000080');
            cv.clip(gx, gy, gw, gh);
            cv.video(VID, gx - s.x * k, gy - s.y * k, cv.place.w * k, cv.place.h * k, 0);
            cv.noclip();
            cv.strokeRoundRect(gx, gy, gw, gh, s.r * k, 3, GOLD);
            const label = dnd.src.hero ? name(dnd.src.i) : dnd.src.label || name(dnd.src.i);
            sh(cv, label, gx + gw / 2, gy + gh + 30, 22, '#ffffff', Object.assign({ align: 'center' }, BOLD));
            return true;
        }

        /** "What happened": the panel over the pane; true while the list glides */
        function drawTimeline(cv, now, T) {
            const p = pane(), x0 = p.x, pw = p.w;
            const list = st.events.filter((e) => TIMELINE.indexOf(e.type) >= 0).slice().reverse();
            // the rows' places in the list (px from its top), a day header before each day's first
            rows = [];
            let y = 0, day = null;
            list.forEach((e) => {
                const d = dayOf(e.ts), head = d !== day ? dayName(e.ts, now) : null;
                if (head) { y += HEAD; day = d; }
                rows.push({ key: 'ev:' + e.id, e, y, head });
                y += ROW;
            });
            listH = y;
            if (listH > viewH()) cv.scroll = { tiles: true };       // the touchpad's two fingers (every row is a target)
            // gliding: to the controller's row, or a flick's inertia
            let glide = false;
            const dt = Math.min(50, now - frameT);
            frameT = now;
            if (scrollTo !== null) { scrollY += (scrollTo - scrollY) * 0.3; if (Math.abs(scrollTo - scrollY) < 1) { scrollY = scrollTo; scrollTo = null; } else glide = true; }
            if (vel && !drag) {
                scrollY += vel * dt; vel *= Math.pow(0.996, dt);
                const was = scrollY;
                clampScroll();
                if (Math.abs(vel) < 0.03 || was !== scrollY) vel = 0; else glide = true;
            }
            clampScroll();
            cv.fillRect(x0, p.y, pw, p.h, '#0b0b0edb');
            cv.fillRect(x0, p.y, 2, p.h, '#ffffff18');
            if (!list.length) cv.text('Nothing to see yet', x0 + pw / 2, p.y + p.h / 2, 24, DIM, Object.assign({ align: 'center' }, LIT));
            const top = p.y + TOP;
            rows.forEach((r) => {
                const ry = top + r.y - scrollY;
                T(x0 + 10, ry, pw - 36, ROW - 12, () => playClip(r.e), r.key, 12);       // every row: the knob reaches them all
                if (r.head && ry > 0 && ry - HEAD < p.y + p.h) cv.text(r.head, x0 + 24, ry - 18, 22, DIM, BOLD);
                if (ry + ROW < p.y || ry > p.y + p.h) return;
                const e = r.e, recent = now - e.ts < RECENT_MS, tx = x0 + 204;
                if (sel === e.id) { cv.roundRect(x0 + 10, ry, pw - 36, ROW - 12, 12, '#F0C06828'); cv.roundRect(x0 + 10, ry + 12, 4, ROW - 36, 2, GOLD); }
                else if (focus === r.key) cv.roundRect(x0 + 10, ry, pw - 36, ROW - 12, 12, '#ffffff14');
                const th = thumbs[e.id], pid = th ? slot(e.id, th) : null;
                if (pid !== null) cv.picture(pid, x0 + 24, ry + 6, 160, 90, 8);
                else { cv.roundRect(x0 + 24, ry + 6, 160, 90, 8, '#ffffff14'); wantThumb(e); }
                cv.text(name(e.cam), tx, ry + 34, 26, '#ffffff', BOLD);
                if (recent) dot(cv, tx + 6, ry + 57, 5);
                cv.text(TYPE[e.type] + (e.count > 1 ? ' · ×' + e.count : ''), tx + (recent ? 20 : 0), ry + 65, 22, SUB, LIT);
                cv.text(rel(e.ts, now), tx, ry + 93, 20, DIM, LIT);
            });
            // the scroll bar on the panel's right edge: where the list is, and how much of it shows
            if (listH > viewH()) {
                const tr = { x: x0 + pw - 12, y: p.y + 12, h: p.h - 24 }, max = maxScroll();
                const bh = Math.max(40, tr.h * viewH() / listH), by = tr.y + (tr.h - bh) * (max ? scrollY / max : 0);
                cv.roundRect(tr.x, tr.y, 4, tr.h, 2, '#ffffff1c');
                cv.roundRect(tr.x - 1, by, 6, bh, 3, GOLD);
            }
            return glide;
        }

        function drawView(cv) {
            const pl = cv.place, now = Date.now();
            frameNo++;
            cv.xf(1, 0, 0).fillRect(0, 0, pl.w, pl.h, '#000000');
            if (riskAsk) { drawRisk(cv); cv.xf(); return false; }
            const v0 = showing(), v = v0 === 'clip' ? clipCam : v0, L = st.layout;   // (back from a clip: its camera's frame)
            if (kIno !== null && Number.isInteger(v) && L && L.heroRect) {
                // back from CAM: that camera's stream still plays until the spot's own picture is in: in the hero's place
                const hr = L.heroRect, k = pl.w / L.w, fr = frameSize();
                const r = F.place(F.picRect(camW(v), camH(v), fr.w, fr.h), fr.w, fr.h, { x: hr.x * k, y: hr.y * k, w: hr.w * k, h: hr.h * k }, 'whole', null);
                cv.clip(r.pic.x, r.pic.y, r.pic.w, r.pic.h).video(VID, r.frame.x, r.frame.y, r.frame.w, r.frame.h, 0).noclip();
            } else if (kIno !== null) cv.video(VID, 0, 0, pl.w, pl.h, 0);
            let anim = false;
            if (overlay() || pastOn()) anim = drawSpot(cv, now);
            else { rows = []; frameT = now; doorArm = 0; auRects = []; }   // (no chips drawn: Open is not armed)
            const at = st.pair && st.up && !overlay() && !pastOn() && !moving() ? drawPair(cv) : null, n = at ? null : note();
            // over Listen and Talk while they show: above them
            let ny = pl.h / 2;
            if (n && auRects.length) {
                const half = cv.textWidth(n, 30, LIT) / 2 + 30;
                if (auRects.some((q) => q.x < pl.w / 2 + half && q.x + q.w > pl.w / 2 - half)) ny = Math.min.apply(null, auRects.map((q) => q.y)) - 70;
            }
            if (n) drawNote(cv, n, pl.w / 2, ny, 30);
            // full screen, the kit has no header tab or bar button for Settings: the app draws one (else a first start,
            // with no server address, could never be set up by touch)
            if ((n || at) && !overlay() && !pastOn() && !moving()) {
                const s = pl.scale, w = 240, h = 72, x = at ? at.x : pl.w / 2 - w / 2, y = at ? at.y : pl.h / 2 + 60, f = focus === 'settings';
                cv.roundRect(x, y, w, h, h / 2, f ? '#ffffff' : '#ffffff26');
                cv.text('Settings', x + w / 2, y + 47, 28, f ? '#000000' : '#ffffff', Object.assign({ align: 'center' }, BOLD));
                cv.target((x - pl.ox) / s, (y - pl.oy) / s, w / s, h / s, openSettings, 'settings', h / 2 / s);
            }
            cv.xf();
            return anim;
        }
        /** the server refuses this car: its QR (the setup page) left, what to do right; where Settings goes */
        function drawPair(cv) {
            const pl = cv.place, k = qr.encode(st.pair.url).length + 8, mod = Math.max(2, Math.floor((pl.h - 160) / k)), side = k * mod;
            const t1 = 'Scan with your phone to add this car', t2 = 'Or on the server: configure.py --add-car ' + st.pair.code;
            const tw = Math.max(cv.textWidth(t1, 36, BOLD), cv.textWidth(t2, 26, LIT));
            const x = Math.max(touchX(pl) + 40, (touchX(pl) + pl.w - side - 60 - tw) / 2), tx = x + side + 60, room = pl.w - 40 - tx;
            qr.draw(cv, st.pair.url, x, (pl.h - side) / 2, mod);
            if (st.pair.fp) cv.text('Check: ' + st.pair.fp, x + side / 2, (pl.h + side) / 2 + 48, 30, '#ffffff', Object.assign({ align: 'center' }, BOLD));
            cv.text(t1, tx, pl.h / 2 - 40, Math.min(36, 36 * room / cv.textWidth(t1, 36, BOLD)), '#ffffff', BOLD);
            cv.text(t2, tx, pl.h / 2 + 10, Math.min(26, 26 * room / cv.textWidth(t2, 26, LIT)), SUB, LIT);
            return { x: tx, y: pl.h / 2 + 60 };
        }
        const openSettings = () => { if (ctx.display && ctx.display._click) ctx.display._click('BTN_SETTINGS'); };
        /** Parked only switched off: the risk page, "I agree" / "Cancel" (no picture under it) */
        function drawRisk(cv) {
            const pl = cv.place, s = pl.scale, mid = (touchX(pl) + pl.w) / 2;
            if (shown('VIEW') && !ui.isVisible('SETTINGS') && !riskSeen) {
                riskSeen = true;
                if (ctx.focus) setImmediate(() => { if (riskAsk) ctx.focus('risk:cancel'); });   // a reflex knob press must not agree
            }
            cv.text('Cameras while driving', mid, 130, 40, GOLD, Object.assign({ align: 'center' }, BOLD));
            RISK.forEach((l, i) => cv.text(l, mid, 200 + i * 44, 30, '#ffffff', Object.assign({ align: 'center' }, LIT)));
            [['I agree', 'risk:ok', true], ['Cancel', 'risk:cancel', false]].forEach((q, k) => {
                const w = 320, h = 80, x = mid + (k ? 20 : -20 - w), y = pl.h - 150, f = focus === q[1];
                cv.roundRect(x, y, w, h, h / 2, f ? '#ffffff' : q[2] ? GOLD : '#ffffff26');
                cv.text(q[0], x + w / 2, y + 52, 30, f || q[2] ? '#000000' : '#ffffff', Object.assign({ align: 'center' }, BOLD));
                cv.target((x - pl.ox) / s, (y - pl.oy) / s, w / s, h / s, () => riskEnd(q[2]), q[1], h / 2 / s);
            });
        }
        let anim = false;
        function render() {
            const now = Date.now();
            // redraw on a change and every frame while something moves, else 4 times a second (clock, spinner, "il y a")
            if (!last || dirty || anim || drag || now - lastT > 250) {
                dirty = false; lastT = now;
                const cv = ctx.canvas(W, H);
                if (cv.own && cv.place) anim = drawView(cv);
                else {
                    cv.clear('#000000');
                    cv.text('RideWatch needs the GPU renderer (mgu-render)', W / 2, H / 2, 30, '#ffffff', Object.assign({ align: 'center' }, LIT));
                }
                last = cv;
            }
            return ui.image('VIEW_GFX', last);
        }
        ctx.loop('VIEW', 10, render);

        /* ---------- CAM: one camera, the app's own layer ---------- */
        const gpu = new RenderClient(ctx.spec.id, log, { kit: record });
        let camShown = false, cIno = null, camRec = null, lastMsg = 0, ccuLast = null;
        gpu.on('ready', safe('gpu ready', (screen, info) => {
            if (!info) return;                                  // not mgu-render/1: no video here
            gpu.mode('layer');
            gpu.place({ x: 0, y: 0, w: screen.w, h: screen.h, scale: 1, ox: 0, oy: 0 });
            gpu.claim([{ x: 0, y: 0, w: screen.w, h: screen.h }]);
            cIno = null; camRec = null;                         // the renderer forgot our video with the connection
            sync();
        }));
        gpu.on('close', safe('gpu close', () => { cIno = null; }));
        /* CAM's picture: where the camera is in the stream now playing (null: another camera's, still there) */
        let camPan = { x: 0, y: 0 }, camRange = { x: 0, y: 0 }, wakeT = Date.now(), tch = null;
        const camMode = {};                      // camera -> 'fill' | 'whole' (until the app restarts)
        const CHIP = { w: 330, h: 76 }, FADE_MS = 4000;
        function srcOf(v) {
            const L = st.layout, fr = frameSize();
            if (v === 'spot' && L && L.heroRect) return { cam: L.hero, src: L.heroRect, fw: L.w, fh: L.h };
            if (Number.isInteger(v)) return { cam: v, src: F.picRect(camW(v), camH(v), fr.w, fr.h), fw: fr.w, fh: fr.h };
            if (v === 'clip') return { cam: 'clip', src: F.picRect(camW(clipCam), camH(clipCam), fr.w, fr.h), fw: fr.w, fh: fr.h };   // fitted as a `cam` view
            return null;
        }
        const viaSpot = (i) => { const s = srcOf(showing()); return showing() === 'spot' && !!s && s.cam === i; };
        const modeOf = (i, s, box) => camMode[i] || F.defaultMode(s.src, box);
        function wake() { wakeT = Date.now(); camRec = null; }
        const chipAt = (pl) => ({ x: pl.w - CHIP.w - 36, y: pl.h - CHIP.h - 32, w: CHIP.w, h: CHIP.h });
        // a clip's end: "Replay" and "Live", side by side bottom centre
        const clipBtns = (pl) => [['Replay', replay], ['Live', direct]].map((q, k) => ({ x: pl.w / 2 + (k ? 12 : -272), y: pl.h - 108, w: 260, h: 76, label: q[0], run: q[1] }));
        const hit = (c, x, y) => x >= c.x - 20 && x < c.x + c.w + 20 && y >= c.y - 20 && y < c.y + c.h + 20;
        function toggleMode() {
            const s = srcOf(viaSpot(cam) ? 'spot' : cam), pl = gpu.placement;
            if (!s || !pl) return;
            camMode[cam] = modeOf(cam, s, { x: 0, y: 0, w: pl.w, h: pl.h }) === 'fill' ? 'whole' : 'fill';
            camPan = { x: 0, y: 0 }; wake();
        }
        function panBy(dx, dy) { camPan = { x: camPan.x + dx, y: camPan.y + dy }; wake(); camFrame(); }
        function camFrame() {
            const pl = gpu.placement;
            if (!pl) return;
            const now = Date.now();
            if (!camRec) {
                // a clip: the decoder's picture is the clip's from its first frame on (also while "Revoir" connects)
                const box = { x: 0, y: 0, w: pl.w, h: pl.h }, v0 = showing(), s = srcOf(clip && (v0 === null || v0 === 'clip') ? 'clip' : v0);
                const mine = !!s && st.pic && (clip ? v0 === 'clip' : s.cam === cam);
                camRec = new Recorder(pl.w, pl.h).clear(0x000000ff);
                if (cIno !== null && s) {
                    // the camera's picture placed (fill / whole, panned); the camera before stays, dimmed, while this one connects
                    const r = F.place(s.src, s.fw, s.fh, box, mine ? modeOf(cam, s, box) : 'fill', mine ? camPan : null);
                    if (mine) { camPan = r.pan; camRange = r.range; }
                    camRec.clip(r.pic.x, r.pic.y, r.pic.w, r.pic.h).video(VID, r.frame.x, r.frame.y, r.frame.w, r.frame.h, 0).noclip();
                    if (!mine) camRec.fillRect(0, 0, pl.w, pl.h, '#000000a0');
                }
                // the overlay (name, live dot, clock, the mode chip, where the pan is): full for 4 s after a touch, then fades
                const age = now - wakeT, a = mine && !clip ? Math.max(0, Math.min(1, 1 - (age - FADE_MS) / 600)) : 1;
                camRec.fade = clip ? !!clip.info && !clip.ended : mine && a > 0;   // (until it is gone / the clip's bar: the 50 ms timer redraws)
                if (a > 0) {
                    camRec.alpha(a);
                    camRec.gradientRect(0, 0, pl.w, 140, [[0, '#000000a0'], [1, '#00000000']]);
                    if (clip) {
                        // what, where, when; the bar: how much has played
                        const e = clip.e;
                        sh(camRec, TYPE[e.type] + ' · ' + name(e.cam) + ' · ' + hhmm(e.first || e.ts), 40, 68, 40, '#ffffff', BOLD);
                        if (clip.info) {
                            const k = clip.ended ? 1 : Math.min(1, (now - clip.t0) / clip.info.dur);
                            camRec.roundRect(40, 96, pl.w - 80, 6, 3, '#ffffff30').roundRect(40, 96, Math.max(6, (pl.w - 80) * k), 6, 3, GOLD);
                        }
                        if (clip.ended) clipBtns(pl).forEach((b, k) => {
                            camRec.roundRect(b.x, b.y, b.w, b.h, b.h / 2, '#000000b8');
                            camRec.strokeRoundRect(b.x, b.y, b.w, b.h, b.h / 2, clipSel === k ? 3 : 2, clipSel === k ? GOLD : '#ffffff40');
                            camRec.text(b.label, b.x + b.w / 2, b.y + b.h / 2 + 10, 28, '#ffffff', Object.assign({ align: 'center' }, BOLD));
                        });
                    } else if (cam !== null) {
                        if (mine) { camRec.circle(52, 54, 16, '#E5484D30'); camRec.circle(52, 54, 8, '#E5484D'); }
                        sh(camRec, name(cam), mine ? 76 : 40, 68, 40, '#ffffff', BOLD);
                    }
                    if (!clip) sh(camRec, hhmm(now), pl.w - 40, 68, 36, '#ffffff', Object.assign({ align: 'right' }, BOLD));
                    const c = chipAt(pl), whole = mine && modeOf(cam, s, box) === 'whole';
                    if (mine && !clip) {
                        camRec.roundRect(c.x, c.y, c.w, c.h, c.h / 2, '#000000b8');
                        camRec.strokeRoundRect(c.x, c.y, c.w, c.h, c.h / 2, 2, '#ffffff40');
                        camRec.text(whole ? 'Fill the screen' : 'Whole picture', c.x + c.w / 2, c.y + c.h / 2 + 10, 28, '#ffffff', Object.assign({ align: 'center' }, BOLD));
                    }
                    if (mine && camRange.y > 0) {          // the pan bar: how much is hidden above and below
                        const tr = { x: pl.w - 14, y: 160, h: pl.h - 320 }, k = pl.h / (pl.h + 2 * camRange.y);
                        const bh = tr.h * k, by = tr.y + (tr.h - bh) * (camRange.y - camPan.y) / (2 * camRange.y);
                        camRec.roundRect(tr.x, tr.y, 5, tr.h, 2.5, '#ffffff30').roundRect(tr.x - 1, by, 7, bh, 3.5, GOLD);
                    }
                    camRec.alpha(1);
                }
                const n = note() || (!mine ? 'Connecting…' : null);
                if (n) drawNote(camRec, n, pl.w / 2, pl.h / 2, 30);
                if (n === 'Connecting…') camRec.spin = true;        // (redrawn for the spinner)
            }
            gpu.frame(camRec);
            lastMsg = now;
            if (camRec.spin || camRec.fade) camRec = null;
        }
        // the overlay's fade and the spinner: 20 frames a second while they move (the 250 ms sync is too slow for them)
        const camAnim = safe('cam anim', () => { if (camShown && !camRec) camFrame(); });
        // a finger: a drag pans (fill), a tap on the chip toggles fill / whole, any other tap: back to the spot
        gpu.on('touch', safe('touch', (ph, x, y) => {
            if (!camShown) return;
            if (ph === 'down') { tch = { x, y, pan: { x: camPan.x, y: camPan.y }, moved: false }; return; }
            if (!tch) return;
            if (ph === 'move') {
                if (Math.abs(x - tch.x) > 14 || Math.abs(y - tch.y) > 14) tch.moved = true;
                if (tch.moved && (camRange.x || camRange.y)) { camPan = { x: tch.pan.x + x - tch.x, y: tch.pan.y + y - tch.y }; wake(); camFrame(); }
                return;
            }
            if (ph === 'up') {
                const pl = gpu.placement || { w: 1920, h: 720 }, c = chipAt(pl), t = tch;
                tch = null;
                if (t.moved) return;
                const b = clip && clip.ended ? clipBtns(pl).find((q) => hit(q, x, y)) : null;
                if (b) b.run();
                else if (!clip && hit(c, x, y)) toggleMode();
                else back();
            }
        }));
        // the controller (the renderer's copy while grabbed): turn = next / previous camera, press or push left = back,
        // up / down = pan a third of the screen, right = fill / whole
        gpu.on('ccu', safe('ccu', (v) => {
            const L = ccuLast;
            ccuLast = v;
            if (!camShown || !L || (v.press === 15 && v.tilt === 15)) return;   // (15: no controller behind it)
            const d = ((v.knob - L.knob + 32768) & 0xffff) - 32768;
            // a clip: the turn picks "Revoir" / "Direct" once it ended, the press runs it
            if (d && Math.abs(d) <= 64) { if (!clip) turn(d > 0 ? 1 : -1); else if (clip.ended) { clipSel = d > 0 ? 1 : 0; camRec = null; } }
            const down = (p) => p === 1 || p === 2, tilt = (a, b) => (v.tilt === a || v.tilt === b) && L.tilt !== v.tilt;
            if (down(v.press) && !down(L.press)) { if (clip && clip.ended) clipBtns(gpu.placement || { w: 1920, h: 720 })[clipSel].run(); else back(); }
            if (tilt(10, 11)) back();
            if (tilt(1, 2)) panBy(0, (gpu.placement ? gpu.placement.h : 720) / 3);
            if (tilt(7, 8)) panBy(0, -(gpu.placement ? gpu.placement.h : 720) / 3);
            if (tilt(4, 5)) toggleMode();
        }));

        /* ---------- the stream and the video gates (every 250 ms) ---------- */
        const ino = () => { try { const f = fs.statSync(VPATH); return f.isFile() ? f.ino : null; } catch (e) { return null; } };
        function sync() {
            const vView = shown('VIEW'), vCam = shown('CAM') && cam !== null, mv = (vView || vCam) && moving(), why = vView || vCam ? 'moving' : 'hidden';
            // Talk only while its button is on the screen: VIEW, the spot's live picture, the door camera the hero. CAM, a
            // clip, the risk page, a stalled picture or another hero end it, and so does its 60 s cap, whatever is drawn
            if (au.talk !== 'off') {
                const L0 = st.layout, H = st.hero ? st.hero.hero : L0 && Number.isInteger(L0.hero) ? L0.hero : null;
                const there = vView && !riskAsk && overlay() && audioOn(H);
                if ((!there || mono() - au.t0 >= TALK_S * 1000) && Date.now() - auStopT > 1000) { auStopT = Date.now(); talkSet(H, false); }
            }
            // CAM of the spot's hero: the spot already playing (no new stream); any other camera: its own stream
            const want = st.up && !mv ? (vCam ? (clip ? 'clip' : viaSpot(cam) ? 'spot' : cam) : vView ? 'spot' : null) : null;
            if (want !== null) {
                const r = rect(), k = want + ' ' + r + (want === 'clip' ? ' ' + clip.e.id + ' #' + clip.n : '');   // (#n: "Revoir" asks again)
                if (k !== sent) { ctl.send(want === 'clip' ? { cmd: 'view', view: 'clip', id: clip.e.id, rect: r } : { cmd: 'view', view: want, rect: r }); sent = k; log.info('view ' + k); }
            } else if (st.up && sent !== 'stop:' + why && (why === 'hidden' || sent !== null)) {
                // (each change said: the service redials the feed slowly while hidden, at once again otherwise)
                ctl.send({ cmd: 'stop', why }); sent = 'stop:' + why;
                if (why === 'hidden') { sel = null; tab = 'live'; }   // left the app: the pick goes too (driving off keeps it)
                log.info('stop (' + why + ')');
            }
            // the decoder's file: on VIEW through the kit's renderer, on CAM through ours (a new file is named again)
            const pic = st.pic && want !== null;
            const kCur = pic && vView ? ino() : null, g = kgpu();
            if (g) { if (!kCur || kCur !== kIno) g.dropVideo(VID); if (kCur) g.video(VID, VPATH); }
            if (kCur !== kIno) { kIno = g ? kCur : null; dirty = true; }
            const cWant = vCam && !!gpu.placement, cCur = cWant && pic ? ino() : null;
            if (cCur !== cIno) {
                if (cIno !== null) gpu.video(VID, null);
                if (cCur !== null) gpu.video(VID, VPATH);
                cIno = cCur; camRec = null;
            }
            if (cWant !== camShown) {
                camShown = cWant;
                ccuLast = null;
                gpu.grab(cWant);
                gpu.show(cWant);
                camRec = null;
                log.info('camera layer ' + (cWant ? 'shown' : 'hidden'));
            }
            if (camShown && (Date.now() - lastMsg >= KEEPALIVE_MS || !camRec)) camFrame();
        }
        // on screen: the speed, the 250 ms sync and the 50 ms CAM animation; the first time also the app's renderer
        // connection, the touchpad and ha.json. Hidden for 1 s (not VIEW <-> CAM): all of them off but the connection
        // and the touchpad's watch (the kit's touchpad has no detach)
        let ticks = null, offT = null, firstShow = true;
        function onOff() {
            clearTimeout(offT); offT = null;
            if (onScreen()) {
                if (firstShow) { firstShow = false; gpu.connect(); require('./kit/touchpad').attach(ctx, log, padOn, () => { dirty = true; }); }
                haLoad();
                needSpeed('shown', true);
                if (!ticks) ticks = [setInterval(safe('sync', sync), 250), setInterval(camAnim, 50)];
            } else if (ticks || needs.has('shown')) offT = setTimeout(safe('hidden', () => {
                if (onScreen()) return;
                needSpeed('shown', false);
                if (ticks) { ticks.forEach(clearInterval); ticks = null; }
                log.info('hidden: timers off');
            }), 1000);
        }
        ui.onVisible(safe('visible', (n, on) => {
            if (n === 'CAM' && !on) clip = null;
            if (n === 'VIEW' && !on && riskAsk && riskSeen) riskEnd(false);   // left the risk page without an answer
            if (!onScreen()) doorArm = 0;
            onOff();
            dirty = true; camRec = null; sync();
        }));   // (left CAM: the clip is done)
        if (ui.onFocus) ui.onFocus(safe('focus', () => sync()));
        // the controller's touchpad (kit/touchpad.js): one finger moves the kit's pointer (what it is on gets the
        // controller, a tap runs it: a tab, the hero, a tile, a timeline row), two fingers scroll the timeline. Only
        // while VIEW is in front and the kit draws it (CAM is the app's own layer: its targets are not the kit's)
        const top = () => (ui.topScreen ? ui.topScreen() : null);
        const padOn = () => shown('VIEW') && !shown('CAM') && !ui.isVisible('SETTINGS') && (top() === null || top() === 'VIEW') && !!(last && last.own);
        onOff();
        log.info('ridewatch app started');
    },
});
module.exports = { doorStep, gapRing };   // (test/app/smoke.js)
