#!/usr/bin/env python3
"""kit_sync.py - keep an app repository's shared kit files equal to the canonical kit (RideTube's).

The shared set (SHARED, paths in the kit directory) is what every app's kit takes as is; kit/CANON.sha256 lists
them with their sha256, its first line names where they came from.

  python3 kit/tools/kit_sync.py --check             exit 1 and print the files that differ from kit/CANON.sha256
  python3 kit/tools/kit_sync.py --pull <kit dir>    copy the shared files from a canonical kit (it must pass its
                                                    own --check), rewrite kit/CANON.sha256
  python3 kit/tools/kit_sync.py --write             (the canonical repo) rewrite kit/CANON.sha256 from its files
  python3 kit/tools/kit_sync.py --self-test
"""
import hashlib, os, shutil, subprocess, sys, tempfile

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = 'CANON.sha256'
HEADER = '# canonical: JustAnotherPU/ridetube kit/ (the commit that last changed this file)'
SHARED = ['runtime/%s.js' % n for n in ('display', 'mgu', 'record', 'canvas', 'renderd', 'sheet', 'signals', 'parked',
                                        'life', 'gauges', 'themes', 'qr', 'hmi-text', 'toucharea', 'touchpad')] + \
         ['tools/hu-stub.js', 'tools/test_parked.js', 'tools/kit_sync.py']


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def read_manifest(kit):
    """(header line, {path: sha256}); ({}: no manifest)"""
    p = os.path.join(kit, MANIFEST)
    if not os.path.exists(p):
        return None, {}
    with open(p, encoding='utf-8') as f:
        lines = f.read().splitlines()
    head = lines[0] if lines and lines[0].startswith('#') else None
    return head, dict((l.split('  ', 1)[1], l.split('  ', 1)[0]) for l in lines if l and not l.startswith('#'))


def write_manifest(kit, head):
    with open(os.path.join(kit, MANIFEST), 'w', encoding='utf-8', newline='\n') as f:
        f.write((head or HEADER) + '\n' + ''.join('%s  %s\n' % (sha(os.path.join(kit, p)), p) for p in SHARED))


def drifted(kit):
    """the shared files that differ from the kit's manifest (missing, changed, not listed)"""
    _, want = read_manifest(kit)
    return [p for p in SHARED if p not in want or not os.path.exists(os.path.join(kit, p)) or sha(os.path.join(kit, p)) != want[p]]


def pull(src, kit):
    src = os.path.abspath(src)
    if os.path.realpath(src) == os.path.realpath(kit):
        print('kit_sync: %s is this kit itself' % src, file=sys.stderr)
        return 1
    bad = drifted(src)
    if bad:
        print('kit_sync: %s does not match its own %s, not pulled: %s' % (src, MANIFEST, ' '.join(bad)), file=sys.stderr)
        return 1
    head, _ = read_manifest(src)
    try:   # the consumer's manifest names the canonical commit pulled (its own header would name the consumer's)
        rev = subprocess.run(['git', '-C', src, 'rev-parse', 'HEAD'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             universal_newlines=True, check=True).stdout.strip()
        dirty = subprocess.run(['git', '-C', src, 'status', '--porcelain', '--', '.'], stdout=subprocess.PIPE,
                               universal_newlines=True, check=True).stdout.strip()
        head = '# canonical: JustAnotherPU/ridetube kit/ at %s%s' % (rev, ' (with uncommitted changes)' if dirty else '')
    except (OSError, subprocess.CalledProcessError):
        pass
    for p in SHARED:
        os.makedirs(os.path.dirname(os.path.join(kit, p)), exist_ok=True)
        shutil.copyfile(os.path.join(src, p), os.path.join(kit, p))
    write_manifest(kit, head)
    print('kit_sync: %d files from %s' % (len(SHARED), src))
    return 0


def self_test():
    with tempfile.TemporaryDirectory() as t:
        canon, app = os.path.join(t, 'canon'), os.path.join(t, 'app')
        for p in SHARED:
            for k in (canon, app):
                os.makedirs(os.path.dirname(os.path.join(k, p)), exist_ok=True)
            with open(os.path.join(canon, p), 'w') as f:
                f.write(p)
            with open(os.path.join(app, p), 'w') as f:
                f.write('old ' + p)
        assert drifted(canon) == SHARED, 'no manifest: every file drifted'
        write_manifest(canon, None)
        assert drifted(canon) == [], 'written: clean'
        assert pull(canon, app) == 0 and drifted(app) == [], 'pulled: clean'
        assert read_manifest(app)[0] == HEADER, 'the canonical header carried over'
        with open(os.path.join(app, 'runtime/mgu.js'), 'a') as f:
            f.write('x')
        os.remove(os.path.join(app, 'tools/hu-stub.js'))
        assert drifted(app) == ['runtime/mgu.js', 'tools/hu-stub.js'], drifted(app)
        with open(os.path.join(canon, 'runtime/qr.js'), 'a') as f:
            f.write('x')
        assert pull(canon, app) == 1 and drifted(app) == ['runtime/mgu.js', 'tools/hu-stub.js'], 'a drifted source is not pulled'
    print('kit_sync: self-test ok')
    return 0


def main(argv):
    if argv[:1] == ['--check'] and len(argv) == 1:
        bad = drifted(KIT)
        for p in bad:
            print('drifted: kit/' + p)
        return 1 if bad else 0
    if argv[:1] == ['--pull'] and len(argv) == 2:
        return pull(argv[1], KIT)
    if argv == ['--write']:
        write_manifest(KIT, read_manifest(KIT)[0])
        return 0
    if argv == ['--self-test']:
        return self_test()
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
