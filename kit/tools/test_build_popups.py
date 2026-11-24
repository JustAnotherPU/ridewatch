#!/usr/bin/env python3
"""build.py pop-ups: app.json "popups" and "startType" reach the package; an app without them is unchanged.

    python3 kit/tools/test_build_popups.py
"""
import contextlib, io, json, os, shutil, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build as b  # noqa: E402

POP = {'name': 'RING_POP', 'type': 'popUp', 'widget': 'LT_State_PopupSmall', 'label': 'text3', 'button': 'View'}
# the app as it would be without pop-ups (RideWatch itself declares one since 0.4.0)
bare = lambda d: {k: v for k, v in d.items() if k not in ('popups', 'startType')}
spec = bare(json.load(open(os.path.join(b.APPS, 'jap_ridewatch', 'app.json'), encoding='utf-8')))
spec.setdefault('id', 'jap_ridewatch')

# without "popups": no pop-up container, the same states
xml0, ui0, _, ids0 = b.build_ui(dict(spec))
assert 'stackConsumer' not in xml0 and 'RING_POP' not in ids0

# with one: a pop-up container after the screens, its label and button focusable, never on the screen stack
xml, ui, strings, ids = b.build_ui(dict(spec, popups=[POP]))
cid = ids['RING_POP']
assert {k: v for k, v in ids.items() if k != 'RING_POP'} == ids0, 'the screens keep their ids'
cont = ui['containers'][str(cid)]
assert cont['type'] == 'popUp' and cont['name'] == 'RING_POP'
names = sorted(c['name'] for c in cont['components'].values())
assert names == ['RING_POP_OK', 'RING_POP_TEXT', 'RING_POP_TITLE'], names
assert f'<container id="{cid}" type="popUp" widget="LT_State_PopupSmall" stackConsumer="false">' in xml
assert xml.count('focusId="') == 2, 'label and button carry a focusId'
ok = next(c for c in cont['components'].values() if c['name'] == 'RING_POP_OK')
assert strings[ok['rows'][0]['Text']['value']] == 'View', 'the button text'

# the whole build (needs oap-sdk/): app-spec.json lists the pop-ups only when declared, startType reaches package.json
if os.path.exists(os.path.join(b.SDK, 'index.js')):
    with tempfile.TemporaryDirectory() as t:
        b.APPS, b.DIST = os.path.join(t, 'apps'), os.path.join(t, 'dist')
        shutil.copytree(os.path.join(b.ROOT, 'apps', 'jap_ridewatch'), os.path.join(b.APPS, 'jap_ridewatch'))
        out = lambda *p: json.load(open(os.path.join(b.DIST, 'jap_ridewatch', 'source', *p), encoding='utf-8'))
        p = os.path.join(b.APPS, 'jap_ridewatch', 'app.json')
        json.dump(bare(json.load(open(p, encoding='utf-8'))), open(p, 'w', encoding='utf-8'))
        with contextlib.redirect_stdout(io.StringIO()):
            b.build('jap_ridewatch')
        assert 'popups' not in out('javascript', 'kit', 'app-spec.json') and 'mguAppStartType' not in out('package.json')
        json.dump(dict(json.load(open(p, encoding='utf-8')), popups=[POP], startType='autostart'), open(p, 'w', encoding='utf-8'))
        with contextlib.redirect_stdout(io.StringIO()):
            b.build('jap_ridewatch')
        rt = out('javascript', 'kit', 'app-spec.json')
        assert rt['popups'] == [POP] and rt['stateIds']['RING_POP'] == cid, rt['stateIds']
        assert out('package.json')['mguAppStartType'] == 'autostart'
else:
    print('(no oap-sdk/: the whole-build check skipped)')
print('build pop-ups: OK')
