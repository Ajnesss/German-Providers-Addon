#!/bin/sh
# Starts Cloudflare WARP as a local SOCKS5 proxy (127.0.0.1:40000) in the background, then the addon.
# The addon works without WARP too (fewer sites); set WARP=0 on Render to switch it off.
# Self-repair: every 2 minutes WARP is tested; after 3 failed tests in a row it is restarted, and if restarts
# keep failing, a fresh WARP account is made.
if [ "${WARP:-1}" != "0" ] && command -v wgcf >/dev/null 2>&1 && command -v wireproxy >/dev/null 2>&1; then
  (
    mkdir -p /tmp/warp && cd /tmp/warp || exit 1
    wait=20
    badstarts=0
    while true; do
      # register only if there is no account yet; a registration that hiccups after creating the account
      # (Cloudflare 5xx on a follow-up call) still leaves a usable account behind, so keep it
      if [ ! -s wgcf-account.toml ]; then
        wgcf register --accept-tos || echo "registration reported an error"
      fi
      if [ -s wgcf-account.toml ] && wgcf generate && [ -s wgcf-profile.conf ]; then
        printf 'WGConfig = /tmp/warp/wgcf-profile.conf\n\n[Socks5]\nBindAddress = 127.0.0.1:40000\n' > wireproxy.conf
        echo "starting wireproxy"
        wireproxy -c wireproxy.conf > /dev/null 2>&1 &
        wp=$!
        fails=0
        worked=0
        sleep 30
        # watchdog: test the tunnel while wireproxy runs
        while kill -0 "$wp" 2>/dev/null; do
          if curl -s -m 15 --socks5-hostname 127.0.0.1:40000 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -Eq 'warp=(on|plus)'; then
            [ "$fails" -gt 0 ] && echo "test ok again"
            [ "$worked" = 0 ] && echo "WARP working"
            fails=0; worked=1; badstarts=0
          else
            fails=$((fails + 1))
            echo "test failed ($fails/3)"
            if [ "$fails" -ge 3 ]; then
              echo "WARP not working, restarting it"
              kill "$wp" 2>/dev/null
              break
            fi
          fi
          sleep 120
        done
        wait "$wp" 2>/dev/null
        echo "wireproxy stopped"
        if [ "$worked" = 0 ]; then
          badstarts=$((badstarts + 1))
          if [ "$badstarts" -ge 3 ]; then
            echo "3 starts without a working tunnel: making a fresh WARP account"
            rm -f wgcf-account.toml wgcf-profile.conf
            badstarts=0
          fi
        fi
        wait=20
      else
        # the account could not produce a profile: start over with a fresh one next time
        echo "no usable account yet, retrying in ${wait}s"
        rm -f wgcf-account.toml wgcf-profile.conf
      fi
      sleep "$wait"
      [ "$wait" -lt 600 ] && wait=$((wait * 2))
    done
  ) 2>&1 | while IFS= read -r line; do echo "$(date -u +%H:%M:%S) [warp] $line" | tee -a /tmp/warp.log; done &
else
  echo "[warp] not started (WARP=0 or tools missing)"
fi
exec node server.js
