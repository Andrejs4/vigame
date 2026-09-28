#!/usr/bin/env bash
# Install or update Vigame on a Debian (or Ubuntu) server, as a systemd
# service. Run it as root from a checkout of the repository:
#
#   sudo deploy/install.sh
#
# Run it again after `git pull` to update: it installs the committed files
# of the checkout (uncommitted changes are left out), keeps the previous
# version for a rollback, and restarts the service. Games are kept.
#
# What it touches (see deploy/README.md for removing it all again):
#   user and group  vigame (a system user; no login, no home)
#   /opt/vigame     Node.js for this service alone, and the installed game
#   /var/lib/vigame the database (created by systemd)
#   /etc/vigame     vigame.env, your settings (written once, never overwritten)
#   /etc/systemd/system/vigame.service
#   apt packages    ca-certificates curl git xz-utils, if missing
#
# Settings, as environment variables:
#   NODE_MAJOR=22   the Node.js line to install (the game needs 22 or newer)

set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-22}"
PREFIX=/opt/vigame
USER_NAME=vigame
UNIT=/etc/systemd/system/vigame.service
ENV_DIR=/etc/vigame

say() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo $0)"
command -v systemctl >/dev/null || die "systemd is needed"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$SRC/package.json" ] && [ -f "$SRC/server/main.js" ] || die "run this from a Vigame checkout"

say "Packages"
missing=()
for pkg in ca-certificates curl git xz-utils; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if [ ${#missing[@]} -gt 0 ]; then
  apt-get update
  apt-get install -y --no-install-recommends "${missing[@]}"
else
  echo "all there"
fi

say "User $USER_NAME"
if id "$USER_NAME" >/dev/null 2>&1; then
  echo "exists"
else
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USER_NAME"
  echo "created"
fi
install -d -m 0755 "$PREFIX"

say "Node.js $NODE_MAJOR"
case "$(dpkg --print-architecture)" in
  amd64) arch=x64 ;;
  arm64) arch=arm64 ;;
  armhf) arch=armv7l ;;
  *) die "no Node.js build for $(dpkg --print-architecture); install Node $NODE_MAJOR into $PREFIX/node yourself" ;;
esac
base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
sums="$(curl -fsSL "$base/SHASUMS256.txt")"
file="$(printf '%s\n' "$sums" | awk -v a="linux-${arch}.tar.xz" '$2 ~ a"$" { print $2; exit }')"
[ -n "$file" ] || die "no linux-$arch build listed at $base"
version="${file#node-}"; version="${version%%-linux*}"
current="$("$PREFIX/node/bin/node" --version 2>/dev/null || true)"
if [ "$current" = "$version" ]; then
  echo "$version already installed"
else
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/$file" "$base/$file"
  (cd "$tmp" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c -)
  rm -rf "$PREFIX/node.new"
  mkdir "$PREFIX/node.new"
  tar -xJf "$tmp/$file" -C "$PREFIX/node.new" --strip-components=1
  rm -rf "$PREFIX/node"
  mv "$PREFIX/node.new" "$PREFIX/node"
  echo "installed $version (was: ${current:-none})"
fi
NODE_BIN="$PREFIX/node/bin"

say "The game"
stage="$PREFIX/app.new"
rm -rf "$stage"
mkdir "$stage"
if git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  # Committed files only, so a stray local file never ends up on the server.
  git -c safe.directory="$SRC" -C "$SRC" archive HEAD | tar -x -C "$stage"
  echo "from commit $(git -c safe.directory="$SRC" -C "$SRC" rev-parse --short HEAD)"
else
  cp -a "$SRC/." "$stage/"
  rm -rf "$stage/node_modules" "$stage/data" "$stage/smoke-output"
  echo "from $SRC (not a git checkout: copied as it is)"
fi
chown -R "$USER_NAME:$USER_NAME" "$stage"
# Production packages only: no Playwright, no Chromium, no playground.
# npm runs as the service user, so package install scripts never run as root.
install -d -o "$USER_NAME" -g "$USER_NAME" "$PREFIX/.npm"
runuser -u "$USER_NAME" -- env PATH="$NODE_BIN:/usr/bin:/bin" HOME="$PREFIX/.npm" \
  npm_config_cache="$PREFIX/.npm" npm_config_update_notifier=false \
  sh -c "cd '$stage' && npm ci --omit=dev --no-audit --no-fund" \
  || die "npm ci failed. If better-sqlite3 had to be compiled, install build tools (apt install python3 make g++) and run this again."

say "Settings"
install -d -m 0750 -o root -g "$USER_NAME" "$ENV_DIR"
if [ ! -f "$ENV_DIR/vigame.env" ]; then
  install -m 0640 -o root -g "$USER_NAME" /dev/null "$ENV_DIR/vigame.env"
  cat > "$ENV_DIR/vigame.env" <<'ENV'
# Vigame settings, read by the service at start. Uncomment to change.
# `systemctl restart vigame` after editing.

# The port nginx forwards to. Keep HOST at 127.0.0.1 behind nginx.
#PORT=2567
#HOST=127.0.0.1

# Serves the Colyseus monitor at /monitor (user "admin"). It shows every
# game and can close rooms: use a long random password, or leave it off.
#MONITOR_PASSWORD=
ENV
  echo "wrote $ENV_DIR/vigame.env"
else
  echo "kept $ENV_DIR/vigame.env"
fi

say "Service"
install -m 0644 "$SRC/deploy/vigame.service" "$UNIT"
systemctl daemon-reload
was_running=no
systemctl is-active --quiet vigame && was_running=yes && systemctl stop vigame
rm -rf "$PREFIX/app.old"
[ -d "$PREFIX/app" ] && mv "$PREFIX/app" "$PREFIX/app.old"
mv "$stage" "$PREFIX/app"
systemctl enable --quiet vigame
systemctl start vigame
sleep 2
if systemctl is-active --quiet vigame; then
  echo "running ($([ "$was_running" = yes ] && echo restarted || echo started))"
else
  journalctl -u vigame -n 30 --no-pager || true
  die "the service didn't stay up; see the log above. The previous version is in $PREFIX/app.old."
fi

port="$(sed -n 's/^PORT=//p' "$ENV_DIR/vigame.env" | tail -1)"
say "Done"
cat <<EOF
The game listens on 127.0.0.1:${port:-2567}. Check it with:
  curl -s http://127.0.0.1:${port:-2567}/ | head -5
To open it to players, put deploy/nginx-location.conf in your nginx site
(see deploy/README.md). Logs: journalctl -u vigame -f
EOF
