#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# mgu-deploy "check", offline on purpose: camdec loads (glibc, MSDK, libva resolve; without arguments it exits 2 by
# its contract, a loader failure is 127), node22 parses and loads the daemon (its modules), without starting it; the car's node parses the sound helper.
set -u
d=$(cd "$(dirname "$0")" && pwd)
"$d/camdec" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 2 ] || { echo "check: camdec without arguments exited $rc, not 2 (missing library?)" >&2; exit 1; }
/var/opt/jap-node22/current/bin/node --check "$d/ridewatchd.js" || exit 1
/bin/sh -n "$d/socklock.sh" || exit 1
/usr/bin/node --check "$d/audio/ridewatch-audio.js" || exit 1      # the sound helper runs on the car's node (someip.node)
# as root, which the daemon refuses without its uid line: the test opt-in, since this starts nothing
JAP_RIDEWATCH_TEST_AS_ROOT=1 exec /var/opt/jap-node22/current/bin/node -e "require('$d/ridewatchd.js')"   # loads socks.js and jpeg-js, starts nothing
