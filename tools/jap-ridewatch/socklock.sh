#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 JustAnotherPU
# socklock.sh SOCKET APP_ID: keeps a service's control socket for one app alone: <app uid>:root 0600, root only
# while the app is not installed. Runs as root, a pass every 30 s (a <name>-lock.service), and once with
# SOCKLOCK_ONCE=1 when the service starts. Byte-identical in every repo that ships it (its test pins the sha256).
# A pass costs 3 or 4 processes (2 stat, an awk when there is an entry, the sleep): the walk and the tests are
# builtins. Worst case, a registry change reaches the socket up to SOCKLOCK_SLEEP (30 s) later: a new install
# connects that much later, and an app removed keeps the socket's uid that long; if MainApp gave that uid to another
# app within those 30 s, the newcomer could connect until the next pass (5 s before 24/11).
#
# The uid is "userId" in MainApp's registry entry oap_12201/data/apps/<APP_ID>.json. Every app can write
# /var/opt/public/oap, so the registry counts only when oap_12201, data and apps are real folders (no links), each
# owned by MainApp (12201) or root, and the entry a plain file with one link owned by them; none of them
# world-writable, nor group-writable unless the group is root or MainApp's. The uid must be an app's: 1001..60000,
# not MainApp's. A registry it cannot trust or read, or an entry with no such uid, keeps the socket's owner as it is
# (said once); a trusted folder without the entry makes it root's (the app is gone, its uid may go to another app).
# The socket's own folder must be root's and not group- or world-writable, or the socket is left as is (said once):
# a folder someone else can write lets them swap the name between the check and the chown. Never shared: the socket
# is made 0600 before its owner changes. A client connected before a change stays connected.
#   SOCKLOCK_OAP   the registry's root (/var/opt/public/oap)
#   SOCKLOCK_SLEEP seconds between passes (30)
#   SOCKLOCK_ONCE  1: one pass, then exit
S=$1 A=$2
case $S in /*) ;; *) S=$PWD/$S ;; esac   # the walk below moves this shell
OAP=${SOCKLOCK_OAP:-/var/opt/public/oap}
said= dsaid=
# "uid gid mode links" of a registry folder or the entry: owned by MainApp or root, not world-writable,
# group-writable only for the root or MainApp group; sets n, its link count
ok() {
	[ "$1" = 12201 ] || [ "$1" = 0 ] || return 1
	case $3 in *[2367]) return 1 ;; *[2367]?) [ "$2" = 0 ] || [ "$2" = 12201 ] || return 1 ;; esac
	n=$4
}
# w: the uid the socket should have (0: root only), empty when the registry says nothing it can trust. Runs in
# this shell (no subshell to fork), so its cd moves the loop: the socket path is made absolute above
want() {
	w=
	cd -P "$OAP" 2>/dev/null && top=$PWD || return 1
	for d in oap_12201 data apps; do cd -P "$d" 2>/dev/null || return 1; done
	# a link anywhere on the way lands elsewhere: cd -P . reads the real path again after the walk, so a swap
	# during the walk counts too
	cd -P . 2>/dev/null && [ "$PWD" = "$top/oap_12201/data/apps" ] || return 1
	f=$A.json e=
	if [ -e "$f" ] || [ -L "$f" ]; then [ -f "$f" ] && [ ! -L "$f" ] || return 1; e=$f; fi
	# the three folders (oap_12201 is ../.. from here) and the entry in one stat; a field missing fails closed
	if [ -n "$e" ]; then set -- $(stat -c '%u %g %a %h' ../.. .. . "$e" 2>/dev/null); [ $# = 16 ] || return 1
	else set -- $(stat -c '%u %g %a %h' ../.. .. . 2>/dev/null); [ $# = 12 ] || return 1; fi
	ok "$1" "$2" "$3" "$4" && ok "$5" "$6" "$7" "$8" && ok "$9" "${10}" "${11}" "${12}" || return 1
	[ $# = 12 ] && { w=0; return 0; }
	# one link: a hard link to a file someone else controls is not MainApp's entry
	ok "${13}" "${14}" "${15}" "${16}" && [ "$n" = 1 ] || return 1
	# compact or pretty-printed; a number or a string of digits, as RideTube's daemon reads it
	u=$(awk -F '[,{}]' '{ for (i = 1; i <= NF; i++) if ($i ~ /^[[:space:]]*"userId"[[:space:]]*:[[:space:]]*"?[0-9]*"?[[:space:]]*$/) { gsub(/[^0-9]/, "", $i); print $i; exit } }' < "$f")   # < : an app id with "=" is no awk assignment
	case $u in [1-9][0-9][0-9][0-9] | [1-9][0-9][0-9][0-9][0-9]) ;; *) return 1 ;; esac
	[ "$u" -gt 1000 ] && [ "$u" -le 60000 ] && [ "$u" != 12201 ] && w=$u
}
while :; do
	want || w=
	cd /   # holds no registry folder between passes
	if [ -z "$w" ]; then
		[ -n "$said" ] || echo "socklock: $S: no app uid MainApp's registry can be trusted for ($A): owner kept"
		said=1
	elif [ -S "$S" ] && [ ! -L "$S" ] && set -- $(stat -c '%u %a' "${S%/*}" "$S" 2>/dev/null) && [ $# = 4 ]; then
		# the folder and the socket in one stat; another count (one went meanwhile): nothing this pass
		said=
		# root's and no one else can write it: else the name could be swapped between the check and the chown
		case $1:$2 in
		0:*[2367] | 0:*[2367]?) dok= ;;
		0:?*) dok=1 ;;
		*) dok= ;;
		esac
		if [ -z "$dok" ]; then
			[ -n "$dsaid" ] || echo "socklock: $S: folder not root's: left as is"
			dsaid=1
		else
			dsaid=
			if [ "$3:$4" != "$w:600" ]; then
				if [ "$w" = 0 ]; then who='root only'; else who="app uid $w only"; fi
				chmod 0600 "$S" && chown -h "$w:0" "$S" && echo "socklock: $S: $who (0600)"
			fi
		fi
	fi
	[ "${SOCKLOCK_ONCE:-}" = 1 ] && exit 0
	sleep "${SOCKLOCK_SLEEP:-30}"
done
