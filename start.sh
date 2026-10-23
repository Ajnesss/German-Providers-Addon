#!/bin/sh
# Starts Cloudflare WARP as a local SOCKS5 proxy (127.0.0.1:40000) in the background, then the addon.
# The addon works without WARP too (fewer sites); set WARP=0 on Render to switch it off.
if [ "${WARP:-1}" != "0" ] && command -v wgcf >/dev/null 2>&1 && command -v wireproxy >/dev/null 2>&1; then
  (
    mkdir -p /tmp/warp && cd /tmp/warp || exit 1
    wait=20
    while true; do
      # register only if there is no account yet; a registration that hiccups after creating the account
      # (Cloudflare 5xx on a follow-up call) still leaves a usable account behind, so keep it
      if [ ! -s wgcf-account.toml ]; then
        wgcf register --accept-tos || echo "[warp] registration reported an error"
      fi
      if [ -s wgcf-account.toml ] && wgcf generate && [ -s wgcf-profile.conf ]; then
        printf 'WGConfig = /tmp/warp/wgcf-profile.conf\n\n[Socks5]\nBindAddress = 127.0.0.1:40000\n' > wireproxy.conf
        echo "[warp] starting wireproxy"
        wireproxy -c wireproxy.conf
        echo "[warp] wireproxy stopped, restarting"
        wait=20
      else
        # the account could not produce a profile: start over with a fresh one next time
        echo "[warp] no usable account yet, retrying in ${wait}s"
        rm -f wgcf-account.toml wgcf-profile.conf
      fi
      sleep "$wait"
      [ "$wait" -lt 600 ] && wait=$((wait * 2))
    done
  ) 2>&1 | sed -u 's/^/[warp] /' &
else
  echo "[warp] not started (WARP=0 or tools missing)"
fi
exec node server.js
