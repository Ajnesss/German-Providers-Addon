#!/bin/bash
# Rebuilds the addon from GitHub when there is a new commit (or with "force"). Runs every 2 minutes from cron.
# This file lives in the repository: the server installs the newest version of itself automatically, so changes to
# the deployment arrive with a normal upload to GitHub.
#   - the addon's memory (s.to answers, availability record, notification state) is kept in the Docker volume
#     "gpa_state", so it survives updates
#   - the old version is stopped gently (it saves its memory first)
#   - if the new version doesn't answer within 90 seconds, the previous version is started again
#   - an update waits (up to 3 hours) while video is playing through the addon, so it never cuts off playback
#   - watchdog: if the running addon stops answering for 3 checks in a row (about 6 minutes), it is restarted
#     (Docker already restarts it after a crash; this also catches a hang)
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

# bytes the addon container has sent so far (video going out through the relay)
tx() {
  timeout 15 docker stats --no-stream --format '{{.NetIO}}' addon 2>/dev/null | awk -F'/' '{print $2}' | tr -d ' ' \
    | awk '{v=$0; u=v; gsub(/[0-9.]/,"",u); gsub(/[A-Za-z]/,"",v); m=1; if(u=="kB")m=1e3; else if(u=="MB")m=1e6; else if(u=="GB")m=1e9; else if(u=="TB")m=1e12; printf "%.0f", v*m}'
}
PENDING=/var/lib/gpa-deploy-pending
RUNNING=0; docker ps --format '{{.Names}}' | grep -qx addon && RUNNING=1
if [ "$OLD" != "$NEW" ] || [ "$1" = "force" ] || [ "$1" = "now" ] || [ -f "$PENDING" ] || [ "$RUNNING" = 0 ]; then
  # someone is watching through the relay (video leaving the container): wait with the update, up to 3 hours,
  # so a deploy never cuts off playback. "gpa-deploy now" deploys at once.
  if [ "$RUNNING" = 1 ] && [ "$1" != "now" ]; then
    A=$(tx); sleep 20; B=$(tx)
    if [ -n "$A" ] && [ -n "$B" ] && [ "$B" -gt $(( A + 5000000 )) ] 2>/dev/null; then
      [ -f "$PENDING" ] || date +%s > "$PENDING"
      SINCE=$(cat "$PENDING" 2>/dev/null || date +%s)
      if [ $(( $(date +%s) - SINCE )) -lt 10800 ]; then
        echo "$(date) update $NEW waiting: video is playing through the addon"
        exit 0
      fi
      echo "$(date) update waited 3 hours, deploying now"
    fi
  fi
  rm -f "$PENDING"
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

# 2. watchdog (only when nothing was deployed in this run)
STRIKES=/var/lib/gpa-watchdog
if docker ps --format '{{.Names}}' | grep -qx addon; then
  # video still flowing out of the container (someone is watching through the relay): then it isn't hung, just busy;
  # never restart it in the middle of playback
  TX=$(tx)
  LAST_TX=$(cat /var/lib/gpa-watchdog-tx 2>/dev/null || echo 0)
  [ -n "$TX" ] && echo "$TX" > /var/lib/gpa-watchdog-tx
  BUSY=0
  [ -n "$TX" ] && [ "$LAST_TX" -gt 0 ] && [ "$TX" -gt $(( LAST_TX + 20000000 )) ] 2>/dev/null && BUSY=1
  if curl -fsS -m 10 http://127.0.0.1:8000/manifest.json >/dev/null 2>&1; then
    rm -f "$STRIKES"
  elif [ "$BUSY" = 1 ]; then
    echo "$(date) addon slow to answer but still sending video: not restarting"
  else
    n=$(( $(cat "$STRIKES" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$STRIKES"
    echo "$(date) addon not answering ($n/3)"
    if [ "$n" -ge 3 ]; then
      echo "$(date) restarting the addon"
      docker restart -t 20 addon >/dev/null && rm -f "$STRIKES"
    fi
  fi
fi
