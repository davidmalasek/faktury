#!/bin/bash
# Spustí server Faktur na pozadí, pokud ještě neběží. Volá ho Faktury.app při každém otevření.
# Použije Python 3.9+, který už na Macu je (Homebrew, vývojářské nástroje od Applu). Když žádný není,
# aplikace stažená z GitHubu (proměnná FAKTURY_APP) si jednou stáhne vlastní do složky python/.
# Když se server spustit nepodaří, vypíše důvod a skončí chybou (podrobnosti jsou v data/server.log).
cd "$(dirname "$0")" || exit 1
PORT=8765
URL="http://localhost:$PORT"
# Python pro aplikaci z GitHubu: https://github.com/astral-sh/python-build-standalone
PBS_RELEASE=20260924
PBS_PYTHON=3.13.15

running() { curl -s -o /dev/null --max-time 1 "$URL/api/settings"; }

download_python() {
  local arch sum tmp file
  case "$(uname -m)" in
    arm64) arch=aarch64 sum=064afb7c2fc0bbf511d886288adf98696af5105e36c138cdf2c199c0146fcf68 ;;
    x86_64) arch=x86_64 sum=327814efd865a0b6a99c149b12a261e9d0ad409183515c745d41bda2d07282e9 ;;
    *) echo "Tenhle Mac Faktury nepodporují ($(uname -m))." >&2; return 1 ;;
  esac
  file="cpython-$PBS_PYTHON%2B$PBS_RELEASE-$arch-apple-darwin-install_only_stripped.tar.gz"
  tmp=$(mktemp -d) || return 1
  if ! curl -fsL --retry 3 -o "$tmp/python.tar.gz" \
      "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/$file"; then
    rm -rf "$tmp"
    echo "Nepodařilo se stáhnout Python. Jsi připojený k internetu?" >&2
    return 1
  fi
  if ! echo "$sum  $tmp/python.tar.gz" | shasum -a 256 -c - >/dev/null 2>&1 \
      || ! tar -xzf "$tmp/python.tar.gz" -C "$tmp"; then
    rm -rf "$tmp"
    echo "Stažený Python je poškozený. Zkus Faktury otevřít znovu." >&2
    return 1
  fi
  rm -rf python && mv "$tmp/python" python && rm -rf "$tmp"
}

system_python() {
  local py
  [ -n "${FAKTURY_STAHNOUT_PYTHON:-}" ] && return 1  # jen pro zkoušku stahování v CI
  for py in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    [ -x "$py" ] || continue
    # Bez vývojářských nástrojů je /usr/bin/python3 jen zástupce, který by nabídl jejich instalaci.
    [ "$py" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1 && continue
    "$py" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null && { echo "$py"; return 0; }
  done
  return 1
}

if [ -x python/bin/python3 ]; then
  PY=python/bin/python3
elif ! PY=$(system_python); then
  if [ -z "${FAKTURY_APP:-}" ]; then
    echo "Chybí Python 3.9 nebo novější (nainstaluješ ho příkazem xcode-select --install)." >&2
    exit 1
  fi
  download_python || exit 1
  PY=python/bin/python3
fi
if [ "$PY" = python/bin/python3 ]; then
  # Stažený Python nezná certifikáty macOS (potřebuje je pro ARES a aktualizace), vezme si je ze systému.
  if [ ! -s python/cacert.pem ]; then
    security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > python/cacert.pem 2>/dev/null
    [ -s python/cacert.pem ] || cp python/lib/python3*/site-packages/pip/_vendor/certifi/cacert.pem python/cacert.pem
  fi
  export SSL_CERT_FILE="$PWD/python/cacert.pem"
fi

# Když běží jiná verze serveru, nebo se od jeho spuštění změnil kód, restartuj ho.
outdated() {
  local version
  version=$(curl -s --max-time 1 "$URL/api/version" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
  [ "$version" != "$(tr -d '[:space:]' < VERSION)" ] && return 0
  [ -f data/server.pid ] && { [ data/server.pid -ot server.py ] || [ data/server.pid -ot db.py ] || [ data/server.pid -ot update.py ]; }
}
if running && outdated; then
  kill "$(cat data/server.pid)" 2>/dev/null
  for _ in $(seq 1 30); do running || break; sleep 0.1; done
fi

if ! running; then
  mkdir -p data
  nohup "$PY" server.py >> data/server.log 2>&1 &
  for _ in $(seq 1 50); do running && break; sleep 0.1; done
fi

running || { echo "Podrobnosti jsou v souboru data/server.log ve složce $PWD." >&2; exit 1; }
