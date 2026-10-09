"""Testy dat a serveru. Spuštění: python3 -m unittest discover tests"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import date
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402
import import_data  # noqa: E402
import server  # noqa: E402

YEAR = str(date.today().year)


def invoice(number, issue=f"{YEAR}-03-01", due=f"{YEAR}-03-15", **extra):
    return {
        "number": number, "issue_date": issue, "due_date": due,
        "customer": {"name": "Odběratel s.r.o.", "ico": "12345678"},
        "items": [{"description": "Práce", "quantity": 1, "price": 1000}],
        **extra,
    }


class TempData(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self._orig = {k: getattr(db, k) for k in ("DATA", "DATA_FILE", "ARCHIV", "ZALOHY", "SMAZANE", "ICLOUD")}
        db.ICLOUD = None  # testy se nikdy nesmí dotknout skutečného iCloudu
        db.DATA = root
        db.DATA_FILE = root / "faktury.json"
        db.ARCHIV = root / "archiv"
        db.ZALOHY = root / "zalohy"
        db.SMAZANE = root / "smazane"
        db.init()

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(db, k, v)
        self.tmp.cleanup()

    def stored(self):
        return json.loads(db.DATA_FILE.read_text(encoding="utf-8"))


class DataTests(TempData):
    def test_init_creates_readable_file_with_defaults(self):
        data = self.stored()
        self.assertEqual(data["invoices"], [])
        self.assertEqual(data["settings"]["vat_note"], "Nejsem plátce DPH.")

    def test_amounts_are_rounded_half_up(self):
        with db.open_data(True) as data:
            inv = db.save_invoice(data, invoice("1", items=[
                {"description": "a", "quantity": "0,1", "price": 3},       # 0.30
                {"description": "b", "quantity": 1, "price": "1 234,565"},  # 1234.57
                {"description": "", "quantity": 1, "price": ""},            # prázdný řádek
            ]))
        self.assertEqual([i["amount"] for i in inv["items"]], [0.3, 1234.57])
        self.assertEqual(inv["total"], 1234.87)
        self.assertEqual(inv["vs"], "1")

    def test_validation(self):
        with db.open_data() as data:
            with self.assertRaisesRegex(ValueError, "aspoň jednu položku"):
                db.save_invoice(data, invoice("1", items=[]))
            with self.assertRaisesRegex(ValueError, "Splatnost"):
                db.save_invoice(data, invoice("1", issue=f"{YEAR}-03-10", due=f"{YEAR}-03-01"))
            with self.assertRaisesRegex(ValueError, "odběratele"):
                db.save_invoice(data, invoice("1", customer={}))
            with self.assertRaisesRegex(ValueError, "není číslo"):
                db.save_invoice(data, invoice("1", items=[{"description": "x", "price": "abc"}]))
            db.save_invoice(data, invoice("1"))
            with self.assertRaisesRegex(ValueError, "už existuje"):
                db.save_invoice(data, invoice("1"))

    def test_error_rolls_back_everything(self):
        with db.open_data(True) as data:
            db.save_invoice(data, invoice("1"))
        with self.assertRaises(ValueError):
            with db.open_data(True) as data:
                db.save_invoice(data, invoice("2"))
                db.save_invoice(data, invoice("2"))  # duplicita → nic se neuloží
        self.assertEqual([i["number"] for i in self.stored()["invoices"]], ["1"])

    def test_cloud_backup_copies_and_keeps_files(self):
        cloud = Path(self.tmp.name) / "iCloud" / "Faktury záloha"
        db.ICLOUD = cloud
        db.cloud_sync()
        self.assertIn("není zapnutý", db.cloud_status["error"])  # chybějící iCloud Drive neshodí nic
        cloud.parent.mkdir()
        with db.open_data(True) as data:
            inv = db.save_invoice(data, invoice("1"))
            db.store_pdf(data, inv["id"], b"%PDF-1.4 test")
        db.cloud_sync()
        self.assertIsNone(db.cloud_status["error"])
        self.assertEqual(json.loads((cloud / "faktury.json").read_text(encoding="utf-8"))["invoices"][0]["number"], "1")
        self.assertEqual((cloud / "archiv" / f"{YEAR}/Faktura-1.pdf").read_bytes(), b"%PDF-1.4 test")
        self.assertTrue(list((cloud / "zalohy").glob("faktury-*.json")))
        with db.open_data(True) as data:
            db.delete_invoice(data, inv["id"])
        db.cloud_sync()
        self.assertEqual(json.loads((cloud / "faktury.json").read_text(encoding="utf-8"))["invoices"], [])
        self.assertTrue((cloud / "archiv" / f"{YEAR}/Faktura-1.pdf").exists())  # z iCloudu se nemaže
        self.assertFalse(list(cloud.rglob("*.tmp")))

    def test_settings_types(self):
        with db.open_data(True) as data:
            s = db.get_settings(data)
            self.assertIs(s["side_activity"], True)
            self.assertEqual(s["expense_rate"], 60)
            s = db.save_settings(data, {"side_activity": False, "expense_rate": "40", "due_days": "7"})
            self.assertEqual((s["side_activity"], s["expense_rate"], s["due_days"]), (False, 40, 7))
            self.assertIs(db.save_settings(data, {"side_activity": "on"})["side_activity"], True)
        with self.assertRaises(ValueError):
            with db.open_data(True) as data:
                db.save_settings(data, {"expense_rate": "55"})  # neplatný paušál → nic se neuloží
        self.assertEqual(self.stored()["settings"]["expense_rate"], 40)

    def test_supplier_is_frozen_unless_refresh_requested(self):
        with db.open_data(True) as data:
            db.save_settings(data, {"name": "Starý název"})
            inv = db.save_invoice(data, invoice("1"))
            db.save_settings(data, {"name": "Nový název"})
            db.save_invoice(data, invoice("1", note="úprava"), inv["id"])
            self.assertEqual(db.get_invoice(data, inv["id"])["supplier"]["name"], "Starý název")
            db.save_invoice(data, invoice("1", refresh_supplier=True), inv["id"])
            self.assertEqual(db.get_invoice(data, inv["id"])["supplier"]["name"], "Nový název")

    def test_new_customer_is_saved_once_as_contact(self):
        with db.open_data(True) as data:
            a = db.save_invoice(data, invoice("1", save_contact=True))
            b = db.save_invoice(data, invoice("2", save_contact=True))
            self.assertEqual(len(data["contacts"]), 1)
            self.assertEqual(a["contact_id"], b["contact_id"])
            db.delete_contact(data, a["contact_id"])
            self.assertIsNone(db.get_invoice(data, a["id"])["contact_id"])
            self.assertEqual(db.get_invoice(data, a["id"])["customer"]["name"], "Odběratel s.r.o.")

    def test_unknown_contact_id_is_dropped(self):
        with db.open_data(True) as data:
            inv = db.save_invoice(data, invoice("1", contact_id=999))
        self.assertIsNone(inv["contact_id"])

    def test_next_number(self):
        def nxt(*numbers):
            with db.open_data() as data:
                data["invoices"] = [{"id": i, "number": n, "issue_date": d}
                                    for i, (n, d) in enumerate(numbers, 1)]
                return db.next_number(data)
        last = str(int(YEAR) - 1)
        self.assertEqual(nxt(), f"{YEAR}0001")
        self.assertEqual(nxt((f"{last}0001", f"{last}-11-26")), f"{YEAR}0001")
        self.assertEqual(nxt((f"{last}0001", f"{last}-11-26"), (f"{YEAR}0008", f"{YEAR}-09-08"),
                             (f"{YEAR}0003", f"{YEAR}-06-09")), f"{YEAR}0009")
        self.assertEqual(nxt((f"FV-{last}-012", f"{last}-12-01")), f"FV-{YEAR}-001")
        self.assertEqual(nxt(("123", f"{last}-12-01")), "124")

    def test_mark_paid_many_is_all_or_nothing(self):
        with db.open_data(True) as data:
            a = db.save_invoice(data, invoice("1"))
        with self.assertRaises(LookupError):
            with db.open_data(True) as data:
                db.mark_paid_many(data, [{"id": a["id"], "paid_date": f"{YEAR}-03-10"}, {"id": 999}])
        self.assertEqual(self.stored()["invoices"][0]["status"], "issued")
        with db.open_data(True) as data:
            db.mark_paid_many(data, [{"id": a["id"], "paid_date": f"{YEAR}-03-10"}])
        self.assertEqual(self.stored()["invoices"][0]["paid_date"], f"{YEAR}-03-10")

    def test_paid_status_always_has_date(self):
        with db.open_data(True) as data:
            inv = db.save_invoice(data, invoice("1", status="paid"))
            self.assertEqual(inv["paid_date"], date.today().isoformat())
            inv = db.save_invoice(data, invoice("1", status="issued"), inv["id"])
            self.assertIsNone(inv["paid_date"])

    def test_pdf_storage_and_delete_keeps_file(self):
        with db.open_data(True) as data:
            inv = db.save_invoice(data, invoice("2026/7"))
            with self.assertRaises(ValueError):
                db.store_pdf(data, inv["id"], b"nope")
            name = db.store_pdf(data, inv["id"], b"%PDF-1.4 test")
            self.assertEqual(name, f"{YEAR}/Faktura-2026-7.pdf")
            db.delete_invoice(data, inv["id"])
        self.assertFalse((db.ARCHIV / name).exists())
        self.assertEqual(len(list(db.SMAZANE.iterdir())), 1)

    def test_backup_before_first_change_of_day(self):
        with db.open_data(True) as data:
            db.save_settings(data, {"name": "A"})
        self.assertTrue((db.ZALOHY / f"faktury-{date.today().isoformat()}.json").exists())

    def test_corrupted_file_gives_clear_error(self):
        db.DATA_FILE.write_text("{nedokončené", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "poškozený"):
            with db.open_data() as data:
                pass

    def test_import(self):
        pdf = Path(self.tmp.name) / "stara.pdf"
        pdf.write_bytes(b"%PDF-1.4 stara")
        spec = Path(self.tmp.name) / "import.json"
        spec.write_text(json.dumps({
            "settings": {"name": "Já"},
            "contacts": [{"name": "Odběratel s.r.o.", "ico": "12345678"}],
            "invoices": [invoice("20250001", issue="2025-11-26", due="2025-12-10", total=1000, pdf="stara.pdf")],
        }), encoding="utf-8")
        import_data.run(spec, dry_run=True)
        self.assertEqual(self.stored()["invoices"], [])
        import_data.run(spec)
        data = self.stored()
        self.assertEqual(len(data["contacts"]), 1)
        inv = data["invoices"][0]
        self.assertTrue(inv["imported"])
        self.assertEqual(inv["contact_id"], data["contacts"][0]["id"])
        self.assertEqual((db.ARCHIV / inv["pdf_file"]).read_bytes(), b"%PDF-1.4 stara")
        log = import_data.run(spec)  # druhý import nic nezdvojí
        self.assertEqual(len(self.stored()["invoices"]), 1)
        self.assertTrue(any("přeskakuji" in line for line in log))

    def test_import_checks_total(self):
        spec = Path(self.tmp.name) / "import.json"
        spec.write_text(json.dumps({"invoices": [invoice("1", total=999)]}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "nesedí"):
            import_data.run(spec)
        self.assertEqual(self.stored()["invoices"], [])


class ServerTests(TempData):
    def setUp(self):
        super().setUp()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        server.ALLOWED_HOSTS = {f"localhost:{self.port}", f"127.0.0.1:{self.port}"}
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def call(self, method, path, body=None, headers=None, ctype="application/json"):
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method,
                                     headers={"Content-Type": ctype, **(headers or {})})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read() or b"null")

    def test_invoice_flow(self):
        status, inv = self.call("POST", "/api/invoices", invoice(f"{YEAR}0001", save_contact=True))
        self.assertEqual(status, 201)
        self.assertEqual(self.call("PUT", f"/api/invoices/{inv['id']}/pdf", b"%PDF-1.4 x", ctype="application/pdf")[0], 200)
        self.assertEqual(self.call("GET", "/api/next-number")[1]["number"], f"{YEAR}0002")
        status, paid = self.call("POST", "/api/invoices/status", {"changes": [{"id": inv["id"], "paid_date": f"{YEAR}-03-05"}]})
        self.assertEqual((status, paid[0]["status"]), (200, "paid"))
        self.assertEqual(self.stored()["invoices"][0]["paid_date"], f"{YEAR}-03-05")
        status, body = self.call("POST", "/api/invoices", invoice(f"{YEAR}0001"))
        self.assertEqual(status, 400)
        self.assertIn("už existuje", body["error"])
        self.assertEqual(self.call("GET", "/api/invoices/999")[0], 404)

    def test_rejects_foreign_sites(self):
        status, _ = self.call("POST", "/api/contacts", {"name": "X"}, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.call("POST", "/api/contacts", b'{"name": "X"}', ctype="text/plain")
        self.assertEqual(status, 400)
        self.assertEqual(self.stored()["contacts"], [])

    def test_static_files_cannot_escape(self):
        self.assertEqual(self.call("GET", "/../db.py")[0], 404)
        self.assertEqual(self.call("GET", "/archiv/../faktury.json")[0], 404)


if __name__ == "__main__":
    unittest.main()
