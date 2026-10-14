#!/bin/bash
# Spustí server Faktur na pozadí, pokud ještě neběží. Volá ho Faktury.app při každém otevření.
# Když se server spustit nepodaří, skončí chybou (podrobnosti jsou v data/server.log).
cd "$(dirname "$0")" || exit 1
PORT=8765
URL="http://localhost:$PORT"
PY=$(command -v /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3 | head -n 1)
running() { curl -s -o /dev/null --max-time 1 "$URL/api/settings"; }

# Když se od spuštění změnil kód serveru, restartuj ho.
if running && [ -f data/server.pid ] && { [ data/server.pid -ot server.py ] || [ data/server.pid -ot db.py ]; }; then
  kill "$(cat data/server.pid)" 2>/dev/null
  for _ in $(seq 1 30); do running || break; sleep 0.1; done
fi

if ! running; then
  mkdir -p data
  nohup "$PY" server.py >> data/server.log 2>&1 &
  for _ in $(seq 1 50); do running && break; sleep 0.1; done
fi

running
