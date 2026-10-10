#!/data/data/com.termux/files/usr/bin/bash
# Starts the addon on the FireTV and connects it to Render. Safe to run again at any time.
RENDER=https://german-providers-addon.onrender.com
TOKEN=$(cat ~/.gpa_token 2>/dev/null)
termux-wake-lock 2>/dev/null
pkill -f "node server.js"; pkill -f "cloudflared tunnel"; pkill -f "gpa-register"
cd ~/gpa || { echo "Addon not installed, run the setup command first."; exit 1; }
git pull -q 2>/dev/null && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1
echo "Getting settings from Render..."
KEY=""
for i in 1 2 3 4 5 6; do
  KEY=$(curl -fsS -m 70 "$RENDER/relay/config?token=$TOKEN" | sed -n 's/.*"tmdbKey":"\([^"]*\)".*/\1/p')
  [ -n "$KEY" ] && break; sleep 10
done
if [ -z "$KEY" ]; then echo "Could not get settings from Render. Check the password matches RELAY_TOKEN on Render."; exit 1; fi
TMDB_API_KEY="$KEY" PORT=7000 nohup node server.js > ~/gpa-server.log 2>&1 &
nohup cloudflared tunnel --no-autoupdate --url http://localhost:7000 > ~/gpa-tunnel.log 2>&1 &
URL=""
for i in $(seq 1 45); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' ~/gpa-tunnel.log | head -1)
  [ -n "$URL" ] && break; sleep 2
done
if [ -z "$URL" ]; then echo "Tunnel did not start. Run: tail ~/gpa-tunnel.log"; exit 1; fi
cat > ~/gpa-register.sh <<REG
while true; do curl -fsS -m 70 "$RENDER/relay/register?token=$TOKEN&url=$URL" >/dev/null 2>&1; sleep 240; done
REG
nohup bash ~/gpa-register.sh >/dev/null 2>&1 &
sleep 3
curl -fsS -m 70 "$RENDER/relay/register?token=$TOKEN&url=$URL" >/dev/null && echo "All set: the FireTV is now doing the searching. You can leave Termux (press Home)." || echo "Started, but Render did not confirm yet. It will retry every 4 minutes."
