#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""RideWatch server: one H.264 stream of the UniFi Protect cameras, encoded at exactly the car's rect.

Runs per connection under systemd socket activation (jap-ridewatch.socket, Accept=yes): stdin/stdout = the TCP socket.
Request, one line:  <token> hello                     -> {"ev":"hello","proto":2,"server","tz","caps":[]} and close (an older
                                                      server says nothing: the car reads proto 1)
                    <token> listen <i>                -> once camera i's audio flows, one JSON line
                                                      {"ev":"listen","rate":24000,"ch":1,"fmt":"s16le"}, then raw PCM
                                                      (s16le, 24 kHz, mono) until the car closes (keep the write side
                                                      open: EOF from the car ends it); or {"ev":"listen","error":
                                                      "camera|noaudio|busy"} and close (camera: bad index or camera not
                                                      reachable; busy: this car already has a listen open)
                    <token> talk <i>                  -> {"ev":"talk","ok":true,"rate":16000,"ch":1,"fmt":"s16le","max":60},
                                                      then the car sends raw PCM in that format; the server sends it as
                                                      AAC (ADTS) over UDP to the camera's talkback port (Protect camera
                                                      list: host, talkbackSettings) and closes at the car's EOF or after
                                                      "max" s. Or {"ev":"talk","error":"camera|nospeaker|nouser|
                                                      forbidden|unreachable|busy"} and close (nouser: no Protect user in
                                                      cams.json; forbidden: its login or role refused the camera list).
                                                      UDP has no answer: "ok" does not prove the doorbell played it.
                    <token> mosaic2 <W>x<H>            -> one JSON line {"ev":"layout",...,"tiles":[{i,name,x,y,w,h}]}, then as mosaic
                    <token> list                      -> JSON [{"i":0,"name":"Garage","shape","w","h","roles"}, ...] and close
                    <token> spot <hero> [o=<i,i,..>] <W>x<H>  -> layout line, then the hero big + the others in the pane
                                                      (o=: the user's order, spot_layout()); a 3:4 hero (the doorbell)
                                                      at the left edge, and "controls": the free column beside it
                    <token> mosaic <W>x<H>             -> raw Annex-B H.264, every camera in a grid, W x H
                    <token> cam <i> <W>x<H>            -> raw Annex-B H.264, camera i alone, fitted into W x H
                    <token> events                    -> the timeline (events_feed()); its first line and pings carry "tz"
                    <token> thumb <id>                -> an event's JPEG, or nothing
                    <token> clip <id> <W>x<H>          -> one JSON line {"ev":"clip",...} (or {"ev":"clip","error":..}),
                                                      then the event's recording from Protect at real time, then close
<token>: a car's code (its SHA-256 is in cams.json "cars", added with configure.py --add-car or the setup page). A wrong
one: closed without a word.
caps: "rtsp", plus, only with "audio": true in cams.json, "listen" (ffmpeg decodes AAC) and "talk" (ffmpeg's own AAC encoder);
listen and talk answer {"error": "off"} without it, or for a camera without the door role.
tz: this server's offset from UTC in minutes (east positive), read at each line: the car's clock is UTC.
The stream runs until the client closes (a clip: until it ends). No B-frames, SPS/PPS before every IDR, 1 s GOP: a decoder
joining or recovering waits at most 1 s.
Config /opt/jap-ridewatch/cams.json (0600, written by configure.py):
  {"cars": ["sha256:<hex of the code>", ...], "protect": {"host", "username", "password"},
   "cams": [{"name", "label", "protectId", "roles": ["door"|"garage"|"day"|"night"],
             "channels": [{"id", "w", "h", "fps", "alias", "url"?}]}]}
  (a channel's "url", by hand: another RTSP source for that camera, used instead of Protect's RTSPS)
  A camera that is not in Protect ("kind": "rtsp", configure.py --add-rtsp): no protectId, one channel with its "url";
  live views only (no Protect events, no clips). Every url is checked by rtsp_url() when added and again here.
  `list` rows end with "kind": "protect" or "rtsp". cams.json may have no "protect" at all.
"""
import hashlib, ipaddress, json, math, os, re, secrets, signal, subprocess, sys, tempfile

CONF = os.environ.get('JAP_RIDEWATCH_CONF', '/opt/jap-ridewatch/cams.json')
URL = 'rtsps://{}:7441/{}'  # Protect's RTSPS, on the Protect host (use())
HOST = ['']
ROLES = ('door', 'garage', 'day', 'night')
VERSION = '0.5.0'
PROTO = 2
MOSAIC_FPS = 30           # most Protect channels are 30 fps (some 24 or 20)
FILL_MAX_CROP = 0.15
BT709 = 'flags=lanczos:out_color_matrix=bt709:out_range=tv'   # MGVF header on the car: BT.709 limited     # same rule as ytdec: crop to fill when it cuts at most 15 %, else fit (black bars)


def even(v):
    return max(2, int(v) // 2 * 2)


def grid(n, W, H, ar=16 / 9):
    """cols, rows for n tiles in W x H, maximising the area a 16:9 picture covers in a tile."""
    def area(c):
        r = math.ceil(n / c); tw, th = W / c, H / r
        return min(tw, th * ar) * min(th, tw / ar)
    c = max(range(1, n + 1), key=area)
    return c, math.ceil(n / c)


def fit(sw, sh, tw, th):
    """ffmpeg filter scaling sw x sh into tw x th: fill (crop) when it cuts <= 15 %, else fit + pad."""
    cover = max(tw / sw, th / sh)
    crop = 1 - (tw * th) / (sw * cover * sh * cover)
    if crop <= FILL_MAX_CROP:
        return 'scale=%d:%d:force_original_aspect_ratio=increase:%s,crop=%d:%d' % (tw, th, BT709, tw, th)
    return 'scale=%d:%d:force_original_aspect_ratio=decrease:%s,pad=%d:%d:(ow-iw)/2:(oh-ih)/2' % (tw, th, BT709, tw, th)


def candidates(chans):
    """the channels a view may use, smallest first: not a doorbell's 3 fps package channel, not the main one (id 0)
    when there is another (setup_web.py turns RTSP on for exactly these)"""
    chans = sorted(chans, key=lambda c: c['w'] * c['h'])
    chans = [c for c in chans if c.get('fps', 30) >= 10] or chans
    if len(chans) > 1:
        chans = [c for c in chans if c['id'] != 0]
    return chans


def channel(cam, tw, th, mosaic):
    """the smallest channel at least as big as its fitted size; never the 4K main one unless nothing else."""
    chans = candidates(cam['channels'])
    for c in chans:
        s = min(tw / c['w'], th / c['h'])
        if s <= 1:
            return c
    return chans[-1]


# drop what the decoder conceals before the camera's first keyframe (Protect starts mid-GOP: ~1-4 s of gray smear)
KEYGATE = "select='if(key,st(0,1),0)+ld(0)',"
# every camera open: only what RTSP over TCP needs (rtsp:// = tcp, rtsps:// = tcp + tls; checked with ffmpeg 8.1 against
# both). Holds because every open also forces -rtsp_transport tcp (UDP transport would need rtp,udp: refused here).
WHITELIST = ['-protocol_whitelist', 'tcp,tls']
PROBE = ['-probesize', '256k', '-analyzeduration', '300000'] + WHITELIST
USERINFO = re.compile(r'(?:[A-Za-z0-9._~!$&()*+,;=:-]|%[0-9A-Fa-f]{2})*')
HOSTPORT = re.compile(r'(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?')


def rtsp_url(u):
    """u itself if it is safe as an ffmpeg -i argument, else ValueError (the reason only: never the url, it may hold a
    password): rtsp:// or rtsps:// only, printable ASCII without spaces, quotes or backslash, at most 512 chars, a
    host name or a bracketed IPv6, port 1-65535 or none (the default), credentials percent-encoded (no raw @)"""
    if not isinstance(u, str) or not 0 < len(u) <= 512:
        raise ValueError('empty or longer than 512 characters')
    if not re.fullmatch(r'[\x21-\x7e]+', u) or any(c in u for c in '"\'\\'):    # before any parsing: urlsplit drops tabs, newlines
        raise ValueError('spaces, control characters, quotes or backslash')
    m = re.match(r'rtsps?://([^/?#]*)', u)
    if not m:
        raise ValueError('not an rtsp:// or rtsps:// address')
    user, at, hp = m.group(1).rpartition('@')
    if at and not USERINFO.fullmatch(user):
        raise ValueError('user and password must be percent-encoded (@ is %40)')
    h = HOSTPORT.fullmatch(hp)
    if not h:
        raise ValueError('bad host or port')
    if h.group(1).startswith('['):
        try:
            ipaddress.IPv6Address(h.group(1)[1:-1])
        except ValueError:
            raise ValueError('bad IPv6 address') from None
    if h.group(2) is not None and not 1 <= int(h.group(2)) <= 65535:
        raise ValueError('port out of 1-65535')
    return u


def scrub(s):
    """a log line without the password of any url in it (ffmpeg prints the input's url as given)"""
    return re.sub(r'(://)[^/@\s]*@', r'\1***@', s)


def is_rtsp(cam):
    """a camera that is not in Protect: "kind": "rtsp", or an older hand-added row (no protectId, every channel a url
    and no Protect alias)"""
    chans = cam.get('channels') or []
    return cam.get('kind') == 'rtsp' or (cam.get('kind') is None and not cam.get('protectId') and bool(chans)
                                         and all(ch.get('url') and not ch.get('alias') for ch in chans))


def inputs(cams, fifos=None, tile=None):
    """ffmpeg opens its inputs one by one, probing each (0.55-4 s per camera over RTSPS: 6 s for 11). For the mosaic
    each camera is opened, decoded and scaled to its tile by its own ffmpeg, all at once, which writes raw I420
    frames into a FIFO: here those open with nothing to probe (known size), and are stamped with the wall clock,
    so every tile is aligned on arrival time."""
    a = []
    for k, c in enumerate(cams):
        if fifos:
            a += ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '%dx%d' % tile, '-framerate', str(MOSAIC_FPS),
                  '-thread_queue_size', '8', '-i', fifos[k]]
        else:
            a += ['-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay'] + PROBE + ['-i', src_url(c)]
    return a


def src_url(ch):
    """a channel's own url (by hand in cams.json, e.g. a prebuffered rebroadcast: starts at once) or Protect's RTSPS"""
    if ch.get('url'):
        try:
            return rtsp_url(ch['url'])
        except ValueError as e:
            raise ValueError('a channel url in cams.json is refused: %s' % e) from None
    return URL.format(HOST[0], ch['alias'])


def use(conf):
    """the Protect host of cams.json for the RTSPS urls"""
    HOST[0] = str((conf.get('protect') or {}).get('host', ''))


def digest(code):
    """a car code's SHA-256, lowercase hex: what cams.json keeps ("sha256:<hex>") and the pairing QR carries"""
    return hashlib.sha256(code.encode()).hexdigest()


def tokens(conf):
    """the cars' code hashes: "sha256:<hex>" entries as stored, an older plain code (and an older cams.json's single
    "token") hashed here. main() hashes what the car sends and compares hashes: a stored hash is no password."""
    out = []
    for t in [conf.get('token')] + list(conf.get('cars') or []):
        if isinstance(t, str) and t:
            m = re.fullmatch(r'sha256:([0-9a-f]{64})', t)
            out.append((m.group(1) if m else digest(t)).encode())
    return out


def puller(ch, fifo, tw, th):
    """one camera -> its tile, raw I420 at MOSAIC_FPS, into a FIFO (blocks until the compositor opens it)"""
    return (['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-rtsp_transport', 'tcp',
             '-fflags', 'nobuffer', '-flags', 'low_delay'] + PROBE + ['-i', src_url(ch), '-map', '0:v:0', '-an',
            '-vf', KEYGATE + 'fps=%d,%s,setsar=1,format=yuv420p' % (MOSAIC_FPS, fit(ch['w'], ch['h'], tw, th)),
            '-f', 'rawvideo', fifo])


def command(cams, view, W, H, fifos=None):
    if view == 'mosaic':
        fps = MOSAIC_FPS
        cols, rows = grid(len(cams), W, H)
        tw, th = even(W / cols), even(H / rows)
        chans = [channel(c, tw, th, True) for c in cams]
        parts, labels, layout = [], [], []
        for k, ch in enumerate(chans):
            if fifos:                            # already scaled by its puller
                parts.append('[%d:v]setsar=1[t%d]' % (k, k))
            else:
                parts.append('[%d:v]fps=%d,%s,setsar=1[t%d]' % (k, fps, fit(ch['w'], ch['h'], tw, th), k))
            labels.append('[t%d]' % k)
        n = len(chans)
        for k in range(n, cols * rows):          # empty slots: black
            parts.append('color=black:s=%dx%d:r=%d[t%d]' % (tw, th, fps, k)); labels.append('[t%d]' % k)
        for k in range(cols * rows):
            layout.append('%d_%d' % (k % cols * tw, k // cols * th))
        # xstack emits on every input's frame (11 x 30/s): fps= keeps the newest of each at a steady 30
        parts.append('%sxstack=inputs=%d:layout=%s:shortest=0,fps=%d,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,format=yuv420p[v]'
                     % (''.join(labels), cols * rows, '|'.join(layout), fps, W, H))
        src = chans
    else:
        cam = cams[view]
        ch = channel(cam, W, H, False)
        fps = ch.get('fps', 30)                  # the camera's own rate: no duplicated or dropped frames, no judder
        if fifos:                                # puller already fitted it to W x H at fps
            return (['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
                     '-s', '%dx%d' % (W, H), '-framerate', str(fps),
                     '-thread_queue_size', '8', '-i', fifos[0], '-filter_complex', '[0:v]fps=%d,setsar=1[v]' % fps] + encode(fps))
        parts = ['[0:v]' + KEYGATE + 'setpts=PTS-STARTPTS,fps=%d,%s,setsar=1,format=yuv420p[v]' % (fps, fit(ch['w'], ch['h'], W, H))]
        src = [ch]
    return (['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin'] + inputs(src, fifos if view == 'mosaic' else None, (tw, th) if fifos else None) +
            ['-filter_complex', ';'.join(parts)] + encode(fps))


RATE = [8000, 8000]                                 # kbit/s cap and VBV size; cams.json maxrate_k / bufsize_k override


def encode(fps):
    return ['-map', '[v]', '-an',
            '-c:v', 'libx264', '-preset', 'faster', '-tune', 'zerolatency', '-profile:v', 'high',
            '-bf', '0', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
            '-g', str(fps), '-keyint_min', str(fps), '-x264-params', 'repeat-headers=1',
            # quality-capped VBR: CRF 20, never above 8 Mbit/s (cams.json maxrate_k), 1 s VBV
            '-crf', '20', '-maxrate', '%dk' % RATE[0], '-bufsize', '%dk' % RATE[1], '-r', str(fps), '-f', 'h264', 'pipe:1']


def tz():
    import time
    return time.localtime().tm_gmtoff // 60


def is_door(cam):
    r = cam.get('roles')
    return isinstance(r, list) and 'door' in r


def audio_caps():
    """"listen" when this ffmpeg decodes AAC and writes s16le, "talk" when it has its own AAC encoder (none without ffmpeg)"""
    try:
        enc, dec = (subprocess.run(['ffmpeg', '-hide_banner', a], stdin=subprocess.DEVNULL, capture_output=True, timeout=5).stdout
                    for a in ('-encoders', '-decoders'))
    except (OSError, subprocess.TimeoutExpired):
        return []
    has = lambda out, name: re.search(rb'^ A\S* %s ' % name, out, re.M) is not None
    return [c for c, ok in (('listen', has(dec, b'aac') and has(enc, b'pcm_s16le')), ('talk', has(enc, b'aac'))) if ok]


def hold(what, key):
    """an exclusive lock for this car (key) and kind, in STATE (one process per connection): the fd, kept until this
    process ends, or None when another connection holds it"""
    import fcntl
    fd = os.open(os.path.join(STATE, '%s-%s.lock' % (what, key)), os.O_RDWR | os.O_CREAT, 0o600)   # not inherited by ffmpeg
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except OSError:
        os.close(fd)
        return None


LISTEN_WAIT = 10                                     # s for a listen's first audio bytes


def listen(cams, arg, key, rfd=0, out=None):
    """`listen <i>`: camera i's audio as s16le 24 kHz mono after one JSON line, until the car closes (EOF on rfd or a
    failed write); ffmpeg is killed then. The line is sent once audio flows, so a camera without audio says so."""
    import select, threading, time
    out = out or sys.stdout.buffer

    def say(o):
        out.write((json.dumps(dict({'ev': 'listen'}, **o)) + '\n').encode()); out.flush()
        return 0 if 'rate' in o else 1
    if not (arg.isdigit() and int(arg) < len(cams)):
        return say({'error': 'camera'})
    if hold('listen', key) is None:
        return say({'error': 'busy'})
    test = os.environ.get('JAP_RIDEWATCH_TEST_AUDIO')
    if test and os.path.isabs(test):                 # the selftests' and demo's door audio: a local file, looped
        src = ['-re', '-stream_loop', '-1', '-i', test]
    else:
        try:                                         # every Protect channel carries the camera's audio: the smallest
            src = ['-rtsp_transport', 'tcp'] + WHITELIST + ['-i', src_url(candidates(cams[int(arg)]['channels'])[0])]
        except (ValueError, KeyError, IndexError, TypeError):
            return say({'error': 'camera'})
    p = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin'] + src +
                         ['-vn', '-map', '0:a:0', '-ar', '24000', '-ac', '1', '-f', 's16le', 'pipe:1'],
                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    errs = []
    t = threading.Thread(target=log_scrubbed, args=(p.stderr, None, errs), daemon=True); t.start()
    first, t0 = True, time.monotonic()
    try:
        while True:
            r = select.select([p.stdout, rfd], [], [], 1)[0]
            if rfd in r and not os.read(rfd, 4096):
                return 0                             # the car closed
            if p.stdout in r:
                b = os.read(p.stdout.fileno(), 1 << 16)
                if not b:
                    if not first:
                        return 1                     # the camera went away mid-listen
                    p.wait(); t.join(2)
                    return say({'error': 'noaudio' if any(b'matches no streams' in l for l in errs) else 'camera'})
                if first:
                    say({'rate': 24000, 'ch': 1, 'fmt': 's16le'}); first = False
                out.write(b); out.flush()
            elif first and time.monotonic() - t0 > LISTEN_WAIT:
                return say({'error': 'camera'})
    except OSError:                                  # the car went (broken pipe, reset)
        return 0
    finally:
        p.kill(); p.wait()


TALK_MAX = 60                                        # s, the server's hard cap on one talk (the car's lease has the same)
TALK_RATES = (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000)


def protect_camera(conf, cam):
    """cam's record in Protect's camera list, by its protectId (or by name for a hand-written cams.json)"""
    try:
        raw = json.loads(protect_get(conf, '/proxy/protect/api/cameras'))
        if not isinstance(raw, list):
            raise ValueError
    except ValueError:
        raise ProtectError('cameras', 'cameras: not a JSON list')
    pid = cam.get('protectId')
    rec = next((c for c in raw if isinstance(c, dict) and (c.get('id') == pid if pid else c.get('name') == cam['name'])), None)
    if rec is None:
        raise ProtectError('camera', 'no Protect camera %r' % (pid or cam['name']))
    return rec


def talk_target(rec):
    """ffmpeg's output args for a camera's speaker, from its Protect record: Protect's talkback over direct UDP to
    camera.host:talkbackSettings.bindPort, ADTS AAC at the camera's own rate and channels. Every value goes into
    ffmpeg's argv: checked here. ProtectError('camera') when the camera has no usable speaker.
    Fallback hook (plan 6.2, live check 4): if the doorbell refuses direct UDP, the console websocket
    /proxy/protect/api/ws/talkback?camera=<id> takes the same ADTS stream; it would replace the udp:// output here
    with pipe:1 relayed into a websocket. Not built: nothing in the docs says UDP is refused."""
    f, t = rec.get('featureFlags') or {}, rec.get('talkbackSettings') or {}
    port, sr, ch = t.get('bindPort'), t.get('samplingRate'), t.get('channels', 1)
    try:
        ip = ipaddress.ip_address(rec.get('host'))
    except ValueError:
        ip = None
    ok = lambda v, vals: isinstance(v, int) and not isinstance(v, bool) and v in vals
    if not (f.get('hasSpeaker') is True and ip and ok(port, range(1, 65536)) and ok(sr, TALK_RATES) and ok(ch, (1, 2))
            and t.get('typeFmt', 'aac') == 'aac'):
        raise ProtectError('camera', 'no speaker or no usable talkbackSettings')
    return ['-c:a', 'aac', '-profile:a', 'aac_low', '-ar', str(sr), '-ac', str(ch), '-f', 'adts',
            'udp://%s:%d' % ('[%s]' % ip if ip.version == 6 else ip, port)]


def talk(conf, arg, key, inp=None, out=None):
    """`talk <i>`: the car's s16le 16 kHz mono after the request line -> AAC -> the doorbell's speaker, until the car's
    EOF or TALK_MAX s (the server closes). UDP has no answer: "ok" means the settings were read and ffmpeg started."""
    inp, out = inp or sys.stdin.buffer, out or sys.stdout.buffer   # inp: the reader that read the request (may hold PCM)
    cams = conf['cams']

    def say(o):
        out.write((json.dumps(dict({'ev': 'talk'}, **o)) + '\n').encode()); out.flush()
        return 0 if o.get('ok') else 1
    if not (arg.isdigit() and int(arg) < len(cams)):
        return say({'error': 'camera'})
    cam = cams[int(arg)]
    if is_rtsp(cam):
        return say({'error': 'nospeaker'})
    p = conf.get('protect') or {}
    if not (p.get('username') and p.get('password')):
        return say({'error': 'nouser'})
    if hold('talk', key) is None:
        return say({'error': 'busy'})
    try:
        dst = talk_target(protect_camera(conf, cam))
    except ProtectError as e:
        sys.stderr.write('talk %s: %s\n' % (arg, e.args[1]))
        code = {'config': 'nouser', 'login': 'forbidden', 'camera': 'nospeaker'}.get(e.args[0])
        if e.args[0] == 'cameras':                   # the user's role refused the camera list, or anything else
            code = 'forbidden' if re.search(r'HTTP 40[13]\b', e.args[1]) else 'unreachable'
        return say({'error': code or 'unreachable'})
    cap = max(1, min(TALK_MAX, int(os.environ.get('JAP_RIDEWATCH_TALK_MAX', TALK_MAX))))   # (alarm(0) would be no cap)   # (shorter in the selftests)
    say({'ok': True, 'rate': 16000, 'ch': 1, 'fmt': 's16le', 'max': cap})
    p = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 's16le', '-ar', '16000',
                          '-ac', '1', '-i', 'pipe:0'] + dst, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)

    def stop(*a):
        raise TimeoutError
    signal.signal(signal.SIGALRM, stop)
    signal.alarm(cap)                                # also fires while blocked on a car that sends nothing
    try:
        while True:
            b = inp.read1(1 << 16)
            if not b:
                break
            p.stdin.write(b)
    except OSError:                                  # the cap (TimeoutError), the car reset, or ffmpeg gone
        pass
    finally:
        signal.alarm(0)
        try:
            p.stdin.close()                          # ffmpeg sends what it has and ends
        except OSError:
            pass
        try:
            p.wait(3)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait()
    return 0


def main():
    signal.alarm(10)                                 # a silent peer must not hold one of the socket's connections
    conf = json.load(open(CONF))
    line = sys.stdin.buffer.readline(256).decode('ascii', 'replace').split()
    if len(line) < 2 or not any(secrets.compare_digest(digest(line[0]).encode(), t) for t in tokens(conf)):
        sys.exit(1)                                   # an unknown car: close, say nothing
    signal.alarm(0)
    use(conf)
    cams = conf['cams']
    RATE[:] = [int(conf.get('maxrate_k', RATE[0])), int(conf.get('bufsize_k', RATE[1]))]
    audio = conf.get('audio') is True                # listen and talk: off unless cams.json says "audio": true
    if line[1] == 'hello' and len(line) == 2:
        caps = ['rtsp'] + (audio_caps() if audio else [])
        sys.stdout.write(json.dumps({'ev': 'hello', 'proto': PROTO, 'server': VERSION, 'tz': tz(), 'caps': caps}) + '\n'); return
    if line[1] in ('listen', 'talk') and len(line) == 3:
        i = line[2]                                   # and only a camera with the door role: never an indoor microphone
        if not audio or (i.isdigit() and int(i) < len(cams) and not is_door(cams[int(i)])):
            sys.stdout.write(json.dumps({'ev': line[1], 'error': 'off'}) + '\n'); sys.exit(1)
        key = digest(line[0])[:16]                    # one listen and one talk per car at a time
        sys.exit(listen(cams, line[2], key) if line[1] == 'listen' else talk(conf, line[2], key))
    if line[1] == 'list':
        sys.stdout.write(json.dumps([dict({'i': i, 'name': c['name'], 'label': c.get('label', c['name']), 'shape': shape(c),
                                           'roles': [r for r in c.get('roles', []) if r in ROLES]}, **size(c),
                                          kind='rtsp' if is_rtsp(c) else 'protect')
                                     for i, c in enumerate(cams)]) + '\n'); return
    if line[1] == 'events' and len(line) == 2:
        events_feed(); return
    if line[1] == 'thumb' and len(line) == 3 and re.fullmatch(r'[0-9a-f]{12}', line[2]):
        try:
            sys.stdout.buffer.write(open(os.path.join(STATE, 'thumbs', line[2] + '.jpg'), 'rb').read())
        except OSError:
            pass
        return
    m = re.fullmatch(r'(\d{2,4})x(\d{2,4})', line[-1])
    if not m:
        sys.exit(2)
    W, H = even(min(int(m.group(1)), 2048)), even(min(int(m.group(2)), 2048))
    if line[1] == 'clip' and len(line) == 4 and re.fullmatch(r'[0-9a-f]{12}', line[2]):
        sys.exit(clip(conf, line[2], W, H))
    order = line[3][2:] if len(line) == 5 and line[3].startswith('o=') else None
    if line[1] == 'spot' and len(line) == (4 if order is None else 5) and line[2].isdigit() and int(line[2]) < len(cams):
        lo = spot_layout(cams, int(line[2]), W, H, parse_order(order, len(cams)) if order is not None else None)
        srcs = spot_pullers(cams, lo, 0)
        fps = srcs[0][0].get('fps', 30)                # the hero's own rate: it is the picture that is watched
        sys.stdout.write(json.dumps(lo) + '\n'); sys.stdout.flush()
        d = tempfile.mkdtemp(prefix='jap-ridewatch-')
        fifos = []
        jobs = []
        rects = [lo['heroRect']] + lo['tiles']
        for k, (ch, vf, pix) in enumerate(srcs):
            f = os.path.join(d, '%d.yuv' % k); os.mkfifo(f, 0o600); fifos.append(f)
            jobs.append((raw_puller(ch, 'pipe:1', vf, pix, fps), f,
                         placeholder(rects[k]['w'], rects[k]['h'], pix, 16 if k == 0 else 28)))
        run_tiles(jobs, fps, spot_command(cams, lo, fifos, fps))
    if line[1] in ('mosaic', 'mosaic2') and len(line) == 3 and cams:
        view = 'mosaic'
        if line[1] == 'mosaic2':                      # one JSON line first, then the H.264 bytes
            sys.stdout.write(json.dumps(layout(cams, W, H)) + '\n'); sys.stdout.flush()
    elif line[1] == 'cam' and len(line) == 4 and line[2].isdigit() and int(line[2]) < len(cams):
        view = int(line[2])
    else:
        sys.exit(2)
    fifos = None
    if view == 'mosaic':
        tw, th, srcs = mosaic_sources(cams, W, H)
        d = tempfile.mkdtemp(prefix='jap-ridewatch-')      # PrivateTmp=yes in the unit: gone when the stream stops
        fifos, jobs, still = [], [], placeholder(tw, th, 'yuv420p', 28)
        for k, ch in enumerate(srcs):
            f = os.path.join(d, '%d.yuv' % k); os.mkfifo(f, 0o600); fifos.append(f)
            jobs.append((puller(ch, 'pipe:1', tw, th), f, still))
        run_tiles(jobs, MOSAIC_FPS, command(cams, view, W, H, fifos), hold=False)   # (no main picture)
    ch = channel(cams[view], W, H, False)             # one camera: same relay, black until its keyframe
    fps = ch.get('fps', 30)
    d = tempfile.mkdtemp(prefix='jap-ridewatch-'); f = os.path.join(d, '0.yuv'); os.mkfifo(f, 0o600)
    run_tiles([(raw_puller(ch, 'pipe:1', fit(ch['w'], ch['h'], W, H), 'yuv420p', fps), f, placeholder(W, H, 'yuv420p', 16))],
              fps, command(cams, view, W, H, [f]))


STATE = os.environ.get('JAP_RIDEWATCH_STATE', '/var/lib/jap-ridewatch')


def event_rows(path):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return []


def events_feed(out=None, polls=None, sleep=None):
    """the timeline: the last 50 rows, then every new or changed row (events.py rewrites the file atomically), and a
    ping every 15 s so a dead link shows. Ends when the client goes (a write fails)."""
    import time
    out = out or sys.stdout; sleep = sleep or time.sleep
    path = os.path.join(STATE, 'events.json')
    rows = event_rows(path)
    sent = {e['id']: (e['ts'], e['count'], e['thumb']) for e in rows}
    out.write(json.dumps({'ev': 'events', 'list': rows[-50:], 'tz': tz()}) + '\n'); out.flush()
    mtime, idle, n = None, 0.0, 0
    while polls is None or n < polls:
        n += 1
        sleep(0.5); idle += 0.5
        try:
            st = os.stat(path); m = (st.st_ino, st.st_mtime_ns, st.st_size)   # Linux mtime is coarse (~4 ms): events.py's os.replace gives a new inode
        except OSError:
            m = None
        if m != mtime:
            mtime = m
            for e in event_rows(path):
                k = (e['ts'], e['count'], e['thumb'])
                if sent.get(e['id']) != k:
                    sent[e['id']] = k
                    out.write(json.dumps(dict(e, ev='event')) + '\n'); idle = 0
        if idle >= 15:
            out.write('{"ev":"ping","tz":%d}\n' % tz()); idle = 0
        out.flush()


# an event's recording: UniFi Protect's private API on the Protect console (verified with a View Only local user:
# login, cameras, video/export -> MP4, HEVC + AAC, starting at the keyframe before `start`)
# Protect's own channel index for an export: 0 = the main recording, the HD one (channel=1 gave a 640x360 picture,
# not the 1280x720 channel 1 of the live view, so cams.json ids do not map here); the server scales it to the car's rect
EXPORT_CHANNEL = 0
CLIP_PRE, CLIP_POST, CLIP_MAX = 5000, 15000, 90000  # ms before the first hit, after the last, at most in all


class ProtectError(Exception):
    """args: (code, detail): the code goes to the car (ridewatchd words it), the detail to the journal; neither holds secrets"""


def http(method, url, headers, body=None, timeout=10, out=None):
    """(status, headers, body) with a timeout on every socket operation; out: a 200's body is copied into that file"""
    import shutil, ssl, urllib.error, urllib.request
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    ctx = ssl._create_unverified_context() if url.startswith('https:') else None   # the console's self-signed cert: LAN only
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            if out is None:
                return r.status, r.headers, r.read(1 << 22)
            shutil.copyfileobj(r, out, 1 << 20)
            return r.status, r.headers, b''
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read(2000)
    except (OSError, ValueError) as e:                 # refused, timeout, DNS, TLS
        raise ProtectError('unreachable', '%s %s: %s' % (method, url.split('?')[0], e))


def base(conf):
    """Protect's address: https://<protect.host> (JAP_RIDEWATCH_PROTECT_URL overrides it, for the selftests)"""
    if os.environ.get('JAP_RIDEWATCH_PROTECT_URL'):
        return os.environ['JAP_RIDEWATCH_PROTECT_URL']
    h = (conf.get('protect') or {}).get('host')
    if not h or not re.fullmatch(r'[A-Za-z0-9.:\[\]-]+', str(h)):
        raise ProtectError('config', 'cams.json has no valid "protect": {"host"}')
    return 'https://' + h


def session_path():
    return os.path.join(STATE, 'protect-session.json')


def login(conf, save=True):
    """a new Protect session; save=False: not written to disk (a login used once, e.g. by an admin)"""
    p = conf.get('protect') or {}
    if not p.get('username') or not p.get('password'):
        raise ProtectError('config', 'cams.json has no "protect": {"username", "password"}')
    st, h, b = http('POST', base(conf) + '/api/auth/login', {'Content-Type': 'application/json'},
                    json.dumps({'username': p['username'], 'password': p['password'], 'rememberMe': False}).encode())
    tok = re.search(r'\bTOKEN=([^;,\s]+)', ', '.join(h.get_all('Set-Cookie') or []))
    if st != 200 or not tok:
        raise ProtectError('login', 'login: HTTP %d%s' % (st, '' if tok else ', no TOKEN cookie'))
    s = {'cookie': 'TOKEN=' + tok.group(1), 'csrf': h.get('X-CSRF-Token', '')}
    if save:
        session_save(s)
    return s


def session_save(s):
    tmp = session_path() + '.tmp'
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        json.dump(s, f)
    os.replace(tmp, session_path())


def protect_get(conf, path, out=None, timeout=10, sess=None):
    return protect_req(conf, 'GET', path, None, out, timeout, sess)


def protect_req(conf, method, path, body=None, out=None, timeout=10, sess=None):
    """a Protect API call with the cached session (body: sent as JSON); on 401/403 one new login and one retry (the
    console rate-limits logins); out: a 200's body is copied into that file. sess: a session held in memory (an
    admin's, login(save=False)): no file read or written, no new login"""
    try:
        s = sess or json.load(open(session_path()))
    except (OSError, ValueError):
        s = None
    fresh = bool(sess)
    while True:
        if s is None:
            s, fresh = login(conf), True
        if out is not None:
            out.seek(0); out.truncate()
        hdr = {'Cookie': s['cookie'], 'X-CSRF-Token': s['csrf']}
        if body is not None:
            hdr['Content-Type'] = 'application/json'
        st, h, b = http(method, base(conf) + path, hdr, None if body is None else json.dumps(body).encode(), timeout, out)
        if st in (401, 403) and not fresh:
            s = None; continue
        if h.get('X-Updated-CSRF-Token'):
            s['csrf'] = h['X-Updated-CSRF-Token']
            if not sess:
                session_save(s)
        if st != 200:
            raise ProtectError('cameras' if out is None else 'export', '%s: HTTP %d %r' % (path.split('?')[0], st, b[:200]))
        return b


def rate(s):
    n, _, d = str(s or '').partition('/')
    try:
        return round(float(n) / float(d or 1))
    except (ValueError, ZeroDivisionError, OverflowError):
        return 0


def probe(f, opts=()):
    """(w, h, fps, ms) of an MP4's (or, with opts, a camera's) first video stream; live RTSP often says 0/0 for
    avg_frame_rate: then r_frame_rate, then 30"""
    try:
        r = subprocess.run(['ffprobe', '-v', 'error'] + list(opts) + ['-select_streams', 'v:0', '-show_entries',
                            'stream=width,height,avg_frame_rate,r_frame_rate:format=duration', '-of', 'json', f],
                           capture_output=True, timeout=15)
        j = json.loads(r.stdout or b'{}')
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        raise ProtectError('export', scrub('ffprobe: %s' % ('no answer in 15 s' if isinstance(e, subprocess.TimeoutExpired) else e)))
    v = (j.get('streams') or [{}])[0]
    fps = rate(v.get('avg_frame_rate', '30/1')) or rate(v.get('r_frame_rate')) or 30
    try:
        ms = int(float(j.get('format', {}).get('duration', 0)) * 1000)
    except (TypeError, ValueError):                      # a live stream: "N/A"
        ms = 0
    return v.get('width'), v.get('height'), max(1, min(60, fps)), ms


def clip_command(f, W, H, sw, sh, fps):
    """the recording at real time, fitted like a `cam` view, with the live views' encoder"""
    return (['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-i', f, '-filter_complex',
             '[0:v]fps=%d,%s,setsar=1,format=yuv420p[v]' % (fps, fit(sw, sh, W, H))] + encode(fps))


def clip(conf, eid, W, H, out=None, now=None):
    """`clip <id> WxH`: the event's row, its camera's Protect id, the export (first - 5 s .. last + 15 s, <= 90 s) into
    a temp file, one JSON line, then the clip as H.264 at real time. A failure: an error line, then close."""
    import shutil, time, urllib.parse
    out = out or sys.stdout.buffer
    now = now or int(time.time() * 1000)

    def say(o):
        out.write((json.dumps(o) + '\n').encode()); out.flush()
    d = tempfile.mkdtemp(prefix='jap-ridewatch-')
    try:
        row = next((e for e in event_rows(os.path.join(STATE, 'events.json')) if e.get('id') == eid), None)
        if row is None or not isinstance(row.get('cam'), int) or not 0 <= row['cam'] < len(conf['cams']):
            raise ProtectError('event', 'no such event')
        name = conf['cams'][row['cam']]['name']
        if is_rtsp(conf['cams'][row['cam']]):
            raise ProtectError('camera', '%r is not a Protect camera: no clips' % name)
        ids = [conf['cams'][row['cam']].get('protectId')]
        if not ids[0]:                                 # a cams.json written by hand: by name
            try:
                ids = [c.get('id') for c in json.loads(protect_get(conf, '/proxy/protect/api/cameras')) if isinstance(c, dict) and c.get('name') == name]
            except (ValueError, AttributeError, TypeError):
                raise ProtectError('cameras', 'cameras: not a JSON list')
        if not ids or not ids[0]:
            raise ProtectError('camera', 'no Protect camera named %r' % name)
        first = row.get('first', row['ts'])
        start = first - CLIP_PRE
        end = min(max(row['ts'], first) + CLIP_POST, start + CLIP_MAX, now)
        f = os.path.join(d, 'clip.mp4')
        q = {'camera': ids[0], 'start': start, 'end': end, 'channel': EXPORT_CHANNEL}
        with open(f, 'w+b') as fo:
            protect_get(conf, '/proxy/protect/api/video/export?' + urllib.parse.urlencode(q), fo, 30)
            fo.seek(4); magic = fo.read(4)
        if magic != b'ftyp':
            raise ProtectError('export', 'export: not an MP4 (%r)' % magic)
        sw, sh, fps, dur = probe(f)
        if not sw or not sh:
            raise ProtectError('export', 'export: no video stream')
    except ProtectError as e:
        sys.stderr.write('clip %s: %s\n' % (eid, e.args[1]))
        say({'ev': 'clip', 'error': e.args[0]})
        shutil.rmtree(d, ignore_errors=True)
        return 1
    say({'ev': 'clip', 'id': eid, 'cam': row['cam'], 'label': row.get('label', name), 'type': row.get('type'),
         'start': start, 'dur': dur or end - start})
    try:
        return subprocess.call(clip_command(f, W, H, sw, sh, fps), stdin=subprocess.DEVNULL, stdout=out)
    finally:
        shutil.rmtree(d, ignore_errors=True)


ALIAS = re.compile(r'[A-Za-z0-9_-]{1,64}')


def discover(conf, sess=None):
    """cams.json's cameras from Protect's camera list: ([{name, label, protectId, doorbell, channels: [{id, w, h, fps,
    alias}]}], [the channels with RTSP off, "camera: channel"]). A channel needs RTSP turned on in Protect (a View Only
    user cannot do it); a camera with none is left out."""
    try:
        raw = json.loads(protect_get(conf, '/proxy/protect/api/cameras', sess=sess))
        if not isinstance(raw, list):
            raise ValueError
    except ValueError:
        raise ProtectError('cameras', 'cameras: not a JSON list')
    num = lambda v: isinstance(v, int) and not isinstance(v, bool) and 0 < v <= 16384
    cams, off = [], []
    for c in raw:
        if not isinstance(c, dict) or not isinstance(c.get('id'), str) or not isinstance(c.get('name'), str):
            continue
        chans = []
        for ch in c.get('channels') or []:
            if not isinstance(ch, dict) or ch.get('enabled') is False or not isinstance(ch.get('id'), int):
                continue
            if ch.get('isRtspEnabled') and isinstance(ch.get('rtspAlias'), str) and ALIAS.fullmatch(ch['rtspAlias']) \
                    and num(ch.get('width')) and num(ch.get('height')):
                fps = ch.get('fps') if num(ch.get('fps')) and ch['fps'] <= 120 else 30
                chans.append({'id': ch['id'], 'w': ch['width'], 'h': ch['height'], 'fps': fps, 'alias': ch['rtspAlias']})
            else:
                off.append('%s: %s' % (c['name'], ch.get('name') or ch['id']))
        if chans:
            cams.append({'name': c['name'], 'label': c['name'], 'protectId': c['id'],
                         'doorbell': bool((c.get('featureFlags') or {}).get('isDoorbell')), 'channels': chans})
    return cams, off


def layout(cams, W, H):
    """where each camera sits in the mosaic, in stream pixels: the app hit-tests and labels from this"""
    cols, rows = grid(len(cams), W, H)
    tw, th = even(W / cols), even(H / rows)
    ox, oy = (W - cols * tw) // 2, (H - rows * th) // 2          # the pad= centring in command()
    return {'ev': 'layout', 'w': W, 'h': H, 'hero': None,
            'tiles': [{'i': k, 'name': c['name'], 'x': ox + k % cols * tw, 'y': oy + k // cols * th, 'w': tw, 'h': th}
                      for k, c in enumerate(cams)]}


def shape(cam):
    ch = max(cam['channels'], key=lambda c: c['w'] * c['h'])
    r = ch['w'] / ch['h']
    return 'wide' if r > 1.2 else 'round' if r > 0.9 else 'tall'


def size(cam):
    """the camera's picture size (its largest channel): the car frames `cam` views from its aspect"""
    ch = max(cam['channels'], key=lambda c: c['w'] * c['h'])
    return {'w': ch['w'], 'h': ch['h']}


def parse_order(s, n):
    """o=3,1,0,..: the user's arrangement, first the camera at home in the hero's place (unknown or repeated ids
    dropped, missing ones appended): the request line is untrusted"""
    out = []
    for v in s.split(',')[:64]:
        if v.isdigit() and int(v) < n and int(v) not in out:
            out.append(int(v))
    return out + [i for i in range(n) if i not in out]


def arrange(order, hero):
    """the pane's cameras in the user's order: the hero leaves its place to the order's first camera, so nothing
    else moves when an event changes the hero"""
    p = list(order)
    if p[0] != hero:
        p[p.index(hero)] = p[0]
    return p[1:]


def spot_layout(cams, hero, W, H, order=None):
    """Concept A "Projecteur": the hero at its native 16:9 size on the left (1280x720 on a 720-high screen), a
    frosted pane on the right: six 16:9 thumbs in 2 x 3, then a band with one tall (3:4) slot and three round ones.
    A camera whose shape has no free slot of its own takes any free slot, centre-cropped. The cameras take the
    slots in camera order, or in the user's (order: parse_order()), each shape's slots in reading order.
    A 3:4 hero (the doorbell) sits at the left edge at full height, then a free column ("controls": the app puts the
    doorbell's Listen, Talk and quick replies there, never over the picture), then the rest: rows of three 16:9 thumbs
    and a band with one more 16:9 and the three rounds (no tall slot: the tall camera is the hero). The pane's frosted
    glass runs under the column too."""
    cw = 0
    if shape(cams[hero]) == 'tall':
        hc0 = channel(cams[hero], W, H, False)
        hw = even(hc0['w'] * H / hc0['h']); pw = W - hw
        cw = even(W * 7 / 32) if pw - even(W * 7 / 32) >= W // 3 else 0     # 420 on 1920: the chips' rows fit
        x0 = hw + cw; aw = W - x0
        tw = even(aw / 3); th = even(tw * 9 / 16); rows = max(1, H // th - 1); by = rows * th; bh = H - by
        cell = (aw - tw) // 3; rd = even(min(bh - 20, cell - 8))
        slots = [('wide', x0 + c * tw, r * th, tw, th) for r in range(rows) for c in range(3)]
        slots += [('wide', x0, by, tw, bh)]
        slots += [('round', x0 + tw + k * cell + (cell - rd) // 2, by + (bh - rd) // 2, rd, rd) for k in range(3)]
    else:
        hw = min(even(H * 16 / 9), even(W * 2 / 3)); pw = W - hw
        tw = even(pw / 2); th = even(tw * 9 / 16); by = 3 * th; bh = H - by
        tall_w = even(bh * 3 / 4); cell = (pw - tall_w) // 3; rd = even(min(bh - 20, cell - 8))
        slots = [('wide', hw + c * tw, r * th, tw, th) for r in range(3) for c in range(2)]
        slots += [('tall', hw, by, tall_w, bh)]
        slots += [('round', hw + tall_w + k * cell + (cell - rd) // 2, by + (bh - rd) // 2, rd, rd) for k in range(3)]
    others = arrange(order, hero) if order else [i for i in range(len(cams)) if i != hero]
    free, tiles = list(slots), []
    for pass_ in (0, 1):                          # own shape first, then whatever is left
        for i in [i for i in others if i not in {t['i'] for t in tiles}]:
            s = next((s for s in free if pass_ or s[0] == shape(cams[i])), None)
            if s:
                free.remove(s)
                c = cams[i]
                tiles.append({'i': i, 'name': c['name'], 'label': c.get('label', c['name']), 'shape': s[0],
                              'x': s[1], 'y': s[2], 'w': s[3], 'h': s[4]})
    hc = channel(cams[hero], hw, H, False)
    s = min(hw / hc['w'], H / hc['h'])
    rw, rh = even(hc['w'] * s), even(hc['h'] * s)
    lo = {'ev': 'layout', 'w': W, 'h': H, 'hero': hero, 'pane': {'x': hw, 'y': 0, 'w': pw, 'h': H},
          'heroRect': {'x': (hw - rw) // 2, 'y': (H - rh) // 2, 'w': rw, 'h': rh},
          'heroName': cams[hero]['name'], 'heroLabel': cams[hero].get('label', cams[hero]['name']),
          'tiles': sorted(tiles, key=lambda t: (t['y'], t['x']))}
    if cw:
        lo['controls'] = {'x': hw, 'y': 0, 'w': cw, 'h': H}   # (last: an older app ignores it)
    return lo


def cover(w, h):
    return 'scale=%d:%d:force_original_aspect_ratio=increase:%s,crop=%d:%d' % (w, h, BT709, w, h)


def frosted(w, h, dark):
    """a blurred, darkened copy filling w x h: blur at 1/8 size (cheap), scaled back up: the frosted glass"""
    sw, sh = even(w / 8), even(h / 8)
    return 'scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,boxblur=6:2,scale=%d:%d:flags=bicubic,eq=brightness=%.2f:saturation=0.75' % (sw, sh, sw, sh, w, h, dark)


def spot_command(cams, lo, fifos, fps):
    """compositor for spot: input 0 = the hero at heroRect size, 1.. = the tiles at their size (rounds with alpha)"""
    W, H, hr, pane = lo['w'], lo['h'], lo['heroRect'], lo['pane']
    hw = pane['x']
    a = []
    for k, f in enumerate(fifos):
        if k == 0:
            size, pix = (hr['w'], hr['h']), 'yuv420p'
        else:
            t = lo['tiles'][k - 1]; size, pix = (t['w'], t['h']), ('yuva420p' if t['shape'] == 'round' else 'yuv420p')
        a += ['-f', 'rawvideo', '-pix_fmt', pix, '-s', '%dx%d' % size, '-framerate', str(fps),
              '-thread_queue_size', '8', '-i', f]
    fitted = (hr['w'], hr['h']) != (hw, H)
    p = ['[0:v]split=%d[h0][hp]%s' % (3 if fitted else 2, '[hb]' if fitted else '')]
    if fitted:                                    # a 3:4 or square hero: on a blurred copy of itself
        p.append('[hb]%s[hbg]' % frosted(hw, H, -0.18))
        p.append('[hbg][h0]overlay=%d:%d,pad=%d:%d:0:0[b0]' % (hr['x'], hr['y'], W, H))
    else:
        p.append('[h0]pad=%d:%d:0:0[b0]' % (W, H))
    p.append('[hp]%s[pbg]' % frosted(pane['w'], H, -0.12))
    p.append('[b0][pbg]overlay=%d:0[b1]' % hw)
    last = 'b1'
    for k, t in enumerate(lo['tiles']):
        p.append('[%s][%d:v]overlay=%d:%d[b%d]' % (last, k + 1, t['x'], t['y'], k + 2)); last = 'b%d' % (k + 2)
    p.append('[%s]fps=%d,format=yuv420p[v]' % (last, fps))
    return ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin'] + a + ['-filter_complex', ';'.join(p)] + encode(fps)


def spot_pullers(cams, lo, fps):
    """(channel, filter, pix_fmt) for the hero then each tile: decoded and sized in their own process"""
    hr = lo['heroRect']
    hc = channel(cams[lo['hero']], hr['w'], hr['h'], False)
    out = [(hc, 'scale=%d:%d:%s' % (hr['w'], hr['h'], BT709), 'yuv420p')]
    for t in lo['tiles']:
        ch = channel(cams[t['i']], t['w'], t['h'], True)
        if t['shape'] == 'round':                 # square cameras: a circle, soft 1 px edge, the pane shows around it
            vf = cover(t['w'], t['h']) + ",format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='clip((W/2-hypot(X-W/2+0.5,Y-H/2+0.5))*255,0,255)'"
            out.append((ch, vf, 'yuva420p'))
        else:
            out.append((ch, cover(t['w'], t['h']), 'yuv420p'))
    return out


def raw_puller(ch, fifo, vf, pix, fps):
    return (['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-rtsp_transport', 'tcp',
             '-fflags', 'nobuffer', '-flags', 'low_delay'] + PROBE + ['-i', src_url(ch), '-map', '0:v:0', '-an',
            '-vf', KEYGATE + 'fps=%d,%s,setsar=1,format=%s' % (fps, vf, pix), '-f', 'rawvideo', fifo])


def placeholder(w, h, pix, y):
    """one raw frame shown until the camera's first keyframe: flat dark (y), transparent where there is alpha"""
    q = (w // 2) * (h // 2)
    return bytes([y]) * (w * h) + b'\x80' * (2 * q) + (b'\x00' * (w * h) if pix == 'yuva420p' else b'')


def relay(src, fifo, still, fps, real=None):
    """puller stdout -> compositor FIFO as a clock: exactly fps frames a second, each the newest whole frame from the
    puller (`still` until its camera's first keyframe, the last frame again if the camera is late, extra frames
    dropped). Every compositor input is then a steady stream counted in frames: nothing to wait for, no bursts.
    real (a threading.Event): set at the puller's first frame (its camera's keyframe is in)."""
    import threading, time
    fb, latest, done = len(still), [still], []

    def reader():
        buf = bytearray(fb); mv = memoryview(buf)
        while True:
            n = 0
            while n < fb:
                k = src.readinto(mv[n:])
                if not k:
                    done.append(1); return
                n += k
            latest[0] = bytes(buf)
            if real is not None:
                real.set()
    threading.Thread(target=reader, daemon=True).start()
    try:
        with open(fifo, 'wb', buffering=0) as out:
            import fcntl
            try:
                fcntl.fcntl(out.fileno(), 1031, 1 << 20)   # F_SETPIPE_SZ: a hero frame is 1.4 MB, the default pipe 64 KB
            except OSError:
                pass
            t = time.monotonic()
            while not done:
                out.write(latest[0])
                t += 1.0 / fps
                d = t - time.monotonic()
                if d > 0:
                    time.sleep(d)
                elif d < -1:                              # the compositor stalled a whole second: restart the clock
                    sys.stderr.write('relay %s: compositor %.1f s behind\n' % (os.path.basename(fifo), -d))
                    t = time.monotonic()
    except OSError:                                   # compositor gone: the unit ends with it
        pass


# The first IDR waits for the main picture's camera (job 0): the car keeps showing the view before until that IDR,
# so a switch goes from the old picture straight to the new one, never through the dark placeholder (Protect's first
# keyframe: 4.4 s measured). Past HOLD_S the view starts anyway (a dead camera: its placeholder); the car
# gives up on a view with no IDR after 10 s (ridewatchd FIRST_MS).
HOLD_S = 7


def run_tiles(jobs, fps, cmd, hold=True):
    """jobs = [(puller argv, fifo, still)]; runs the compositor on this process's stdout until it ends"""
    import threading
    real = threading.Event()
    for k, (argv, fifo, still) in enumerate(jobs):
        pr = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        threading.Thread(target=log_scrubbed, args=(pr.stderr,), daemon=True).start()
        threading.Thread(target=relay, args=(pr.stdout, fifo, still, fps, real if k == 0 else None), daemon=True).start()
    if hold:
        real.wait(HOLD_S)
    sys.exit(subprocess.call(cmd, stdin=subprocess.DEVNULL))   # pullers share the unit's cgroup: stopped with it


def log_scrubbed(src, out=None, keep=None):
    """a puller's stderr -> the journal, passwords out (keep: a list that also gets the raw lines)"""
    for l in src:
        (out or sys.stderr).write(scrub(l.decode('utf-8', 'replace')))
        if keep is not None:
            keep.append(l)


def mosaic_sources(cams, W, H):
    cols, rows = grid(len(cams), W, H)
    tw, th = even(W / cols), even(H / rows)
    return tw, th, [channel(c, tw, th, True) for c in cams]


def selftest():
    assert grid(11, 1920, 720) == (4, 3), grid(11, 1920, 720)
    assert grid(11, 1836, 720) == (4, 3)
    assert grid(1, 1920, 720) == (1, 1)
    assert 'increase' in fit(640, 360, 480, 240)          # 16:9 into 2:1 crops 11 %: fill
    assert 'decrease' in fit(640, 640, 480, 240)          # square into 2:1: fit
    assert 'decrease' in fit(1280, 720, 1920, 720)        # full screen 16:9 into 8:3: fit, no upscale needed
    cam = {'name': 'x', 'channels': [{'id': 0, 'w': 3840, 'h': 2160, 'alias': 'a0'},
                                     {'id': 1, 'w': 1280, 'h': 720, 'alias': 'a1'},
                                     {'id': 2, 'w': 640, 'h': 360, 'alias': 'a2'}]}
    assert channel(cam, 480, 240, True)['id'] == 2
    assert channel(cam, 1920, 720, False)['id'] == 1      # 1280x720 fits 1920x720 at scale 1: native pixels
    door = {'name': 'd', 'channels': [{'id': 1, 'w': 1440, 'h': 1920, 'fps': 20, 'alias': 'b1'},
                                      {'id': 2, 'w': 480, 'h': 640, 'fps': 20, 'alias': 'b2'},
                                      {'id': 3, 'w': 1600, 'h': 1200, 'fps': 3, 'alias': 'b3'}]}
    assert channel(door, 1920, 720, False)['id'] == 1      # not the 3 fps package channel
    c1 = command([door], 0, 1920, 720); assert c1[c1.index('-r') + 1] == '20'
    cmd = command([cam] * 11, 'mosaic', 1920, 720)
    fc = cmd[cmd.index('-filter_complex') + 1]
    assert 'xstack=inputs=12' in fc and 'color=black:s=480x240' in fc
    assert cmd.count('-i') == 11 and 'repeat-headers=1' in cmd
    cmd = command([cam] * 11, 'mosaic', 1920, 720, ['/f%d' % k for k in range(11)])
    assert cmd.count('rawvideo') == 11 and '480x240' in cmd and 'scale=' not in cmd[cmd.index('-filter_complex') + 1]
    assert cmd.count('-framerate') == 11 and '/f10' in cmd and not any(a.startswith('rtsps') for a in cmd)
    pl = puller({'alias': 'a2', 'w': 640, 'h': 360}, '/f0', 480, 240)
    assert pl[-1] == '/f0' and 'rawvideo' in pl and 'crop=480:240' in pl[pl.index('-vf') + 1]
    assert src_url({'alias': 'a', 'url': 'rtsp://127.0.0.1:1/x'}) == 'rtsp://127.0.0.1:1/x' and src_url({'alias': 'a'}).endswith('/a')
    assert [c['id'] for c in mosaic_sources([cam] * 11, 1920, 720)[2]] == [2] * 11
    lo = layout([cam] * 11, 1836, 720)
    assert len(lo['tiles']) == 11 and lo['tiles'][0]['x'] == 2 and lo['tiles'][4] == {'i': 4, 'name': 'x', 'x': 2, 'y': 240, 'w': 458, 'h': 240}
    assert lo['tiles'][3]['x'] + lo['tiles'][3]['w'] <= 1836
    # spot (concept A) with the real camera set's shapes: 7 wide, 1 tall door, 3 round
    sq = {'name': 's', 'channels': [{'id': 1, 'w': 1280, 'h': 1280, 'fps': 24, 'alias': 's1'}, {'id': 2, 'w': 720, 'h': 720, 'fps': 24, 'alias': 's2'}]}
    real = [door] + [cam] * 7 + [sq] * 3
    assert [shape(c) for c in real] == ['tall'] + ['wide'] * 7 + ['round'] * 3
    lo = spot_layout(real, 1, 1920, 720)                    # a wide hero: native 1280x720, every slot by its own shape
    assert lo['heroRect'] == {'x': 0, 'y': 0, 'w': 1280, 'h': 720} and len(lo['tiles']) == 10
    assert [t['shape'] for t in lo['tiles'] if t['i'] == 0] == ['tall'] and sum(t['shape'] == 'round' for t in lo['tiles']) == 3
    assert all(t['x'] >= 1280 and t['x'] + t['w'] <= 1920 and t['y'] + t['h'] <= 720 for t in lo['tiles'])
    assert all(t['w'] % 2 == 0 and t['h'] % 2 == 0 for t in lo['tiles'])
    assert {(t['w'], t['h']) for t in lo['tiles'] if t['shape'] == 'wide'} == {(320, 180)}
    # the doorbell hero: 540x720 at the left edge, the controls column 540-960 free, the rest 3 x 3 thumbs + a band
    lo = spot_layout(real, 0, 1920, 720)
    assert lo['heroRect'] == {'x': 0, 'y': 0, 'w': 540, 'h': 720} and lo['pane'] == {'x': 540, 'y': 0, 'w': 1380, 'h': 720}
    assert lo['controls'] == {'x': 540, 'y': 0, 'w': 420, 'h': 720} and len(lo['tiles']) == 10
    assert not any(t['shape'] == 'tall' for t in lo['tiles']) and sum(t['shape'] == 'round' for t in lo['tiles']) == 3
    assert all(t['x'] >= 960 and t['x'] + t['w'] <= 1920 and t['y'] + t['h'] <= 720 for t in lo['tiles'])   # none in the column
    assert all(t['w'] % 2 == 0 and t['h'] % 2 == 0 for t in lo['tiles'])
    assert {(t['w'], t['h']) for t in lo['tiles'] if t['shape'] == 'wide'} == {(320, 180)}
    assert {(t['w'], t['h'], t['y']) for t in lo['tiles'] if t['shape'] == 'round'} == {(160, 160, 550)}
    assert 'controls' not in spot_layout(real, 1, 1920, 720)  # a wide hero: no column
    fps = 30; srcs = spot_pullers(real, lo, fps)
    cmd = spot_command(real, lo, ['/f%d' % k for k in range(11)], fps)
    fc = cmd[cmd.index('-filter_complex') + 1]
    assert cmd.count('-i') == 11 and cmd.count('yuva420p') == 3 and fc.count('overlay=') == 11   # no blurred copy behind the hero
    assert "geq=" in srcs[-1][1] and srcs[0][1].startswith('scale=540:720') and 'split=2' in fc and 'overlay=540:0' in fc
    cmd = spot_command(real, spot_layout(real, 1, 1920, 720), ['/f%d' % k for k in range(11)], fps)
    assert 'split=2' in cmd[cmd.index('-filter_complex') + 1]
    # events feed: initial list, then only changed rows, pings when idle
    import io
    global STATE
    d = tempfile.mkdtemp(); STATE = d; p = os.path.join(d, 'events.json')
    json.dump([{'id': 'a' * 12, 'cam': 1, 'label': 'Garage', 'type': 'person', 'ts': 1, 'count': 1, 'thumb': False}], open(p, 'w'))
    steps = iter([lambda: None,
                  lambda: (json.dump([{'id': 'a' * 12, 'cam': 1, 'label': 'Garage', 'type': 'person', 'ts': 2, 'count': 2, 'thumb': True},
                                      {'id': 'b' * 12, 'cam': 0, 'label': 'Door', 'type': 'ring', 'ts': 3, 'count': 1, 'thumb': False}],
                                     open(p + '.tmp', 'w')), os.replace(p + '.tmp', p))]
                 + [lambda: None] * 40)
    buf = io.StringIO()
    events_feed(buf, polls=33, sleep=lambda s: next(steps)())
    raw = buf.getvalue().splitlines(True)
    lines = [json.loads(l) for l in raw]
    assert lines[0]['ev'] == 'events' and len(lines[0]['list']) == 1
    assert [(l['ev'], l.get('id', '')[:1], l.get('count')) for l in lines[1:3]] == [('event', 'a', 2), ('event', 'b', 1)]
    assert len(lines) == 4
    # v1 bytes (an older car reads these): the rows as they were; the first line and the ping only gain "tz" at the end
    assert raw[0] == json.dumps({'ev': 'events', 'list': lines[0]['list']})[:-1] + ', "tz": %d}\n' % tz(), raw[0]
    assert raw[2] == '{"id": "bbbbbbbbbbbb", "cam": 0, "label": "Door", "type": "ring", "ts": 3, "count": 1, "thumb": false, "ev": "event"}\n', raw[2]
    assert raw[3] == '{"ev":"ping"}'[:-1] + ',"tz":%d}\n' % tz(), raw[3]
    assert isinstance(tz(), int) and -840 <= tz() <= 840
    assert len(placeholder(320, 180, 'yuv420p', 28)) == 320 * 180 * 3 // 2
    a = placeholder(160, 160, 'yuva420p', 28); assert len(a) == 160 * 160 * 5 // 2 and a[-1] == 0 and a[0] == 28
    import threading, time as _t
    d2 = tempfile.mkdtemp(); ff = os.path.join(d2, 'f'); os.mkfifo(ff)
    r, w = os.pipe(); src = os.fdopen(r, 'rb')
    th = threading.Thread(target=relay, args=(src, ff, b'S' * 4, 50)); th.start()
    rd = os.open(ff, os.O_RDONLY); _t.sleep(0.15); os.write(w, b'REAL'); _t.sleep(0.1); os.close(w)
    got = b''
    while True:
        b = os.read(rd, 4096)
        if not b: break
        got += b
    th.join(); os.close(rd); import shutil; shutil.rmtree(d); shutil.rmtree(d2)
    assert got.startswith(b'SSSS') and b'REAL' in got and len(got) % 4 == 0, got
    # the hold: set by the first whole frame from the puller, not by the placeholder
    d3 = tempfile.mkdtemp(); f3 = os.path.join(d3, 'f'); os.mkfifo(f3)
    r, w = os.pipe(); ev = threading.Event()
    th = threading.Thread(target=relay, args=(os.fdopen(r, 'rb'), f3, b'S' * 4, 50, ev)); th.start()
    rd = os.open(f3, os.O_RDONLY); _t.sleep(0.1); assert not ev.is_set()
    os.write(w, b'RE'); _t.sleep(0.05); assert not ev.is_set(); os.write(w, b'AL'); assert ev.wait(1)
    os.close(w); th.join(); os.close(rd); shutil.rmtree(d3)
    # the user's order: the pane keeps it, the hero leaves its place to the order's first camera
    assert parse_order('3,x,1,3,99', 5) == [3, 1, 0, 2, 4] and parse_order('', 3) == [0, 1, 2]
    assert arrange([3, 1, 0, 2, 4], 3) == [1, 0, 2, 4] and arrange([3, 1, 0, 2, 4], 0) == [1, 3, 2, 4]
    wide = lambda lo: [t['i'] for t in sorted(lo['tiles'], key=lambda t: (t['y'], t['x'])) if t['shape'] == 'wide']
    assert wide(spot_layout(real, 1, 1920, 720)) == [2, 3, 4, 5, 6, 7]
    o = parse_order('1,7,6,5,4,3,2,0,10,9,8', 11)
    lo = spot_layout(real, 1, 1920, 720, o)
    assert wide(lo) == [7, 6, 5, 4, 3, 2] and [t['i'] for t in lo['tiles'] if t['shape'] == 'round'] == [10, 9, 8]
    assert wide(spot_layout(real, 6, 1920, 720, o)) == [7, 1, 5, 4, 3, 2]      # hero 6: 1 takes its place
    assert [(t['shape'], t['y']) for t in spot_layout(real, 0, 1920, 720, o)['tiles'] if t['i'] == 1] == [('wide', 360)]   # door hero: the 7th wide in the third row
    assert size(door) == {'w': 1440, 'h': 1920}
    h = hashlib.sha256(b'AAAA-BBBB').hexdigest()
    assert digest('AAAA-BBBB') == h and tokens({}) == []
    assert tokens({'cars': ['AAAA-BBBB', 7, '', 'sha256:' + 'a' * 64, 'sha256:' + 'A' * 64], 'token': 'old'}) == \
        [digest('old').encode(), h.encode(), b'a' * 64, digest('sha256:' + 'A' * 64).encode()], 'an upper-case "hash" is a plain code'
    assert [c['id'] for c in candidates([{'id': 0, 'w': 9, 'h': 9}, {'id': 2, 'w': 4, 'h': 4}, {'id': 3, 'w': 1, 'h': 1, 'fps': 3}])] == [2]
    assert [c['id'] for c in candidates([{'id': 0, 'w': 9, 'h': 9}])] == [0], 'the main channel only when it is the only one'
    use({'protect': {'host': '192.0.2.1'}}); assert src_url({'alias': 'abc'}) == 'rtsps://192.0.2.1:7441/abc'
    rtsp_url_selftest()
    clip_selftest()
    golden_selftest()
    rtsp_feed_selftest()
    audio_selftest()
    print('selftest ok')


PW = 's3cr%40t'                                       # the password in the test urls: must never be printed


def rtsp_url_selftest():
    """section 4.4's table: what may go into ffmpeg's argv as -i"""
    good = ['rtsp://192.0.2.10/live', 'rtsp://192.0.2.10', 'rtsps://cam.example.com:7441/aBc_1-2',
            'rtsp://viewer:%s@192.0.2.10:554/Streaming/Channels/101' % PW, 'rtsp://viewer@cam.example.com/x',
            'rtsp://[2001:db8::1]:554/x', 'rtsp://[::1]/x', 'rtsp://cam.example.com/live?channel=1&subtype=0',
            'rtsp://cam.example.com:65535/x', 'rtsp://cam.example.com:1/x', 'rtsp://h/' + 'a' * 500]
    for u in good:                                    # (no port: the scheme's default, 554 or 322)
        assert rtsp_url(u) == u, u
    bad = ['-i', '-rtsp://h/x', 'file:/etc/passwd', 'file:///etc/passwd', 'concat:rtsp://h/a|file:/x', 'pipe:0', 'pipe:',
           'subfile,,start,0,end,0,,:rtsp://h/x', 'http://h/x', 'https://h/x', 'tcp://h:554', 'RTSP://h/x', 'rtp://h:5004',
           'rtsp://h/x -f lavfi', 'rtsp://h/x\n-i file:/etc/passwd', 'rtsp://h/x\r', 'rtsp://h/x\t', 'rtsp://h/a b',
           ' rtsp://h/x', 'rtsp://h/x\x00', 'rtsp://h/x\x7f', 'rtsp://hé/x', 'rtsp://h/' + 'a' * 600, '', None, 5,
           'rtsp://h"/x', "rtsp://h/x'", 'rtsp://h\\x/', 'rtsp:///x', 'rtsp://h_x/y', 'rtsp://:554/x',
           'rtsp://[2001:db8::zz]/x', 'rtsp://[::1/x', 'rtsp://::1/x', 'rtsp://h:0/x', 'rtsp://h:65536/x', 'rtsps://h:99999/x',
           'rtsp://h:/x', 'rtsp://h:5a/x', 'rtsp://viewer:p@ss@192.0.2.10/x', 'rtsp://viewer:p ss@192.0.2.10/x',
           'rtsp://viewer:%s@192.0.2.10:0/x' % PW, 'rtsp://viewer:%s@[zz]/x' % PW]
    for u in bad:
        try:
            rtsp_url(u); assert False, u
        except ValueError as e:
            assert 's3cr' not in str(e) and 'p@ss' not in str(e), e
    try:
        src_url({'url': 'file:/etc/passwd'}); assert False
    except ValueError as e:
        assert 'refused' in str(e) and 'passwd' not in str(e)
    assert all(WHITELIST == a[a.index('-protocol_whitelist'):a.index('-protocol_whitelist') + 2]
               for a in (puller({'url': 'rtsp://h/x', 'w': 640, 'h': 360}, '/f', 320, 180),
                         raw_puller({'url': 'rtsp://h/x'}, '/f', 'null', 'yuv420p', 30),
                         inputs([{'url': 'rtsp://h/x'}]))), 'every camera open has the whitelist'
    line = 'Error opening input file rtsp://viewer:%s@127.0.0.1:1/x.\n' % PW    # ffmpeg 8.1's own line
    assert scrub(line) == 'Error opening input file rtsp://***@127.0.0.1:1/x.\n' and scrub('rtsp://h/x a@b') == 'rtsp://h/x a@b'
    assert is_rtsp({'kind': 'rtsp'}) and is_rtsp({'name': 'Gate', 'channels': [{'id': 1, 'url': 'rtsp://h/x'}]})
    assert not is_rtsp({'name': 'Door'}) and not is_rtsp({'protectId': 'c0', 'channels': [{'url': 'rtsp://h/x'}]})
    assert not is_rtsp({'channels': [{'alias': 'a', 'url': 'rtsp://h/x'}]}) and not is_rtsp({'kind': 'protect', 'channels': [{'url': 'x'}]})
    assert rate('0/0') == 0 and rate('inf/1') == 0 and rate('25/1') == 25 and rate(None) == 0 and rate('30000/1001') == 30
    import io, shutil
    if shutil.which('ffmpeg'):                        # a real puller's stderr, through the journal path
        p = subprocess.run(puller({'url': 'rtsp://viewer:%s@127.0.0.1:9/x' % PW, 'w': 640, 'h': 360}, '-', 320, 180),
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
        buf = io.StringIO(); log_scrubbed(io.BytesIO(p.stderr), buf)
        assert PW not in buf.getvalue(), buf.getvalue()
    print('rtsp url selftest ok')


def rtsp_feed_selftest():
    """a testsrc RTSP feed through a real puller (needs mediamtx; skipped without it, or when it or the feed does not
    come up: this runs at install, on machines that may already run their own mediamtx)"""
    import shutil, socket, time
    if not (shutil.which('mediamtx') and shutil.which('ffmpeg')):
        print('rtsp feed selftest skipped (no mediamtx)'); return
    d = tempfile.mkdtemp(); y = os.path.join(d, 'm.yml')
    open(y, 'w').write('rtspAddress: 127.0.0.1:18554\nrtmp: no\nhls: no\nwebrtc: no\nsrt: no\npaths:\n  t: {}\n')
    m = subprocess.Popen(['mediamtx', y], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=d)
    up = False
    for _ in range(30):
        time.sleep(0.1)
        try:
            socket.create_connection(('127.0.0.1', 18554), 0.5).close(); up = m.poll() is None; break
        except OSError:
            pass
    if not up:
        m.kill(); m.wait(); shutil.rmtree(d); print('rtsp feed selftest skipped (mediamtx did not start)'); return
    pub = subprocess.Popen(['ffmpeg', '-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-c:v', 'libx264',
                            '-bf', '0', '-g', '25', '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://127.0.0.1:18554/t'],
                           stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    try:
        if pub.poll() is not None:
            print('rtsp feed selftest skipped (the test feed did not start)'); return
        argv = puller({'url': 'rtsp://127.0.0.1:18554/t', 'w': 320, 'h': 180}, '-', 160, 90)
        got = subprocess.run(argv[:-1] + ['-frames:v', '5', '-'], stdin=subprocess.DEVNULL, capture_output=True, timeout=20).stdout
    finally:
        for x in (pub, m):
            x.kill(); x.wait()
        shutil.rmtree(d)
    assert len(got) == 160 * 90 * 3 // 2 * 5, len(got)
    print('rtsp feed selftest ok')


def golden_selftest():
    """the requests an older car sends, through main() as systemd runs it (stdin/stdout = the socket): the replies byte
    for byte as before hello; hello itself; a wrong code or an unknown request: nothing"""
    import shutil
    d = tempfile.mkdtemp(); c = os.path.join(d, 'cams.json')
    json.dump({'cars': ['AAAA-BBBB-CCCC-DDDD'], 'protect': {'host': '192.0.2.1'}, 'cams': [
        {'name': 'Door', 'label': 'Front door', 'roles': ['door', 'x'], 'channels': [{'id': 1, 'w': 1440, 'h': 1920, 'fps': 20, 'alias': 'd1', 'url': 'rtsp://127.0.0.1:9/d'}]},
        {'name': 'Yard', 'roles': ['day'], 'channels': [{'id': 1, 'w': 1280, 'h': 720, 'fps': 30, 'alias': 'y1', 'url': 'rtsp://127.0.0.1:9/y'},
                                                        {'id': 2, 'w': 640, 'h': 360, 'alias': 'y2', 'url': 'rtsp://127.0.0.1:9/y2'}]},
        {'name': 'Round', 'label': 'Patio', 'channels': [{'id': 1, 'w': 1024, 'h': 1024, 'alias': 'r1', 'url': 'rtsp://127.0.0.1:9/r'}]}]}, open(c, 'w'))
    json.dump([{'id': 'a' * 12, 'cam': 1, 'label': 'Yard', 'type': 'person', 'ts': 1762300000000, 'first': 1762299990000, 'count': 2, 'thumb': True}],
              open(os.path.join(d, 'events.json'), 'w'))
    os.mkdir(os.path.join(d, 'thumbs')); open(os.path.join(d, 'thumbs', 'a' * 12 + '.jpg'), 'wb').write(b'\xff\xd8JPEG')
    env = dict(os.environ, JAP_RIDEWATCH_CONF=c, JAP_RIDEWATCH_STATE=d, TMPDIR=d)    # (a view's FIFO folder: removed with d)

    def ask(req, line=True):
        p = subprocess.Popen([sys.executable, os.path.abspath(__file__)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        p.stdin.write(b'AAAA-BBBB-CCCC-DDDD ' + req + b'\n'); p.stdin.flush()
        b = p.stdout.readline() if line else p.stdout.read()
        try:
            os.killpg(p.pid, signal.SIGKILL)          # with a view's ffmpeg pullers
        except OSError:                               # (already gone: macOS says EPERM for a group of zombies)
            pass
        p.wait(); p.stdout.close(); p.stdin.close()
        return b
    V1 = [(b'list', b'[{"i": 0, "name": "Door", "label": "Front door", "shape": "tall", "roles": ["door"], "w": 1440, "h": 1920}, {"i": 1, "name": "Yard", "label": "Yard", "shape": "wide", "roles": ["day"], "w": 1280, "h": 720}, {"i": 2, "name": "Round", "label": "Patio", "shape": "round", "roles": [], "w": 1024, "h": 1024}]\n'),
          (b'mosaic2 1920x720', b'{"ev": "layout", "w": 1920, "h": 720, "hero": null, "tiles": [{"i": 0, "name": "Door", "x": 0, "y": 0, "w": 960, "h": 360}, {"i": 1, "name": "Yard", "x": 960, "y": 0, "w": 960, "h": 360}, {"i": 2, "name": "Round", "x": 0, "y": 360, "w": 960, "h": 360}]}\n'),
          (b'spot 0 1920x720', b'{"ev": "layout", "w": 1920, "h": 720, "hero": 0, "pane": {"x": 540, "y": 0, "w": 1380, "h": 720}, "heroRect": {"x": 0, "y": 0, "w": 540, "h": 720}, "heroName": "Door", "heroLabel": "Front door", "tiles": [{"i": 1, "name": "Yard", "label": "Yard", "shape": "wide", "x": 960, "y": 0, "w": 320, "h": 180}, {"i": 2, "name": "Round", "label": "Patio", "shape": "round", "x": 1306, "y": 550, "w": 160, "h": 160}], "controls": {"x": 540, "y": 0, "w": 420, "h": 720}}\n'),   # 0.5.5: the doorbell at the left edge, its controls column
          (b'spot 1 o=2,0,1 1836x720', b'{"ev": "layout", "w": 1836, "h": 720, "hero": 1, "pane": {"x": 1224, "y": 0, "w": 612, "h": 720}, "heroRect": {"x": 0, "y": 16, "w": 1224, "h": 688}, "heroName": "Yard", "heroLabel": "Yard", "tiles": [{"i": 0, "name": "Door", "label": "Front door", "shape": "tall", "x": 1224, "y": 516, "w": 152, "h": 204}, {"i": 2, "name": "Round", "label": "Patio", "shape": "round", "x": 1380, "y": 546, "w": 144, "h": 144}]}\n')]
    for req, want in V1:
        got = ask(req)
        if req == b'list':                            # v1 keys byte for byte; "kind" only appended at the end of each row
            rows = json.loads(got)
            assert [list(r)[-1] for r in rows] == ['kind'] * 3 and {r.pop('kind') for r in rows} == {'protect'}, got
            got = (json.dumps(rows) + '\n').encode()
        assert got == want, (req, got)
    ev = b'{"ev": "events", "list": [{"id": "aaaaaaaaaaaa", "cam": 1, "label": "Yard", "type": "person", "ts": 1762300000000, "first": 1762299990000, "count": 2, "thumb": true}]}\n'
    got = ask(b'events'); assert got == ev[:-2] + (', "tz": %d}\n' % tz()).encode(), got
    assert ask(b'thumb ' + b'a' * 12, False) == b'\xff\xd8JPEG' and ask(b'thumb ' + b'b' * 12, False) == b''
    h = json.loads(ask(b'hello'))
    assert h == {'ev': 'hello', 'proto': 2, 'server': VERSION, 'tz': tz(), 'caps': ['rtsp']}, h   # no "audio": true, no listen or talk
    assert list(h) == ['ev', 'proto', 'server', 'tz', 'caps']
    for req in (b'nope', b'hello x'):
        assert ask(req, False) == b'', req
    p = subprocess.run([sys.executable, os.path.abspath(__file__)], input=b'WRONG-CODE list\n', capture_output=True, env=env)
    assert p.stdout == b'' and p.returncode == 1, 'a wrong code: closed without a word'
    p = subprocess.run([sys.executable, os.path.abspath(__file__)], input=b'WRONG-CODE hello\n', capture_output=True, env=env)
    assert p.stdout == b'' and p.returncode == 1, 'hello says nothing to an unknown car'
    # a car stored as its hash (configure.py, the pairing page): its code gets in, the hash itself does not
    json.dump(dict(json.load(open(c)), cars=['sha256:' + digest('AAAA-BBBB-CCCC-DDDD')]), open(c, 'w'))
    assert json.loads(ask(b'hello'))['ev'] == 'hello'
    p = subprocess.run([sys.executable, os.path.abspath(__file__)], input=b'sha256:%s hello\n' % digest('AAAA-BBBB-CCCC-DDDD').encode(),
                       capture_output=True, env=env)
    assert p.stdout == b'' and p.returncode == 1, 'the stored hash is not a password'
    # no Protect at all: RTSP cameras only (one added by configure.py, one older hand-added row); no clips for them
    json.dump({'cars': ['AAAA-BBBB-CCCC-DDDD'], 'cams': [
        {'name': 'Gate', 'label': 'Gate', 'kind': 'rtsp', 'roles': ['day'],
         'channels': [{'id': 0, 'w': 1920, 'h': 1080, 'fps': 25, 'url': 'rtsp://viewer:%s@127.0.0.1:9/live' % PW}]},
        {'name': 'Shed', 'channels': [{'id': 1, 'w': 640, 'h': 480, 'fps': 15, 'url': 'rtsps://[::1]:9/s'}]}]}, open(c, 'w'))
    json.dump([{'id': 'c' * 12, 'cam': 0, 'label': 'Gate', 'type': 'person', 'ts': 1762300000000, 'count': 1, 'thumb': False}],
              open(os.path.join(d, 'events.json'), 'w'))
    rows = json.loads(ask(b'list'))
    assert [(r['name'], r['kind'], r['shape']) for r in rows] == [('Gate', 'rtsp', 'wide'), ('Shed', 'rtsp', 'wide')], rows
    for req in (b'list', b'mosaic2 1920x720', b'spot 0 1920x720', b'spot 1 o=1,0 1920x720'):
        got = ask(req); assert PW.encode() not in got and b'viewer' not in got and json.loads(got), (req, got)
    assert json.loads(ask(b'spot 1 1920x720'))['heroName'] == 'Shed'
    assert json.loads(ask(b'clip ' + b'c' * 12 + b' 640x240')) == {'ev': 'clip', 'error': 'camera'}
    assert json.loads(ask(b'hello'))['caps'] == ['rtsp']
    for req in (b'listen 0', b'talk 0'):             # camera 0 has the door role, but no "audio": true
        assert json.loads(ask(req)) == {'ev': req.split()[0].decode(), 'error': 'off'}, req
    json.dump({'cars': ['AAAA-BBBB-CCCC-DDDD'], 'cams': []}, open(c, 'w'))
    assert ask(b'list') == b'[]\n' and ask(b'mosaic2 1920x720', False) == b'', 'no camera: an empty list, no mosaic'
    shutil.rmtree(d)
    print('v1 golden + hello + no-Protect selftest ok')


def clip_selftest():
    """`clip` against a fake Protect (http://127.0.0.1) and a 1 s MP4 from ffmpeg's testsrc (skipped without ffmpeg)"""
    import http.server, shutil, threading
    global STATE
    if not shutil.which('ffmpeg'):
        print('clip selftest skipped (no ffmpeg)'); return
    d = tempfile.mkdtemp(); STATE = d
    mp4 = os.path.join(d, 't.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=1', '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p', mp4], check=True)
    P = {'logins': 0, 'token': 't1', 'asked': [], 'mp4': open(mp4, 'rb').read()}

    class Fake(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, st, body=b'', hdr=()):
            self.send_response(st)
            for k, v in hdr:
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

        def do_POST(self):
            b = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            P['logins'] += 1
            if self.path != '/api/auth/login' or b != {'username': 'u', 'password': 'p', 'rememberMe': False}:
                return self.reply(401)
            self.reply(200, b'{}', [('Set-Cookie', 'TOKEN=%s; path=/; samesite=strict; secure; httponly' % P['token']), ('X-CSRF-Token', 'c-' + P['token'])])

        def do_GET(self):
            if P.get('deny') or self.headers.get('Cookie') != 'TOKEN=' + P['token'] or self.headers.get('X-CSRF-Token') != 'c-' + P['token']:
                return self.reply(401)
            if self.path == '/proxy/protect/api/cameras':
                P['camlists'] = P.get('camlists', 0) + 1
                return self.reply(200, json.dumps(CAMERAS).encode())
            P['asked'].append(self.path)
            self.reply(200, P['mp4'])

        def do_PATCH(self):
            if self.headers.get('Cookie') != 'TOKEN=' + P['token'] or self.headers.get('X-CSRF-Token') != 'c-' + P['token']:
                return self.reply(401)
            P['patched'] = (self.path, self.headers.get('Content-Type'), json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            self.reply(200, b'{"ok":1}')
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ['JAP_RIDEWATCH_PROTECT_URL'] = 'http://127.0.0.1:%d' % srv.server_address[1]
    now = 1762300000000
    json.dump([{'id': 'a' * 12, 'cam': 1, 'label': 'Garage', 'type': 'person', 'ts': now - 60000, 'first': now - 70000, 'count': 2, 'thumb': True},
               {'id': 'b' * 12, 'cam': 2, 'label': 'Attic', 'type': 'animal', 'ts': now - 5000, 'first': now - 5000, 'count': 1, 'thumb': False}],
              open(os.path.join(d, 'events.json'), 'w'))
    conf = {'cams': [{'name': 'Door'}, {'name': 'Garage'}, {'name': 'Attic'}], 'protect': {'host': '192.0.2.1', 'username': 'u', 'password': 'p'}}

    def run(eid, c=conf):
        o = tempfile.TemporaryFile()
        rc = clip(c, eid, 640, 240, o, now)
        o.seek(0); b = o.read()
        k = b.index(b'\n')
        return rc, json.loads(b[:k]), b[k + 1:]
    rc, j, v = run('a' * 12)
    assert rc == 0 and j['ev'] == 'clip' and (j['id'], j['cam'], j['label'], j['type']) == ('a' * 12, 1, 'Garage', 'person'), j
    assert j['start'] == now - 75000 and 900 <= j['dur'] <= 1100, j
    assert P['asked'] == ['/proxy/protect/api/video/export?camera=c1&start=%d&end=%d&channel=0' % (now - 75000, now - 45000)], P['asked']
    assert all(b'\x00\x00\x01' + bytes([t]) in v for t in (0x67, 0x68, 0x65)), 'Annex-B with SPS, PPS, IDR'
    assert P['logins'] == 1 and os.stat(session_path()).st_mode & 0o777 == 0o600
    run('a' * 12)
    assert P['logins'] == 1, 'the cached session is reused'
    P['token'] = 't2'                                 # the session expired on the console: one new login, then the clip
    rc, j, _ = run('b' * 12)
    assert P['logins'] == 2 and j.get('error') == 'camera', (P['logins'], j)   # (no Protect camera named Attic)
    P['deny'] = True                                  # 401 even right after a login: no second login, no loop
    rc, j, _ = run('a' * 12)
    assert P['logins'] == 3 and j == {'ev': 'clip', 'error': 'cameras'}, (P['logins'], j)
    P['deny'] = False; P['mp4'] = b'<html>nope</html>'
    rc, j, v = run('a' * 12)
    assert j == {'ev': 'clip', 'error': 'export'} and v == b'' and P['logins'] == 3
    rc, j, v = run('c' * 12)
    assert rc == 1 and j == {'ev': 'clip', 'error': 'event'} and v == b''
    os.unlink(session_path()); P['token'] = 't3'
    rc, j, _ = run('a' * 12, dict(conf, protect={'username': 'u', 'password': 'wrong'}))
    assert j == {'ev': 'clip', 'error': 'login'} and P['logins'] == 4, 'a refused login: once, said'
    rc, j, _ = run('a' * 12, {'cams': conf['cams']})
    assert j == {'ev': 'clip', 'error': 'config'} and P['logins'] == 4
    rtsp = [{'name': 'Door'}, {'name': 'Garage', 'kind': 'rtsp', 'channels': [{'id': 0, 'w': 640, 'h': 360, 'url': 'rtsp://h/x'}]}]
    rc, j, _ = run('a' * 12, dict(conf, cams=rtsp))
    assert rc == 1 and j == {'ev': 'clip', 'error': 'camera'} and P['logins'] == 4, 'an RTSP camera: no clip, Protect not asked'
    s = login(conf, save=False)
    assert P['logins'] == 5 and s['cookie'] == 'TOKEN=t3' and not os.path.exists(session_path()), 'a one-time login: nothing on disk'
    login(conf); assert os.path.exists(session_path()), 'the default still saves it'
    os.unlink(session_path())
    # a camera discovered with its Protect id: the export asks for it without the camera list
    P['camlists'] = 0; P['asked'] = []; P['mp4'] = open(mp4, 'rb').read()
    rc, j, _ = run('a' * 12, dict(conf, cams=[{'name': 'Door'}, {'name': 'Renamed', 'protectId': 'c1'}]))
    assert rc == 0 and P['camlists'] == 0 and 'camera=c1&' in P['asked'][0], (P, j)
    # discovery: RTSP channels kept (aliases, sizes), RTSP off listed, cameras without any left out, junk ignored
    cams, off = discover(conf)
    assert [c['name'] for c in cams] == ['Door', 'Garage'] and cams[0]['doorbell'] and not cams[1]['doorbell'], cams
    assert cams[0]['protectId'] == 'c0' and cams[0]['channels'] == [{'id': 0, 'w': 1600, 'h': 1200, 'fps': 30, 'alias': 'dOoR0'}], cams[0]
    assert [ch['alias'] for ch in cams[1]['channels']] == ['gA1', 'gA2'] and cams[1]['channels'][1]['fps'] == 30, cams[1]
    assert off == ['Door: Medium', 'Garage: bad', 'Shed: High'], off
    # protect_req: another method with a JSON body, the same session rules (an expired one: one new login, one retry)
    n = P['logins']; P['token'] = 't4'
    assert protect_req(conf, 'PATCH', '/proxy/protect/api/cameras/c0', {'a': [1]}) == b'{"ok":1}' and P['logins'] == n + 1
    assert P['patched'] == ('/proxy/protect/api/cameras/c0', 'application/json', {'a': [1]}), P['patched']
    os.environ.pop('JAP_RIDEWATCH_PROTECT_URL')
    try:
        base({'protect': {'host': 'x/y'}}); assert False
    except ProtectError as e:
        assert e.args[0] == 'config'
    assert base({'protect': {'host': '192.0.2.1'}}) == 'https://192.0.2.1'
    srv.shutdown(); shutil.rmtree(d)
    print('clip + discovery selftest ok')


def audio_selftest():
    """listen and talk through main() (pipes for the socket), against a fake Protect camera list and a UDP receiver on
    127.0.0.1 standing in for the doorbell's talkback port; the listen source is a local file (JAP_RIDEWATCH_TEST_AUDIO)"""
    import http.server, math, shutil, socket, struct, threading, time
    if audio_caps() != ['listen', 'talk']:
        print('audio selftest skipped (no ffmpeg with AAC)'); return
    d = tempfile.mkdtemp(); c = os.path.join(d, 'cams.json')
    door, mute = os.path.join(d, 'door.wav'), os.path.join(d, 'mute.nut')
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=2', '-ar', '48000', door], check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5:duration=1', '-c:v', 'rawvideo', mute], check=True)
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); rx.bind(('127.0.0.1', 0)); rx.settimeout(0.2)
    got, done = [], []

    def recv():
        while not done:
            try:
                got.append(rx.recv(65536))
            except socket.timeout:
                pass
    threading.Thread(target=recv, daemon=True).start()
    tb = {'typeFmt': 'aac', 'typeIn': 'serverudp', 'bindPort': rx.getsockname()[1], 'samplingRate': 22050, 'channels': 1}
    recs = [{'id': 'c0', 'name': 'Door', 'host': '127.0.0.1', 'featureFlags': {'isDoorbell': True, 'hasSpeaker': True}, 'talkbackSettings': tb},
            {'id': 'c1', 'name': 'Garage', 'host': '127.0.0.1', 'featureFlags': {'hasSpeaker': False}, 'talkbackSettings': tb}]
    P = {'deny': False}

    class Fake(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, st, body=b'', hdr=()):
            self.send_response(st)
            for k, v in hdr:
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            self.reply(200, b'{}', [('Set-Cookie', 'TOKEN=t; path=/'), ('X-CSRF-Token', 'c')])

        def do_GET(self):
            if P['deny'] or self.path != '/proxy/protect/api/cameras':
                return self.reply(403)
            self.reply(200, json.dumps(recs).encode())
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    D = ['door']                                      # listen and talk only reach cameras with the door role
    conf = {'cars': ['AAAA-BBBB-CCCC-DDDD'], 'audio': True, 'protect': {'host': '127.0.0.1', 'username': 'u', 'password': 'p'}, 'cams': [
        {'name': 'Door', 'protectId': 'c0', 'roles': D, 'channels': [{'id': 1, 'w': 1440, 'h': 1920, 'alias': 'd1', 'url': 'rtsp://127.0.0.1:9/d'}]},
        {'name': 'Garage', 'protectId': 'c1', 'roles': D, 'channels': [{'id': 1, 'w': 1280, 'h': 720, 'alias': 'g1', 'url': 'rtsp://127.0.0.1:9/g'}]},
        {'name': 'Gate', 'kind': 'rtsp', 'roles': D, 'channels': [{'id': 0, 'w': 1280, 'h': 720, 'url': 'rtsp://127.0.0.1:9/x'}]},
        {'name': 'Hall', 'protectId': 'c0', 'roles': ['day', 'indoor'], 'channels': [{'id': 1, 'w': 1280, 'h': 720, 'alias': 'h1', 'url': 'rtsp://127.0.0.1:9/h'}]}]}
    json.dump(conf, open(c, 'w'))
    env = dict(os.environ, JAP_RIDEWATCH_CONF=c, JAP_RIDEWATCH_STATE=d, JAP_RIDEWATCH_TEST_AUDIO=door, JAP_RIDEWATCH_TALK_MAX='2',
               JAP_RIDEWATCH_PROTECT_URL='http://127.0.0.1:%d' % srv.server_address[1])

    def start(req, **e):
        p = subprocess.Popen([sys.executable, os.path.abspath(__file__)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, env=dict(env, **e))
        p.stdin.write(b'AAAA-BBBB-CCCC-DDDD ' + req + b'\n'); p.stdin.flush()
        return p

    def one(req, **e):                                # an answer that is one line, then close
        p = start(req, **e); b = p.stdout.read(); p.wait(); p.stdin.close(); p.stdout.close()
        return json.loads(b)

    def ffmpegs(marker):
        return [l for l in subprocess.run(['ps', '-A', '-o', 'command'], capture_output=True, text=True).stdout.splitlines()
                if marker in l and 'ffmpeg' in l]
    # listen: the line once audio flows, PCM, one per car, ffmpeg gone when the car closes
    p = start(b'listen 0')
    assert json.loads(p.stdout.readline()) == {'ev': 'listen', 'rate': 24000, 'ch': 1, 'fmt': 's16le'}
    pcm = p.stdout.read(9600)
    assert len(pcm) == 9600 and max(abs(v) for v in struct.unpack('<4800h', pcm)) > 1000, 'a 700 Hz tone, s16le'
    assert ffmpegs(door), 'its ffmpeg runs'
    assert one(b'listen 1') == {'ev': 'listen', 'error': 'busy'}, 'one listen per car, whatever the camera'
    p.stdin.close(); p.stdout.close()                 # the car closes: no kill from here
    assert p.wait(5) == 0 and not ffmpegs(door), 'no ffmpeg left after the car closed'
    p = start(b'listen 1')
    assert json.loads(p.stdout.readline())['rate'] == 24000, 'the lock went with the connection'
    p.stdin.close(); p.stdout.close(); p.wait(5)
    assert one(b'listen 0', JAP_RIDEWATCH_TEST_AUDIO=mute) == {'ev': 'listen', 'error': 'noaudio'}
    assert one(b'listen 0', JAP_RIDEWATCH_TEST_AUDIO='') == {'ev': 'listen', 'error': 'camera'}, 'unreachable RTSP'
    for req in (b'listen 4', b'listen x', b'listen -1'):
        assert one(req) == {'ev': 'listen', 'error': 'camera'}, req
    for req in (b'listen 3', b'talk 3'):
        assert one(req) == {'ev': req.split()[0].decode(), 'error': 'off'}, (req, 'a camera without the door role')
    json.dump(dict(conf, audio='yes'), open(c, 'w'))
    for req in (b'listen 0', b'talk 0'):
        assert one(req) == {'ev': req.split()[0].decode(), 'error': 'off'}, (req, 'audio not exactly true')
    assert one(b'hello')['caps'] == ['rtsp']
    json.dump(conf, open(c, 'w'))
    assert one(b'hello')['caps'] == ['rtsp', 'listen', 'talk']
    # talk: AAC frames at the camera's rate on its UDP port, ended by the server at the cap
    tone = b''.join(struct.pack('<h', int(8000 * math.sin(2 * math.pi * 440 * k / 16000))) for k in range(1600))   # 0.1 s
    p = start(b'talk 0'); t0 = time.monotonic()
    assert json.loads(p.stdout.readline()) == {'ev': 'talk', 'ok': True, 'rate': 16000, 'ch': 1, 'fmt': 's16le', 'max': 2}
    sent = []

    def car():                                        # keeps talking well past the cap
        try:
            while time.monotonic() - t0 < 6:
                p.stdin.write(tone); p.stdin.flush(); sent.append(1); time.sleep(0.05)
        except OSError:
            pass
    w = threading.Thread(target=car); w.start()
    time.sleep(0.5)
    assert one(b'talk 0') == {'ev': 'talk', 'error': 'busy'}
    assert p.wait(5) == 0 and 1.8 < time.monotonic() - t0 < 4, 'the server ends a talk at the cap'
    assert p.stdout.read() == b''
    w.join(); p.stdout.close()
    try:
        p.stdin.close()
    except OSError:                                   # (what the car still had buffered: the server is gone)
        pass
    time.sleep(0.5)
    a, i, n = b''.join(got), 0, 0
    while i < len(a):                                 # ADTS frame by frame: sync, layer 0, rate index 7 (22050), length
        assert a[i] == 0xFF and a[i + 1] & 0xF6 == 0xF0 and (a[i + 2] >> 2) & 0xF == 7, (i, a[i:i + 4])
        i += ((a[i + 3] & 3) << 11) | (a[i + 4] << 3) | (a[i + 5] >> 5); n += 1
    assert i == len(a) and n >= 30, (n, len(a))       # ~2 s at 22050 Hz, 1024 samples a frame
    got[:] = []
    p = start(b'talk 0'); t0 = time.monotonic()
    p.stdin.write(tone * 5); p.stdin.close()          # PCM right behind the request (read with it), then the car lets go
    assert json.loads(p.stdout.readline())['ok']
    assert p.wait(3) == 0 and time.monotonic() - t0 < 2.5 and p.stdout.read() == b''
    p.stdout.close(); time.sleep(0.3)
    assert got and got[0][:2] == b'\xff\xf1', 'the end of a talk is still sent'
    done.append(1)
    for req, err in ((b'talk 1', 'nospeaker'), (b'talk 2', 'nospeaker'), (b'talk 4', 'camera'), (b'talk x', 'camera')):
        assert one(req) == {'ev': 'talk', 'error': err}, req
    P['deny'] = True
    assert one(b'talk 0') == {'ev': 'talk', 'error': 'forbidden'}, 'the role refuses the camera list'
    P['deny'] = False
    assert one(b'talk 0', JAP_RIDEWATCH_PROTECT_URL='http://127.0.0.1:9') == {'ev': 'talk', 'error': 'unreachable'}
    json.dump(dict(conf, protect={'host': '127.0.0.1'}), open(c, 'w'))
    assert one(b'talk 0') == {'ev': 'talk', 'error': 'nouser'}, 'no Protect user stored (a cached session is not enough)'
    # the speaker's values are checked before they reach ffmpeg's argv
    good = recs[0]
    for bad in ({'host': '127.0.0.1 -y'}, {'host': None}, {'featureFlags': {'hasSpeaker': 'yes'}},
                {'talkbackSettings': dict(tb, bindPort=70000)}, {'talkbackSettings': dict(tb, samplingRate='22050')},
                {'talkbackSettings': dict(tb, channels=3)}, {'talkbackSettings': dict(tb, typeFmt='opus')}):
        try:
            talk_target(dict(good, **bad)); assert False, bad
        except ProtectError as e:
            assert e.args[0] == 'camera'
    assert talk_target(dict(good, host='fd00::5'))[-1] == 'udp://[fd00::5]:%d' % tb['bindPort']
    srv.shutdown(); rx.close(); shutil.rmtree(d)
    print('listen + talk selftest ok')


# a fake Protect camera list (field names as Protect's /proxy/protect/api/cameras gives them)
CAMERAS = [
    {'id': 'c0', 'name': 'Door', 'featureFlags': {'isDoorbell': True}, 'channels': [
        {'id': 0, 'name': 'High', 'enabled': True, 'isRtspEnabled': True, 'rtspAlias': 'dOoR0', 'width': 1600, 'height': 1200, 'fps': 30},
        {'id': 1, 'name': 'Medium', 'enabled': True, 'isRtspEnabled': False, 'rtspAlias': None, 'width': 1280, 'height': 960, 'fps': 30},
        {'id': 2, 'name': 'Low', 'enabled': False, 'isRtspEnabled': False, 'rtspAlias': None, 'width': 640, 'height': 480, 'fps': 30}]},
    {'id': 'c1', 'name': 'Garage', 'featureFlags': {}, 'channels': [
        {'id': 1, 'name': 'Medium', 'enabled': True, 'isRtspEnabled': True, 'rtspAlias': 'gA1', 'width': 1280, 'height': 720, 'fps': 24},
        {'id': 2, 'name': 'Low', 'enabled': True, 'isRtspEnabled': True, 'rtspAlias': 'gA2', 'width': 640, 'height': 360, 'fps': 'x'},
        {'id': 3, 'name': 'bad', 'enabled': True, 'isRtspEnabled': True, 'rtspAlias': 'a b', 'width': 640, 'height': 360}]},
    {'id': 'c2', 'name': 'Shed', 'channels': [{'id': 0, 'name': 'High', 'isRtspEnabled': False}]},
    {'name': 'no id'}, 'junk']


if __name__ == '__main__':
    selftest() if sys.argv[1:] == ['--selftest'] else main()
