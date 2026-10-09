#!/usr/bin/env python3
"""Faktury – lokální server. Spuštění: python3 server.py [--open]"""
import json
import mimetypes
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

import db

PORT = int(os.environ.get("FAKTURY_PORT", "8765"))
STATIC = db.ROOT / "static"
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
MAX_UPLOAD = 25 * 1024 * 1024


def ares_lookup(ico):
    """Dohledá firmu v registru ARES podle IČO."""
    ico = re.sub(r"\D", "", ico)
    if not ico or len(ico) > 8:
        raise ValueError("IČO má mít až 8 číslic.")
    ico = ico.zfill(8)
    url = f"https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise LookupError(f"IČO {ico} v ARES neexistuje.")
        raise ValueError(f"ARES neodpovídá (chyba {e.code}).")
    except (urllib.error.URLError, TimeoutError):
        raise ValueError("ARES je nedostupný – jsi připojený k internetu?")

    s = d.get("sidlo") or {}
    street = s.get("nazevUlice") or s.get("nazevCastiObce") or s.get("nazevObce") or ""
    number = str(s.get("cisloDomovni") or "")
    if s.get("cisloOrientacni"):
        number += f"/{s['cisloOrientacni']}{s.get('cisloOrientacniPismeno') or ''}"
    city = s.get("nazevObce") or ""
    if city == "Praha" and s.get("nazevMestskehoObvodu"):
        city = s["nazevMestskehoObvodu"]
    psc = str(s.get("psc") or "")
    return {
        "name": d.get("obchodniJmeno") or "",
        "ico": d.get("ico") or ico,
        "dic": d.get("dic") or "",
        "street": f"{street} {number}".strip(),
        "city": city,
        "zip": f"{psc[:3]} {psc[3:]}" if len(psc) == 5 else psc,
        "country": "" if (s.get("kodStatu") or "CZ") == "CZ" else (s.get("nazevStatu") or ""),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "Faktury"

    # ---------- odpovědi ----------

    def send_json(self, data, status=200, headers=None):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def send_file(self, path, root):
        try:
            path = path.resolve()
            path.relative_to(root.resolve())
        except ValueError:
            return self.send_error_json(404, "Nenalezeno.")
        if not path.is_file():
            return self.send_error_json(404, "Nenalezeno.")
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD:
            raise ValueError("Soubor je moc velký.")
        return self.rfile.read(length) if length else b""

    def read_json(self):
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            raise ValueError("Očekávám JSON.")
        return json.loads(self.read_body() or b"{}")

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else "") and not str(args[1]).startswith("2"):
            super().log_message(fmt, *args)

    # ---------- zabezpečení ----------

    def is_trusted(self):
        """Server poslouchá jen na tomto Macu; navíc odmítne požadavky z cizích webů."""
        if self.headers.get("Host") not in ALLOWED_HOSTS:
            return False
        origin = self.headers.get("Origin")
        if self.command != "GET" and origin and urlparse(origin).netloc not in ALLOWED_HOSTS:
            return False
        return True

    # ---------- směrování ----------

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_PUT(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()

    def dispatch(self):
        if not self.is_trusted():
            return self.send_error_json(403, "Zakázáno.")
        path = unquote(urlparse(self.path).path)
        try:
            if path.startswith("/api/"):
                return self.api(self.command, path[5:].strip("/").split("/"))
            if self.command != "GET":
                return self.send_error_json(405, "Nepovolená metoda.")
            if path.startswith("/archiv/"):
                return self.send_file(db.ARCHIV / path[8:], db.ARCHIV)
            return self.send_file(STATIC / (path.lstrip("/") or "index.html"), STATIC)
        except LookupError as e:
            self.send_error_json(404, str(e))
        except (ValueError, RuntimeError) as e:
            self.send_error_json(400, str(e))
        except Exception as e:  # noqa: BLE001 – ať appka nespadne, chybu ukážeme
            self.log_error("Chyba: %r", e)
            self.send_error_json(500, f"Neočekávaná chyba: {e}")

    def api(self, method, parts):
        res, rid, sub = (parts + [None, None])[:3]
        rid = int(rid) if rid and rid.isdigit() else rid

        # Věci, které nesahají na data, běží mimo zámek (ARES může chvíli trvat).
        if res == "ares" and method == "GET" and rid is not None:
            return self.send_json(ares_lookup(str(rid)))

        body = self.read_json() if method in ("POST", "PUT") and sub != "pdf" else None
        pdf = self.read_pdf() if method == "PUT" and sub == "pdf" else None
        status, headers = 200, None
        # Odpověď se pošle až po úspěšném uložení – při chybě se neuloží nic.
        with db.open_data(write=method != "GET") as data:
            result = self.route(data, method, res, rid, sub, body, pdf)
        if result is None:
            return self.send_error_json(404, "Neznámá adresa.")
        if isinstance(result, tuple):
            result, status, headers = result
        if res == "invoices" and sub == "reveal":
            target = db.ARCHIV / result["pdf_file"] if result.get("pdf_file") else db.ARCHIV
            subprocess.run(["open", "-R", str(target)], check=False)
            result = {"ok": True}
        self.send_json(result, status, headers)

    def read_pdf(self):
        if self.headers.get("Content-Type") != "application/pdf":
            raise ValueError("Očekávám PDF.")
        return self.read_body()

    @staticmethod
    def route(data, method, res, rid, sub, body, pdf):
        if res == "settings":
            if method == "GET":
                return db.get_settings(data)
            if method == "PUT":
                return db.save_settings(data, body)

        elif res == "contacts":
            if method == "GET" and rid is None:
                return db.list_contacts(data)
            if method == "POST" and rid is None:
                return db.save_contact(data, body), 201, None
            if isinstance(rid, int):
                if method == "GET":
                    return db.get_contact(data, rid)
                if method == "PUT":
                    return db.save_contact(data, body, rid)
                if method == "DELETE":
                    db.delete_contact(data, rid)
                    return {"ok": True}

        elif res == "invoices":
            if method == "GET" and rid is None:
                return db.list_invoices(data)
            if method == "POST" and rid is None:
                return db.save_invoice(data, body), 201, None
            if method == "POST" and rid == "status":
                return db.mark_paid_many(data, body.get("changes"))
            if isinstance(rid, int):
                if sub is None and method == "GET":
                    return db.get_invoice(data, rid)
                if sub is None and method == "PUT":
                    return db.save_invoice(data, body, rid)
                if sub is None and method == "DELETE":
                    db.delete_invoice(data, rid)
                    return {"ok": True}
                if sub == "status" and method == "POST":
                    return db.set_status(data, rid, body.get("status"), body.get("paid_date"))
                if sub == "pdf" and method == "PUT":
                    return {"pdf_file": db.store_pdf(data, rid, pdf)}
                if sub == "reveal" and method == "POST":
                    return db.get_invoice(data, rid)

        elif res == "next-number" and method == "GET":
            return {"number": db.next_number(data)}

        elif res == "zaloha" and method == "GET":
            return db.cloud_status

        elif res == "export" and method == "GET":
            name = f"faktury-zaloha-{date.today().isoformat()}.json"
            return data, 200, {"Content-Disposition": f'attachment; filename="{name}"'}

        return None


def main():
    db.init()
    db.daily_backup()
    # Kopie do iCloud Drive; testovací data (FAKTURY_DATA) jen když ji výslovně zapne FAKTURY_ICLOUD.
    cloud = os.environ.get("FAKTURY_ICLOUD") or ("" if os.environ.get("FAKTURY_DATA") else str(db.ICLOUD_DEFAULT))
    if cloud:
        db.start_cloud_backup(cloud)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        sys.exit(f"Port {PORT} je obsazený – Faktury už nejspíš běží. "
                 f"Otevři http://localhost:{PORT}")
    url = f"http://localhost:{PORT}"
    (db.DATA / "server.pid").write_text(str(os.getpid()))  # spouštěč podle něj pozná starou verzi
    print(f"Faktury běží na {url}")
    print("Data:", db.DATA)
    print("Vypnutí: zavři toto okno (nebo Ctrl+C).")
    if "--open" in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nFaktury vypnuty.")


if __name__ == "__main__":
    main()
