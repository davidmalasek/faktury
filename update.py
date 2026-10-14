"""Aktualizace z GitHubu. Verze je v souboru VERSION a každá vydaná verze má na GitHubu
vydání (release) s tagem v<verze>. Aktualizace přepíše soubory aplikace, data nechá být."""
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import db

REPO = "davidmalasek/faktury"
KEEP = {"data", ".git"}  # tyhle složky aktualizace nikdy nepřepíše
# Když se změní některý z těchto souborů, je potřeba znovu sestavit okno aplikace (Faktury.app).
APP_FILES = ("macos/Faktury.swift", "macos/Faktury.icns", "instalovat.sh")
CHECK_EVERY = 3600  # GitHub se ptáme nejvýš jednou za hodinu
RETRY_AFTER = 300   # po chybě (třeba bez internetu) za 5 minut

_cache = {"at": 0.0, "release": None}
_running = threading.Lock()


def current_version(root=db.ROOT):
    try:
        return (root / "VERSION").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return "0"


def parse_version(version):
    """„v1.2“ → (1, 2, 0), ať jde verze porovnávat."""
    parts = [int(m.group()) if (m := re.match(r"\d+", p)) else 0
             for p in version.strip().lstrip("vV").split(".")]
    return tuple(parts + [0] * (3 - len(parts)))


def latest_release():
    """Poslední vydání na GitHubu, nebo None (žádné není nebo GitHub neodpovídá)."""
    now = time.time()
    if now - _cache["at"] < CHECK_EVERY:
        return _cache["release"]
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/releases/latest",
                                 headers={"Accept": "application/vnd.github+json", "User-Agent": "Faktury"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.load(r)
        release = {"tag": d["tag_name"], "version": d["tag_name"].lstrip("vV"),
                   "notes": d.get("body") or "", "url": d.get("html_url") or ""}
        _cache.update(at=now, release=release)
    except (OSError, ValueError, KeyError):  # bez internetu, GitHub nedostupný, zatím žádné vydání
        _cache["at"] = now - CHECK_EVERY + RETRY_AFTER
    return _cache["release"]


def status(root=db.ROOT):
    current = current_version(root)
    release = latest_release()
    return {
        "version": current,
        "latest": release and release["version"],
        "available": bool(release) and parse_version(release["version"]) > parse_version(current),
        "url": release and release["url"],
        "git": (root / ".git").exists(),  # z gitu se aktualizuje přes git pull
    }


def _fingerprint(root):
    h = hashlib.sha256()
    for name in APP_FILES:
        path = root / name
        h.update(path.read_bytes() if path.exists() else b"-")
    return h.hexdigest()


def apply_zip(content, root=db.ROOT, version=None):
    """Nahraje soubory z archivu verze (jak ho dává GitHub) přes soubory aplikace.
    Vrátí True, když se změnilo okno aplikace a je potřeba ho znovu sestavit."""
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        files = {}
        for info in z.infolist():
            name = Path(info.filename)
            if name.is_absolute() or ".." in name.parts:
                raise ValueError("Stažená aktualizace je poškozená.")
            rel = Path(*name.parts[1:]) if len(name.parts) > 1 else None  # 1. složka je faktury-<verze>/
            if info.is_dir() or rel is None or rel.parts[0] in KEEP:
                continue
            files[rel] = info
        if Path("server.py") not in files or Path("VERSION") not in files:
            raise ValueError("Stažená aktualizace neobsahuje Faktury.")
        if version and z.read(files[Path("VERSION")]).decode().strip() != version:
            raise ValueError("Stažená aktualizace má jinou verzi, než se čekalo.")

        before = _fingerprint(root)
        for rel, info in files.items():
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(f".{target.name}.novy")
            tmp.write_bytes(z.read(info))
            os.chmod(tmp, (info.external_attr >> 16) & 0o777 or 0o644)
            os.replace(tmp, target)
    return _fingerprint(root) != before


def install(root=db.ROOT):
    """Stáhne a nainstaluje poslední vydání. Před tím zazálohuje data."""
    if (root / ".git").exists():
        raise ValueError("Faktury jsou stažené přes git – aktualizuj je příkazem git pull.")
    if not _running.acquire(blocking=False):
        raise ValueError("Aktualizace už běží.")
    try:
        _cache["at"] = 0  # vždy čerstvý stav z GitHubu
        release = latest_release()
        if not release or parse_version(release["version"]) <= parse_version(current_version(root)):
            raise ValueError("Nová verze není k dispozici.")
        with db.open_data():  # záloha pod zámkem, ať se nezkopíruje rozepsaný soubor
            db.backup_now("pred-aktualizaci")
        url = f"https://github.com/{REPO}/archive/refs/tags/{release['tag']}.zip"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Faktury"}),
                                        timeout=120) as r:
                content = r.read()
        except OSError:
            raise ValueError("Aktualizaci se nepodařilo stáhnout – jsi připojený k internetu?")
        try:
            app_changed = apply_zip(content, root, release["version"])
        except zipfile.BadZipFile:
            raise ValueError("Stažená aktualizace je poškozená.")
        result = {"version": release["version"], "app_changed": app_changed}
        if result["app_changed"]:
            # Okno aplikace se změnilo – sestaví se znovu (projeví se po dalším otevření).
            build = subprocess.run(["./instalovat.sh"], cwd=root, capture_output=True, text=True)
            result["app_error"] = build.returncode != 0
            print(build.stdout, build.stderr, file=sys.stderr, flush=True)
        return result
    finally:
        _running.release()


def restart_later(delay=0.5):
    """Po odeslání odpovědi nahradí běžící server novou verzí (stejný proces, nový kód)."""
    def run():
        time.sleep(delay)
        sys.stdout.flush()
        sys.stderr.flush()
        args = [a for a in sys.argv[1:] if a != "--open"]
        os.execv(sys.executable, [sys.executable, str(db.ROOT / "server.py"), *args])
    threading.Thread(target=run, daemon=True).start()
