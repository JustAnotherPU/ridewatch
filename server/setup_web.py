#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""RideWatch setup page: one HTTPS page on the LAN to sign in to UniFi Protect once, see every camera, add RTSP cameras
and let cars in by scanning their QR code.

    sudo ridewatch-setup           (= configure.py --web: this, run as the service user, never as root)
    python3 setup_web.py [--bind ADDRESS] [--port 18642] [--cert PEM] [--key PEM]
    python3 setup_web.py --selftest

Prints https://<LAN address>:18642/, the certificate's SHA-256 fingerprint and an 8-character setup code, then serves
until "Done", 15 minutes without a request or 60 minutes in all. No unit runs it: it exits.
- The certificate: self-signed, made by install.sh with the openssl CLI (/var/lib/jap-ridewatch/setup-*.pem). No
  certificate: no page (terminal setup with configure.py only). The browser warns about it once.
- Protect: a LOCAL admin user (not a ui.com account with two-step login). Its password is used for one login, never
  written, logged or sent back; the page lists what it will change (RTSPS turned on for the channels the car may use,
  serve.candidates(): never the main one when there is another), applies it, then signs out. An optional View Only
  user for detections and clips is stored in cams.json (0600) as configure.py does.
- Cars: the car shows a QR code of https://<server>:18642/pair#h=<hex SHA-256 of its code> and, under it, the hash's
  fingerprint ("Check: 7F3A 9C", its first 6 hex); the page shows the same from h before it adds the car. The fragment
  never reaches the server in a URL; the page posts the hash once the setup code is entered. cams.json keeps
  "sha256:<hex>"; the car's next try gets in.
Guards: peers on RFC1918, loopback, fc00::/7 or fe80::/10 only (not Tailscale's 100.64/10, not public); the Host
header must be this connection's own address and port (DNS rebinding); 5 wrong setup codes stop the page; the session
token lives in the page's memory and comes back as the X-Setup header (no cookie, so no CSRF); a POST needs it and
Content-Type: application/json; no CORS headers; a strict Content-Security-Policy (script and style by hash).
"""
import base64, hashlib, http.server, ipaddress, json, os, re, secrets, signal, socket, ssl, sys, threading, time, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import configure, serve  # noqa: E402

PORT = 18642
IDLE_S, MAX_S = 15 * 60, 60 * 60
TRIES = 5
BODY_MAX = 16 << 10
ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'    # Crockford base32: 32 symbols, 8 = 40 bits; I L O U never shown
LAN = [ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128',
                                          'fc00::/7', 'fe80::/10')]
HOSTNAME = re.compile(r'[A-Za-z0-9.:\[\]-]{1,255}')
PROTECT_ID = re.compile(r'[A-Za-z0-9_-]{1,64}')


class Refused(Exception):
    """a request the page answers with 400 and this sentence"""


def ip(addr):
    """an address without its %scope, an IPv4-mapped IPv6 as IPv4; None if not an address"""
    try:
        a = ipaddress.ip_address(str(addr).split('%')[0])
    except ValueError:
        return None
    return a.ipv4_mapped if a.version == 6 and a.ipv4_mapped else a


def peer_ok(addr):
    a = ip(addr)
    return a is not None and any(a in n for n in LAN)


def host_ok(host, local, port):
    """Host is exactly this connection's own address and port: a page served under a name (DNS rebinding) is refused"""
    a = ip(local)
    return a is not None and host == '%s:%d' % ('[%s]' % a if a.version == 6 else a, port)


def new_code():
    return ''.join(secrets.choice(ALPHABET) for _ in range(8))


def norm_code(s):
    """what was typed, as the code is printed: case, dashes and spaces ignored, O read as 0, I and L as 1"""
    return re.sub(r'[\s-]', '', str(s).upper()).translate(str.maketrans('OIL', '011'))


def fingerprint(cert):
    der = ssl.PEM_cert_to_DER_cert(open(cert).read())
    return ':'.join('%02X' % b for b in hashlib.sha256(der).digest())


def lan_ip():
    """the address of the interface the default route uses (a UDP connect sends nothing)"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('192.0.2.1', 9))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def protect_words(e):
    """a ProtectError in the page's words (its detail goes to the terminal; neither holds a password)"""
    code, detail = e.args
    if code == 'login':
        return 'Protect refused to sign in (too many tries: wait a minute)' if '429' in detail else \
            'Protect refused this user or password. It must be a local Protect user, not a ui.com account.'
    if code == 'unreachable':
        return 'No answer from that address. Check the console\'s IP address.'
    if 'HTTP 401' in detail or 'HTTP 403' in detail:
        return 'Protect refused: this user may not change cameras. Sign in with a local admin (Full Management).'
    return 'Protect gave an answer the page could not use (%s).' % detail.split(':')[0]


def num(v):
    return isinstance(v, int) and not isinstance(v, bool) and 0 < v <= 16384


def rtsp_plan(raw):
    """[(camera, [ids of the channels to turn RTSP on])] from Protect's camera list: of the channels a view may use
    (serve.candidates(), as channel() picks them: never the main one when there is another), those with RTSP off"""
    out = []
    for c in raw if isinstance(raw, list) else []:
        if not isinstance(c, dict) or not isinstance(c.get('name'), str) or not PROTECT_ID.fullmatch(c.get('id') or '') \
                or not isinstance(c.get('id'), str):
            continue
        chans = [dict(ch, w=ch['width'], h=ch['height'], fps=ch['fps'] if num(ch.get('fps')) else 30)
                 for ch in c.get('channels') or [] if isinstance(ch, dict) and ch.get('enabled') is not False
                 and isinstance(ch.get('id'), int) and num(ch.get('width')) and num(ch.get('height'))]
        use = serve.candidates(chans) if chans else []
        out.append((c, [ch['id'] for ch in use if not ch.get('isRtspEnabled')], bool(use)))
    return out


def logout(a):
    """signs the admin's Protect session out (best effort: it also expires by itself)"""
    try:
        serve.http('POST', serve.base({'protect': {'host': a['host']}}) + '/api/auth/logout',
                   {'Cookie': a['s']['cookie'], 'X-CSRF-Token': a['s']['csrf'], 'Content-Type': 'application/json'}, b'{}', 5)
    except serve.ProtectError:
        pass


def text(v, what, empty=False):
    """a name or label: 1 to 64 printable characters (as configure.add_rtsp checks them)"""
    if not isinstance(v, str) or len(v) > 64 or not v.isprintable() or v != v.strip() or not (v or empty):
        raise Refused('%s: 1 to 64 printable characters' % what)
    return v


# ---- the routes: (server, session token, body) -> JSON reply; run under server.lock -------------------------------

def state(srv, tok, body=None):
    conf = configure.load()
    p = conf.get('protect') or {}
    cams = [{'name': c['name'], 'label': c.get('label', c['name']), 'kind': 'rtsp' if serve.is_rtsp(c) else 'protect',
             'roles': [r for r in c.get('roles', []) if r in serve.ROLES], 'size': '%dx%d' % (serve.size(c)['w'], serve.size(c)['h'])}
            for c in conf.get('cams', []) if c.get('channels')]
    return {'protect': {'host': p.get('host', ''), 'user': p.get('username', '')}, 'cams': cams, 'roles': list(serve.ROLES),
            'cars': [h[7:19] for h in configure.car_entries(conf)], 'signedIn': tok in srv.admin,
            'left': int(max(0, min(srv.idle - (time.monotonic() - srv.seen), srv.max_s - (time.monotonic() - srv.started))))}


def protect_scan(srv, tok, body):
    """the admin login (never saved) and what applying would change"""
    host = str(body.get('host', '')).strip()
    if not HOSTNAME.fullmatch(host):
        raise Refused('the console\'s address: an IP address like 192.0.2.1')
    user, pw = body.get('username'), body.get('password')
    if not isinstance(user, str) or not user or not isinstance(pw, str) or not pw:
        raise Refused('enter the Protect user and its password')
    if tok in srv.admin:
        logout(srv.admin.pop(tok))
    s = serve.login({'protect': {'host': host, 'username': user, 'password': pw}}, save=False)
    del pw, body['password']                            # used for that one login only
    try:
        raw = json.loads(serve.protect_get({'protect': {'host': host}}, '/proxy/protect/api/cameras', sess=s))
    except ValueError:
        raw = None
    except serve.ProtectError:
        logout({'host': host, 's': s}); raise
    plan = rtsp_plan(raw)
    srv.admin[tok] = {'host': host, 's': s, 'plan': plan}
    return {'cams': [{'name': c['name'], 'doorbell': bool((c.get('featureFlags') or {}).get('isDoorbell')), 'usable': ok,
                      'turnOn': [str(ch.get('name') or ch['id']) for ch in c['channels'] if isinstance(ch, dict) and ch.get('id') in ids]}
                     for c, ids, ok in plan]}


def protect_apply(srv, tok, body):
    """RTSP on where planned, the camera list again (the new aliases), merged into cams.json; then signed out"""
    a = srv.admin.pop(tok, None)
    if not a:
        raise Refused('sign in to Protect first')
    conf = {'protect': {'host': a['host']}}
    try:
        for c, ids, _ in a['plan']:
            if ids:
                chans = [dict(ch, isRtspEnabled=True) if isinstance(ch, dict) and ch.get('id') in ids else ch for ch in c['channels']]
                serve.protect_req(conf, 'PATCH', '/proxy/protect/api/cameras/' + c['id'], {'channels': chans}, sess=a['s'])
        found, off = serve.discover(conf, sess=a['s'])
    finally:
        logout(a)
    old = configure.load()
    roles = {r: c['name'] for c in old.get('cams', []) for r in c.get('roles', [])}
    if 'door' not in roles:
        roles['door'] = next((c['name'] for c in found if c['doorbell']), '')
    p = dict(old.get('protect') or {})
    moved = p.get('host') != a['host']
    dropped = moved and 'username' in p
    if moved:                                          # another console: the View Only user and its session were for the old one
        p.pop('username', None); p.pop('password', None)
        try:
            os.unlink(serve.session_path())
        except OSError:
            pass
    new = configure.merge(dict(old, protect=dict(p, host=a['host'])), found, roles)
    new.setdefault('cars', [])
    configure.write(new)
    got = {c['name'] for c in found}
    return {'saved': len(new['cams']), 'missing': [c['name'] for c, _, ok in a['plan'] if ok and c['name'] not in got],
            'userDropped': dropped}


def protect_cancel(srv, tok, body):
    if tok in srv.admin:
        logout(srv.admin.pop(tok))
    return {}


def protect_user(srv, tok, body):
    """the optional runtime user (detections, clips), checked with one login, stored in cams.json; empty: removed"""
    conf = configure.load()
    p = dict(conf.get('protect') or {})
    if not p.get('host'):
        raise Refused('sign in to Protect with the admin first')
    user, pw = body.get('username', ''), body.get('password', '')
    if not isinstance(user, str) or not isinstance(pw, str):
        raise Refused('bad user')
    if user:
        if not pw:
            raise Refused('enter that user\'s password')
        p.update(username=user, password=pw)
        logout({'host': p['host'], 's': serve.login({'protect': p}, save=False)})
    else:
        p.pop('username', None); p.pop('password', None)
    try:
        os.unlink(serve.session_path())                 # the old user's session: the services log in afresh
    except OSError:
        pass
    configure.write(dict(conf, protect=p))
    return {'user': user}


def cams_save(srv, tok, body):
    """labels and roles"""
    conf = configure.load()
    names = [c['name'] for c in conf.get('cams', [])]
    labels, roles = body.get('labels') or {}, body.get('roles') or {}
    if not isinstance(labels, dict) or not isinstance(roles, dict):
        raise Refused('bad request')
    for r, n in roles.items():
        if r not in serve.ROLES or n not in names + ['']:
            raise Refused('no camera named %r' % n)
    cams = []
    for c in conf.get('cams', []):
        c = dict(c, roles=[r for r in serve.ROLES if roles.get(r, '') == c['name']] if roles else c.get('roles', []))
        if c['name'] in labels:
            c['label'] = text(labels[c['name']], 'a label')
        cams.append(c)
    configure.write(dict(conf, cams=cams))
    return {}


def exits(f, *a):
    """configure.py's checks end with sys.exit(reason): the reason as a 400"""
    try:
        return f(*a)
    except SystemExit as e:
        raise Refused(str(e.code)) from None


def cams_add(srv, tok, body):
    name, url, label = body.get('name'), body.get('url'), body.get('label') or None
    if not all(isinstance(v, str) for v in (name, url)) or label is not None and not isinstance(label, str):
        raise Refused('bad request')
    configure.write(exits(configure.add_rtsp, configure.load(), name.strip(), url.strip(), label and label.strip()))
    return {}


def cams_remove(srv, tok, body):
    configure.write(exits(configure.remove_cam, configure.load(), body.get('name')))
    return {}


def cars_add(srv, tok, body):
    h = body.get('h')
    if not isinstance(h, str) or not re.fullmatch(r'[0-9a-f]{64}', h):
        raise Refused('this is not a car\'s QR code: scan it again')
    conf = configure.load()
    configure.write(dict(conf, cars=configure.car_entries(conf) + ['sha256:' + h]))
    return {}


def cars_remove(srv, tok, body):
    conf = configure.load()
    have = configure.car_entries(conf)
    hit = [x for x in have if isinstance(body.get('id'), str) and len(body['id']) >= 8 and x[7:].startswith(body['id'])]
    if len(hit) != 1:
        raise Refused('no such car')
    have.remove(hit[0])
    configure.write(dict(conf, cars=have))
    return {}


def done(srv, tok, body):
    srv.quit()
    return {}


ROUTES = {'/api/state': state, '/api/protect/scan': protect_scan, '/api/protect/apply': protect_apply,
          '/api/protect/cancel': protect_cancel, '/api/protect/user': protect_user, '/api/cams': cams_save,
          '/api/cams/add': cams_add, '/api/cams/remove': cams_remove, '/api/cars/add': cars_add,
          '/api/cars/remove': cars_remove, '/api/done': done}


# ---- the server ----------------------------------------------------------------------------------------------------

class Setup(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, ctx, code, idle=IDLE_S, max_s=MAX_S):
        self.address_family = socket.AF_INET6 if ':' in addr[0] else socket.AF_INET
        super().__init__(addr, H)
        self.ctx, self.code, self.idle, self.max_s = ctx, code, idle, max_s
        self.sessions, self.admin, self.wrong = set(), {}, 0
        self.lock = threading.Lock()
        self.started = self.seen = time.monotonic()
        self.stopping = False

    def verify_request(self, request, client_address):
        return peer_ok(client_address[0])               # before TLS: an outside peer gets nothing at all

    def handle_error(self, request, client_address):
        pass                                            # an aborted handshake (the browser's certificate warning)

    def quit(self):
        if not self.stopping:
            self.stopping = True
            threading.Thread(target=self.shutdown, daemon=True).start()

    def watchdog(self):
        while not self.stopping:
            time.sleep(min(1, self.idle / 4))
            now = time.monotonic()
            if now - self.seen > self.idle or now - self.started > self.max_s:
                self.quit()


class H(http.server.BaseHTTPRequestHandler):
    timeout = 10                                        # a half-sent request does not keep its thread
    server_version, sys_version = 'RideWatch', ''

    def setup(self):
        self.request.settimeout(self.timeout)
        if self.server.ctx:                             # the handshake in this thread: a silent client blocks nobody
            self.request = self.server.ctx.wrap_socket(self.request, server_side=True)
        super().setup()

    def log_message(self, *a):
        pass                                            # nothing per request: no path, no header ever logged

    def end_headers(self):
        for k, v in HEADERS:
            self.send_header(k, v)
        super().end_headers()

    def reply(self, st, body, ctype='application/json'):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(st)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def gate(self):
        if not host_ok(self.headers.get('Host', ''), self.connection.getsockname()[0], self.server.server_address[1]):
            self.close_connection = True
            self.reply(403, {'error': 'open this page by the address printed in the terminal'}); return False
        return True

    def token(self):
        t = self.headers.get('X-Setup', '').encode()
        s = next((s for s in list(self.server.sessions) if secrets.compare_digest(t, s.encode())), None)
        if s:
            # only a session (or the right code) keeps the page alive, not a GET of the page: anyone on the LAN can
            # fetch that, and an open page does not poll, so the idle time counts from the last real use
            self.server.seen = time.monotonic()
        return s

    def do_GET(self):
        if not self.gate():
            return
        path = self.path.split('?')[0]
        if path in ('/', '/pair'):
            return self.reply(200, PAGE, 'text/html; charset=utf-8')
        if path == '/icon.svg':
            return self.reply(200, FAVICON, 'image/svg+xml')
        if path != '/api/state':
            return self.reply(404, {'error': 'not found'})
        tok = self.token()
        if not tok:
            return self.reply(401, {'error': 'enter the setup code'})
        self.run(state, tok, None)

    def do_POST(self):
        if not self.gate():
            return
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            return self.reply(415, {'error': 'JSON only'})
        try:
            n = int(self.headers.get('Content-Length', ''))
        except ValueError:
            self.close_connection = True
            return self.reply(411, {'error': 'length required'})
        if not 0 <= n <= BODY_MAX:
            self.close_connection = True
            return self.reply(413, {'error': 'too large'})
        try:
            body = json.loads(self.rfile.read(n))
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self.reply(400, {'error': 'bad JSON'})
        if self.path == '/api/code':
            return self.code(body)
        tok = self.token()
        if not tok:
            return self.reply(401, {'error': 'enter the setup code'})
        route = ROUTES.get(self.path)
        if not route:
            return self.reply(404, {'error': 'not found'})
        self.run(route, tok, body)

    def run(self, route, tok, body):
        with self.server.lock:
            try:
                self.reply(200, route(self.server, tok, body))
            except Refused as e:
                self.reply(400, {'error': str(e)})
            except serve.ProtectError as e:
                sys.stderr.write('protect: %s\n' % e.args[1])
                self.reply(502, {'error': protect_words(e)})
            except Exception as e:                      # a bug: said, not a dropped connection (the type only: no data)
                sys.stderr.write('setup page: %s on %s\n' % (type(e).__name__, self.path))
                self.reply(500, {'error': 'the server failed (%s); see the terminal' % type(e).__name__})

    def code(self, body):
        with self.server.lock:
            if self.server.stopping:
                return self.reply(403, {'error': 'stopped'})
            if secrets.compare_digest(norm_code(body.get('code', '')).encode(), self.server.code.encode()):
                t = secrets.token_urlsafe(24)
                self.server.sessions.add(t); self.server.seen = time.monotonic()
                return self.reply(200, {'token': t})
            self.server.wrong += 1
            left = TRIES - self.server.wrong
            if left > 0:
                return self.reply(403, {'error': 'Wrong code. %d %s left.' % (left, 'try' if left == 1 else 'tries'), 'left': left})
            sys.stderr.write('%d wrong setup codes: stopped\n' % TRIES)
            self.reply(403, {'error': 'Too many wrong codes: the page has stopped. Run ridewatch-setup again.', 'left': 0})
            self.server.quit()


def serve_page(srv):
    threading.Thread(target=srv.watchdog, daemon=True).start()
    try:
        srv.serve_forever(poll_interval=0.2)
    finally:
        with srv.lock:
            for a in list(srv.admin.values()):
                logout(a)
            srv.admin.clear()
        srv.server_close()


def run_page(srv):
    """serve_page; SIGTERM and SIGHUP (the ssh window closed) take Done's way out, so the admin is signed out of Protect
    (SIGKILL cannot be caught: that session expires by itself)"""
    old = {n: signal.signal(n, lambda *a: srv.quit()) for n in (signal.SIGTERM, signal.SIGHUP)}
    try:
        serve_page(srv)
    except KeyboardInterrupt:
        pass
    finally:
        for n, h in old.items():
            signal.signal(n, h)


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description='RideWatch setup page (see the top of this file)')
    ap.add_argument('--bind', default='0.0.0.0')
    ap.add_argument('--port', type=int, default=PORT)
    ap.add_argument('--cert', default=os.path.join(serve.STATE, 'setup-cert.pem'))
    ap.add_argument('--key', default=os.path.join(serve.STATE, 'setup-key.pem'))
    o = ap.parse_args(argv)
    if os.geteuid() == 0:
        sys.exit('setup_web.py never runs as root: use sudo ridewatch-setup (it runs this as the service user)')
    if not os.path.exists(o.cert) or not os.path.exists(o.key):
        sys.exit('no certificate at %s: install.sh makes one with openssl (install openssl, run install.sh again).\n'
                 'Without it, set up in the terminal: sudo python3 /opt/jap-ridewatch/configure.py' % o.cert)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(o.cert, o.key)
    srv = Setup((o.bind, o.port), ctx, new_code())
    host = lan_ip() if o.bind in ('0.0.0.0', '::') else o.bind
    print('RideWatch setup page:  https://%s:%d/' % ('[%s]' % host if ':' in host else host, o.port))
    print('Setup code:            %s-%s' % (srv.code[:4], srv.code[4:]))
    print('Certificate SHA-256:   %s' % fingerprint(o.cert))
    print('Your browser will warn that the certificate is not trusted: the server made it itself. Compare the')
    print('fingerprint above with the one the browser shows, then continue. The page stops after 15 minutes without')
    print('use, 60 minutes in all, or when you press Done. Ctrl-C stops it now.')
    sys.stdout.flush()
    run_page(srv)
    print('Setup page closed.')


# ---- the page (static; script and style allowed by their hashes) ---------------------------------------------------

STYLE = r'''
:root{--bg:#0d1014;--card:#151a21;--line:#232b36;--text:#e9edf2;--dim:#93a0b0;--accent:#f2a33a;--ok:#5cc28b;--bad:#ef6a5e;
color-scheme:dark;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Ubuntu,Roboto,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}
main{max-width:720px;margin:0 auto;padding:28px 16px 64px}
header{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.logo{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#f6b44f,#e0832a);display:grid;place-items:center}
.logo svg{width:24px;height:24px}
h1{font-size:21px;margin:0;letter-spacing:.2px}h1 small{display:block;font-size:13px;font-weight:400;color:var(--dim)}
h2{font-size:17px;margin:0 0 4px}p{margin:6px 0}.dim{color:var(--dim);font-size:14px}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin:14px 0}
label{display:block;font-size:13px;color:var(--dim);margin:12px 0 4px}
input,select{width:100%;font:inherit;color:var(--text);background:#0f1318;border:1px solid var(--line);border-radius:10px;padding:10px 12px}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1 1 180px}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:11px 18px;margin-top:16px;cursor:pointer;background:var(--accent);color:#1b1206}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
button.link{background:none;color:var(--dim);padding:4px 8px;margin:0;font-weight:500}
button:disabled{opacity:.55;cursor:default}
.code{font:600 28px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px;text-align:center;text-transform:uppercase;padding:14px}
.msg{margin-top:12px;font-size:14px;min-height:1px}.msg.bad{color:var(--bad)}.msg.ok{color:var(--ok)}
ul{list-style:none;margin:12px 0 0;padding:0}
li{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}
li .grow{flex:1;min-width:0}li .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li input{padding:7px 10px}
.chip{font-size:12px;font-weight:600;border-radius:99px;padding:3px 9px;white-space:nowrap;background:#222a35;color:var(--dim)}
.chip.ok{background:rgba(92,194,139,.14);color:var(--ok)}.chip.do{background:rgba(242,163,58,.15);color:var(--accent)}
.chip.bad{background:rgba(239,106,94,.14);color:var(--bad)}
.summary{background:#0f1318;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:14px;font-size:15px}
.roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0 10px}
details summary{cursor:pointer;color:var(--dim);font-size:14px;margin-top:14px}
.big{font-size:22px;font-weight:700;margin:4px 0 2px}
.hidden{display:none}footer{text-align:center;margin-top:20px}
.pairbox{text-align:center;padding:28px 20px}.pairbox .car{font:700 34px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:3px;margin:10px 0}
'''

SCRIPT = r'''
"use strict";
const $ = s => document.querySelector(s);
let token = "";
const pair = location.pathname === "/pair";
const frag = new URLSearchParams(location.hash.slice(1));
const want = frag.get("h") || "";
const fp = h => h.slice(0, 4).toUpperCase() + " " + h.slice(4, 6).toUpperCase();

function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; }
function msg(sel, t, kind) { const m = $(sel); m.textContent = t || ""; m.className = "msg" + (kind ? " " + kind : ""); }
async function api(path, body) {
  const o = body === undefined ? {headers: {"X-Setup": token}}
    : {method: "POST", headers: {"X-Setup": token, "Content-Type": "application/json"}, body: JSON.stringify(body)};
  let r;
  try { r = await fetch(path, o); } catch (e) { throw new Error("The setup page has stopped. Run sudo ridewatch-setup again."); }
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) { const e = new Error(j.error || ("Error " + r.status)); e.left = j.left; throw e; }
  return j;
}
async function busy(btn, label, fn) {
  const was = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = was; }
}
function show(id) { for (const s of document.querySelectorAll("[data-screen]")) s.classList.toggle("hidden", s.id !== id && !(id === "main" && s.dataset.screen === "main")); }

$("#codeform").addEventListener("submit", async ev => {
  ev.preventDefault();
  const btn = $("#codeform button");
  try {
    const j = await busy(btn, "Checking…", () => api("/api/code", {code: $("#code").value}));
    token = j.token; msg("#codemsg", "");
    if (pair) showPair(); else { show("main"); refresh(); }
  } catch (e) { msg("#codemsg", e.message, "bad"); if (e.left === 0) btn.disabled = true; }
});

function showPair() {
  if (!/^[0-9a-f]{64}$/.test(want)) { show("pairbad"); return; }
  $("#carn").textContent = fp(want); show("pair");
}
$("#pairyes").addEventListener("click", ev => busy(ev.target, "Adding…", async () => {
  try { await api("/api/cars/add", {h: want}); show("paired"); } catch (e) { msg("#pairmsg", e.message, "bad"); }
}));
$("#pairno").addEventListener("click", () => { show("notadded"); });

let st = null;
async function refresh() {
  try { st = await api("/api/state"); } catch (e) { msg("#protectmsg", e.message, "bad"); return; }
  if (!$("#host").value) $("#host").value = st.protect.host;
  $("#ruser").value = st.protect.user;
  $("#rstate").textContent = st.protect.user ? "Stored: " + st.protect.user : "None stored: live views only, no detections or clips.";
  drawCams(); drawCars();
}

$("#protectform").addEventListener("submit", ev => {
  ev.preventDefault();
  busy($("#protectform button"), "Signing in…", async () => {
    msg("#protectmsg", "");
    try {
      const j = await api("/api/protect/scan", {host: $("#host").value.trim(), username: $("#user").value, password: $("#pass").value});
      $("#pass").value = "";
      drawPlan(j.cams);
    } catch (e) { $("#pass").value = ""; msg("#protectmsg", e.message, "bad"); }
  });
});
function drawPlan(cams) {
  const ul = $("#plan"); ul.textContent = "";
  let n = 0, k = 0;
  for (const c of cams) {
    const li = el("li"), g = el("div", "grow");
    g.append(el("div", "name", c.name), el("div", "dim", c.doorbell ? "Doorbell" : "Camera"));
    let chip;
    if (!c.usable) chip = el("span", "chip bad", "No channel to use");
    else if (c.turnOn.length) { chip = el("span", "chip do", "Turn on RTSPS: " + c.turnOn.join(", ")); n += c.turnOn.length; k++; }
    else chip = el("span", "chip ok", "Ready");
    li.append(g, chip); ul.append(li);
  }
  $("#plansum").textContent = n
    ? "RideWatch will turn on RTSPS for " + n + " channel" + (n > 1 ? "s" : "") + " on " + k + " camera" + (k > 1 ? "s" : "") + " (never the main, full-resolution one). Nothing else changes in Protect. Then it signs out."
    : "Nothing to change in Protect: every camera is ready. Saving signs out.";
  $("#protectform").classList.add("hidden"); $("#planbox").classList.remove("hidden");
}
$("#apply").addEventListener("click", ev => busy(ev.target, "Applying…", async () => {
  try {
    const j = await api("/api/protect/apply", {});
    $("#planbox").classList.add("hidden"); $("#protectform").classList.remove("hidden");
    msg("#protectmsg", "Done. Signed out of Protect. " + j.saved + " camera" + (j.saved === 1 ? "" : "s") + " saved." + (j.missing.length ? " Not shown (no RTSPS channel): " + j.missing.join(", ") + "." : "")
      + (j.userDropped ? " The View Only user was for the old address: enter it again below." : ""), "ok");
    refresh();
  } catch (e) { msg("#planmsg", e.message, "bad"); }
}));
$("#cancel").addEventListener("click", async () => {
  try { await api("/api/protect/cancel", {}); } catch (e) {}
  $("#planbox").classList.add("hidden"); $("#protectform").classList.remove("hidden"); msg("#protectmsg", "Signed out. Nothing changed.");
});
$("#rform").addEventListener("submit", ev => {
  ev.preventDefault();
  busy($("#rform button"), "Checking…", async () => {
    try { await api("/api/protect/user", {username: $("#ruser").value.trim(), password: $("#rpass").value}); $("#rpass").value = ""; msg("#rmsg", "Saved.", "ok"); refresh(); }
    catch (e) { $("#rpass").value = ""; msg("#rmsg", e.message, "bad"); }
  });
});

function drawCams() {
  const ul = $("#cams"); ul.textContent = "";
  $("#nocams").classList.toggle("hidden", st.cams.length > 0);
  for (const c of st.cams) {
    const li = el("li"), g = el("div", "grow"), inp = el("input");
    inp.value = c.label; inp.dataset.name = c.name; inp.setAttribute("aria-label", "Label of " + c.name);
    g.append(inp, el("div", "dim", (c.kind === "rtsp" ? "RTSP camera" : "Protect") + " · " + c.size + (c.label !== c.name ? " · " + c.name : "")));
    const rm = el("button", "link", "Remove"); rm.type = "button";
    rm.addEventListener("click", () => busy(rm, "…", async () => {
      try { await api("/api/cams/remove", {name: c.name}); refresh(); } catch (e) { msg("#camsmsg", e.message, "bad"); }
    }));
    if (c.roles.length) li.append(g, el("span", "chip do", c.roles.join(", ")), rm); else li.append(g, rm);
    ul.append(li);
  }
  const box = $("#roles"); box.textContent = "";
  const words = {door: "Door (a ring takes over)", garage: "Garage (hidden at home)", day: "Default by day", night: "Default at night"};
  for (const r of st.roles) {
    const w = el("div"), lab = el("label", "", words[r] || r), sel = el("select");
    sel.dataset.role = r; sel.id = "role-" + r; lab.htmlFor = sel.id;
    sel.append(new Option("None", ""));
    for (const c of st.cams) { const o = new Option(c.label, c.name); o.selected = c.roles.includes(r); sel.append(o); }
    w.append(lab, sel); box.append(w);
  }
  $("#savecams").classList.toggle("hidden", !st.cams.length); box.classList.toggle("hidden", !st.cams.length);
}
$("#savecams").addEventListener("click", ev => busy(ev.target, "Saving…", async () => {
  const labels = {}, roles = {};
  for (const i of document.querySelectorAll("#cams input")) labels[i.dataset.name] = i.value.trim();
  for (const s of document.querySelectorAll("#roles select")) roles[s.dataset.role] = s.value;
  try { await api("/api/cams", {labels, roles}); msg("#camsmsg", "Saved.", "ok"); refresh(); } catch (e) { msg("#camsmsg", e.message, "bad"); }
}));
$("#addform").addEventListener("submit", ev => {
  ev.preventDefault();
  busy($("#addform button"), "Checking the camera…", async () => {
    try {
      await api("/api/cams/add", {name: $("#aname").value.trim(), url: $("#aurl").value.trim(), label: $("#alabel").value.trim()});
      msg("#addmsg", "Added: " + $("#aname").value.trim() + ".", "ok"); $("#aurl").value = ""; $("#aname").value = ""; $("#alabel").value = ""; refresh();
    } catch (e) { msg("#addmsg", e.message, "bad"); }
  });
});

function drawCars() {
  const ul = $("#cars"); ul.textContent = "";
  $("#nocars").classList.toggle("hidden", st.cars.length > 0);
  st.cars.forEach((id, k) => {
    const li = el("li"), g = el("div", "grow"), rm = el("button", "link", "Remove"); rm.type = "button";
    g.append(el("div", "name", "Car " + (k + 1)), el("div", "dim", "key " + id + "…"));
    rm.addEventListener("click", () => busy(rm, "…", async () => {
      try { await api("/api/cars/remove", {id}); refresh(); } catch (e) { msg("#carsmsg", e.message, "bad"); }
    }));
    li.append(g, rm); ul.append(li);
  });
}
$("#done").addEventListener("click", async ev => {
  ev.target.disabled = true;
  try { await api("/api/done", {}); } catch (e) {}
  show("closed");
});
if (pair) { $("#codetitle").textContent = "Add a car"; $("#codehelp").textContent = "Enter the setup code printed in the terminal where ridewatch-setup runs, then confirm the car."; }
show("lock"); $("#code").focus();
'''

ICON = ('<svg viewBox="0 0 24 24" fill="none" stroke="#1b1206" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
        'aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>')

BODY = '''<main>
<header><div class="logo">%s</div><h1>RideWatch setup<small>Served by your RideWatch server, on your network only</small></h1></header>

<section id="lock" data-screen="lock">
 <h2 id="codetitle">Enter the setup code</h2>
 <p class="dim" id="codehelp">It is printed in the terminal where you ran <b>sudo ridewatch-setup</b>, with this page's address.</p>
 <form id="codeform" autocomplete="off"><label for="code">Setup code</label>
  <input id="code" class="code" maxlength="9" placeholder="XXXX-XXXX" autocapitalize="characters" spellcheck="false" required>
  <button type="submit">Continue</button><div id="codemsg" class="msg"></div></form>
</section>

<section id="pair" data-screen="pair" class="hidden pairbox">
 <p class="dim">A car asks to see your cameras</p><div class="big">Add this car?</div><p>Check the car shows</p>
 <div class="car" id="carn"></div><p class="dim">under its QR code. Not the same: Cancel.</p>
 <div class="row"><button id="pairyes" type="button">Add this car</button><button id="pairno" type="button" class="ghost">Cancel</button></div>
 <div id="pairmsg" class="msg"></div>
</section>
<section id="paired" data-screen="paired" class="hidden pairbox">
 <div class="big">Car added</div><p class="dim">It gets in on its next try, within a few seconds. You can close this page.</p>
</section>
<section id="notadded" data-screen="notadded" class="hidden pairbox"><div class="big">Not added</div><p class="dim">Nothing changed.</p></section>
<section id="pairbad" data-screen="pairbad" class="hidden pairbox">
 <div class="big">This link is incomplete</div><p class="dim">Scan the QR code on the car's screen again.</p>
</section>
<section id="closed" data-screen="closed" class="hidden pairbox">
 <div class="big">Setup page stopped</div><p class="dim">Run <b>sudo ridewatch-setup</b> to open it again.</p>
</section>

<section data-screen="main" class="hidden">
 <h2>UniFi Protect</h2>
 <p class="dim">Sign in once with a <b>local</b> Protect admin (not a ui.com account with two-step login). The password is used
 for this one sign-in and is not stored.</p>
 <form id="protectform" autocomplete="off">
  <label for="host">Console address</label><input id="host" placeholder="192.0.2.1" inputmode="url" spellcheck="false" required>
  <div class="row"><div><label for="user">Admin user</label><input id="user" autocomplete="off" spellcheck="false" required></div>
   <div><label for="pass">Password</label><input id="pass" type="password" autocomplete="off" required></div></div>
  <button type="submit">Find my cameras</button><div id="protectmsg" class="msg"></div>
 </form>
 <div id="planbox" class="hidden"><ul id="plan"></ul><div id="plansum" class="summary"></div>
  <div class="row"><button id="apply" type="button">Apply and sign out</button><button id="cancel" type="button" class="ghost">Cancel</button></div>
  <div id="planmsg" class="msg"></div></div>
 <details><summary>Detections and clips (optional)</summary>
  <p class="dim">A Protect user with the View Only role, stored on the server (readable by RideWatch only), lets the car show
  what happened and play clips. <span id="rstate"></span></p>
  <form id="rform" autocomplete="off"><div class="row"><div><label for="ruser">View Only user (empty: remove)</label><input id="ruser" spellcheck="false"></div>
   <div><label for="rpass">Password</label><input id="rpass" type="password" autocomplete="new-password"></div></div>
   <button type="submit" class="ghost">Save user</button><div id="rmsg" class="msg"></div></form>
 </details>
</section>

<section data-screen="main" class="hidden">
 <h2>Cameras</h2><p class="dim">The car shows them in this order. Labels are what the car shows.</p>
 <p id="nocams" class="dim hidden">No camera yet: sign in to Protect above, or add one below.</p>
 <ul id="cams"></ul><div class="roles" id="roles"></div>
 <button id="savecams" type="button" class="ghost">Save labels and roles</button><div id="camsmsg" class="msg"></div>
 <details><summary>Add a camera by its RTSP address</summary>
  <form id="addform" autocomplete="off">
   <div class="row"><div><label for="aname">Name</label><input id="aname" maxlength="64" required></div>
    <div><label for="alabel">Label (optional)</label><input id="alabel" maxlength="64"></div></div>
   <label for="aurl">RTSP address</label><input id="aurl" placeholder="rtsp://user:password@192.0.2.20:554/stream1" spellcheck="false" required>
   <p class="dim">The server opens it once to check it (up to 15 s). It is stored with its password: use a camera-only
   account. Live view only: no detections or clips for these.</p>
   <button type="submit" class="ghost">Add camera</button><div id="addmsg" class="msg"></div></form>
 </details>
</section>

<section data-screen="main" class="hidden">
 <h2>Cars</h2>
 <p class="dim">To add a car, open RideWatch in it: while this server does not know the car, it shows a QR code. Scan it
 with your phone and confirm. Only a hash of the car's code is stored.</p>
 <p id="nocars" class="dim hidden">No car yet.</p><ul id="cars"></ul><div id="carsmsg" class="msg"></div>
</section>

<footer data-screen="main" class="hidden"><button id="done" type="button" class="ghost">Done: stop this page</button>
 <p class="dim">The page also stops by itself after 15 minutes without use.</p></footer>
</main>''' % ICON


FAVICON = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#f2a33a"/>'
           '<g transform="translate(4 4)">%s</g></svg>' % ICON.replace('<svg viewBox="0 0 24 24"', '<svg width="24" height="24" viewBox="0 0 24 24"')).encode()


def sha(s):
    return "'sha256-%s'" % base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()


CSP = ("default-src 'self'; script-src %s; style-src %s; img-src 'self'; base-uri 'none'; form-action 'none'; "
       "frame-ancestors 'none'" % (sha(SCRIPT), sha(STYLE)))
HEADERS = [('Content-Security-Policy', CSP), ('Cache-Control', 'no-store'), ('Referrer-Policy', 'no-referrer'),
           ('X-Content-Type-Options', 'nosniff'), ('X-Frame-Options', 'DENY')]
PAGE = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,'
        'initial-scale=1"><meta name="referrer" content="no-referrer"><link rel="icon" href="/icon.svg"><title>RideWatch setup</title><style>%s</style>'
        '</head><body>%s<script>%s</script></body></html>' % (STYLE, BODY, SCRIPT)).encode()


# ---- selftest --------------------------------------------------------------------------------------------------------

def selftest():
    import contextlib, io, shutil, subprocess, tempfile
    for a in ('10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1', '127.0.0.1', '::1', 'fd00::1', 'fe80::1%eth0',
              '::ffff:192.168.1.2'):
        assert peer_ok(a), a
    for a in ('100.64.0.1', '100.100.100.100', '172.32.0.1', '8.8.8.8', '192.0.2.1', '169.254.1.1', '2001:db8::1',
              '::ffff:8.8.8.8', '0.0.0.0', 'junk', ''):
        assert not peer_ok(a), a
    assert host_ok('192.0.2.5:18642', '192.0.2.5', 18642) and host_ok('192.0.2.5:18642', '::ffff:192.0.2.5', 18642)
    assert host_ok('[2001:db8::5]:18642', '2001:db8::5', 18642)
    for h in ('192.0.2.5', '192.0.2.5:80', 'evil.example:18642', 'localhost:18642', '192.0.2.6:18642', '', '192.0.2.5:18642 '):
        assert not host_ok(h, '192.0.2.5', 18642), h
    assert len(ALPHABET) == len(set(ALPHABET)) == 32 and not set('ILOU') & set(ALPHABET), '8 symbols = 40 bits'
    codes = {new_code() for _ in range(200)}
    assert len(codes) == 200 and all(len(c) == 8 and set(c) <= set(ALPHABET) for c in codes)
    assert norm_code(' abcd-ef0h ') == 'ABCDEF0H' and norm_code('OIL0') == '0110'
    assert sha(SCRIPT)[8:-1] in CSP and sha(STYLE)[8:-1] in CSP and 'unsafe' not in CSP and "frame-ancestors 'none'" in CSP
    assert PAGE.count(b'<script>') == 1 and PAGE.count(b'<style>') == 1 and b' style=' not in PAGE and b' on' + b'click' not in PAGE
    assert SCRIPT.encode() in PAGE and STYLE.encode() in PAGE, 'the hashes cover the bytes served'
    line = next(l for l in SCRIPT.splitlines() if l.startswith('const fp = '))
    assert 'frag.get("n")' not in SCRIPT and b'Check the car shows' in PAGE, 'the check is the hash\'s fingerprint, no code bits'
    if shutil.which('node'):                           # the page's fingerprint = the daemon's (ridewatchd_test.js: "2356 32")
        r = subprocess.run(['node', '-e', line + '; process.stdout.write(fp(%r))' % serve.digest('ABCD-EFGH-JKLM-NPQR')],
                           capture_output=True, text=True)
        assert r.stdout == '2356 32', r
    raw = json.loads(json.dumps(serve.CAMERAS))
    plan = rtsp_plan(raw)
    assert [(c['name'], ids, ok) for c, ids, ok in plan] == [('Door', [1], True), ('Garage', [], True), ('Shed', [], False)], plan
    assert rtsp_plan([{'id': 'x', 'name': 'Main only', 'channels': [{'id': 0, 'width': 1920, 'height': 1080, 'isRtspEnabled': False}]}])[0][1] == [0]
    assert rtsp_plan([{'id': '../x', 'name': 'bad id', 'channels': []}, 'junk']) == [] and rtsp_plan(None) == []
    d = tempfile.mkdtemp()
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            run_selftest(d, raw)
    finally:
        os.environ.pop('JAP_RIDEWATCH_PROTECT_URL', None)
        shutil.rmtree(d, ignore_errors=True)
    assert 'Adm1n-pw' not in out.getvalue() + err.getvalue() and 'v13w-pw' not in out.getvalue() + err.getvalue(), 'no password printed'
    print('setup page selftest ok')
    if shutil.which('openssl'):
        tls_selftest(subprocess)
    else:
        print('setup page TLS selftest skipped (no openssl)')
    print('selftest ok')


def fake_protect(raw, P):
    """a fake Protect console: a login (the admin and the View Only user), the camera list, PATCH (RTSP on gives an
    alias), logout"""
    import http.client
    users = {'admin': 'Adm1n-pw', 'viewer': 'v13w-pw'}

    class F(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, st, body=b'{}', hdr=()):
            self.send_response(st)
            for k, v in hdr:
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

        def ok(self):
            return self.headers.get('Cookie') in P['live'] and self.headers.get('X-CSRF-Token') == 'c'

        def do_POST(self):
            b = json.loads(self.rfile.read(int(self.headers['Content-Length'])) or b'{}')
            if self.path == '/api/auth/logout':
                P['live'].discard(self.headers.get('Cookie')); P['logouts'] += 1; return self.reply(200)
            if users.get(b.get('username')) != b.get('password'):
                return self.reply(401)
            t = 'TOKEN=%s-%d' % (b['username'], len(P['live']) + P['logouts'])
            P['live'].add(t); P['logins'].append(b['username'])
            self.reply(200, b'{}', [('Set-Cookie', t + '; path=/'), ('X-CSRF-Token', 'c')])

        def do_GET(self):
            if not self.ok():
                return self.reply(401)
            self.reply(200, json.dumps(raw).encode() if self.path == '/proxy/protect/api/cameras' else b'{}')

        def do_PATCH(self):
            b = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if not self.ok() or 'admin' not in self.headers.get('Cookie'):
                return self.reply(403)
            cid = self.path.rsplit('/', 1)[1]
            cam = next(c for c in raw if isinstance(c, dict) and c.get('id') == cid)
            P['patched'].append((cid, b))
            for ch, new in zip(cam['channels'], b['channels']):
                if new.get('isRtspEnabled') and not ch.get('isRtspEnabled'):
                    ch.update(isRtspEnabled=True, rtspAlias='new%s%d' % (cid, ch['id']))
            self.reply(200)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), F)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, http.client


def run_selftest(d, raw):
    """the page over HTTP on 127.0.0.1 against the fake Protect: every guard, then the whole flow"""
    import http.client, subprocess
    P = {'live': set(), 'logins': [], 'logouts': 0, 'patched': []}
    fake, _ = fake_protect(raw, P)
    os.environ['JAP_RIDEWATCH_PROTECT_URL'] = 'http://127.0.0.1:%d' % fake.server_address[1]
    configure.CONF = os.path.join(d, 'cams.json'); serve.STATE = d
    configure.write({'cars': ['AAAA-BBBB-CCCC-DDDD'], 'cams': [{'name': 'Gate', 'label': 'Gate', 'kind': 'rtsp', 'roles': [],
                    'channels': [{'id': 0, 'w': 1920, 'h': 1080, 'fps': 25, 'url': 'rtsp://u:%s@192.0.2.10/live' % serve.PW}]}]})
    srv = Setup(('127.0.0.1', 0), None, 'ABCD2345')
    t = threading.Thread(target=serve_page, args=(srv,), daemon=True); t.start()
    port = srv.server_address[1]
    host = '127.0.0.1:%d' % port

    def req(method, path, body=None, hdr=None, raw_body=None):
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
        h = {'Host': host}
        if body is not None:
            h['Content-Type'] = 'application/json'
        h.update(hdr or {})
        c.request(method, path, raw_body if raw_body is not None else None if body is None else json.dumps(body), h)
        r = c.getresponse(); b = r.read(); c.close()
        return r.status, dict(r.getheaders()), b
    api = lambda path, body=None, tok=None: req('POST' if body is not None else 'GET', path, body, {'X-Setup': tok} if tok else {})
    st, h, b = req('GET', '/')
    assert st == 200 and b == PAGE and h['Content-Security-Policy'] == CSP and h['Cache-Control'] == 'no-store', h
    assert h['Referrer-Policy'] == 'no-referrer' and not [k for k in h if k.lower().startswith('access-control') or k.lower() == 'set-cookie']
    assert req('GET', '/pair')[2] == PAGE and req('GET', '/icon.svg')[2] == FAVICON
    for bad in ('evil.example:%d' % port, 'localhost:%d' % port, '127.0.0.1', '127.0.0.1:1'):
        assert req('GET', '/', hdr={'Host': bad})[0] == 403, bad
    st, h, _ = req('OPTIONS', '/api/cars/add', hdr={'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'POST'})
    assert st == 501 and not [k for k in h if k.lower().startswith('access-control')], 'no CORS preflight answer'
    assert api('/api/state')[0] == 401 and req('GET', '/api/state', hdr={'Cookie': 'X-Setup=x'})[0] == 401, 'no cookie auth'
    assert req('POST', '/api/code', raw_body='{"code":"ABCD2345"}', hdr={'Content-Type': 'text/plain'})[0] == 415, 'a form post is refused'
    assert req('POST', '/api/code', raw_body='x' * (BODY_MAX + 1), hdr={'Content-Type': 'application/json'})[0] == 413
    assert req('POST', '/api/code', raw_body='[1]', hdr={'Content-Type': 'application/json'})[0] == 400
    for left in (4, 3):
        st, _, b = api('/api/code', {'code': 'WRONG000'})
        assert st == 403 and json.loads(b)['left'] == left, b
    st, _, b = api('/api/code', {'code': 'abcd-2345'})
    tok = json.loads(b)['token']
    assert st == 200 and len(tok) >= 32
    assert api('/api/cars/add', {'h': 'a' * 64})[0] == 401 and api('/api/cars/add', {'h': 'a' * 64}, 'x' + tok)[0] == 401
    assert req('POST', '/api/cars/add', raw_body='{"h":"%s"}' % ('a' * 64), hdr={'X-Setup': tok, 'Content-Type': 'text/plain'})[0] == 415
    st, _, b = api('/api/state', tok=tok)
    s0 = json.loads(b)
    assert st == 200 and s0['cars'] == [serve.digest('AAAA-BBBB-CCCC-DDDD')[:12]] and serve.PW.encode() not in b and b'192.0.2.10' not in b, b
    assert [c['name'] for c in s0['cams']] == ['Gate'] and s0['protect'] == {'host': '', 'user': ''} and 0 < s0['left'] <= IDLE_S
    # Protect: a refused login, then the admin; the plan; apply; signed out; no session or password on disk
    st, _, b = api('/api/protect/scan', {'host': '192.0.2.1', 'username': 'admin', 'password': 'nope'}, tok)
    assert st == 502 and b'local Protect user' in b, b
    assert api('/api/protect/scan', {'host': 'a/b', 'username': 'admin', 'password': 'x'}, tok)[0] == 400
    assert api('/api/protect/apply', {}, tok)[0] == 400, 'apply needs a sign-in first'
    st, _, b = api('/api/protect/scan', {'host': '192.0.2.1', 'username': 'admin', 'password': 'Adm1n-pw'}, tok)
    j = json.loads(b)
    assert st == 200 and [(c['name'], c['turnOn'], c['usable']) for c in j['cams']] == [('Door', ['Medium'], True), ('Garage', [], True), ('Shed', [], False)], j
    assert b'Adm1n' not in b and not P['patched'] and len(P['live']) == 1, 'nothing changed before apply'
    st, _, b = api('/api/protect/apply', {}, tok)
    assert st == 200 and json.loads(b) == {'saved': 3, 'missing': [], 'userDropped': False}, b
    assert [(cid, [ch.get('isRtspEnabled') for ch in body['channels']]) for cid, body in P['patched']] == [('c0', [True, True, False])], P['patched']
    assert P['patched'][0][1]['channels'][0] == serve.CAMERAS[0]['channels'][0], 'the other channels sent back as they were'
    assert not P['live'] and P['logouts'] == 1, 'signed out'
    conf = json.load(open(configure.CONF))
    assert [c['name'] for c in conf['cams']] == ['Gate', 'Door', 'Garage'] and conf['protect'] == {'host': '192.0.2.1'}, conf
    assert [ch['alias'] for ch in conf['cams'][1]['channels']] == ['dOoR0', 'newc01'] and conf['cams'][1]['roles'] == ['door'], conf['cams'][1]
    assert not os.path.exists(serve.session_path()), 'the admin session never touches the disk'
    for root, _, files in os.walk(d):
        for f in files:
            assert b'Adm1n-pw' not in open(os.path.join(root, f), 'rb').read(), f
    # the runtime user: checked by one login, stored; a wrong one refused
    assert api('/api/protect/user', {'username': 'viewer', 'password': 'bad'}, tok)[0] == 502
    assert api('/api/protect/user', {'username': 'viewer', 'password': 'v13w-pw'}, tok)[0] == 200 and not P['live']
    assert json.load(open(configure.CONF))['protect'] == {'host': '192.0.2.1', 'username': 'viewer', 'password': 'v13w-pw'}
    st, _, b = api('/api/state', tok=tok)
    assert json.loads(b)['protect'] == {'host': '192.0.2.1', 'user': 'viewer'} and b'v13w' not in b
    # the same console again keeps the View Only user; another console drops it and its session (never sent there)
    open(serve.session_path(), 'w').write('{}')
    for h2, kept in (('192.0.2.1', True), ('192.0.2.2', False)):
        assert api('/api/protect/scan', {'host': h2, 'username': 'admin', 'password': 'Adm1n-pw'}, tok)[0] == 200
        st, _, b = api('/api/protect/apply', {}, tok)
        p = json.load(open(configure.CONF))['protect']
        assert st == 200 and json.loads(b)['userDropped'] is not kept and os.path.exists(serve.session_path()) is kept, (h2, b)
        assert p == ({'host': h2, 'username': 'viewer', 'password': 'v13w-pw'} if kept else {'host': h2}), p
    # cameras: labels, roles, add (probe stubbed), remove; reasons from configure.py come back as 400
    assert api('/api/cams', {'labels': {'Door': 'Front door'}, 'roles': {'door': 'Door', 'day': 'Garage', 'night': ''}}, tok)[0] == 200
    cams = json.load(open(configure.CONF))['cams']
    assert cams[1]['label'] == 'Front door' and [c['roles'] for c in cams] == [[], ['door'], ['day']], cams
    assert api('/api/cams', {'labels': {'Door': ' x'}}, tok)[0] == 400 and api('/api/cams', {'roles': {'door': 'Nope'}}, tok)[0] == 400
    probe, serve.probe = serve.probe, lambda u, opts=(): (1280, 720, 25, 0)
    try:
        st, _, b = api('/api/cams/add', {'name': 'Porch', 'url': 'rtsp://cam:%s@192.0.2.12/s' % serve.PW, 'label': ''}, tok)
        assert st == 200, b
        st, _, b = api('/api/cams/add', {'name': 'Bad', 'url': 'file:/etc/passwd'}, tok)
        assert st == 400 and b'cannot be used' in b, b
        assert api('/api/cams/add', {'name': 'Porch', 'url': 'rtsp://192.0.2.13/s'}, tok)[0] == 400, 'one name once'
    finally:
        serve.probe = probe
    st, _, b = api('/api/state', tok=tok)
    assert [c['name'] for c in json.loads(b)['cams']] == ['Gate', 'Door', 'Garage', 'Porch'] and serve.PW.encode() not in b
    assert api('/api/cams/remove', {'name': 'Gate'}, tok)[0] == 200 and api('/api/cams/remove', {'name': 'Gate'}, tok)[0] == 400
    # pairing: the hash from the QR's fragment; the car's next try gets in; the hash alone does not
    code = 'WXYZ-2345-6789-NPQR'
    assert api('/api/cars/add', {'h': 'A' * 64}, tok)[0] == 400 and api('/api/cars/add', {'h': code}, tok)[0] == 400
    env = dict(os.environ, JAP_RIDEWATCH_CONF=configure.CONF, JAP_RIDEWATCH_STATE=d)
    car = lambda line: subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'serve.py')],
                                      input=line.encode() + b'\n', capture_output=True, env=env).stdout
    assert car(code + ' hello') == b'', 'not yet paired'
    assert api('/api/cars/add', {'h': serve.digest(code)}, tok)[0] == 200
    assert json.loads(car(code + ' hello'))['ev'] == 'hello' and car('sha256:%s hello' % serve.digest(code)) == b''
    assert json.loads(car('AAAA-BBBB-CCCC-DDDD hello'))['ev'] == 'hello', 'the older car still gets in'
    conf = json.load(open(configure.CONF))
    assert conf['cars'] == ['sha256:' + serve.digest('AAAA-BBBB-CCCC-DDDD'), 'sha256:' + serve.digest(code)], 'no code on disk'
    assert api('/api/cars/remove', {'id': serve.digest(code)[:12]}, tok)[0] == 200 and car(code + ' hello') == b''
    assert api('/api/cars/remove', {'id': 'abc'}, tok)[0] == 400
    ROUTES['/api/boom'] = lambda *a: 1 // 0
    st, _, b = api('/api/boom', {}, tok)
    assert st == 500 and b'ZeroDivisionError' in b, 'a bug is a 500, the page goes on'
    del ROUTES['/api/boom']
    good = open(configure.CONF).read()
    open(configure.CONF, 'w').write('{not json')
    st, _, b = api('/api/state', tok=tok)
    assert st == 500 and 'error' in json.loads(b), 'a corrupt cams.json: a JSON answer, not a dropped connection'
    open(configure.CONF, 'w').write(good)
    # Cancel signs out and changes nothing; an abandoned plan is signed out when the page stops
    n = len(P['patched'])
    assert api('/api/protect/scan', {'host': '192.0.2.1', 'username': 'admin', 'password': 'Adm1n-pw'}, tok)[0] == 200 and P['live']
    assert api('/api/protect/cancel', {}, tok)[0] == 200 and not P['live'] and len(P['patched']) == n
    assert api('/api/protect/apply', {}, tok)[0] == 400
    assert api('/api/protect/scan', {'host': '192.0.2.1', 'username': 'admin', 'password': 'Adm1n-pw'}, tok)[0] == 200 and P['live']
    assert api('/api/done', {}, tok)[0] == 200
    t.join(5)
    assert not t.is_alive() and not P['live'], 'Done stops the page and signs out'
    # 5 wrong codes stop the page; idle and hard timeouts stop it; an outside peer is refused before TLS
    srv = Setup(('127.0.0.1', 0), None, 'ABCD2345')
    t = threading.Thread(target=serve_page, args=(srv,), daemon=True); t.start()
    port = srv.server_address[1]; host = '127.0.0.1:%d' % port
    for k in range(TRIES):
        st, _, b = api('/api/code', {'code': 'WRONG%03d' % k})
        assert st == 403 and json.loads(b)['left'] == TRIES - 1 - k
    t.join(5)
    assert not t.is_alive(), '5 wrong codes: stopped'
    for idle, max_s in ((0.4, 60), (60, 0.4)):
        srv = Setup(('127.0.0.1', 0), None, 'ABCD2345', idle, max_s)
        t = threading.Thread(target=serve_page, args=(srv,), daemon=True); t.start(); t.join(5)
        assert not t.is_alive(), (idle, max_s)
    # the idle timer: requests without a session do not keep the page alive, a session's do
    srv = Setup(('127.0.0.1', 0), None, 'ABCD2345', 0.8, 60)
    t = threading.Thread(target=serve_page, args=(srv,), daemon=True); t.start()
    port = srv.server_address[1]; host = '127.0.0.1:%d' % port
    t0 = time.monotonic()
    try:
        while t.is_alive() and time.monotonic() - t0 < 3:
            req('GET', '/'); api('/api/state'); time.sleep(0.1)
    except OSError:
        pass
    t.join(3)
    assert not t.is_alive() and time.monotonic() - t0 < 2.5, 'no session: idle'
    srv = Setup(('127.0.0.1', 0), None, 'ABCD2345', 0.8, 60)
    t = threading.Thread(target=serve_page, args=(srv,), daemon=True); t.start()
    port = srv.server_address[1]; host = '127.0.0.1:%d' % port
    tk = json.loads(api('/api/code', {'code': 'ABCD2345'})[2])['token']
    t0 = time.monotonic()
    while time.monotonic() - t0 < 2:
        assert api('/api/state', tok=tk)[0] == 200, 'a session keeps it alive'; time.sleep(0.2)
    t.join(3)
    assert not t.is_alive(), 'then idle'
    # SIGHUP (the ssh window closed) and SIGTERM: the admin signed out as on Done; the handlers given back
    before = [signal.getsignal(n) for n in (signal.SIGHUP, signal.SIGTERM)]
    for sig in (signal.SIGHUP, signal.SIGTERM):
        srv = Setup(('127.0.0.1', 0), None, 'ABCD2345')
        port = srv.server_address[1]; host = '127.0.0.1:%d' % port
        seen = []

        def go(sig=sig):
            tk = json.loads(api('/api/code', {'code': 'ABCD2345'})[2])['token']
            seen.append(api('/api/protect/scan', {'host': '192.0.2.1', 'username': 'admin', 'password': 'Adm1n-pw'}, tk)[0])
            seen.append(bool(P['live']))
            os.kill(os.getpid(), sig)
        threading.Thread(target=go, daemon=True).start()
        guard = threading.Timer(10, srv.quit); guard.start()
        run_page(srv)                                  # here, in the main thread, where Python runs signal handlers
        guard.cancel()
        assert seen == [200, True] and not P['live'], (sig, seen, P['live'])
    assert [signal.getsignal(n) for n in (signal.SIGHUP, signal.SIGTERM)] == before
    srv = Setup(('127.0.0.1', 0), None, 'ABCD2345')
    assert srv.verify_request(None, ('127.0.0.1', 1)) and not srv.verify_request(None, ('100.64.0.1', 1))
    assert not srv.verify_request(None, ('203.0.113.9', 1)); srv.server_close()
    fake.shutdown()


def tls_selftest(subprocess):
    """the real thing over TLS with an openssl certificate: fingerprint, a silent client does not block the page"""
    import tempfile, shutil, http.client
    d = tempfile.mkdtemp()
    try:
        cert, key = os.path.join(d, 'c.pem'), os.path.join(d, 'k.pem')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=RideWatch setup',
                        '-keyout', key, '-out', cert], check=True, capture_output=True)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
        srv = Setup(('127.0.0.1', 0), ctx, 'ABCD2345')
        t = threading.Thread(target=serve_page, args=(srv,), daemon=True); t.start()
        port = srv.server_address[1]
        silent = socket.create_connection(('127.0.0.1', port))       # never says hello
        c = http.client.HTTPSConnection('127.0.0.1', port, timeout=5, context=ssl._create_unverified_context())
        c.connect()
        der = c.sock.getpeercert(binary_form=True)
        c.request('GET', '/', headers={'Host': '127.0.0.1:%d' % port})
        r = c.getresponse()
        assert r.status == 200 and r.read() == PAGE
        assert ':'.join('%02X' % b for b in hashlib.sha256(der).digest()) == fingerprint(cert)
        c.close(); silent.close(); srv.quit(); t.join(5)
        assert not t.is_alive()
    finally:
        shutil.rmtree(d)
    print('setup page TLS selftest ok')


if __name__ == '__main__':
    selftest() if sys.argv[1:] == ['--selftest'] else main(sys.argv[1:])
