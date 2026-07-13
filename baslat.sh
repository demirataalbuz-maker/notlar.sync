#!/usr/bin/env bash
# Notlar Sync — masaüstü uygulaması (Electron)
export PATH="/home/demo/.local/node-v22/bin:$PATH"
cd /home/demo/notlar-sync || exit 1

# sunucu ayakta değilse arka planda başlat
if ! curl -s -o /dev/null -w '' http://127.0.0.1:7777/ 2>/dev/null; then
  node server.js >> /tmp/notlar-sync.log 2>&1 &
  sleep 1
fi

# Electron masaüstü penceresi
exec ./node_modules/.bin/electron . --no-sandbox "$@"
