"""MejvOS – propojení aplikací na jednom Macu (Faktury, Hodinovka a další, které přibudou).

Každá aplikace má dál vlastní server a vlastní data. Ve sdílené složce
~/Library/Application Support/MejvOS o sobě jen zveřejňuje:

    apps/<id>.json       kdo je, na jaké adrese běží, co umí a jak ji spustit (manifest)
    contacts/<id>.json   svoje kontakty (klienty) ve společném tvaru
    invoices/<id>.json   faktury, které vznikly z jiné aplikace, a jejich stav (jen Faktury)

Ostatní aplikace si tyhle soubory čtou, takže druhá aplikace kvůli tomu nemusí běžet.
Když po ní chtějí něco udělat (třeba vystavit fakturu), zavolají její server přes call().
Když neběží, spustí ji. Když ještě nikdy neběžela, ale je nainstalovaná, otevřou ji.
A když na Macu chybí úplně, umí ji jedním kliknutím stáhnout z GitHubu a nainstalovat (install()).
Nic dalšího se instalovat nemusí: složku MejvOS vytvoří ta aplikace, která se spustí první.

Tenhle soubor je stejný v každé aplikaci. Když ho měníš, zkopíruj ho do všech.
Protokol pro nové aplikace popisuje docs/mejvos.md.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

NAME = "MejvOS"  # název celého systému (pracovní) – mění se jen tady
PROTOCOL = 1
HOME = Path(os.environ.get("MEJVOS_DIR") or Path.home() / "Library/Application Support" / NAME)
# Zapisovat do sdílené složky smí jen opravdu spuštěný server (ne testy ani testovací data).
ENABLED = False
CONTACT_FIELDS = ("name", "ico", "dic", "street", "city", "zip", "country", "email")

# Známé aplikace systému. Díky tomu se dají najít a nabídnout ke stažení, i když ještě nikdy neběžely.
CATALOG = {
    "faktury": {
        "name": "Faktury",
        "description": "Faktury v PDF s QR platbou a přehled daní",
        "bundle": "local.faktury",
        "provides": ["contacts", "invoices"],
        "web": "https://github.com/davidmalasek/faktury",
        "download": "https://github.com/davidmalasek/faktury/releases/latest/download/Faktury.zip",
    },
    "hodinovka": {
        "name": "Hodinovka",
        "description": "Měření odpracovaného času po projektech",
        "bundle": "local.hodinovka",
        "provides": ["contacts", "time"],
        "web": "https://github.com/davidmalasek/hodinovka",
        "download": "https://github.com/davidmalasek/hodinovka/releases/latest/download/Hodinovka.zip",
    },
}


class PeerError(ValueError):
    """Jiná aplikace není k dispozici nebo odmítla požadavek. Text je pro uživatele."""


def _name(app):
    return app.get("name") or app.get("id") or "?"


# ---------- pomocné ----------

def now():
    """Teď, i s časovým pásmem (porovnání pak funguje i přes změnu letního času)."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_uid():
    return str(uuid.uuid4())


def parse_time(value):
    """ISO čas → datetime s pásmem. Čas bez pásma bere jako místní. Neplatný → None."""
    try:
        dt = datetime.fromisoformat(str(value or "").strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.astimezone()


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def contact(c):
    """Kontakt ve společném tvaru, jak si ho aplikace předávají."""
    return {
        "uid": str(c.get("uid") or ""),
        **{k: str(c.get(k) or "").strip() for k in CONTACT_FIELDS},
        "updated_at": c.get("updated_at") or c.get("created_at") or "",
    }


# ---------- zveřejnění ----------

def announce(app_id, *, name, version, port, root, provides, env=None):
    """Při spuštění serveru: přihlásí aplikaci do systému (apps/<id>.json)."""
    entry = CATALOG.get(app_id, {})
    manifest = {
        "id": app_id,
        "name": name,
        "version": version,
        "protocol": PROTOCOL,
        "url": f"http://localhost:{port}",
        "api": f"http://localhost:{port}/api/os",
        "scheme": app_id,  # app_id://cesta otevře okno aplikace na #/cesta
        "bundle": entry.get("bundle", ""),
        "provides": list(provides),
        "launch": {"command": ["/bin/bash", str(Path(root) / "spustit.sh")],
                   "env": {k: v for k, v in (env or {}).items() if v}},
        "pid": os.getpid(),
        "updated_at": now(),
    }
    _publish_file(HOME / "apps" / f"{app_id}.json", manifest)
    return manifest


def publish(app_id, kind, items, **extra):
    """Zveřejní seznam (contacts, invoices…) do <kind>/<app_id>.json, ať ho ostatní přečtou i bez serveru."""
    _publish_file(HOME / kind / f"{app_id}.json", {"app": app_id, "updated_at": now(), **extra, "items": list(items)})


def publish_contacts(app_id, rows):
    publish(app_id, "contacts", [contact(c) for c in rows if c.get("uid") and str(c.get("name") or "").strip()])


def _publish_file(path, value):
    if not ENABLED:
        return
    try:
        _write_json(path, value)
    except OSError as e:  # sdílená složka nesmí shodit aplikaci
        print(f"{NAME}: nepodařilo se zapsat {path}: {e}", file=sys.stderr, flush=True)


# ---------- ostatní aplikace ----------

def apps(exclude=None):
    """Aplikace přihlášené v systému (kromě exclude). Odinstalované (zmizel jejich spouštěč) vynechá."""
    out = []
    for path in sorted((HOME / "apps").glob("*.json")):
        m = _read_json(path)
        if not isinstance(m, dict) or not m.get("id") or m["id"] == exclude or not m.get("api"):
            continue
        command = (m.get("launch") or {}).get("command") or []
        if command and not Path(command[-1]).exists():
            continue
        out.append(m)
    return out


def find(capability, exclude=None):
    return next((a for a in apps(exclude) if capability in (a.get("provides") or [])), None)


def read(kind, exclude=None):
    """Zveřejněné seznamy ostatních aplikací: {app_id: {"name": …, "items": […], …}}."""
    names = {a["id"]: a.get("name") or a["id"] for a in apps(exclude)}
    out = {}
    for path in sorted((HOME / kind).glob("*.json")):
        d = _read_json(path)
        if path.stem in names and isinstance(d, dict) and isinstance(d.get("items"), list):
            out[path.stem] = {**d, "name": names[path.stem]}
    return out


def signature(kind, exclude=None):
    """Otisk zveřejněných souborů – změní se, když jiná aplikace něco zveřejní."""
    sig = []
    for path in sorted((HOME / kind).glob("*.json")):
        if path.stem != exclude:
            try:
                sig.append((path.stem, path.stat().st_mtime_ns))
            except OSError:
                pass
    return tuple(sig)


def peer_contacts(exclude):
    """Kontakty ostatních aplikací, u každého i odkud je (app, app_name)."""
    out = []
    for app_id, d in read("contacts", exclude).items():
        for c in d["items"]:
            if isinstance(c, dict) and c.get("uid") and str(c.get("name") or "").strip():
                out.append({**contact(c), "app": app_id, "app_name": d["name"]})
    return out


def offered_contacts(rows, peers):
    """Kontakty z ostatních aplikací, které tahle ještě nemá – podle uid, IČO i přesného názvu."""
    uids = {r.get("uid") for r in rows if r.get("uid")}
    icos = {str(r.get("ico") or "").strip() for r in rows} - {""}
    names = {str(r.get("name") or "").strip().casefold() for r in rows}
    out, seen = [], set()
    for p in peers:
        if p["uid"] in uids or p["uid"] in seen or (p["ico"] and p["ico"] in icos) or p["name"].casefold() in names:
            continue
        seen.add(p["uid"])
        out.append(p)
    return out


def merge_contacts(rows, peers):
    """Doplní do vlastních kontaktů novější údaje stejných kontaktů (stejné uid) z ostatních aplikací.
    Přenáší se jen vyplněné údaje, takže jiná aplikace nikdy nic nesmaže. Vrátí počet změněných kontaktů."""
    newest = {}
    for p in peers:
        when = parse_time(p.get("updated_at"))
        if when and (p["uid"] not in newest or when > newest[p["uid"]][0]):
            newest[p["uid"]] = (when, p)
    changed = 0
    for r in rows:
        when, p = newest.get(r.get("uid"), (None, None))
        mine = parse_time(r.get("updated_at") or r.get("created_at"))
        if not p or (mine and when <= mine):
            continue
        new = {k: p[k] for k in CONTACT_FIELDS if p[k] and p[k] != str(r.get(k) or "")}
        if new:
            r.update(new)
            r["updated_at"] = p["updated_at"]
            changed += 1
    return changed


# ---------- volání ostatních aplikací ----------

def call(app, method, path, body=None, timeout=20, launch=True):
    """Zavolá API jiné aplikace (app = manifest). Když neběží a launch=True, spustí ji a zkusí to znovu."""
    url = app["api"].rstrip("/") + "/" + path.lstrip("/")
    try:
        return _request(app, url, method, body, timeout)
    except _Offline:
        if not launch:
            raise PeerError(f"Aplikace {_name(app)} teď neběží.")
    start(app)
    try:
        return _request(app, url, method, body, timeout)
    except _Offline:
        raise PeerError(f"Aplikace {_name(app)} neodpovídá. Zkus ji otevřít.")


class _Offline(Exception):
    pass


def _request(app, url, method, body, timeout):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": NAME})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            message = json.loads(e.read() or b"{}").get("error")
        except ValueError:
            message = None
        raise PeerError(f"{_name(app)}: {message or f'chyba {e.code}'}")
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        raise _Offline(str(e))


def alive(app, timeout=0.5):
    try:
        _request(app, app["api"], "GET", None, timeout)
        return True
    except (_Offline, PeerError, OSError):
        return False


def start(app, wait=20):
    """Spustí server jiné aplikace (na pozadí, bez okna) a počká, až odpoví."""
    launch = app.get("launch") or {}
    if launch.get("command"):
        env = {**os.environ, **(launch.get("env") or {})}
        try:
            r = subprocess.run(launch["command"], env=env, capture_output=True, text=True, timeout=wait + 40)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise PeerError(f"Aplikaci {_name(app)} nejde spustit ({e}).")
        if r.returncode != 0:
            raise PeerError(f"Aplikaci {_name(app)} nejde spustit. {r.stderr.strip()}")
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if alive(app):
            return
        time.sleep(0.2)
    raise PeerError(f"Aplikace {_name(app)} se nespustila.")


def app_path(app_id):
    """Kde na tomhle Macu je aplikace z katalogu (i když ještě nikdy neběžela), nebo None."""
    entry = CATALOG.get(app_id)
    if not entry or sys.platform != "darwin":
        return None
    for folder in (Path("/Applications"), Path.home() / "Applications"):
        if (folder / f"{entry['name']}.app").exists():
            return folder / f"{entry['name']}.app"
    try:
        r = subprocess.run(["mdfind", f"kMDItemCFBundleIdentifier == '{entry['bundle']}'"],
                           capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return None
    found = [Path(line) for line in r.stdout.splitlines() if line.endswith(".app") and "/AppTranslocation/" not in line]
    return found[0] if found else None


def _open_and_wait(app_id, path, capability=None, wait=180):
    """Otevře aplikaci na pozadí a počká, až se přihlásí do systému. Poprvé si připravuje složku
    a případně stahuje Python, proto se čeká déle."""
    subprocess.run(["open", "-g", str(path)], check=False)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        app = next((a for a in apps() if a["id"] == app_id), None)
        if app and (capability is None or capability in (app.get("provides") or [])) and alive(app):
            return app
        time.sleep(0.5)
    raise PeerError(f"Aplikace {CATALOG[app_id]['name']} se nespustila. Otevři ji a zkus to znovu.")


def open_app(app_id):
    """Otevře okno nainstalované aplikace (i starší verze, která ještě nezná odkazy <id>://)."""
    path = app_path(app_id)
    if path is None:
        raise PeerError("Aplikace na tomhle Macu není.")
    subprocess.run(["open", str(path)], check=False)


def ensure(capability, exclude=None):
    """Najde aplikaci, která umí capability. Když je nainstalovaná, ale ještě nikdy neběžela, otevře ji.
    Když na Macu není, vrátí None (nabídni install())."""
    app = find(capability, exclude)
    if app:
        return app
    for app_id, entry in CATALOG.items():
        path = app_path(app_id) if app_id != exclude and capability in entry["provides"] else None
        if path:
            return _open_and_wait(app_id, path, capability)
    return None


def install(app_id):
    """Stáhne aplikaci z katalogu (poslední vydání na GitHubu), dá ji do složky Aplikace a spustí ji.
    Stažená takhle nemá karanténu, takže ji macOS pustí bez ptaní. Vrátí její manifest."""
    entry = CATALOG.get(app_id)
    if not entry:
        raise PeerError("Neznámá aplikace.")
    if sys.platform != "darwin":
        raise PeerError("Aplikace systému jdou nainstalovat jen na Macu.")
    path = app_path(app_id)
    if path is None:
        folder = Path("/Applications") if os.access("/Applications", os.W_OK) else Path.home() / "Applications"
        folder.mkdir(exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix=f".{app_id}-", dir=folder))
        try:
            req = urllib.request.Request(entry["download"], headers={"User-Agent": NAME})
            with urllib.request.urlopen(req, timeout=300) as r:
                (tmp / "app.zip").write_bytes(r.read())
            subprocess.run(["ditto", "-x", "-k", str(tmp / "app.zip"), str(tmp)], check=True)
            new = tmp / f"{entry['name']}.app"
            if not (new / "Contents/MacOS" / entry["name"]).exists():
                raise OSError("v archivu chybí aplikace")
            path = folder / new.name
            os.rename(new, path)
        except (OSError, subprocess.CalledProcessError) as e:
            raise PeerError(f"Aplikaci {entry['name']} se nepodařilo nainstalovat ({e}). "
                            f"Stáhni ji ručně z {entry['web']}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return _open_and_wait(app_id, path)


def overview(exclude):
    """Stav systému pro Nastavení: všechny známé i přihlášené aplikace kromě sebe."""
    registered = {a["id"]: a for a in apps(exclude)}
    out = []
    for app_id in list(CATALOG) + [a for a in registered if a not in CATALOG]:
        if app_id == exclude:
            continue
        entry, m = CATALOG.get(app_id, {}), registered.get(app_id)
        if m:
            state = "running" if alive(m) else "ready"
        else:
            state = "installed" if app_path(app_id) else "missing"
        out.append({
            "id": app_id,
            "name": (m or entry).get("name") or app_id,
            "description": entry.get("description", ""),
            "version": m.get("version") if m else None,
            "state": state,
            "scheme": m.get("scheme") if m else None,
            "web": entry.get("web"),
            "download": entry.get("download"),
        })
    return {"system": NAME, "apps": out}
