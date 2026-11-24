#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""jap-ridewatch setup: writes /var/lib/jap-ridewatch/cams.json (0600, as the service user: run with sudo, root drops to
it first) from what Protect says. /opt/jap-ridewatch/cams.json is a link to it, for the services.

    sudo python3 /opt/jap-ridewatch/configure.py                    asks for Protect (optional) and the cameras' roles
                                                               (again: Enter keeps each answer; new cameras are found)
    sudo python3 /opt/jap-ridewatch/configure.py --add-rtsp NAME URL [LABEL]
                                                               adds any RTSP/RTSPS camera (URL "-": read from stdin, so
                                                               a password in it stays out of ps and the shell history)
    sudo python3 /opt/jap-ridewatch/configure.py --remove-cam NAME  removes a camera (a Protect one comes back on the
                                                               next run without arguments)
    sudo python3 /opt/jap-ridewatch/configure.py --add-car CODE     lets a car in (the code its app shows; only its
                                                               SHA-256 is kept)
    sudo python3 /opt/jap-ridewatch/configure.py --remove-car CODE  (or the sha256:... prefix --cars shows)
    sudo python3 /opt/jap-ridewatch/configure.py --cars             lists the cars (the start of each hash)
    sudo ridewatch-setup  (= configure.py --web)                     the setup page in a browser (setup_web.py), run
                                                               as the service user, never as root

Protect: its address (the console, e.g. 192.0.2.1) and a local user with the View Only role (Protect, Settings,
Admins and Users). The cameras and their RTSPS channels come from Protect's camera list; a channel with RTSP off is
named so that it can be turned on in Protect (a View Only user cannot), then this is run again.
Roles (all optional), for the car's choice of the big picture: door (a ring or a person there takes over), garage
(left out while the car is at home), day and night (the default picture).
Without Protect (Enter with no address, or - to drop it): only the cameras added with --add-rtsp, live views only.
"""
import getpass, json, os, pwd, re, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402

CONF = os.environ.get('JAP_RIDEWATCH_CONF', '/var/lib/jap-ridewatch/cams.json')   # the real file, not the /opt link
USER = 'japridewatch'
CODE = re.compile(r'[A-Z0-9]{4}(-[A-Z0-9]{4}){3}')


def load():
    try:
        return json.load(open(CONF))
    except FileNotFoundError:
        return {}


def car_entries(conf):
    """cams.json "cars" as "sha256:<hex>" only: an older plain code (and an older single "token") hashed, no duplicate"""
    return list(dict.fromkeys('sha256:' + t.decode() for t in serve.tokens(conf)))


def write(conf, path=None):
    """atomically, 0600 (mkstemp's mode), the cars as hashes. Never as root (drop() runs first), so the writer owns it"""
    path = path or CONF
    if 'cars' in conf or 'token' in conf:
        conf = dict(conf, cars=car_entries(conf)); conf.pop('token', None)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.cams-')
    with os.fdopen(fd, 'w') as f:
        json.dump(conf, f, indent=1, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)


def merge(old, found, roles):
    """the new cams.json: the cameras in their old order (indices in events.json and the car's order stay), a Protect
    camera updated from the discovered list (its old label and hand-set channel urls kept), one Protect no longer
    lists removed, every other camera (RTSP) kept as it is, new Protect cameras appended in Protect's order (one named
    like an RTSP camera left out); roles {role: camera name}; the cars, the Protect login and every other key kept.
    A camera is matched on its protectId where both have one and Protect still lists it (Protect allows two cameras with
    one name), else on its name, among the discovered cameras no old one claims by id"""
    rtsp = {c.get('name') for c in old.get('cams', []) if c.get('kind') == 'rtsp'}
    found = [c for c in found if c['name'] not in rtsp]
    ids = {o['protectId'] for o in old.get('cams', []) if o.get('protectId') and o.get('kind') != 'rtsp'}
    fids = {c.get('protectId') for c in found}

    def take(o):
        pid = o.get('protectId')
        for k, c in enumerate(found):
            if pid and pid in fids and c.get('protectId'):
                same = c['protectId'] == pid
            else:
                same = c['name'] == o.get('name') and c.get('protectId') not in ids
            if same:
                return found.pop(k)
        return None

    def fresh(c, o):
        c = json.loads(json.dumps(c))                  # the discovered list stays as it is
        c.pop('doorbell', None)
        c['label'] = o.get('label', c['name'])
        urls = {ch.get('id'): ch['url'] for ch in o.get('channels', []) if ch.get('url')}
        for ch in c['channels']:
            if ch['id'] in urls:
                ch['url'] = urls[ch['id']]
        return c
    cams = []
    for o in old.get('cams', []):
        c = take(o) if o.get('kind') != 'rtsp' else None
        if c:
            cams.append(fresh(c, o))
        elif serve.is_rtsp(o):
            cams.append(json.loads(json.dumps(o)))
    cams += [fresh(c, {}) for c in found]
    for c in cams:
        c['roles'] = [r for r in serve.ROLES if roles.get(r) == c['name']]
    return dict(old, cams=cams)


def add_rtsp(conf, name, url, label=None, probe=None):
    """conf with one more camera, any RTSP/RTSPS source: checked (serve.rtsp_url), probed for its size and rate
    (ffprobe, 15 s), appended; SystemExit with the reason (never the url: it may hold a password)"""
    for what, v in (('name', name), ('label', name if label is None else label)):
        if not v or len(v) > 64 or not v.isprintable() or v != v.strip():
            sys.exit('a camera %s: 1 to 64 printable characters' % what)
    if any(c.get('name') == name for c in conf.get('cams', [])):
        sys.exit('there is already a camera named %r' % name)
    try:
        serve.rtsp_url(url)
    except ValueError as e:
        sys.exit('this address cannot be used: %s' % e)
    try:
        w, h, fps, _ = (probe or (lambda u: serve.probe(u, ['-rtsp_transport', 'tcp'] + serve.WHITELIST)))(url)
    except serve.ProtectError as e:
        sys.exit(serve.scrub('the camera did not answer: %s' % e.args[1]))
    if not w or not h:
        sys.exit('no video stream at that address (wrong path, user or password, or RTSP off on the camera)')
    cam = {'name': name, 'label': label or name, 'kind': 'rtsp', 'roles': [],
           'channels': [{'id': 0, 'w': w, 'h': h, 'fps': fps, 'url': url}]}
    return dict(conf, cams=list(conf.get('cams', [])) + [cam], cars=list(conf.get('cars') or []))


def remove_cam(conf, name):
    cams = [c for c in conf.get('cams', []) if c.get('name') != name]
    if len(cams) == len(conf.get('cams', [])):
        sys.exit('no camera named %r' % name)
    return dict(conf, cams=cams)


def ask(q, default=''):
    a = input('%s%s: ' % (q, ' [%s]' % default if default else '')).strip()
    return a or default


def setup():
    conf = load()
    p = dict(conf.get('protect') or {})
    print('UniFi Protect (optional): the console\'s address and a local user with the View Only role.')
    print('No Protect: Enter with no address (or - to drop it); then only the cameras added with --add-rtsp.')
    p['host'] = ask('Protect address', p.get('host', ''))
    found, off = [], []
    if p['host'] in ('', '-'):
        conf.pop('protect', None)                      # no key at all: events.py then does not poll Protect
    else:
        p['username'] = ask('User', p.get('username', ''))
        pw = getpass.getpass('Password%s: ' % (' [Enter keeps it]' if p.get('password') else ''))
        if pw:
            p['password'] = pw
        conf['protect'] = p
        try:
            serve.login(conf)                          # the answers just given, not a stored session of another user or console
            found, off = serve.discover(conf)
        except serve.ProtectError as e:
            sys.exit('Protect: %s (%s)' % (e.args[0], e.args[1]))
    if off:
        print('\nRTSPS is off on these channels (turn it on in Protect, in each camera\'s Advanced settings, then run this again):')
        for x in off:
            print('  ' + x)
    allc = merge(conf, found, {})['cams']
    left = [c['name'] for c in found if c['name'] not in {x['name'] for x in allc if not serve.is_rtsp(x)}]
    if left:
        print('\nLeft out, an RTSP camera has the same name (rename one): ' + ', '.join(left))
    if not allc and 'protect' not in conf:             # a first install with no Protect: the services start empty
        conf.update(cams=[], cars=list(conf.get('cars') or []))
        write(conf)
        print('\nWrote %s with no camera yet: add one with --add-rtsp NAME - [LABEL].' % CONF); return
    if not allc:
        sys.exit('\nNo camera (none with an RTSPS channel in Protect, none added with --add-rtsp): nothing to show.')
    bells = {c['name'] for c in found if c['doorbell']}
    print('\nCameras:')
    for k, c in enumerate(allc):
        print('  %2d  %s%s (%s)' % (k + 1, c['name'], ' [doorbell]' if c['name'] in bells else ' [rtsp]' if serve.is_rtsp(c) else '',
                                    ', '.join('%dx%d' % (ch['w'], ch['h']) for ch in c['channels'])))
    old = {r: c['name'] for c in conf.get('cams', []) for r in c.get('roles', [])}
    bell = next((c['name'] for c in found if c['doorbell']), '')
    roles = {}
    for r, q in (('door', 'Door camera (a ring or a person there takes the big picture)'),
                 ('garage', 'Garage camera (left out while the car is at home)'),
                 ('day', 'Default camera by day'), ('night', 'Default camera at night')):
        cur = old.get(r, bell if r == 'door' else '')
        k = next((str(i + 1) for i, c in enumerate(allc) if c['name'] == cur), '')
        while True:
            a = ask('%s: number, or - for none' % q, k)
            if a in ('', '-'):
                break
            if a.isdigit() and 1 <= int(a) <= len(allc):
                roles[r] = allc[int(a) - 1]['name']
                break
    conf = merge(conf, found, roles)
    conf.setdefault('cars', [])
    write(conf)
    print('\nWrote %s (%d cameras). Cars allowed: %d.' % (CONF, len(conf['cams']), len(conf['cars'])))


def cams(cmd, name, url=None, label=None):
    conf = load()
    if cmd == '--add-rtsp':
        if url == '-':
            url = getpass.getpass('RTSP address (not shown): ') if sys.stdin.isatty() else sys.stdin.readline().strip()
        conf = add_rtsp(conf, name, url, label)
    else:
        conf = remove_cam(conf, name)
    write(conf)
    print('cameras: %d (%s)' % (len(conf['cams']), ', '.join(c['name'] for c in conf['cams']) or 'none'))


def cars(cmd, code=None):
    conf = load()
    if not conf:
        sys.exit('%s does not exist yet: run this without arguments first' % CONF)
    have = car_entries(conf)
    if cmd == '--cars':
        print('\n'.join(h[:19] + '...' for h in have) or '(none)'); return
    arg = (code or '').strip()
    if cmd == '--remove-car' and re.fullmatch(r'sha256:[0-9a-f]{8,64}', arg):   # a car whose code is lost
        hit = [h for h in have if h.startswith(arg)]
        if len(hit) != 1:
            sys.exit('%s car starts with %s' % ('no' if not hit else 'more than one', arg))
        have.remove(hit[0])
    else:
        code = arg.upper()
        if not CODE.fullmatch(code):
            sys.exit('a car code looks like ABCD-EFGH-JKLM-NPQR (the RideWatch app shows it)')
        h = 'sha256:' + serve.digest(code)
        if cmd == '--add-car' and h not in have:
            have.append(h)
        if cmd == '--remove-car':
            have = [c for c in have if c != h]
    conf['cars'] = have
    write(conf)
    print('cars: %d' % len(have))


def drop():
    """root becomes the service user before anything opens cams.json or its folder: /var/lib/jap-ridewatch is that
    user's, so root there could be sent through a link it planted (to any file, root's next write)"""
    if os.geteuid() != 0:
        return
    try:
        pw = pwd.getpwnam(USER)
    except KeyError:
        sys.exit('no user %s: run install.sh first' % USER)
    os.setgroups([]); os.setgid(pw.pw_gid); os.setuid(pw.pw_uid)
    os.environ.update(HOME='/nonexistent', USER=USER, LOGNAME=USER)


def web(args):
    """the setup page, as the service user (main() dropped to it; the page never runs as root)"""
    page = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'setup_web.py')
    os.execv(sys.executable, [sys.executable, page] + args)


def selftest():
    if os.geteuid() == 0:                              # its CLI runs drop to the service user, who cannot read root's temp folder
        sys.exit('run the selftest as a normal user (install.sh: runuser -u japridewatch -- python3 configure.py --selftest)')
    d = tempfile.mkdtemp()
    path = os.path.join(d, 'cams.json')
    old = {'cars': ['AAAA-BBBB-CCCC-DDDD'], 'protect': {'host': 'h', 'username': 'u', 'password': 'p'}, 'maxrate_k': 6000,
           'cams': [{'name': 'Door', 'label': 'Front door', 'roles': ['door'], 'channels': [{'id': 1, 'url': 'rtsp://127.0.0.1:1/x'}]},
                    {'name': 'Gone', 'channels': []}]}
    found = [{'name': 'Door', 'label': 'Door', 'protectId': 'c0', 'doorbell': True, 'channels': [{'id': 1, 'w': 1600, 'h': 1200, 'fps': 30, 'alias': 'a1'}]},
             {'name': 'Garage', 'label': 'Garage', 'protectId': 'c1', 'doorbell': False, 'channels': [{'id': 0, 'w': 1920, 'h': 1080, 'fps': 30, 'alias': 'g0'}]}]
    new = merge(old, found, {'door': 'Door', 'night': 'Door', 'day': 'Garage'})
    assert new['cars'] == old['cars'] and new['protect'] == old['protect'] and new['maxrate_k'] == 6000
    assert [c['name'] for c in new['cams']] == ['Door', 'Garage'], 'a camera gone from Protect goes'
    door, garage = new['cams']
    assert door['label'] == 'Front door' and door['roles'] == ['door', 'night'] and 'doorbell' not in door
    assert door['channels'][0]['url'] == 'rtsp://127.0.0.1:1/x' and door['channels'][0]['alias'] == 'a1', 'a hand-set url stays'
    assert garage['label'] == 'Garage' and garage['roles'] == ['day'] and 'url' not in garage['channels'][0]
    assert found[0]['doorbell'] is True and 'url' not in found[0]['channels'][0], 'the discovered list is not changed'
    write(new, path)
    h = 'sha256:' + serve.digest('AAAA-BBBB-CCCC-DDDD')
    assert os.stat(path).st_mode & 0o777 == 0o600 and json.load(open(path)) == dict(new, cars=[h]), 'a plain code is written as its hash'
    cars_selftest(d)
    assert CODE.fullmatch('ABCD-EFGH-JKLM-NPQR') and not CODE.fullmatch('ABCD-EFGH') and not CODE.fullmatch('abcd-efgh-jklm-npqr')
    rtsp_selftest(d)
    drop_selftest()
    import shutil
    shutil.rmtree(d)
    print('selftest ok')


def cars_selftest(d):
    """cars as hashes: an older plain code and "token" migrated on write, the CLI never prints a code"""
    code, other = 'ABCD-EFGH-JKLM-NPQR', 'WXYZ-2345-6789-ABCD'
    h = 'sha256:' + serve.digest(code)
    assert car_entries({'cars': [code, h, 'sha256:' + serve.digest(other)], 'token': other}) == ['sha256:' + serve.digest(other), h]
    path = os.path.join(d, 'cars.json')
    write({'cars': [code], 'token': 'OLD', 'cams': []}, path)
    on = json.load(open(path))
    assert on == {'cars': ['sha256:' + serve.digest('OLD'), h], 'cams': []}, on
    env = dict(os.environ, JAP_RIDEWATCH_CONF=path)
    run = lambda *a: subprocess.run([sys.executable, os.path.abspath(__file__)] + list(a), capture_output=True, env=env, text=True)
    r = run('--add-car', other.lower())
    assert r.returncode == 0 and len(json.load(open(path))['cars']) == 3, r
    r = run('--cars')
    assert r.returncode == 0 and code not in r.stdout and other not in r.stdout and h[:19] + '...' in r.stdout.split(), r.stdout
    assert run('--add-car', other).returncode == 0 and len(json.load(open(path))['cars']) == 3, 'added once'
    assert run('--remove-car', code).returncode == 0 and h not in json.load(open(path))['cars']
    r = run('--remove-car', 'sha256:' + serve.digest(other)[:8])
    assert r.returncode == 0 and json.load(open(path))['cars'] == ['sha256:' + serve.digest('OLD')], r
    assert run('--remove-car', 'sha256:00000000').returncode == 1 and run('--add-car', 'nope').returncode == 1
    assert os.stat(path).st_mode & 0o777 == 0o600 and not [f for f in os.listdir(d) if f.startswith('.cams-')]
    link = os.path.join(d, 'planted.json')             # a link at cams.json is replaced by the file, its target untouched
    os.symlink(os.path.join(d, 'target'), link)
    write({'cams': []}, link)
    assert not os.path.islink(link) and not os.path.exists(os.path.join(d, 'target'))
    serve_ok = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'serve.py')],
                              input=b'OLD hello\n', capture_output=True, env=dict(os.environ, JAP_RIDEWATCH_CONF=path))
    assert json.loads(serve_ok.stdout)['ev'] == 'hello', 'a migrated "token" still gets in'
    print('cars configure selftest ok')


def drop_selftest():
    """every mode but --selftest: root drops to the service user before cams.json is opened (load) or the page starts"""
    import types

    class Stop(Exception):
        pass
    calls, saved, env = [], (os.geteuid, os.setgroups, os.setgid, os.setuid, os.execv, pwd.getpwnam, load), dict(os.environ)
    g = globals()
    try:
        os.geteuid = lambda: 0
        os.setgroups, os.setgid, os.setuid = [lambda v, n=n: calls.append((n, v)) for n in ('groups', 'gid', 'uid')]
        os.execv = lambda *a: calls.append('exec') or (_ for _ in ()).throw(Stop())
        g['load'] = lambda: calls.append('load') or (_ for _ in ()).throw(Stop())
        pwd.getpwnam = lambda u: types.SimpleNamespace(pw_uid=999, pw_gid=998)
        dropped = [('groups', []), ('gid', 998), ('uid', 999)]
        for a in ([], ['--cars'], ['--add-car', 'X'], ['--remove-car', 'X'], ['--add-rtsp', 'N', 'u'], ['--remove-cam', 'N'], ['--web']):
            del calls[:]
            try:
                main(a); assert False, a
            except Stop:
                pass
            assert calls == dropped + ['exec' if a == ['--web'] else 'load'], (a, calls)
        pwd.getpwnam = lambda u: (_ for _ in ()).throw(KeyError(u))
        del calls[:]
        try:
            main(['--cars']); assert False
        except SystemExit as e:
            assert 'run install.sh' in str(e.code) and calls == [], 'root with no service user: stops, never goes on as root'
    finally:
        os.geteuid, os.setgroups, os.setgid, os.setuid, os.execv, pwd.getpwnam, g['load'] = saved
        os.environ.clear(); os.environ.update(env)
    print('drop configure selftest ok')


def rtsp_selftest(d):
    """RTSP cameras: kept by merge() in their place, added and removed, never printed with their password"""
    import contextlib, io
    gate = {'name': 'Gate', 'label': 'Gate', 'kind': 'rtsp', 'roles': ['day'],
            'channels': [{'id': 0, 'w': 1920, 'h': 1080, 'fps': 25, 'url': 'rtsp://viewer:s3cr%40t@192.0.2.10/live'}]}
    shed = {'name': 'Shed', 'channels': [{'id': 1, 'w': 640, 'h': 480, 'fps': 15, 'url': 'rtsp://192.0.2.11/s'}]}  # older, by hand
    door = {'name': 'Door', 'label': 'Front door', 'protectId': 'c0', 'channels': [{'id': 1, 'w': 1600, 'h': 1200, 'fps': 30, 'alias': 'a1'}]}
    gone = {'name': 'Gone', 'protectId': 'c9', 'channels': [{'id': 1, 'w': 640, 'h': 360, 'fps': 30, 'alias': 'g9'}]}
    old = {'cars': [], 'cams': [gate, door, gone, shed]}
    found = [{'name': 'New', 'protectId': 'c5', 'doorbell': False, 'channels': [{'id': 1, 'w': 1280, 'h': 720, 'fps': 30, 'alias': 'n1'}]},
             {'name': 'Gate', 'protectId': 'c6', 'doorbell': False, 'channels': [{'id': 1, 'w': 1280, 'h': 720, 'fps': 30, 'alias': 'x1'}]},
             {'name': 'Door', 'protectId': 'c0', 'doorbell': True, 'channels': [{'id': 1, 'w': 1600, 'h': 1200, 'fps': 30, 'alias': 'a2'}]}]
    new = merge(old, found, {'day': 'Gate', 'door': 'Door', 'night': 'Shed'})
    assert [c['name'] for c in new['cams']] == ['Gate', 'Door', 'Shed', 'New'], 'old order kept, gone Protect camera out, new appended'
    g, dr, sh, nw = new['cams']
    assert g == gate and 'protectId' not in g, 'an RTSP camera is kept as it is; a Protect camera of the same name is left out'
    assert dr['channels'][0]['alias'] == 'a2' and dr['label'] == 'Front door' and dr['roles'] == ['door']
    assert sh['roles'] == ['night'] and sh['channels'] == shed['channels'] and nw['roles'] == [] and nw['label'] == 'New'
    assert [c['name'] for c in merge(old, [], {})['cams']] == ['Gate', 'Shed'], 'no Protect: the RTSP cameras stay'
    # two Protect cameras with one name: matched on protectId (Protect's order may change), a third one appended
    g4 = lambda pid, alias, **k: dict({'name': 'G4', 'protectId': pid, 'channels': [{'id': 1, 'w': 1280, 'h': 720, 'fps': 30, 'alias': alias}]}, **k)
    old2 = {'cams': [g4('a', 'a1', label='Front'), gate, g4('b', 'b1', label='Back')]}
    new2 = merge(old2, [g4('b', 'b2'), g4('c', 'c2'), g4('a', 'a2')], {})
    assert [(c['protectId'] if 'protectId' in c else c['name'], c['label']) for c in new2['cams']] == [('a', 'Front'), ('Gate', 'Gate'), ('b', 'Back'), ('c', 'G4')], new2
    assert [new2['cams'][k]['channels'][0]['alias'] for k in (0, 2)] == ['a2', 'b2'], 'each keeps its own channels'
    assert merge(new2, [g4('b', 'b2'), g4('c', 'c2'), g4('a', 'a2')], {}) == new2, 'stable on a second run'
    # an older cams.json without ids matches on the name, never a camera another old one claims by id
    new3 = merge({'cams': [dict(g4('a', 'a1'), protectId=None), g4('b', 'b1')]}, [g4('b', 'b2'), g4('a', 'a2')], {})
    assert [c['protectId'] for c in new3['cams']] == ['a', 'b'], new3
    # a camera Protect now lists under a new id (re-adopted): the name keeps its place and label
    new4 = merge({'cams': [g4('x', 'x1', label='Front'), gate]}, [g4('y', 'y2')], {})
    assert [(c.get('protectId'), c['label']) for c in new4['cams']] == [('y', 'Front'), (None, 'Gate')], new4
    probed = []
    pr = lambda u: probed.append(u) or (1280, 720, 25, 0)
    url = 'rtsp://viewer:s3cr%40t@192.0.2.12:554/x'
    c = add_rtsp({}, 'Porch', url, 'Front porch', pr)
    assert c == {'cams': [{'name': 'Porch', 'label': 'Front porch', 'kind': 'rtsp', 'roles': [],
                           'channels': [{'id': 0, 'w': 1280, 'h': 720, 'fps': 25, 'url': url}]}], 'cars': []} and probed == [url], c
    assert add_rtsp(c, 'Back', 'rtsps://cam.example.com/b', None, pr)['cams'][1]['label'] == 'Back'
    for args in (('Porch', url), ('', url), (' x', url), ('x' * 65, url), ('Bad', 'file:/etc/passwd'), ('Bad', '-i'),
                 ('Bad', 'rtsp://h/x\n-f lavfi'), ('Lab', url, ''), ('Lab', url, ' x'), ('Lab', url, 'x' * 65), ('Lab', url, 'a\nb')):
        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err):
                add_rtsp(c, *args, probe=pr); assert False, args
        except SystemExit as e:
            assert 's3cr' not in str(e.code), e.code
    for res in ((None, None, 30, 0), serve.ProtectError('export', "ffprobe: Command '[..., '%s']' timed out" % url)):
        def bad(u, res=res):
            if isinstance(res, Exception):
                raise res
            return res
        try:
            add_rtsp(c, 'Dead', url, None, bad); assert False
        except SystemExit as e:
            assert 's3cr' not in str(e.code) and ('no video' in str(e.code) or '***@' in str(e.code)), e.code
    assert [x['name'] for x in remove_cam(new, 'Shed')['cams']] == ['Gate', 'Door', 'New']
    try:
        remove_cam(new, 'Nope'); assert False
    except SystemExit:
        pass
    path = os.path.join(d, 'rtsp.json')            # the CLI: a fresh install, no Protect, the url from stdin
    env = dict(os.environ, JAP_RIDEWATCH_CONF=path)
    r = subprocess.run([sys.executable, os.path.abspath(__file__), '--add-rtsp', 'Gate', '-'], input=b'file:/etc/passwd\n',
                       capture_output=True, env=env)
    assert r.returncode == 1 and b'cannot be used' in r.stderr and not os.path.exists(path), r
    write({'cars': [], 'cams': [gate, shed]}, path)
    r = subprocess.run([sys.executable, os.path.abspath(__file__), '--remove-cam', 'Shed'], capture_output=True, env=env)
    assert r.returncode == 0 and b's3cr' not in r.stdout + r.stderr and [x['name'] for x in json.load(open(path))['cams']] == ['Gate']
    assert os.stat(path).st_mode & 0o777 == 0o600 and 'protect' not in json.load(open(path))
    print('rtsp configure selftest ok')


def main(a):
    if a == ['--selftest']:
        return selftest()
    drop()
    if a and a[0] == '--add-rtsp' and len(a) in (3, 4) or a and a[0] == '--remove-cam' and len(a) == 2:
        cams(*a)
    elif a and a[0] in ('--add-car', '--remove-car') and len(a) == 2 or a == ['--cars']:
        cars(*a)
    elif a[:1] == ['--web']:
        web(a[1:])
    elif not a:
        setup()
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
