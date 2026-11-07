#!/bin/bash
# German Providers Addon on Oracle Cloud (Always Free).
# Paste this whole file into "Cloud-init script" when creating the server: it installs everything on first boot.
# Progress log on the server: /var/log/gpa-setup.log
exec > /var/log/gpa-setup.log 2>&1
set -x

REPO=https://github.com/Ajnesss/German-Providers-Addon
RENDER=https://german-providers-addon.onrender.com
RELAY_TOKEN="${RELAY_TOKEN:-PUT_YOUR_SECRET_HERE}"   # your private password (unlocks tmdb-key.enc); fill in before use, never commit the real one

# 0. swap space, so the small 1 GB "Micro" server can build and run the addon too (harmless on bigger ones)
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 1. Oracle's Ubuntu image blocks every port except SSH: open web ports 80 + 443
iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io git curl iptables-persistent
netfilter-persistent save
systemctl enable --now docker

# 2. the addon's code
git clone --depth 1 "$REPO" /opt/gpa

# 3. settings: TMDB key from Render, public address = this server's IP as an sslip.io name (free, gets https)
KEY=""
for i in $(seq 1 20); do
  KEY=$(curl -fsS -m 80 "$RENDER/relay/config?token=$RELAY_TOKEN" | sed -n 's/.*"tmdbKey":"\([^"]*\)".*/\1/p')
  [ -n "$KEY" ] && break; sleep 15
done
IP=$(curl -fsS -m 20 https://api.ipify.org || curl -fsS -m 20 https://ifconfig.me)
HOST="$(echo "$IP" | tr . -).sslip.io"
cat > /opt/gpa.env <<ENV
TMDB_API_KEY=$KEY
RELAY_TOKEN=$RELAY_TOKEN
TIMEOUT_MS=25000
PASSTHROUGH_GB=9000
PUBLIC_URL=https://$HOST
ENV
echo "https://$HOST/manifest.json" > /opt/gpa-address.txt

# 4. build and start the addon (restarts by itself after crashes and reboots)
# (the deploy script is part of the repository and keeps itself up to date)
install -m 755 /opt/gpa/deploy/gpa-deploy.sh /usr/local/bin/gpa-deploy
/usr/local/bin/gpa-deploy force

# 5. https in front of it (Caddy gets a free certificate for the sslip.io name)
mkdir -p /opt/caddy
cat > /opt/caddy/Caddyfile <<CADDY
$HOST {
    reverse_proxy 127.0.0.1:8000
}
CADDY
docker rm -f caddy 2>/dev/null
docker run -d --name caddy --restart always --network host \
  -v /opt/caddy/Caddyfile:/etc/caddy/Caddyfile -v caddy_data:/data caddy:2

# 6. updates: every 2 minutes, pick up new commits from GitHub (no Render-style "Manual Deploy" needed)
echo '*/2 * * * * root /usr/local/bin/gpa-deploy >> /var/log/gpa-deploy.log 2>&1' > /etc/cron.d/gpa-deploy

echo "DONE. Addon address: https://$HOST/manifest.json"
