# RideWatch

Your home cameras on your BMW's centre screen while the car is parked.

Write-up, with the home server and the tunnel the car uses: [RideWatch on Everything Patched](https://everythingpatched.com/posts/ridewatch/).

RideWatch runs on BMW iDrive 7 (MGU). One camera fills the left of the screen and the others sit live in a pane on
the right. When something happens (a ring at the door, a person, a car, an animal, a parcel), that camera takes the
big picture. A second tab lists the last few days of detections with a thumbnail each, and plays the clip from
Protect.

![The live view: the camera with the latest detection big, the others beside it](docs/media/live.png)
*The live view. A test stub draws these pictures; they are not real cameras.*

![What happened: the detections, newest first, each with its clip](docs/media/past.png)
*What happened: tap a row to play its clip.*

![A person at the door takes the big picture, with a gold ring](docs/media/ring.png)
*A person at the door camera takes over the big picture.*

The car never talks to Protect directly. A small server on your home network (any Linux machine with ffmpeg) reads
the cameras over RTSPS, composes them into one H.264 stream at exactly the size of the car's screen, and keeps the
list of detections. The car reaches that server through a tunnel: WireGuard to your own server, or Tailscale.

What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

## UniFi Protect, plug-and-play for your cameras

Plug-and-play for your cameras: sign in to UniFi Protect once and every camera appears.

### What you still need

- A Linux machine at home that stays on (details in [What you need](#what-you-need)).
- A local Protect user to sign in with. A ui.com account with two-step login cannot sign in here.
- A tunnel tool on the car: `jap-wireproxy` (WireGuard) or IterioDev's Tailscale.
- The server's address, typed once in the car's Settings.
- For detections, clips and quick replies: a View Only Protect user or Home Assistant, set up by hand in Protect or
  Home Assistant.

### The setup page

It comes with server 0.5.0, still listed as Unreleased in the [CHANGELOG](CHANGELOG.md), and does the Protect side
for you. You sign in with a local Protect admin. The page lists every camera, turns on RTSPS for the channels
the car uses, saves the list and signs out. The admin password is used for that one sign-in and is not stored.

<img src="docs/media/setup-code.png" width="520" alt="The setup page asks for the code printed in the terminal">

<img src="docs/media/setup-cameras.png" width="520" alt="The setup page lists the cameras found in Protect, with labels, roles and a form to add an RTSP camera">

*The setup page, run here against a fake Protect console.*

Protect cameras get everything: the live view, the "What happened" list and each detection's clip. Steps are in
[Use the setup page](#use-the-setup-page).

### Where the detections come from

By default the events service asks Protect for its event list every 3 seconds, using the View Only user. It keeps
rings and smart detections (person, vehicle, animal, package) and drops plain motion. When Protect cannot be reached
or refuses the login, it waits longer between tries (up to 5 minutes), so a wrong password does not lock the user
out. With no Protect user stored, it does not ask Protect at all.

Home Assistant can send the detections instead, or as well: `examples/home-assistant.yaml` has the `rest_command`
and the automation. Add `"events_from": "<Home Assistant's IP>"` and `"events_token": "<a long random string>"` to
`cams.json`, and `"events_protect": false` to stop asking Protect, then
`sudo systemctl restart jap-ridewatch-events`.

## Doorbell

| | Since |
|---|---|
| Pop-up over any app when the doorbell rings, while parked | 0.4.0 |
| Quick replies through Home Assistant (optional, `ha.json`) | 0.4.0 |
| Open the door, two taps (optional, through the same Home Assistant script) | 0.4.0 |
| Talk and listen | planned, not shipped |

When the doorbell rings and the car is parked, RideWatch shows a pop-up over any app. Tap View to see the door
camera. Person, vehicle, package and animal pop-ups are off by default; you can turn each one on in Settings, with a
1, 5 or 15 min cooldown. No pop-up shows while the car moves, or when the car gives no speed reading. A setting
switches the pop-ups and the doorbell's buttons to French.

Quick replies are optional and go through your Home Assistant. Put `ha.json` in the app's data folder, owned by
the RideWatch app's own uid, mode 0600:

```json
{"host": "192.0.2.20", "port": 8123, "token": "<long-lived token>", "script": "script.my_doorbell_reply"}
```

The host must be an IPv4 address and the port a number from 1 to 65535. The apps on the car share one group, so
RideWatch ignores the file and shows no buttons if it belongs to another uid, if anyone else can read it, or if it is
a link. The app's log says why, with the app's uid to `chown` it to.

When the camera with the `door` role is the big one, RideWatch shows Open (two taps), I'm coming, Leave the parcel,
Not available and One moment. Each calls the script once with `door` set to `DOORBELL_OPEN`, `DOORBELL_COMING`,
`DOORBELL_PARCEL`, `DOORBELL_BUSY` or `DOORBELL_WAIT`. Your script decides what each one does: unlock, a message on
the doorbell, a notification. Open is never retried, and does nothing for 10 seconds after it was sent. Without the
file, or without `script`, there are no buttons. The buttons are hidden while the car moves. Read
[Security](#security) before you let `DOORBELL_OPEN` unlock anything.

## Any RTSP camera

Any camera with an RTSP or RTSPS stream can be added, next to the Protect ones or with no Protect at all. The limits:

- Live view only. The live views work as for Protect cameras.
- No detections from the camera itself. They reach "What happened" only through the Home Assistant hook (see
  [Where the detections come from](#where-the-detections-come-from)).
- No clips. Clips come from Protect's recordings only, so a camera that is not in Protect has none.

Add one on the setup page, or in the terminal (with no Protect, leave the Protect address empty when `configure.py`
asks for it):

```sh
sudo python3 /opt/jap-ridewatch/configure.py --add-rtsp Gate - "Front gate"
sudo python3 /opt/jap-ridewatch/configure.py --remove-cam Gate
```

- `-` asks for the address without showing it (or reads it from stdin), for example
  `rtsp://viewer:p%40ss@192.0.2.20:554/stream1`, so a password in it stays out of the shell history. You can also
  give the address in place of `-`. Special characters in the user or password are percent-encoded (`@` is `%40`).
- Only `rtsp://` and `rtsps://` addresses are taken, with a host name or an IPv4 or `[IPv6]` address and an optional
  port. The server checks that the camera answers and reads its size and frame rate before adding it.
- The camera keeps its place in the list when `configure.py` runs again; a Protect camera with the same name is left
  out. Removing a camera moves the ones after it up by one, so an older row in "What happened" can then open the
  clip of the wrong camera.
- Its password is stored (see [Security](#security)): use an account on the camera that can only watch.

## Install

### What you need

- An iDrive 7 car (MGU, ID7 HMI) with the [MGU Store](https://github.com/robertnisipeanu/mgu-store) installed, and
  from the Store: mgu-render (0.6.8 or newer) and mgu-uplink, so that the car has a network.
- A UniFi Protect console (UniFi OS) with your cameras, or any RTSP cameras (see [Any RTSP camera](#any-rtsp-camera)).
- A Linux machine at home that stays on: Debian or Ubuntu with systemd, Python 3.7 or newer, ffmpeg with libx264,
  and `openssl` for the setup page's certificate. It encodes one 1920 x 720 stream per car, so give it a few CPU
  cores (a small x86 box or a VM is fine).
- A way for the car to reach that machine. The service tries two local SOCKS5 proxies, in this order:
  - `jap-wireproxy` from [mgu-apps](https://github.com/JustAnotherPU/mgu-apps), on port 1065. It is a client for
    the WireGuard protocol, to a server you run yourself (a home router, a VPS) on the server machine's network.
  - IterioDev's Tailscale (`iteriodev-tailscale`, from [IterioDev/car-apps](https://github.com/IterioDev/car-apps)),
    on port 1055. Its SOCKS5 server is off until you turn it on, as root on the head unit:
    `echo 1055 > /var/opt/iteriodev-tailscale/socks5-port && systemctl restart iteriodev-tailscale`. Sign it in
    with IterioDev's Tailscale app, which shows the login QR code. The server machine is on the tailnet too (or
    behind a subnet router).

  One of them is enough. With both, Tailscale is the backup when WireGuard fails.

### Install the server

On the Linux machine, from a checkout of this repository:

```sh
sudo bash server/install.sh
```

It installs ffmpeg if it is missing, creates a `japridewatch` system user and `/opt/jap-ridewatch`, runs the
selftests and then asks for the Protect address (the console, for example `192.0.2.1`), the user and its password.
It keeps `cams.json` in `/var/lib/jap-ridewatch` with a link at the old path, `/opt/jap-ridewatch/cams.json` (mode
0600, readable by the service only), and starts the services: the stream on TCP port 18640 and the events service.

`sudo bash server/install.sh 100.64.0.5` listens on that address only (for example the machine's Tailscale or
WireGuard address) instead of every interface.

Do not open port 18640 to the internet. The stream is not encrypted and the only check is the car's code: keep it on
your LAN and your tunnel.

Then set up the cameras with the setup page, or in the terminal.

#### Use the setup page

Press Enter at `install.sh`'s Protect address question (no View Only user and no RTSPS setup needed beforehand),
then run:

```sh
sudo ridewatch-setup
```

It prints an address like `https://192.0.2.5:18642/`, the certificate's SHA-256 fingerprint and an 8-character setup
code. Open the address on a computer or phone on the same network. The browser warns that the certificate is not
trusted: compare fingerprints first (see [Security](#security)), then type the code. On the page:

1. Sign in with a local Protect admin. The page lists your cameras and says what it will change: RTSPS turned on for
   the lower-resolution channels the car uses, never the main one. Apply, and it signs out. The admin password is
   used for that one sign-in and is not stored.
2. Optional: a View Only user for detections and clips. That one is stored in `cams.json`, as with `configure.py`.
3. Set labels and roles (see [Camera roles](#camera-roles)), or add any camera by its RTSP address.
4. Add the car (see [Pair the car](#pair-the-car)).

The page stops after 15 minutes without use, 60 minutes in all, or when you press Done. Five wrong codes stop it too.
It answers only addresses on your local network (not Tailscale or the internet), and runs as the service user, never
as root. Without `openssl` there is no page: use the terminal.

#### Use the terminal

1. In Protect, make a local user with the View Only role (Protect, Settings, Admins and Users). The server only
   reads with it.
2. In Protect, turn on RTSPS for each camera (camera, Settings, Advanced, RTSPS), at least for one low and one high
   quality channel. A View Only user cannot do this itself.
3. Give that user to `install.sh` when it asks. It lists the cameras it found, and the channels that still have
   RTSPS off. Then it asks for the cameras' roles (see [Camera roles](#camera-roles)); each one can be left empty.

Run `sudo python3 /opt/jap-ridewatch/configure.py` again whenever you add a camera or want to change the roles;
Enter keeps each answer.

### Install on the car

1. In the MGU Store, open Sources and add `JustAnotherPU/ridewatch` and pick the Releases channel.
   Type only `owner/repo`: the Store refuses a `:releases` at the end.
2. Add `JustAnotherPU/mgu-apps` on Releases too. It has Node.js 22 (`jap-node22`), which the RideWatch service runs
   on, and wireproxy (`jap-wireproxy`).
3. Install RideWatch. The Store installs the RideWatch service (`jap-ridewatch`) and Node.js 22 first, and
   mgu-render if it is missing.
4. Set up the tunnel (see [What you need](#what-you-need)). For `jap-wireproxy`, install it from mgu-apps and write
   its configuration with `BindAddress = 127.0.0.1:1065` (see its
   [README](https://github.com/JustAnotherPU/mgu-apps/tree/main/tools/jap-wireproxy)). For Tailscale, install
   IterioDev's, turn on its SOCKS5 server on port 1055 and sign it in.
5. If the Store says a restart is pending, restart the head unit.

### Pair the car

1. Open RideWatch, then its Settings. Set Server IP (four numbers) to the server machine's address as the car sees
   it, for example its LAN address behind your WireGuard server, or its Tailscale address `100.x.y.z`.
2. Back on the camera page, the app says the server refused this car. While parked it shows a QR code, and below it
   a code like `ABCD-EFGH-JKLM-NPQR`. The car made that code at its first start; it is kept on the head unit
   (`/var/opt/jap-ridewatch/state/server.json`, readable by the service only).
3. Let the car in, either way:
   - By QR code (0.4.3, with the setup page running): scan it with your phone and type the setup code. The page shows
     a short check code, like `7F3A 9C`; confirm if the car shows the same one under its QR code (0.4.4). The QR
     code holds the server address the car uses. If that is a Tailscale or WireGuard address your phone cannot
     reach, or the page refuses it (it answers local addresses only), use the code instead.
   - By the code, on the server:

     ```sh
     sudo python3 /opt/jap-ridewatch/configure.py --add-car ABCD-EFGH-JKLM-NPQR
     ```

4. The app retries by itself and the cameras appear.

`configure.py --cars` lists the cars that are let in (the start of each hash), and `--remove-car` removes one; it
takes the code or that `sha256:...` start.

## Security

What the server stores:

- Nothing from the Protect admin sign-in on the setup page. The admin password is used once and dropped. Done,
  closing the terminal (SIGHUP) or SIGTERM signs the admin out of Protect.
- The optional View Only user and its password, in `cams.json` (mode 0600, owned by `japridewatch`, in a 0700
  folder). Give it the View Only role and no more. A new console address drops the stored View Only user.
- Each car's code as a SHA-256 only (`"sha256:..."` in `cams.json`). Older plain codes keep working and are converted
  the next time `configure.py` or the page writes the file.
- RTSP camera passwords, in `cams.json` only. They are removed from the server's logs, but the stream's address is
  visible to every user on the server in `ps` while a view is open. Use a camera-only account that can only watch.

Things to know:

- The setup page's certificate is self-signed (`install.sh` made it), so the browser warns. Compare the fingerprint
  the browser shows with the one printed in the terminal before you continue. That comparison is the only proof you
  reached your server: if you skip it, a device on your network answering in its place could read the setup code and
  the Protect admin password.
- The server talks to the Protect console over HTTPS without checking its certificate (the console's own certificate
  is self-signed). The setup page sends the admin password the same way, so a device answering at the console's
  address (a typo, or a spoofed address on the LAN) could get it. Run the server on the same LAN as the console.
- A paired car with `ha.json` can open the door if your script unlocks on `DOORBELL_OPEN`. Anyone using the car's
  screen while it is parked can then do it with two taps. Leave unlocking out of the script if you do not want that.
- The Home Assistant token in `ha.json` is sent in plain HTTP inside the tunnel from the car to your home. Create a
  separate Home Assistant user for it, not an administrator: the token can run anything that user can run, not only
  the script.
- Listen and talk on the server are off unless `cams.json` has `"audio": true`, and even then they only work for
  cameras with the `door` role. An indoor camera stays silent unless you give it that role. A car code is enough to
  use them, so turn them on only once a car can. The car reads the server's features once per start of its service, so restart it (or the car)
  after the change.
- The stream between the server and the car is plain H.264 over TCP, and the car's code travels in clear in the first
  line. Inside the tunnel (WireGuard or Tailscale) it is encrypted. Past the tunnel's end, and on any other network,
  it is not. Keep port 18640 off the internet.
- On the car, the RideWatch service's control socket (`/run/jap-ridewatch/ctl.sock`) belongs to the RideWatch app's
  own uid (mode 0600, the uid MainApp's app registry gives `jap_ridewatch`), so other installed apps cannot use it. A
  root helper (`jap-ridewatch-lock`, `socklock.sh`) keeps it that way; while it cannot trust the registry it leaves
  the owner as it was, and with RideWatch uninstalled the socket is root's.
- The RideWatch service runs as RideWatch's own uid and gid, 3911 (no account; not `nobody`, which other services
  share). Its unit starts as root and the service drops to 3911 before anything else; it refuses to run as root.
- From 0.5.3 the sound helper runs as root, because the car's SOME/IP policy lets root reach the audio manager and has
  no entry for uid 3911. Its socket (`/run/jap-ridewatch/audio.sock`) is 3911's, mode 0600, and the helper serves it
  only that way, so only the service (and root) can ask it for sound or for the mic. It takes a short list of
  commands, strictly checked, at most 4 connections. The player it starts runs as 3911 with the car's `mgu_alsa`
  group, never as root. The helper is installed but its socket is off until the car test turns it on.
- Talk needs another app to lend the cabin mic. The helper connects to that app as root, so the lending app should
  admit only uid 3911: that keeps every other user out (root gets in anyway).

## Known limits

- iDrive 7 (ID7) only. The server and the tunnel were measured from one car; the app, the service and the decoder
  are checked by offline tests, and their CPU and decode times on the head unit are not measured yet.
- Protect's API is private and changes between versions. The login, the RTSPS streams and the export used for
  clips were tested with one console. The setup page's sign-in, the camera list (`/proxy/protect/api/cameras`) and
  the camera update it sends were run against that console too (12 cameras, RTSPS already on everywhere, so the
  update changed nothing). The event list (`/proxy/protect/api/events`, the default source of detections) was
  tested only against a fake Protect. If the timeline stays empty, look at `journalctl -u jap-ridewatch-events` and use
  the Home Assistant source meanwhile.
- A camera with RTSPS off is left out. A clip is first exported from Protect (HEVC), then re-encoded to H.264 on
  the server, so it takes a few seconds to start.
- One server stream per car; several cars at once each cost one encoder on the server.
- The video is decoded in hardware (Intel Media SDK). Popups and the reversing camera cover it.

Tested on: a BMW with iDrive 7 (MGU), UniFi Protect on a UniFi console, and a Debian 12 server. The limits above
still apply.

### Driving

By default the cameras show only while the car is parked. Above 3 km/h the picture stops, and if the car's speed
cannot be read the car counts as moving. Pop-ups and the doorbell's buttons never show while the car moves, whatever
the setting.

You can turn Parked only off in the settings. Then the cameras keep playing while the car moves. That is for
passengers only: the driver must never watch the screen. You use it at your own risk; check that it is legal where
you drive. When you turn it off, RideWatch shows a disclaimer first, and the setting only counts once you press
"I agree". Cancel, BACK or leaving the page turns Parked only back on. It also takes effect only once the car has
stopped: turned off while driving, the picture waits for the next stop.

### No warranty

RideWatch is free software, provided "as is", without warranty of any kind, to the extent permitted by applicable
law. In no event will the authors be liable for damages arising from its use. See sections 15 (Disclaimer of
Warranty) and 16 (Limitation of Liability) of the GNU General Public License v3 in `LICENSE`.

Use at your own risk. RideWatch is an independent project, not affiliated with or endorsed by BMW or Ubiquiti; their
names are their owners' trademarks and are used only to say what RideWatch works with. By default it shows the
cameras only while the car is parked.

## Settings

On the car (RideWatch, Settings):

| Setting | |
|---|---|
| Parked only | On by default. See [Driving](#driving). |
| Server IP | The RideWatch server's IPv4 address. There is no default. |
| Server port | 18640, the server's default. |
| SOCKS5 proxy port | The local proxy the service connects through. 1065 (the default) is `jap-wireproxy`, on 127.0.0.1. |
| Second SOCKS5 proxy port | Tried when the first one fails. 1055 (the default) is IterioDev's Tailscale, on 127.0.0.2. 0: none. |
| Latitude, Longitude | Where the cameras are, to the nearest 5 degrees, east positive. Used only to switch to the night camera between sunset and sunrise. Both 0: always the day camera. |

On the server (`/opt/jap-ridewatch/cams.json`, written by `configure.py` or the setup page): the Protect address and
user, the cameras and their roles, the cars' code hashes, the RTSP cameras (added with `--add-rtsp`). Optional keys,
by hand: a Protect channel's `url` (another RTSP source for that camera, used instead of Protect's RTSPS), and the
Home Assistant keys in [Where the detections come from](#where-the-detections-come-from).

On the head unit, by hand and optional: `homeSsid` in `/var/opt/jap-ridewatch/state/server.json`, your home Wi-Fi's
name. When the car is on it, the app shows "car at home" and never picks the garage camera by itself.

## Camera roles

Each role points to one camera, or to none:

| Role | |
|---|---|
| door | A ring, or a person seen there, takes the big picture with a gold ring around it. The doorbell is suggested. |
| garage | Left out of the automatic choice while the car is at home (you would only see your own car). |
| day | The camera shown when nothing is going on. |
| night | The same between sunset and sunrise (needs Latitude and Longitude). |

With no roles at all, the big picture goes to the camera with the latest detection, else to the first camera.
A ring without a door camera shows the camera that rang. Tapping a camera in the pane makes it the big one until
you leave the app.

The controller's touchpad works too: one finger moves a pointer onto a tab, a camera or a row of the timeline, a
tap on the pad opens it, and two fingers scroll the timeline.

## Uninstall

1. In the MGU Store, uninstall RideWatch, then the RideWatch service (`jap-ridewatch`). Node.js 22 and the tunnel
   stay for other apps.
2. On the server, remove the car's code (`configure.py --remove-car CODE`), or the whole server:
   `sudo systemctl disable --now jap-ridewatch.socket jap-ridewatch-events.service`, then
   `sudo rm -r /opt/jap-ridewatch /var/lib/jap-ridewatch /etc/systemd/system/jap-ridewatch*` and
   `sudo userdel japridewatch`.

## Repository layout

| Path | |
|---|---|
| `apps/jap_ridewatch`, `test/app` | the app (Node 8, on the head unit), built with the kit, and its tests |
| `kit/` | the app kit (build script and runtime) |
| `daemon/` | `ridewatchd.js`, the service (Node 22): the stream and events from the server, the choice of the big camera |
| `native/camdec` | the H.264 decoder (C++, Intel Media SDK) writing into mgu-render's video layer |
| `tools/jap-ridewatch` | the service's tool: manifest, unit, build script |
| `server/` | the RideWatch server: `serve.py` (stream, clips), `events.py`, `configure.py`, `install.sh`, systemd units |
| `examples/` | Home Assistant as a source of detections |
| `demo/` | `testserver.py`: the server with a fake Protect and an event hook, for tests without cameras |
| `release/` | makes the Store release (`catalog.json` and the artifacts) |

## Building

You need Docker (on a Mac: colima; set `TMPDIR` to a folder outside `/var/folders`), Python 3, Node.js, and a
checkout of the [MGU Store](https://github.com/robertnisipeanu/mgu-store) for its packer (`MGU_STORE=<path>`).
BMW's oap-sdk is never part of this repository or of a release. To build or test the app you need your own copy,
extracted from your head unit with `kit/tools/extract_sdk.js`, in `./oap-sdk`.

```sh
python3 kit/tools/build.py jap_ridewatch              # the app: dist/jap_ridewatch@<version>.tgz
make -C native/camdec target                     # the decoder (x86_64, glibc 2.27)
sh tools/jap-ridewatch/build.sh                       # the tool artifact, in dist/
sh release/release.sh                            # dist/release/: catalog.json + artifacts (no oap-sdk)
```

Tests:

```sh
# the app against a fake service and renderer, on Node 8 (the head unit's)
docker run --rm --network none -v "$PWD:/w" -w /w node:8.16.0-alpine \
  sh -c 'mkdir -p /tmp/t && node test/app/smoke.js dist/jap_ridewatch /tmp/t && node test/app/frame_test.js'
# the service, on Node 22
docker run --rm --network none -v "$PWD/daemon:/w" -w /w node:22-alpine node test/ridewatchd_test.js
# the decoder: unit tests and a smoke test on the host (needs ffmpeg), then the same in the target image
make -C native/camdec test target
# the kit's shared files against RideTube's canonical kit, and its parked check
python3 kit/tools/kit_sync.py --check && node kit/tools/test_parked.js
# the server (Python 3, ffmpeg)
python3 server/serve.py --selftest && python3 server/events.py --selftest && python3 server/configure.py --selftest
# the test server (demo/testserver.py: the real serve.py and events.py behind a fake Protect)
python3 demo/testserver.py --selftest
```

## Releasing

Make a GitHub release named `catalog` (tag `catalog`) and upload every file of `dist/release/`: `catalog.json`,
the two `.tgz` artifacts and `jap_ridewatch.png`. The Store reads `catalog.json` from that release and checks every
download against its size and sha256. For a new version, run `release/release.sh` again and replace the release's
files.

## License

GPL-3.0-or-later (`LICENSE`). Copyright (C) 2026 JustAnotherPU. Third-party components and their licences are
listed in `THIRD_PARTY_LICENSES/`.
