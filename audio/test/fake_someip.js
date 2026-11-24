'use strict';
// A stand-in for the unit's someip.node (JAP_RIDEWATCH_SOMEIP): every callMethod goes as a JSON line to the test's fake
// AudioManager on FAKE_AM (a unix socket), which answers it. The proxies are always available. A method the schema it was
// built from does not describe is refused, as the real module would (the shipped defs/ are what the helper loads).
const net = require('net');

let sock = null, buf = '', n = 0;
const wait = new Map();
function link() {
    if (sock) return;
    sock = net.connect(process.env.FAKE_AM);
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
            const cb = wait.get(m.n); wait.delete(m.n);
            if (cb) cb(m.r);
        }
    });
    sock.on('error', () => {});
}
module.exports = {
    buildProxy(def, inst) {
        link();
        return Promise.resolve({
            init: () => Promise.resolve(),
            isAvailable: () => true,
            callMethod: (name, args) => (!def.methods || !def.methods[name] ? Promise.reject(new Error('no method ' + name + ' in ' + def.name)) : new Promise((res) => { const k = ++n; wait.set(k, res); sock.write(JSON.stringify({ n: k, svc: def.name, inst, name, args }) + '\n'); })),
        });
    },
};
