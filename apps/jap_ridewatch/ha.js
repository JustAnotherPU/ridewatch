'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/**
 * ha.js - Home Assistant REST over the car's SOCKS5 proxies (Node 8, no TUN on the unit), for the doorbell's quick replies.
 *
 *   const ha = new Ha({ host: '192.0.2.20', port: 8123, token, socks: [['127.0.0.1', 1065], ['127.0.0.2', 1055]] });
 *   await ha.call('script', 'my_doorbell_reply', { door: 'DOORBELL_COMING' });
 *
 * The first proxy that answers is kept first for a minute (as the service's socksFallback), then the list is tried in
 * order again. Every request has a hard timeout; a service call is never retried (a retry could open a door twice).
 */
const http = require('http');
const net = require('net');

const TIMEOUT_MS = 8000, STICKY_MS = 60000;

/** One TCP connection to ip:port through a SOCKS5 server (CONNECT, no auth). cb(err, socket). */
function socksConnect(sh, sp, ip, port, cb) {
    const s = net.connect(sp, sh);
    let stage = 0, buf = Buffer.alloc(0), done = false;
    const end = (e) => { if (done) return; done = true; s.setTimeout(0); s.removeListener('data', onData); if (e) { s.destroy(); cb(e instanceof Error ? e : new Error('socks ' + sh + ':' + sp + ': ' + e)); } else cb(null, s); };
    s.setTimeout(5000, () => end('timeout'));
    s.on('error', end);
    s.on('close', () => end('closed before its reply'));   // a proxy hanging up: try the next one now, not after 5 s
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    function onData(d) {
        buf = Buffer.concat([buf, d]);
        if (stage === 0) {
            if (buf.length < 2) return;
            if (buf[0] !== 5 || buf[1] !== 0) return end('auth refused');
            buf = buf.slice(2); stage = 1;
            const a = Buffer.alloc(10); a[0] = 5; a[1] = 1; a[2] = 0; a[3] = 1;
            ip.split('.').forEach((n, i) => { a[4 + i] = +n; });
            a.writeUInt16BE(port, 8);
            s.write(a);
        }
        if (buf.length < 10) return;                 // IPv4 reply (the proxies here answer with atyp 1)
        if (buf[1] !== 0) return end('reply ' + buf[1]);
        s.removeListener('error', end);
        end(null);
    }
    s.on('data', onData);
}

class Ha {
    constructor(o) {
        // socksConnect sends IPv4 only, each octet as one byte: 300 would wrap to 44
        if (!net.isIPv4(o.host)) throw new Error('host must be an IPv4 address');
        const port = o.port === undefined ? 8123 : o.port;
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be a number from 1 to 65535');
        if (typeof o.token !== 'string' || !o.token) throw new Error('no token');
        this.host = o.host; this.port = port; this.token = o.token;
        this.socks = o.socks || [];                  // [[host, port], ...]: set again before each call (the app's settings)
        this.pref = 0; this.prefAt = 0;
    }

    _connect(cb) {
        const all = this.socks.map((_, i) => i);
        const order = Date.now() - this.prefAt < STICKY_MS ? [this.pref].concat(all.filter((i) => i !== this.pref)) : all;
        const errs = [];
        const next = (k) => {
            if (k >= order.length) return cb(new Error(errs.join('; ') || 'no proxy'));
            const i = order[k], p = this.socks[i];
            if (!p) return next(k + 1);
            socksConnect(p[0], p[1], this.host, this.port, (e, s) => {
                if (e) { errs.push(e.message); return next(k + 1); }
                this.pref = i; this.prefAt = Date.now();
                cb(null, s);
            });
        };
        next(0);
    }

    /** method, path, body (object or undefined) -> parsed JSON (or text). Rejects on HTTP >= 400 or timeout. */
    request(method, path, body) {
        return new Promise((resolve, reject) => {
            const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
            let settled = false;
            const fin = (e, v) => { if (settled) return; settled = true; clearTimeout(timer); e ? reject(e) : resolve(v); };
            const timer = setTimeout(() => { fin(new Error('timeout')); if (req) req.abort(); }, TIMEOUT_MS);
            let req = null;
            this._connect((e, sock) => {
                if (e) return fin(e);
                if (settled) return sock.destroy();
                req = http.request({
                    method, path, host: this.host, port: this.port,
                    createConnection: () => sock,
                    headers: Object.assign({ Authorization: 'Bearer ' + this.token, Connection: 'close' },
                        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
                }, (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const txt = Buffer.concat(chunks).toString('utf8');
                        if (res.statusCode >= 400) return fin(new Error('HTTP ' + res.statusCode + (res.statusCode === 401 ? ' (token refused)' : '')));
                        try { fin(null, txt ? JSON.parse(txt) : null); } catch (x) { fin(null, txt); }
                    });
                    res.on('error', fin);
                });
                req.on('error', fin);
                if (data) req.write(data);
                req.end();
            });
        });
    }

    call(domain, service, data) { return this.request('POST', '/api/services/' + domain + '/' + service, data || {}); }
}

module.exports = { Ha, socksConnect };
