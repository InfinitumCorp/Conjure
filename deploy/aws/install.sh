#!/usr/bin/env bash
# Installs or updates Conjure on an Amazon Linux 2023 EC2 instance. Runs as root,
# from user data on first boot and through SSM Run Command on every deploy.
#
#   install.sh <s3-bucket> <s3-key> <app-host> <preview-host> <region>
#
# Layout: /opt/conjure/releases/<id> (code, "current" symlink), /var/lib/conjure (deliverables),
# /etc/conjure/env (secrets from SSM Parameter Store, root-only).
set -euo pipefail
BUCKET="$1"; KEY="$2"; APP_HOST="$3"; PREVIEW_HOST="$4"; REGION="$5"

NODE_VERSION="v24.11.0"
CADDY_VERSION="2.10.2"
case "$(uname -m)" in
  aarch64) NODE_ARCH="linux-arm64"; CADDY_ARCH="linux_arm64" ;;
  x86_64)  NODE_ARCH="linux-x64";   CADDY_ARCH="linux_amd64" ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac
log() { echo "[conjure-install] $*"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# --- Node.js (official build, checksum-verified) ---
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  log "installing Node $NODE_VERSION"
  base="https://nodejs.org/dist/$NODE_VERSION"
  file="node-$NODE_VERSION-$NODE_ARCH.tar.xz"
  curl -fsSL -o "$TMP/$file" "$base/$file"
  curl -fsSL -o "$TMP/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$TMP" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$file" -C /usr/local --strip-components=1 --no-same-owner
fi

# --- Caddy (HTTPS reverse proxy, checksum-verified) ---
if ! /usr/local/bin/caddy version 2>/dev/null | grep -q "v$CADDY_VERSION"; then
  log "installing Caddy $CADDY_VERSION"
  base="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
  file="caddy_${CADDY_VERSION}_${CADDY_ARCH}.tar.gz"
  curl -fsSL -o "$TMP/$file" "$base/$file"
  curl -fsSL -o "$TMP/sums.txt" "$base/caddy_${CADDY_VERSION}_checksums.txt"
  (cd "$TMP" && grep " $file\$" sums.txt | sha512sum -c -)
  tar -xzf "$TMP/$file" -C "$TMP" caddy
  install -m 0755 "$TMP/caddy" /usr/local/bin/caddy
fi

id conjure >/dev/null 2>&1 || useradd --system --home-dir /var/lib/conjure --shell /sbin/nologin conjure
id caddy   >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy   --shell /sbin/nologin caddy
install -d -o conjure -g conjure -m 0750 /var/lib/conjure
install -d -o caddy -g caddy -m 0750 /var/lib/caddy
install -d -m 0755 /opt/conjure/releases /etc/caddy
install -d -m 0700 /etc/conjure

# --- Code ---
RELEASE="/opt/conjure/releases/$(date +%Y%m%d%H%M%S)"
log "fetching s3://$BUCKET/$KEY -> $RELEASE"
mkdir -p "$RELEASE"
aws s3 cp --region "$REGION" --only-show-errors "s3://$BUCKET/$KEY" "$TMP/conjure.tar.gz"
tar -xzf "$TMP/conjure.tar.gz" -C "$RELEASE" --no-same-owner
(cd "$RELEASE" && PATH=/usr/local/bin:$PATH npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$RELEASE"; chmod -R a+rX "$RELEASE"
ln -sfn "$RELEASE" /opt/conjure/current.new && mv -Tf /opt/conjure/current.new /opt/conjure/current

# --- Secrets (SSM Parameter Store, SecureString) ---
param() { aws ssm get-parameter --region "$REGION" --name "$1" --with-decryption --query Parameter.Value --output text 2>/dev/null || true; }
TOKEN="$(param /conjure/access-token)"
API_KEY="$(param /conjure/anthropic-api-key)"
MODEL="$(param /conjure/model)"
if [ -z "$TOKEN" ] || [ "$TOKEN" = "None" ]; then echo "missing SSM parameter /conjure/access-token" >&2; exit 1; fi
umask 077
{
  echo "CONJURE_ACCESS_TOKEN=$TOKEN"
  if [ -n "$API_KEY" ] && [ "$API_KEY" != "None" ] && [ "$API_KEY" != "unset" ]; then echo "ANTHROPIC_API_KEY=$API_KEY"; fi
  if [ -n "$MODEL" ] && [ "$MODEL" != "None" ]; then echo "CONJURE_MODEL=$MODEL"; fi
} > /etc/conjure/env
umask 022

# --- Services ---
cat > /etc/systemd/system/conjure.service <<EOF
[Unit]
Description=Conjure
After=network-online.target
Wants=network-online.target

[Service]
User=conjure
Group=conjure
WorkingDirectory=/opt/conjure/current
EnvironmentFile=/etc/conjure/env
Environment=NODE_ENV=production HOST=127.0.0.1 PORT=4317 PREVIEW_PORT=4318
Environment=CONJURE_OUT=/var/lib/conjure PREVIEW_ORIGIN=https://$PREVIEW_HOST
ExecStart=/usr/local/bin/node src/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/conjure
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
{
	admin off
}
$APP_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:4317 {
		flush_interval -1
	}
	header Strict-Transport-Security "max-age=31536000"
}
$PREVIEW_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:4318
}
EOF

cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable conjure caddy >/dev/null 2>&1
systemctl restart conjure
systemctl restart caddy

# Keep the five newest releases.
ls -1dt /opt/conjure/releases/* | tail -n +6 | xargs -r rm -rf

for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4317/healthz >/dev/null 2>&1; then log "conjure is up: https://$APP_HOST"; exit 0; fi
  sleep 1
done
echo "conjure did not become healthy" >&2
journalctl -u conjure -n 40 --no-pager >&2 || true
exit 1
