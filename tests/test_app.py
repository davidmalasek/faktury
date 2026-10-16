"""Testy dat a serveru. Spuštění: python3 -m unittest discover tests"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import zipfile
import urllib.request
from datetime import date
from http.server import ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dane  # noqa: E402
import db  # noqa: E402
import import_data  # noqa: E402
import mejvos  # noqa: E402
import server  # noqa: E402
import update  # noqa: E402

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
        self._mejvos = (mejvos.HOME, mejvos.ENABLED)
        db.ICLOUD = None  # testy se nikdy nesmí dotknout skutečného iCloudu
        mejvos.HOME = root / "MejvOS"  # ani skutečného systému MejvOS
        mejvos.ENABLED = False
        db._peer_sig = None
        db.DATA = root
        db.DATA_FILE = root / "faktury.json"
        db.ARCHIV = root / "archiv"
        db.ZALOHY = root / "zalohy"
        db.SMAZANE = root / "smazane"
        db.init()

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(db, k, v)
        mejvos.HOME, mejvos.ENABLED = self._mejvos
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

    def test_income_without_invoice(self):
        received = {"date": f"{YEAR}-05-04", "amount": "12 381", "payer": " Pořadatel s.r.o. "}
        with db.open_data(True) as data:
            with self.assertRaisesRegex(ValueError, "větší než nula"):
                db.save_income(data, {**received, "amount": ""})
            with self.assertRaisesRegex(ValueError, "od koho"):
                db.save_income(data, {**received, "payer": ""})
            with self.assertRaisesRegex(ValueError, "neplatné datum"):
                db.save_income(data, {**received, "date": ""})
            inc = db.save_income(data, received)
            self.assertEqual((inc["amount"], inc["payer"], inc["doc_file"]), (12381.0, "Pořadatel s.r.o.", None))
            with self.assertRaisesRegex(ValueError, "PDF, PNG nebo JPG"):
                db.store_income_doc(data, inc["id"], b"nope")
            db.store_income_doc(data, inc["id"], b"%PDF-1.4 a")
            self.assertEqual(inc["doc_file"], f"{YEAR}/Prijem-{YEAR}-05-04-Poradatel-s.r.o.pdf")
            db.store_income_doc(data, inc["id"], b"\x89PNG b")  # nový doklad nahradí starý
            self.assertEqual(inc["doc_file"], f"{YEAR}/Prijem-{YEAR}-05-04-Poradatel-s.r.o.png")
            other = db.save_income(data, received)  # stejný den i plátce → jiný název souboru
            db.store_income_doc(data, other["id"], b"\x89PNG c")
            self.assertEqual(other["doc_file"], f"{YEAR}/Prijem-{YEAR}-05-04-Poradatel-s.r.o-{other['id']}.png")
            db.delete_income(data, inc["id"])
            self.assertEqual([i["id"] for i in db.list_incomes(data)], [other["id"]])
        self.assertEqual((db.ARCHIV / other["doc_file"]).read_bytes(), b"\x89PNG c")
        self.assertFalse((db.ARCHIV / f"{YEAR}/Prijem-{YEAR}-05-04-Poradatel-s.r.o.png").exists())
        self.assertEqual(len(list(db.SMAZANE.iterdir())), 2)  # nic se nemaže natrvalo

    def test_old_data_without_incomes(self):
        db.DATA_FILE.write_text(json.dumps({"settings": {}, "contacts": [], "invoices": []}), encoding="utf-8")
        with db.open_data() as data:
            self.assertEqual(db.list_incomes(data), [])

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


class EcosystemTests(TempData):
    """Propojení s ostatními aplikacemi systému MejvOS (třeba s Hodinovkou)."""

    def linked(self, ref="r1", **customer):
        return {"customer": {"name": "Kavárna", **customer},
                "items": [{"description": "Web", "quantity": 2.5, "unit": "hod", "price": 800}],
                "note": "Období: 1. 10. – 14. 10. 2026",
                "source": {"app": "hodinovka", "name": "Hodinovka", "ref": ref, "link": f"hodinovka://vyuctovani/{ref}"}}

    def peer(self, items):
        launcher = Path(self.tmp.name) / "hodinovka/spustit.sh"
        launcher.parent.mkdir(exist_ok=True)
        launcher.write_text("exit 0")
        mejvos._write_json(mejvos.HOME / "apps/hodinovka.json", {
            "id": "hodinovka", "name": "Hodinovka", "api": "http://127.0.0.1:1/api/os", "provides": ["contacts"],
            "launch": {"command": ["/bin/bash", str(launcher)]}})
        mejvos._write_json(mejvos.HOME / "contacts/hodinovka.json", {"items": items})

    def test_app_icons(self):
        # Nastavení ukazuje skutečné ikony aplikací: složka je v každé aplikaci stejná a zná celý katalog
        icons = db.ROOT / "static/mejvos"
        self.assertEqual(sorted(p.stem for p in icons.glob("*.svg")), sorted(mejvos.CATALOG))
        self.assertEqual((icons / f"{db.APP_ID}.svg").read_bytes(), (db.ROOT / "static/icon.svg").read_bytes())

    def test_old_contacts_get_stable_uid(self):
        db.DATA_FILE.write_text(json.dumps({"settings": {}, "invoices": [], "incomes": [], "contacts": [
            {"id": 1, "name": "Stará firma", "ico": "", "created_at": "2025-01-01T10:00:00"}]}), encoding="utf-8")
        db.init()
        first = self.stored()["contacts"][0]
        self.assertTrue(first["uid"])
        self.assertEqual(first["updated_at"], "2025-01-01T10:00:00")
        db.init()
        self.assertEqual(self.stored()["contacts"][0]["uid"], first["uid"])
        with db.open_data(True) as data:
            c = db.save_contact(data, {"name": "Nová", "uid": first["uid"]})  # cizí uid se nezdvojí
            self.assertNotEqual(c["uid"], first["uid"])

    def test_linked_invoice_is_created_once(self):
        with db.open_data(True) as data:
            db.save_settings(data, {"due_days": "10"})
            inv = db.create_linked_invoice(data, self.linked())
            self.assertEqual((inv["number"], inv["total"], inv["status"]), (f"{YEAR}0001", 2000.0, "issued"))
            self.assertEqual(inv["due_date"], date.fromordinal(date.today().toordinal() + 10).isoformat())
            self.assertEqual(inv["source"]["link"], "hodinovka://vyuctovani/r1")
            again = db.create_linked_invoice(data, self.linked())  # opakovaný požadavek
            self.assertIs(again, inv)
            self.assertEqual(len(data["invoices"]), 1)
            other = db.create_linked_invoice(data, self.linked("r2"))
            self.assertEqual(other["number"], f"{YEAR}0002")
            with self.assertRaisesRegex(ValueError, "ze které aplikace"):
                db.create_linked_invoice(data, {**self.linked(), "source": {}})

    def test_linked_invoice_customer(self):
        with db.open_data(True) as data:
            known = db.save_contact(data, {"name": "Kavárna s.r.o.", "ico": "12345678", "street": "Mlýnská 1", "uid": "u1"})
            # stejné uid: propojí se s kontaktem a chybějící údaje doplní, poslané údaje mají přednost
            inv = db.create_linked_invoice(data, self.linked(uid="u1", name="Kavárna U Mlýna"))
            self.assertEqual(inv["contact_id"], known["id"])
            self.assertEqual((inv["customer"]["name"], inv["customer"]["ico"], inv["customer"]["street"]),
                             ("Kavárna U Mlýna", "12345678", "Mlýnská 1"))
            # fakturace na jinou firmu: nový kontakt se uloží i s uid z druhé aplikace
            inv = db.create_linked_invoice(data, self.linked("r2", uid="u9", name="Holding a.s.", ico="87654321"))
            holding = db.get_contact(data, inv["contact_id"])
            self.assertEqual((holding["name"], holding["uid"]), ("Holding a.s.", "u9"))
            # bez uid se najde podle IČO
            inv = db.create_linked_invoice(data, self.linked("r3", name="Holding", ico="87654321"))
            self.assertEqual(inv["contact_id"], holding["id"])
            self.assertEqual(len(data["contacts"]), 2)

    def test_publishes_contacts_and_linked_invoices(self):
        mejvos.ENABLED = True
        with db.open_data(True) as data:
            db.save_invoice(data, invoice("1", save_contact=True))
            inv = db.create_linked_invoice(data, self.linked())
        contacts = json.loads((mejvos.HOME / "contacts/faktury.json").read_text(encoding="utf-8"))["items"]
        self.assertEqual(sorted(c["name"] for c in contacts), ["Kavárna", "Odběratel s.r.o."])
        published = json.loads((mejvos.HOME / "invoices/faktury.json").read_text(encoding="utf-8"))
        self.assertEqual(published["ready"], False)  # chybí údaje dodavatele
        self.assertEqual([(i["ref"], i["status"]) for i in published["items"]], [("r1", "issued")])  # jen propojené
        with db.open_data(True) as data:
            db.set_status(data, inv["id"], "paid")
        published = json.loads((mejvos.HOME / "invoices/faktury.json").read_text(encoding="utf-8"))
        self.assertEqual(published["items"][0]["status"], "paid")

    def test_deleted_linked_invoices_are_published(self):
        mejvos.ENABLED = True
        read = lambda: json.loads((mejvos.HOME / "invoices/faktury.json").read_text(encoding="utf-8"))  # noqa: E731
        with db.open_data(True) as data:
            inv = db.create_linked_invoice(data, self.linked())
            own = db.save_invoice(data, invoice("1"))
        self.assertEqual(read()["deleted"], [])
        with db.open_data(True) as data:
            db.delete_invoices(data, [inv["id"], own["id"]])
        published = read()
        self.assertEqual(published["items"], [])
        self.assertEqual([(d["app"], d["ref"], d["number"]) for d in published["deleted"]],
                         [("hodinovka", "r1", inv["number"])])  # vlastní faktura se nikomu nehlásí
        with db.open_data(True) as data:  # Hodinovka k témuž vyúčtování vystavila fakturu znovu
            db.create_linked_invoice(data, self.linked())
        self.assertEqual((len(read()["items"]), read()["deleted"]), (1, []))

    def test_delete_linked_invoice(self):
        with db.open_data(True) as data:
            issued, paid, cancelled = (db.create_linked_invoice(data, self.linked(r)) for r in ("r1", "r2", "r3"))
            db.set_status(data, paid["id"], "paid")
            db.set_status(data, cancelled["id"], "cancelled")
            ask = lambda ref: db.delete_linked_invoice(data, {"app": "hodinovka", "ref": ref})  # noqa: E731
            self.assertEqual(ask("r1"), {"deleted": True, "status": None, "number": issued["number"]})
            self.assertEqual(ask("r1"), {"deleted": False, "status": None})  # už je pryč
            with self.assertRaisesRegex(ValueError, "zaplacená"):
                ask("r2")
            self.assertEqual(ask("r3")["status"], "cancelled")  # stornovaná zůstane v číselné řadě
            self.assertEqual([i["number"] for i in data["invoices"]], [paid["number"], cancelled["number"]])
            self.assertEqual([d["ref"] for d in data["deleted_links"]], ["r1"])

    def test_delete_many_is_all_or_nothing(self):
        with db.open_data(True) as data:
            a = db.save_invoice(data, invoice("1"))
            db.save_invoice(data, invoice("2"))
        with self.assertRaises(LookupError), db.open_data(True) as data:
            db.delete_invoices(data, [a["id"], 999])
        self.assertEqual(len(self.stored()["invoices"]), 2)
        with self.assertRaisesRegex(ValueError, "Nevybral"), db.open_data(True) as data:
            db.delete_invoices(data, [])
        with db.open_data(True) as data:
            self.assertEqual(db.delete_invoices(data, [a["id"], str(a["id"])]), {"deleted": 1})
        self.assertEqual([i["number"] for i in self.stored()["invoices"]], ["2"])

    def test_peer_contacts_are_offered_and_linked(self):
        later = mejvos.now()
        self.peer([{"uid": "h1", "name": "Studio Sova", "updated_at": later},
                   {"uid": "h2", "name": "Odběratel s.r.o.", "updated_at": later}])
        with db.open_data(True) as data:
            db.save_contact(data, {"name": "Odběratel s.r.o."})
            self.assertEqual([c["uid"] for c in db.offered_contacts(data)], ["h1"])
            inv = db.save_invoice(data, invoice("1", customer={"name": "Studio Sova", "ico": "11223344"},
                                                save_contact=True, contact_uid="h1"))
            self.assertEqual(db.get_contact(data, inv["contact_id"])["uid"], "h1")
            self.assertEqual(db.offered_contacts(data), [])

    def test_newer_peer_data_updates_linked_contact(self):
        with db.open_data(True) as data:
            c = db.save_contact(data, {"name": "Studio Sova", "ico": "11223344", "uid": "h1"})
            c["updated_at"] = "2026-01-01T10:00:00+01:00"
        self.peer([{"uid": "h1", "name": "Studio Sova s.r.o.", "ico": "", "updated_at": "2026-02-01T10:00:00+01:00"}])
        db.sync_peers()
        stored = self.stored()["contacts"][0]
        self.assertEqual((stored["name"], stored["ico"]), ("Studio Sova s.r.o.", "11223344"))  # prázdné nic nesmaže


def release_zip(version, files, prefix=None):
    """Archiv verze ve tvaru, v jakém ho dává GitHub (vše ve složce faktury-<verze>/)."""
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, (content, mode) in {"VERSION": (version, 0o644), "server.py": ("# nový", 0o644), **files}.items():
            info = zipfile.ZipInfo(f"{prefix or 'faktury-' + version}/{name}")
            info.external_attr = (0o100000 | mode) << 16
            z.writestr(info, content)
    return buf.getvalue()


class UpdateTests(TempData):
    def setUp(self):
        super().setUp()
        self.root = Path(self.tmp.name) / "app"
        (self.root / "data").mkdir(parents=True)
        (self.root / "data/faktury.json").write_text("moje data", encoding="utf-8")
        (self.root / "VERSION").write_text("1.0.0\n", encoding="utf-8")
        (self.root / "server.py").write_text("# starý", encoding="utf-8")
        (self.root / "macos").mkdir()
        (self.root / "macos/Faktury.swift").write_text("okno", encoding="utf-8")
        update._cache.update(at=0.0, release=None)

    def latest(self, version):
        return mock.patch.object(update, "latest_release", return_value={
            "tag": f"v{version}", "version": version, "notes": "", "url": "https://example.com"})

    def test_versions_compare_as_numbers(self):
        self.assertEqual(update.parse_version("v1.2"), (1, 2, 0))
        self.assertGreater(update.parse_version("1.10.0"), update.parse_version("1.9.3"))

    def test_apply_replaces_app_files_but_never_data(self):
        content = release_zip("1.1.0", {
            "spustit.sh": ("#!/bin/bash", 0o755),
            "static/novy.js": ("// nový soubor", 0o644),
            "data/faktury.json": ("cizí data", 0o644),
            "python/bin/python3": ("cizí python", 0o755),
        })
        self.assertFalse(update.apply_zip(content, self.root, "1.1.0"))  # okno se nezměnilo
        self.assertEqual(update.current_version(self.root), "1.1.0")
        self.assertEqual((self.root / "server.py").read_text(encoding="utf-8"), "# nový")
        self.assertEqual((self.root / "static/novy.js").read_text(encoding="utf-8"), "// nový soubor")
        self.assertEqual((self.root / "data/faktury.json").read_text(encoding="utf-8"), "moje data")
        self.assertTrue((self.root / "spustit.sh").stat().st_mode & 0o100)
        self.assertFalse((self.root / "python").exists())

    def test_apply_reports_changed_app_window(self):
        content = release_zip("1.1.0", {"macos/Faktury.swift": ("nové okno", 0o644)})
        self.assertTrue(update.apply_zip(content, self.root, "1.1.0"))

    def test_apply_rejects_bad_archives(self):
        with self.assertRaisesRegex(ValueError, "poškozená"):
            update.apply_zip(release_zip("1.1.0", {"../mimo.txt": ("x", 0o644)}, prefix="faktury"), self.root)
        with self.assertRaisesRegex(ValueError, "jinou verzi"):
            update.apply_zip(release_zip("1.1.0", {}), self.root, "1.2.0")
        self.assertEqual((self.root / "server.py").read_text(encoding="utf-8"), "# starý")

    def test_status_and_git_install(self):
        with self.latest("1.1.0"):
            self.assertTrue(update.status(self.root)["available"])
            (self.root / ".git").mkdir()
            self.assertTrue(update.status(self.root)["git"])
            with self.assertRaisesRegex(ValueError, "gitu"):
                update.install(self.root)
        with self.latest("1.0.0"):
            self.assertFalse(update.status(self.root)["available"])

    def test_install_backs_up_and_applies(self):
        content = release_zip("1.1.0", {})

        class Response(BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        with self.latest("1.1.0"), mock.patch.object(update.urllib.request, "urlopen", return_value=Response(content)):
            self.assertEqual(update.install(self.root), {"version": "1.1.0", "app_changed": False})
        self.assertEqual(update.current_version(self.root), "1.1.0")
        self.assertEqual(len(list(db.ZALOHY.glob("pred-aktualizaci-*.json"))), 1)


class TaxReturnTests(TempData):
    """Připomínka daňového přiznání."""

    def test_deadline_moves_to_workday(self):
        self.assertEqual(dane.deadline(2025), (date(2026, 4, 1), date(2026, 5, 4)))  # 1. 5. svátek, pak víkend
        self.assertEqual(dane.deadline(2026), (date(2027, 4, 1), date(2027, 5, 3)))
        self.assertEqual(dane.deadline(2023), (date(2024, 4, 2), date(2024, 5, 2)))  # 1. 4. 2024 Velikonoční pondělí
        self.assertEqual(dane.easter(2027), date(2027, 3, 28))
        self.assertEqual(dane.workday(date(2026, 12, 24)), date(2026, 12, 28))

    def test_reminder_until_filed(self):
        feb = date(2027, 2, 10)
        with db.open_data() as data:
            self.assertFalse(dane.tax_return(data, feb)["show"])  # v roce 2026 nic nebylo
        with db.open_data(True) as data:
            db.save_invoice(data, invoice("1", issue="2026-11-02", due="2026-11-16"))
        with db.open_data() as data:
            self.assertEqual(dane.tax_return(data, feb), {"year": 2026, "paper": "2027-04-01", "due": "2027-05-03",
                                                          "filed": False, "season": True, "show": True})
            self.assertTrue(dane.tax_return(data, date(2027, 7, 2))["show"])
            late = dane.tax_return(data, date(2027, 7, 3))  # 60 dní po termínu už nestraší ani v Nastavení
            self.assertEqual((late["season"], late["show"]), (False, False))
        with db.open_data(True) as data:
            db.save_settings(data, {"tax_return_filed": "2026"})
        with db.open_data() as data:
            t = dane.tax_return(data, feb)
            self.assertEqual((t["filed"], t["season"], t["show"]), (True, True, False))
            self.assertEqual(dane.tax_return(data, date(2028, 2, 1))["year"], 2027)


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
        self.call("POST", "/api/invoices", invoice(f"{YEAR}0002"))
        self.assertEqual(self.call("POST", "/api/invoices/delete", {"ids": [inv["id"], 999]})[0], 404)
        self.assertEqual(self.call("POST", "/api/invoices/delete", {"ids": [i["id"] for i in self.stored()["invoices"]]}),
                         (200, {"deleted": 2}))
        self.assertEqual(self.stored()["invoices"], [])

    def test_income_flow(self):
        status, inc = self.call("POST", "/api/incomes", {"date": f"{YEAR}-05-04", "amount": "12381", "payer": "Pořadatel"})
        self.assertEqual((status, inc["amount"]), (201, 12381.0))
        status, body = self.call("PUT", f"/api/incomes/{inc['id']}/doc", b"GIF89a", ctype="image/gif")
        self.assertEqual(status, 400)
        self.assertIn("PDF, PNG nebo JPG", body["error"])
        status, inc = self.call("PUT", f"/api/incomes/{inc['id']}/doc", b"\xff\xd8\xff jpg", ctype="image/jpeg")
        self.assertEqual((status, inc["doc_file"]), (200, f"{YEAR}/Prijem-{YEAR}-05-04-Poradatel.jpg"))
        self.assertEqual(len(self.call("GET", "/api/incomes")[1]), 1)
        self.assertEqual(self.call("PUT", f"/api/incomes/{inc['id']}", {**inc, "amount": "-5"})[0], 400)
        self.assertEqual(self.call("DELETE", f"/api/incomes/{inc['id']}")[0], 200)
        self.assertEqual(self.stored()["incomes"], [])
        self.assertEqual(self.call("GET", f"/api/incomes/{inc['id']}")[0], 404)

    def test_rejects_foreign_sites(self):
        status, _ = self.call("POST", "/api/contacts", {"name": "X"}, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.call("POST", "/api/contacts", b'{"name": "X"}', ctype="text/plain")
        self.assertEqual(status, 400)
        self.assertEqual(self.stored()["contacts"], [])

    def test_version_and_update_status(self):
        self.assertEqual(self.call("GET", "/api/version")[1], {"version": update.current_version()})
        with mock.patch.object(update, "latest_release", return_value=None):
            status, body = self.call("GET", "/api/update")
        self.assertEqual((status, body["available"]), (200, False))
        status, _ = self.call("POST", "/api/update", {}, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_os_api_for_other_apps(self):
        status, info = self.call("GET", "/api/os")
        self.assertEqual((status, info["provides"], info["ready"]), (200, ["contacts", "invoices"], False))
        body = EcosystemTests.linked(self, "x1")
        status, created = self.call("POST", "/api/os/invoices", body)
        self.assertEqual((status, created["number"], created["total"]), (201, f"{YEAR}0001", 2000.0))
        self.assertEqual(self.call("POST", "/api/os/invoices", body)[1]["id"], created["id"])
        self.assertEqual([c["name"] for c in self.call("GET", "/api/os/contacts")[1]], ["Kavárna"])
        self.assertEqual(self.call("GET", "/api/offered")[1], [])
        gone = {"app": "hodinovka", "ref": "x1"}
        self.assertEqual(self.call("POST", "/api/os/invoices/delete", gone), (200, {"deleted": True, "status": None, "number": created["number"]}))
        self.assertEqual(self.call("POST", "/api/os/invoices/delete", gone)[1]["deleted"], False)
        self.assertEqual(self.stored()["invoices"], [])
        status, _ = self.call("POST", "/api/os/invoices", body, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_revision_follows_changes(self):
        _, first = self.call("GET", "/api/rev")
        self.assertEqual(self.call("GET", "/api/rev")[1], first)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/os/invoices", method="POST",
                                     data=json.dumps(EcosystemTests.linked(self, "r9")).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as r:
            own = r.headers["X-Rev"]
        _, now = self.call("GET", "/api/rev")
        self.assertNotEqual(now, first)  # okno Faktur se obnoví, když fakturu vystaví Hodinovka
        self.assertEqual(own, now["rev"])
        EcosystemTests.peer(self, [{"uid": "u1", "name": "Pekárna"}])  # Hodinovka zveřejnila klienty
        self.assertNotEqual(self.call("GET", "/api/rev")[1], now)

    def test_tax_return_reminder(self):
        status, body = self.call("GET", "/api/priznani")
        self.assertEqual((status, body["year"], body["filed"]), (200, int(YEAR) - 1, False))
        self.assertEqual(self.call("PUT", "/api/settings", {"tax_return_filed": int(YEAR) - 1})[0], 200)
        self.assertTrue(self.call("GET", "/api/priznani")[1]["filed"])

    def test_static_files_cannot_escape(self):
        self.assertEqual(self.call("GET", "/../db.py")[0], 404)
        self.assertEqual(self.call("GET", "/archiv/../faktury.json")[0], 404)


if __name__ == "__main__":
    unittest.main()
