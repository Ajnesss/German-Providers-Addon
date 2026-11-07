#!/bin/bash
# Rebuilds the addon from GitHub when there is a new commit (or with "force"). Runs every 2 minutes from cron.
# This file lives in the repository: the server installs the newest version of itself automatically, so changes to
# the deployment arrive with a normal upload to GitHub.
#   - the addon's memory (s.to answers, availability record, notification state) is kept in the Docker volume
#     "gpa_state", so it survives updates
#   - the old version is stopped gently (it saves its memory first)
#   - if the new version doesn't answer within 90 seconds, the previous version is started again
cd /opt/gpa || exit 1
SELF=/usr/local/bin/gpa-deploy
OLD=$(git rev-parse HEAD)
git fetch -q --depth 1 origin && git reset -q --hard origin/HEAD
NEW=$(git rev-parse HEAD)

# 1. keep this script itself up to date
SRC=/opt/gpa/deploy/gpa-deploy.sh
[ -f "$SRC" ] || SRC=/opt/gpa/gpa-deploy.sh        # the file may also sit in the main folder of the repository
if [ -f "$SRC" ] && ! cmp -s "$SRC" "$SELF"; then
  install -m 755 "$SRC" "$SELF"
  echo "$(date) deploy script updated"
  exec "$SELF" force
fi

run() {
  docker run -d --name addon --restart always --env-file /opt/gpa.env \
    -e STATE_DIR=/state -v gpa_state:/state \
    --log-opt max-size=20m --log-opt max-file=3 \
    -p 127.0.0.1:8000:8000 "$1"
}
answers() {
  for i in $(seq 1 30); do
    curl -fsS -m 5 http://127.0.0.1:8000/manifest.json >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

if [ "$OLD" != "$NEW" ] || [ "$1" = "force" ] || ! docker ps --format '{{.Names}}' | grep -qx addon; then
  echo "$(date) deploying $NEW"
  docker image inspect gpa:latest >/dev/null 2>&1 && docker tag gpa:latest gpa:previous
  docker build -t gpa:latest /opt/gpa || { echo "$(date) build failed, keeping the running version"; exit 1; }
  docker stop -t 20 addon >/dev/null 2>&1
  docker rm -f addon >/dev/null 2>&1
  run gpa:latest
  if answers; then
    echo "$(date) running $NEW"
  elif docker image inspect gpa:previous >/dev/null 2>&1; then
    echo "$(date) new version does not answer, going back to the previous one"
    docker logs --tail 40 addon 2>&1 | sed 's/^/    /'
    docker rm -f addon >/dev/null 2>&1
    run gpa:previous
  fi
  docker image prune -f >/dev/null
fi
