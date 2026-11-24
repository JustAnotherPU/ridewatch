# Changelog

The Store still installs 0.3.4. Versions 0.4.0 to 0.5.5 are in the source only, until they have run on a car.

## Unreleased (server 0.5.0, service tool 0.5.5)

- App: `ha.json` must belong to the RideWatch app's own uid, mode 0600, and must not be a link. The apps on the car
  share one group, so the old 0640 rule let any of them read the Home Assistant token. An older file is ignored until
  it is chowned to the app's uid (the log names it) and chmodded to 600. Every app on the car could read the old
  file, so make a new Home Assistant token and revoke the old one.
- Server: listen and talk are off unless `cams.json` has `"audio": true`, and then only for cameras with the `door`
  role. Before, any paired car could ask for the audio of every camera, indoor ones included. `hello` lists them only
  when they are on.
- Service tool: `jap-ridewatch-lock` checks MainApp's registry every 30 s instead of every 5 s, with about a third
  of the processes per check. The service and socket starts still run one check at once; a first install of the app can
  take up to 30 s more to connect.
- Server: a setup page, `sudo ridewatch-setup`. Sign in to UniFi Protect once with a local admin: the page lists every
  camera, turns on RTSPS for the channels the car uses (never the main one), saves them and signs out. The admin
  password is not stored. It also sets labels and roles, adds RTSP cameras, stores an optional View Only user, and
  lets a car in when you scan the QR code the car shows. It uses HTTPS with a certificate that `install.sh` makes with
  openssl; without openssl there is no page. It answers only on the local network, asks for an 8-character code
  printed in the terminal, and stops by itself.
- Server: cars are stored as the SHA-256 of their code. Older codes keep working and are converted on the next write.
  `configure.py --cars` no longer prints the codes.
- Server: `cams.json` moves to `/var/lib/jap-ridewatch` (a link stays at the old path), so the page can write it as
  the service user.
- Server: the events service no longer polls Protect when no Protect user is stored.
- Server: `configure.py` switches to the service user before it touches `cams.json`, whatever it is run with, and
  `install.sh` moves the old `cams.json` as that user, so root never writes in the service user's folder. The state
  folder is 0700.
- Server: the setup page checks a car by a short fingerprint of its code's hash (the car shows it under the QR code)
  instead of the last four characters of the code. A new console address drops the stored View Only user and its
  session. Closing the terminal (SIGHUP) or SIGTERM signs the admin out of Protect, as Done does.
- Server: a 3:4 hero (the doorbell) now sits at the left edge at full height (540x720 on 1920x720) instead of centred
  on a blurred copy of itself. The layout line adds `controls`, a free 420 px column beside it, and the other cameras
  fill the rest: three rows of three 16:9 thumbs and a band with one more thumb and the three rounds. A wide hero
  is laid out as before. Older apps ignore `controls`.

## 0.5.5

The app only; the service is unchanged (still 0.5.4). Tested offline (smoke test and the simulator), not on a car.

- With a server that sends `controls`, the doorbell's Listen and Talk buttons and its quick replies go in that column,
  never over the door picture, each row centred in the column. Without Listen and Talk the replies are centred
  in it vertically too. An older server keeps the old placement over the picture.
- The clock and Day/Night stay at the top right; beside the doorbell they move to the top of the column.
- Settings is a gear after the tabs instead of the word "Settings".
- No more gold frame drawn over the door picture on a ring.

## 0.5.4

Small checks in the sound helper, all tested offline; nothing run on a car.

- It refuses to start when its state folder is a link, is not its own, or is open to others.
- Started by hand outside the unit, it refuses a socket folder that is not its own or that others can write, so it
  never changes the owner of a file through a link.
- A first line over 256 bytes is refused even when it arrives in one piece.

## 0.5.3

Still no sound on any car, and nothing below was run on one; "tested" means the offline tests.

- The sound helper runs as root again: the car's SOME/IP rules let root reach the audio manager and have no entry for
  RideWatch's uid. The car's service itself stays uid 3911.
- Only the service (and root) can reach the helper: its socket is 3911's and 0600, and the helper refuses to serve one
  that is not. It takes only its four commands, with their own fields, a first line of 256 bytes within 2 s, and at
  most 4 connections. Tested, including a socket that is not 3911's and one the helper cannot hand over.
- The player the helper starts runs as uid 3911 with the car's ALSA group as its only group, never as root. Tested
  with a fake player; whether the car's player works that way is for the car test.
- The helper connects to the mic lender as root. A lender that admits only uid 3911 keeps everyone else out, but not
  root.
- The helper's unit is hardened where it cannot get in the way of SOME/IP or ALSA: no new privileges, no access to home
  folders, system folders read-only. Not run under the car's systemd yet.
- The SOME/IP group 0.5.2 added is gone: nothing running as 3911 talks SOME/IP now.

## 0.5.2

Still no sound on any car, and nothing below was run on one; "tested" means the offline tests.

- The frame file for the video is checked when the service starts (root's, the service's group, 0660), and a failure
  stops the start instead of leaving a black picture. A link or an empty folder put at its path is removed first.
  Tested on BusyBox, including the car's version.
- The car's service refuses to run as root unless the unit's uid line is there.
- The sound helper no longer uses an audio source when it cannot record that it did (the record is what undoes it
  after a crash). Tested against the fakes.
- Temporary files a killed earlier version left in the state folder are removed at start, so settings save again.
- The sound helper also joins the car's SOME/IP group. That may not be enough for the car to let it talk to the audio
  manager: still to be seen on the car.

## 0.5.1

Still no sound on any car: Listen and Talk stay off until a supervised test on the car fills in what is missing
(the car's audio source ids, a player, a mic lender). Nothing below was run on a car; "tested" means the offline
tests, against a fake audio manager, a fake player and a fake mic lender.

- The buttons show only when they can work: the car's service offers Listen when the sound helper has a source id and
  a player, and Talk when a mic lender is set. With this release's defaults neither shows.
- The sound helper's socket is installed but not turned on.
- The car's service and the sound helper run as RideWatch's own uid 3911 instead of `nobody`. Only the service can
  reach the sound helper. The video's frame file is now made by root for the service's group, which the
  renderer accepts (its check, owner only, read in its source); the decoder opening it as uid 3911 was tested with the
  decoder's own code, not on a car. The state earlier versions left as `nobody`'s is handed over (tested on busybox).
- The sound helper ships the two audio manager interface descriptions it needs. Connecting, disconnecting and the
  connection list match this car model's firmware image; the source list (`getListMainSources`) is taken from the
  GENIVI interface and is unverified on this car until it is read there.
- Tested against the fakes: an audio source is used only if it is free; whether it was available before is read and
  put back; a connection another program made is never closed; after a crash only what the helper recorded for its
  own sources is undone, and with nothing recorded the audio manager is not touched.
- Tested against the fakes: every phone source (calls, rings, phone assistants) refuses or ends Listen and Talk, and
  so does an audio manager that stops answering for 1 second. Listen ends after 5 minutes (configurable).
- Talk ends as soon as its button leaves the screen: the camera view, a clip, a lost picture, another camera in the
  hero's place. Its 60-second limit no longer depends on the button being drawn.
- Sound passed between the server, the service and the helper is cut only on whole samples.
- A talk the server ends early no longer says "Talk ended after 60 s".

## 0.5.0

The plumbing for Listen and Talk, off by default; no sound yet on any car.

- Listen and Talk buttons on the door camera's view: hold Talk with a finger, or press the knob to start and stop,
  60 seconds at most. Checked by the app's offline tests.
- A sound helper service, `jap-ridewatch-audio`, and the car service's `listen`, `unlisten`, `talk` and `untalk`.
  Checked only against fakes; as built it could not have worked on the car (corrected in 0.5.1).

## 0.4.4

- Under the pairing QR code the car shows a short check code, for example `Check: 7F3A 9C`. The server's setup page
  shows the same code before it adds the car. The QR code no longer carries the last four characters of the car's code.

## 0.4.3

- When the server refuses the car, RideWatch shows a QR code while parked. Scan it with a phone to open the server's setup page and add the car. The terminal way stays below it (configure.py --add-car <code>), and the QR goes as soon as the server accepts the car.

## 0.4.2

- On a narrow camera (the portrait doorbell) the clock moves under the tabs instead of running into Settings.

## 0.4.1

- Full screen: a Settings button under the message (for example "no server address") and a Settings tab next to
  Live and What happened. The full-screen view had no way to open the settings by touch.

## 0.4.0

- RideWatch starts with the head unit and stays running while hidden, with only the service's socket open. When the
  doorbell rings it shows a pop-up over any app, "Doorbell · <camera>" with "View", for 30 seconds. "View" opens
  RideWatch on the doorbell. A ring while RideWatch is on screen goes to the Live tab instead.
- Pop-ups for a person, a vehicle, a package or an animal, each with its own setting (off by default) and a cooldown
  per camera and type (1, 5 or 15 minutes).
- No pop-up while the car moves or when no speed can be read, whether Parked only is on or off, and a pop-up that is
  showing closes as soon as the car moves. The speed is read only while RideWatch is on screen or while a pop-up is
  being decided or shown. A second ring within two minutes still pops up, and so does a ring that came while the
  service was reconnecting to the server, if it is less than a minute old.
- Quick replies on the doorbell camera (the one with the `door` role): Open (two taps), I'm coming, Leave the parcel,
  Not available, One moment. Each calls a Home Assistant script named in `ha.json` in the app's data folder, with
  `{"door": "DOORBELL_OPEN"}` and so on. Without that file, or without a script in it, there are no buttons. Hidden
  while the car moves. Open is never sent twice, and does nothing for 10 seconds after it was sent; its two taps are
  timed on a clock that a change of the car's time does not move. `ha.json` is ignored if every app can read it (it
  must be mode 0640 or stricter), or if its host is not an IPv4 address or its port not a number from 1 to 65535.
- A setting puts the pop-ups and the doorbell's buttons in French.
- Hidden, RideWatch tells the service so from the start, and runs no timers, no speed watch and no renderer connection.
  The speed watch's SOME/IP proxy is shut down in its own tick, as the kit builds it.
- Server: `configure.py` keeps two Protect cameras that have the same name (it matches them on Protect's id), and
  checks a camera's label as it checks its name.

## 0.3.4

- Turning Parked only off now shows a disclaimer first (passengers only, at the owner's risk). The setting counts
  once you press "I agree", and only from the next stop: turned off while driving, the picture waits until the car
  has stopped. Before, it showed the cameras at once. A car that already had Parked only off shows the
  disclaimer once, at the next start.
- The controller's touchpad: one finger moves a pointer, a tap on the pad opens what it is on, two fingers scroll
  the timeline.
- The tabs and the big camera's tap area now start right of the HMI's back arrow column (x 84), where a tap closed
  the app, unless the renderer gives the app that column.
- Service: when camdec shows no new picture for 5 seconds while the stream keeps sending, the service reconnects on
  a new camdec. Before, the picture could stay frozen.
- The kit's shared files are synced with RideTube's (`kit/tools/kit_sync.py --check`).

## Service 0.3.3

- The control socket is now for the RideWatch app alone: systemd makes it (`jap-ridewatch.socket`, root, 0600) and
  `jap-ridewatch-lock` hands it to the app's uid from MainApp's registry, so other installed apps can no longer
  connect. After the update the app gets in at once; the lock loop itself runs from the next start of the head unit.

## 0.3.2

- The tunnels: `jap-wireproxy` from mgu-apps first (SOCKS5 port 1065, on 127.0.0.1), IterioDev's Tailscale second
  (port 1055, on 127.0.0.2). The second SOCKS5 proxy port is now 1055 by default, set once on cars that saved
  another value. The service writes port 1055 as `127.0.0.2:1055` in `server.json` and any other port on
  127.0.0.1; `server.json` keeps its `host:port` form.
- `jap-tailscale` is no longer in mgu-apps: for Tailscale, use IterioDev's with its SOCKS5 server turned on
  (README, "What you need").

## 0.3.1

- Renamed to RideWatch: the app is `jap_ridewatch`, its service `jap-ridewatch`, and the server's user, folders and
  units say `ridewatch` too. Install the server again with `server/install.sh`, then set the Server IP in the app
  and add the car's new code.
- README: which cameras work with what (Protect, other RTSP cameras).
- The video frames go to `/dev/shm/mgu-video-ridewatch`: mgu-render only reads frame files named
  `/dev/shm/mgu-video-*`, and refused the previous path.

## 0.3.0

First public release.

- The app, the service and the server no longer assume one home: the server address, the ports and the location
  are app settings, and the cameras' roles (door, garage, day, night) are set on the server.
- The car makes its own code at the first start and shows it while the server refuses it; `configure.py --add-car`
  lets it in.
- `server/install.sh` and `server/configure.py`: the server is installed in one command, finds the cameras and their
  RTSPS channels in Protect and writes `cams.json` itself.
- The detections are read from Protect's event list by default; Home Assistant stays possible as a source.
- Parked only is on by default.
- Everything is in English.
