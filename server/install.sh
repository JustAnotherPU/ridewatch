#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
# Installs the RideWatch server on this Linux machine (Debian or Ubuntu with systemd), from a checkout of the repository:
#   sudo bash server/install.sh [listen address]        (default 0.0.0.0: every interface)
# Adds ffmpeg (apt) if missing, a system user "japridewatch", /opt/jap-ridewatch (the scripts and cams.json), the stream socket on
# port 18640 and the events service, runs the selftests, then configure.py (asks for Protect and the cameras' roles).
# With openssl: a self-signed certificate and the "ridewatch-setup" command for the setup page in a browser (port 18642,
# only while it runs). Without openssl: no setup page, terminal setup only.
# cams.json lives in /var/lib/jap-ridewatch (the setup page writes it as the service user); /opt/jap-ridewatch/cams.json
# is a link to it. Run it again to update the scripts; cams.json is kept (configure.py asks again, Enter keeps each answer).
# Remove: systemctl disable --now jap-ridewatch.socket jap-ridewatch-events.service
#         rm -r /opt/jap-ridewatch /var/lib/jap-ridewatch /etc/systemd/system/jap-ridewatch* /usr/local/bin/ridewatch-setup
#         userdel japridewatch
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
listen=${1:-0.0.0.0}
[ "$(id -u)" = 0 ] || { echo "install.sh: run it as root (sudo)" >&2; exit 2; }
[[ $listen =~ ^[0-9.]+$ || $listen =~ ^\[[0-9a-fA-F:]+\]$ ]] || { echo "install.sh: $listen is not an IPv4 or [IPv6] address" >&2; exit 2; }
command -v systemctl >/dev/null || { echo "install.sh: needs systemd" >&2; exit 2; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 7))' || { echo "install.sh: needs Python 3.7 or newer" >&2; exit 2; }
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
    command -v apt-get >/dev/null || { echo "install.sh: install ffmpeg first" >&2; exit 2; }
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null
fi
# (not "| grep -q": with pipefail, ffmpeg's SIGPIPE when grep stops early reads as "no libx264")
[[ $(ffmpeg -hide_banner -encoders 2>/dev/null) == *libx264* ]] || { echo "install.sh: this ffmpeg has no libx264" >&2; exit 2; }
id japridewatch >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /nonexistent japridewatch
install -d -m 755 /opt/jap-ridewatch
install -m 755 "$here/serve.py" "$here/events.py" "$here/configure.py" "$here/setup_web.py" /opt/jap-ridewatch/
install -d -m 700 -o japridewatch -g japridewatch /var/lib/jap-ridewatch
if [ -f /opt/jap-ridewatch/cams.json ] && [ ! -L /opt/jap-ridewatch/cams.json ]; then
    # root only reads (from its own folder); the service user writes into its folder: root follows no link there
    runuser -u japridewatch -- setsid -w sh -c 'umask 077; d=/var/lib/jap-ridewatch; cat > $d/.cams-move && mv -fT $d/.cams-move $d/cams.json' \
        </opt/jap-ridewatch/cams.json
    rm /opt/jap-ridewatch/cams.json
fi
ln -sfn /var/lib/jap-ridewatch/cams.json /opt/jap-ridewatch/cams.json
web=
cert=/var/lib/jap-ridewatch/setup-cert.pem key=/var/lib/jap-ridewatch/setup-key.pem
if command -v openssl >/dev/null && ! [ -s $cert -a -s $key ]; then
    # made as the service user: root never writes into its folder
    runuser -u japridewatch -- setsid -w sh -c "umask 077; openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj '/CN=RideWatch setup' \
        -keyout $key -out $cert 2>/dev/null" || rm -f $cert $key
fi
if [ -s $cert -a -s $key ]; then
    cat > /usr/local/bin/ridewatch-setup <<'EOF'
#!/bin/sh
# RideWatch setup page (configure.py --web: run as the service user), then the events service reads the new cams.json
[ "$(id -u)" = 0 ] || { echo "ridewatch-setup: run it with sudo" >&2; exit 2; }
python3 /opt/jap-ridewatch/configure.py --web "$@"
rc=$?
systemctl try-restart jap-ridewatch-events.service
exit $rc
EOF
    chmod 755 /usr/local/bin/ridewatch-setup
    web=1
else
    rm -f /usr/local/bin/ridewatch-setup
    echo "install.sh: no openssl (or it failed), so no setup page: set up in the terminal (configure.py)" >&2
fi
sed "s/@LISTEN@/$listen/" "$here/jap-ridewatch.socket" > /etc/systemd/system/jap-ridewatch.socket
install -m 644 "$here/jap-ridewatch@.service" "$here/jap-ridewatch-events.service" /etc/systemd/system/
for t in serve events configure setup_web; do       # as the service user: configure.py drops root, its tests too
    (cd / && runuser -u japridewatch -- setsid -w python3 /opt/jap-ridewatch/$t.py --selftest </dev/null)
done
python3 /opt/jap-ridewatch/configure.py </dev/tty
systemctl daemon-reload
systemctl enable --now jap-ridewatch.socket
systemctl enable jap-ridewatch-events.service
systemctl restart jap-ridewatch-events.service
systemctl is-active jap-ridewatch.socket jap-ridewatch-events.service
echo
echo "Listening on $listen:18640. In the car: RideWatch, Settings, set the server's IP; the app then shows the car's code."
if [ -n "$web" ]; then
    echo "Easiest: sudo ridewatch-setup, then open the address it prints (cameras, and the car by scanning its QR code)."
fi
echo "Or add the car here: sudo python3 /opt/jap-ridewatch/configure.py --add-car <code>"
