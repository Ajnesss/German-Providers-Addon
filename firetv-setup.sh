#!/data/data/com.termux/files/usr/bin/bash
# One-time setup on the FireTV (inside Termux):
#   curl -fsSL https://raw.githubusercontent.com/Ajnesss/German-Providers-Addon/main/firetv-setup.sh | bash -s YOUR_RELAY_TOKEN
set -e
TOKEN="$1"
if [ -z "$TOKEN" ]; then echo "Add your relay password after the command."; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
echo "== Installing Node.js and Cloudflare tunnel (takes a few minutes) =="
pkg update -y -o Dpkg::Options::=--force-confnew
pkg upgrade -y -o Dpkg::Options::=--force-confnew
pkg install -y nodejs-lts cloudflared git curl procps
echo "== Downloading the addon =="
rm -rf ~/gpa
git clone --depth 1 https://github.com/Ajnesss/German-Providers-Addon ~/gpa
cd ~/gpa && npm install --omit=dev --no-audit --no-fund
echo "$TOKEN" > ~/.gpa_token
# start automatically whenever Termux is opened
grep -q 'gpa/firetv-start.sh' ~/.bashrc 2>/dev/null || cat >> ~/.bashrc <<'RC'
pgrep -f "node server.js" >/dev/null || bash ~/gpa/firetv-start.sh
RC
# and on boot, if the Termux:Boot app is installed
mkdir -p ~/.termux/boot && printf '#!/data/data/com.termux/files/usr/bin/bash\nbash ~/gpa/firetv-start.sh\n' > ~/.termux/boot/start-gpa.sh && chmod +x ~/.termux/boot/start-gpa.sh
bash ~/gpa/firetv-start.sh
