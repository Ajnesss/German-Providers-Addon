#!/bin/sh
# Starts Cloudflare WARP as a local SOCKS5 proxy (127.0.0.1:40000) in the background, then the addon.
# The addon works without WARP too; set WARP=0 on Render to switch it off.
if [ "${WARP:-1}" != "0" ] && command -v wgcf >/dev/null 2>&1 && command -v wireproxy >/dev/null 2>&1; then
  (
    mkdir -p /tmp/warp && cd /tmp/warp || exit 1
    ok=""
    for i in 1 2 3 4 5; do
      if wgcf register --accept-tos && wgcf generate; then ok=1; break; fi
      echo "[warp] registration failed, retrying in 20s"; sleep 20
    done
    [ -z "$ok" ] && { echo "[warp] giving up"; exit 1; }
    printf 'WGConfig = /tmp/warp/wgcf-profile.conf\n\n[Socks5]\nBindAddress = 127.0.0.1:40000\n' > wireproxy.conf
    echo "[warp] starting wireproxy"
    exec wireproxy -c wireproxy.conf
  ) 2>&1 | sed -u 's/^/[warp] /' &
else
  echo "[warp] not started (WARP=0 or tools missing)"
fi
exec node server.js
