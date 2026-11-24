#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""RideWatch test server: the real server/serve.py and events.py, unchanged, on any machine, for car tests without a
real camera system.

    python3 demo/testserver.py --car ABCD-EFGH-JKLM-NPQR [--host 127.0.0.1] [--port 18640] [--event-port 18641]
                               [--cams cams.json] [--state DIR] [--events-from ADDRESS] [--door-audio FILE]
    python3 demo/testserver.py --selftest

- An accept loop on --host:--port runs one serve.py per connection with the socket as its stdin and stdout, as
  systemd's jap-ridewatch.socket does. --car: the codes let in (the code the car's app shows; repeat for more).
- A fake Protect on 127.0.0.1 (login, logout, cameras, events, nvr, video/export, PATCH turns RTSP on), reached by the
  children through JAP_RIDEWATCH_PROTECT_URL. Each camera also lists a main channel (id 0) with RTSP off, and a channel
  with "rtsp": false in --cams starts off, for the setup page's "will turn on" step. An event's clip is a 20 s ffmpeg
  test picture (no ffmpeg: no clips).
- events.py's hook on --host:--event-port: a synthetic ring or detection, from --events-from only (default: --host,
  so a curl on this machine to the printed address):
      curl -X POST -H 'X-Token: <printed at start>' -d '{"cam":"Front door","type":"ring"}' http://<host>:<event-port>/event
  (types: ring, person, vehicle, animal, package). No thumbnails: events.grab() is not run.
- Listen and talk (needs ffmpeg with AAC): `listen` on the door camera plays --door-audio (default: a tone made at start,
  door.wav in the state folder), looped, through serve.py's JAP_RIDEWATCH_TEST_AUDIO. The door-role cameras have a
  speaker in the fake camera list, its talkback port a UDP receiver on 127.0.0.1: each talk is written to
  talk-<n>.wav in the state folder (closed 2 s after its last packet), so a car test proves talk arrived.
- The cameras: three invented ones (or --cams, a JSON list in cams.json's "cams" format). Their pictures come from
  each channel's "url", an RTSP server you run (mediamtx, ...); this script serves no video. A camera that cannot be
  reached ends its stream, and the car retries.
Everything binds to 127.0.0.1 unless --host says otherwise. State (cams.json, events.json) goes to --state, by default
a new temporary folder.
"""
import argparse, http.server, json, os, secrets, shutil, socket, subprocess, sys, tempfile, threading, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, '..', 'server')
CAMS = [
    {'name': 'Front door', 'protectId': 'demo0', 'roles': ['door'],
     'channels': [{'id': 1, 'w': 1440, 'h': 1920, 'fps': 20, 'alias': 'front', 'url': 'rtsp://127.0.0.1:8554/front'}]},
    {'name': 'Driveway', 'protectId': 'demo1', 'roles': ['day'],
     'channels': [{'id': 1, 'w': 1280, 'h': 720, 'fps': 30, 'alias': 'drive', 'url': 'rtsp://127.0.0.1:8554/drive'}]},
    {'name': 'Garden', 'protectId': 'demo2', 'roles': ['night'],
     'channels': [{'id': 1, 'w': 1280, 'h': 720, 'fps': 30, 'alias': 'garden', 'url': 'rtsp://127.0.0.1:8554/garden'}]},
]
MAX_CONN = 12                                       # as jap-ridewatch.socket's MaxConnections
live = []                                           # the serve.py children


def fake_camera(c, talk_port=None):
    """a cams.json camera as Protect's camera list shows it, with a main channel (id 0, RTSP off) if it has none; a
    door-role camera has a speaker whose talkback port is talk_port on 127.0.0.1"""
    chans = [{'id': ch['id'], 'name': ch['alias'], 'enabled': True, 'isRtspEnabled': ch.get('rtsp', True),
              'rtspAlias': ch['alias'] if ch.get('rtsp', True) else None, 'width': ch['w'], 'height': ch['h'],
              'fps': ch.get('fps', 30)} for ch in c['channels']]
    if all(ch['id'] for ch in chans):
        chans.insert(0, {'id': 0, 'name': 'High', 'enabled': True, 'isRtspEnabled': False, 'rtspAlias': None,
                         'width': chans[0]['width'] * 2, 'height': chans[0]['height'] * 2, 'fps': 30})
    bell = 'door' in c.get('roles', [])
    rec = {'id': c['protectId'], 'name': c['name'], 'featureFlags': {'isDoorbell': bell}, 'channels': chans}
    if bell and talk_port:
        rec.update(host='127.0.0.1', talkbackSettings={'typeFmt': 'aac', 'typeIn': 'serverudp', 'bindPort': talk_port,
                                                       'samplingRate': 22050, 'channels': 1})
        rec['featureFlags']['hasSpeaker'] = True
    return rec


TALK_GAP = 2                                        # s without a packet: that talk's WAV is closed


def talk_receiver(state):
    """the door's speaker: a UDP port on 127.0.0.1 taking ADTS AAC, each talk decoded to <state>/talk-<n>.wav; returns
    the port"""
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); rx.bind(('127.0.0.1', 0)); rx.settimeout(TALK_GAP)

    def run():
        n, dec = 0, None
        while True:
            try:
                b = rx.recv(65536)
            except socket.timeout:
                if dec:
                    dec.stdin.close(); dec.wait(); dec = None
                    print('talk received: %s' % os.path.join(state, 'talk-%d.wav' % n)); sys.stdout.flush()
                continue
            if not dec:
                n += 1
                dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-f', 'aac', '-i', 'pipe:0', '-y',
                                        os.path.join(state, 'talk-%d.wav' % n)], stdin=subprocess.PIPE)
            try:
                dec.stdin.write(b); dec.stdin.flush()
            except OSError:                          # the decoder died: the next packet starts a new file
                dec.wait(); dec = None
    threading.Thread(target=run, daemon=True).start()
    return rx.getsockname()[1]


def fake_protect(cams, mp4, talk_port=None):
    """a fake Protect console on 127.0.0.1 (an ephemeral port): returns the server"""
    tok = secrets.token_hex(8)
    raw = [fake_camera(c, talk_port) for c in cams]

    class P(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, st, body=b'', hdr=()):
            self.send_response(st)
            for k, v in hdr:
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

        def body(self):
            return self.rfile.read(min(int(self.headers.get('Content-Length') or 0), 1 << 16))

        def ok(self):
            return self.headers.get('Cookie') == 'TOKEN=' + tok

        def do_POST(self):
            self.body()
            if self.path == '/api/auth/logout':
                return self.reply(200, b'{}')
            if self.path != '/api/auth/login':
                return self.reply(404)
            self.reply(200, b'{}', [('Set-Cookie', 'TOKEN=%s; path=/; httponly' % tok), ('X-CSRF-Token', 'demo')])

        def do_PATCH(self):
            try:
                new = {ch['id']: ch.get('isRtspEnabled') for ch in json.loads(self.body()).get('channels', [])}
            except (ValueError, AttributeError, KeyError, TypeError):
                new = {}
            cam = next((c for c in raw if self.path == '/proxy/protect/api/cameras/' + c['id']), None)
            if not self.ok() or not cam:
                return self.reply(401 if not self.ok() else 404, b'{}')
            for ch in cam['channels']:                  # RTSP on: Protect makes up an alias
                if new.get(ch['id']) and not ch['isRtspEnabled']:
                    ch.update(isRtspEnabled=True, rtspAlias=ch['name'] if ch['id'] else 'main%s' % cam['id'])
            self.reply(200, b'{}')

        def do_GET(self):
            if not self.ok():
                return self.reply(401)
            path = self.path.split('?')[0]
            if path == '/proxy/protect/api/cameras':
                return self.reply(200, json.dumps(raw).encode())
            if path == '/proxy/protect/api/events':
                return self.reply(200, b'[]')
            if path == '/proxy/protect/api/nvr':
                return self.reply(200, b'{"doorbellSettings": {"allMessages": []}}')
            if path == '/proxy/protect/api/video/export' and mp4:
                return self.reply(200, open(mp4, 'rb').read())
            self.reply(404)
    srv = fake_protect.last = http.server.ThreadingHTTPServer(('127.0.0.1', 0), P)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def accept_loop(lsock, env):
    """one serve.py per connection, the socket as its stdin and stdout (systemd's Accept=yes)"""
    while True:
        c, _ = lsock.accept()
        live[:] = [p for p in live if p.poll() is None]
        if len(live) >= MAX_CONN:
            c.close(); continue
        live.append(subprocess.Popen([sys.executable, os.path.join(SERVER, 'serve.py')], stdin=c.fileno(), stdout=c.fileno(), env=env))
        c.close()                                   # the child holds it now


def start(host, port, event_port, cars, cams, state, events_from, door_audio=None):
    """everything running in threads: returns (stream port, event port, the event token)"""
    mp4, talk_port, audio = None, None, {}
    if shutil.which('ffmpeg'):
        mp4 = os.path.join(state, 'clip.mp4')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=20', '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p', mp4], check=True)
        if not door_audio:                          # a two-note chime, then quiet: easy to hear in the cabin
            door_audio = os.path.join(state, 'door.wav')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                            "aevalsrc='0.3*sin(2*PI*(if(lt(t,0.5),659,523))*t)*lt(t,1)':s=48000:d=3", door_audio], check=True)
        audio = {'JAP_RIDEWATCH_TEST_AUDIO': os.path.abspath(door_audio)}
        talk_port = talk_receiver(state)
    protect = fake_protect(cams, mp4, talk_port)
    token = secrets.token_hex(12)
    # "audio": true: listen and talk on, for the fake doorbell only (its door role); serve.py has them off by default
    conf = {'cars': list(cars), 'audio': True, 'protect': {'host': '127.0.0.1', 'username': 'demo', 'password': 'demo'}, 'cams': cams,
            'events_protect': False, 'events_from': events_from, 'events_token': token}
    path = os.path.join(state, 'cams.json')
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        json.dump(conf, f, indent=1)
    env = dict(os.environ, JAP_RIDEWATCH_CONF=path, JAP_RIDEWATCH_STATE=state, TMPDIR=state,
               JAP_RIDEWATCH_PROTECT_URL='http://127.0.0.1:%d' % protect.server_address[1], **audio)
    os.environ.update(JAP_RIDEWATCH_CONF=path, JAP_RIDEWATCH_STATE=state)     # read by events.py at import
    sys.path.insert(0, SERVER)
    import events
    events.grab = lambda cam, eid: None             # shortcut: no thumbnails (grab() needs GNU timeout and a live feed)
    os.makedirs(events.THUMBS, exist_ok=True)
    hook = http.server.ThreadingHTTPServer((host, event_port), events.H)
    threading.Thread(target=hook.serve_forever, daemon=True).start()
    lsock = socket.create_server((host, port), reuse_port=False)
    threading.Thread(target=accept_loop, args=(lsock, env), daemon=True).start()
    return lsock.getsockname()[1], hook.server_address[1], token


def selftest():
    state = tempfile.mkdtemp()
    code = 'TEST-CODE-0000-0001'
    port, eport, token = start('127.0.0.1', 0, 0, [code], json.loads(json.dumps(CAMS)), state, '127.0.0.1')

    def ask(req, line=True):
        s = socket.create_connection(('127.0.0.1', port), 10)
        s.sendall(req.encode() + b'\n')
        f = s.makefile('rb')
        return s, f, (f.readline() if line else f.read())
    s, f, b = ask(code + ' hello')
    h = json.loads(b); s.close()
    assert h['ev'] == 'hello' and h['proto'] == 2 and isinstance(h['tz'], int), h
    s, f, b = ask(code + ' list')
    assert [c['label'] for c in json.loads(b)] == ['Front door', 'Driveway', 'Garden'], b
    s.close()
    s, f, b = ask('WRONG list', False)
    assert b == b'', 'a wrong code: nothing'
    s.close()
    s, f, b = ask(code + ' events')
    assert json.loads(b)['list'] == []
    req = urllib.request.Request('http://127.0.0.1:%d/event' % eport, json.dumps({'cam': 'Front door', 'type': 'ring'}).encode(), {'X-Token': token})
    assert urllib.request.urlopen(req, timeout=5).status == 204
    e = json.loads(f.readline())
    assert (e['ev'], e['cam'], e['type'], e['label']) == ('event', 0, 'ring', 'Front door'), e
    s.close()
    if shutil.which('ffmpeg'):                       # the event's clip: the fake Protect's login and export
        s, f, b = ask(code + ' clip %s 640x360' % e['id'])
        c = json.loads(b); s.close()
        assert c['ev'] == 'clip' and c['id'] == e['id'] and 19000 <= c['dur'] <= 21000, c
    try:
        urllib.request.urlopen(urllib.request.Request(req.full_url, req.data, {'X-Token': 'nope'}), timeout=5); assert False
    except urllib.error.HTTPError as x:
        assert x.code == 403
    if shutil.which('ffmpeg'):                       # listen: the door audio as PCM; talk: it lands in talk-1.wav
        import math, struct, time, wave
        assert {'listen', 'talk'} <= set(h['caps']), h
        s, f, b = ask(code + ' listen 0')
        assert json.loads(b) == {'ev': 'listen', 'rate': 24000, 'ch': 1, 'fmt': 's16le'}, b
        assert len(f.read(4800)) == 4800
        s.close()
        s, f, b = ask(code + ' talk 0')
        assert json.loads(b) == {'ev': 'talk', 'ok': True, 'rate': 16000, 'ch': 1, 'fmt': 's16le', 'max': 60}, b
        s.sendall(b''.join(struct.pack('<h', int(8000 * math.sin(2 * math.pi * 440 * k / 16000))) for k in range(16000)))
        s.shutdown(socket.SHUT_WR)                  # the car lets go: the server ends the talk
        assert f.read() == b''
        s.close()
        w = os.path.join(state, 'talk-1.wav')
        for _ in range(60):
            time.sleep(0.1)
            try:
                with wave.open(w) as x:
                    n = x.getnframes()
                if n:
                    break
            except (OSError, EOFError, wave.Error):
                pass
        assert 0.8 * 22050 < n < 1.5 * 22050, n
        s, f, b = ask(code + ' talk 1')
        assert json.loads(b) == {'ev': 'talk', 'error': 'off'}, b    # the driveway has no door role
        s.close()
    sys.path.insert(0, SERVER)
    import serve
    os.environ['JAP_RIDEWATCH_PROTECT_URL'] = 'http://127.0.0.1:%d' % fake_protect.last.server_address[1]
    conf = {'protect': {'host': '127.0.0.1', 'username': 'demo', 'password': 'demo'}}
    s = serve.login(conf, save=False)
    found, off = serve.discover(conf, sess=s)
    assert [c['name'] for c in found] == ['Front door', 'Driveway', 'Garden'] and len(off) == 3, (found, off)
    serve.protect_req(conf, 'PATCH', '/proxy/protect/api/cameras/demo0', {'channels': [{'id': 0, 'isRtspEnabled': True}]}, sess=s)
    assert serve.discover(conf, sess=s)[1] == off[1:], 'PATCH turns RTSP on'
    os.environ.pop('JAP_RIDEWATCH_PROTECT_URL')
    for p in live:
        p.kill()
    shutil.rmtree(state, ignore_errors=True)
    print('testserver selftest ok')


def main():
    a = argparse.ArgumentParser(description='RideWatch test server (see the top of this file)')
    a.add_argument('--host', default='127.0.0.1')
    a.add_argument('--port', type=int, default=18640)
    a.add_argument('--event-port', type=int, default=18641)
    a.add_argument('--car', action='append', default=[], help="a car's code (its app shows it); repeat for more")
    a.add_argument('--cams', help="a JSON list of cameras, cams.json's \"cams\" format")
    a.add_argument('--state', help='folder for cams.json and events.json (default: a new temporary one)')
    a.add_argument('--events-from', help='the only address the event hook takes posts from (default: --host, 127.0.0.1 for 0.0.0.0)')
    a.add_argument('--door-audio', help='an audio file every listen plays, looped (default: a chime made at start)')
    a.add_argument('--selftest', action='store_true')
    o = a.parse_args()
    if o.selftest:
        return selftest()
    cams = json.load(open(o.cams)) if o.cams else CAMS
    state = o.state or tempfile.mkdtemp(prefix='ridewatch-demo-')
    os.makedirs(state, exist_ok=True)
    # a post from this machine to --host comes from --host
    efrom = o.events_from or ('127.0.0.1' if o.host in ('0.0.0.0', '::') else o.host)
    port, eport, token = start(o.host, o.port, o.event_port, o.car, cams, state, efrom, o.door_audio)
    print('RideWatch test server on %s:%d, state in %s' % (o.host, port, state))
    print('cars let in: %s' % (', '.join(o.car) or 'none (add --car CODE)'))
    print('cameras: %s' % ', '.join(c['name'] for c in cams))
    print("ring: curl -X POST -H 'X-Token: %s' -d '{\"cam\":\"%s\",\"type\":\"ring\"}' http://%s:%d/event" % (token, cams[0]['name'], o.host, eport))
    sys.stdout.flush()
    threading.Event().wait()


if __name__ == '__main__':
    main()
