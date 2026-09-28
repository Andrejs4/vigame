# Running Vigame on a Debian server

Vigame runs as one systemd service under its own user, with its own copy of
Node.js, behind the nginx you already have. It installs no global npm
packages, doesn't touch the system's Node (if any), and can only write to
its database folder. Removing it removes everything (see the end).

| Path | What it is |
| --- | --- |
| `/opt/vigame/node` | Node.js 22, for this service alone |
| `/opt/vigame/app` | the game, as installed (`app.old`: the version before) |
| `/var/lib/vigame` | the database: `vigame.db` and its `-wal` and `-shm` files |
| `/etc/vigame/vigame.env` | your settings |
| `/etc/systemd/system/vigame.service` | the service ([vigame.service](vigame.service)) |

## Install

On the server, as a user with sudo:

```sh
git clone https://github.com/Andrejs4/vigame.git ~/vigame
cd ~/vigame
sudo deploy/install.sh
```

(If the repository is private, clone it with your GitHub credentials or a
deploy key; the script itself needs no access to GitHub, only to nodejs.org
and your apt mirror.)

The script ([install.sh](install.sh)):

1. installs `ca-certificates curl git xz-utils` if they're missing;
2. creates the system user `vigame` (no login, no home);
3. downloads the latest Node.js 22 for your CPU from nodejs.org, checks its
   checksum, and unpacks it into `/opt/vigame/node`;
4. copies the committed files of your checkout into `/opt/vigame/app` and
   runs `npm ci --omit=dev` there as `vigame`, so no package script runs as
   root, and without Playwright or its browser, which only the tests use;
5. writes `/etc/vigame/vigame.env` with the settings commented out (only
   the first time);
6. installs and starts the service.

Check it: `curl -s http://127.0.0.1:2567/ | head -5` should print the start
of the page.

If `npm ci` fails compiling `better-sqlite3`, there was no ready-made build
for your CPU and Node version: `sudo apt install python3 make g++`, then run
the script again.

## Open it to players

The service listens on `127.0.0.1:2567` only. Put
[nginx-location.conf](nginx-location.conf) inside your site's `server { }`
block (it serves the game at `/vigame/`), then:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

Players open `https://your-site/vigame/`. For a subdomain of its own
instead, use `location /` and `proxy_pass http://127.0.0.1:2567;` with the
same headers. The main [README](../README.md#behind-nginx) has more on this.

## Settings

Edit `/etc/vigame/vigame.env`, then `sudo systemctl restart vigame`:

- `PORT`: if 2567 is taken (change it in the nginx block too).
- `MONITOR_PASSWORD`: serves the Colyseus monitor at `/monitor/`, user
  `admin`. It shows every game and can close rooms: use a long random
  password, or leave it unset.

## Update

```sh
cd ~/vigame
git pull
sudo deploy/install.sh
```

Games in progress are saved when the service stops and carry on after it
starts. The previous version stays in `/opt/vigame/app.old`. To go back to
it:

```sh
sudo systemctl stop vigame
sudo mv /opt/vigame/app /opt/vigame/app.bad && sudo mv /opt/vigame/app.old /opt/vigame/app
sudo systemctl start vigame
```

A release that changes the rules may start a new database version, which
drops saved games (players keep their names). The commit notes say when.

## Day to day

```sh
systemctl status vigame          # running?
journalctl -u vigame -f          # the log
sudo systemctl restart vigame    # after changing settings
```

## Backups

The whole game state is the database. To copy it safely, stop the service
for a moment:

```sh
sudo systemctl stop vigame
sudo cp -a /var/lib/vigame /root/vigame-backup-$(date +%F)
sudo systemctl start vigame
```

Or, without stopping it, with SQLite's own tool (`sudo apt install sqlite3`):

```sh
sudo -u vigame sqlite3 /var/lib/vigame/vigame.db ".backup /var/lib/vigame/backup.db"
```

Keep the database on a local disk, not a network share: SQLite needs real
file locks.

## Remove it

```sh
sudo systemctl disable --now vigame
sudo rm /etc/systemd/system/vigame.service && sudo systemctl daemon-reload
sudo rm -rf /opt/vigame /etc/vigame
sudo rm -rf /var/lib/vigame          # the games; keep a copy if you want them
sudo userdel vigame
```

Then take the `location /vigame/` block out of your nginx site and reload
nginx. The apt packages the script may have added (`curl`, `git`,
`xz-utils`, `ca-certificates`) are common tools; remove them only if you
know nothing else uses them.
