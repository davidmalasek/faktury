"""Data fakturace – vše je v jednom čitelném souboru data/faktury.json.
Sdílí ho server i import starých dat."""
import json
import os
import re
import shutil
import sys
import threading
import unicodedata
from contextlib import contextmanager
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

import mejvos

APP_ID = "faktury"
ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("FAKTURY_DATA") or ROOT / "data")  # jiná složka jen pro testy
DATA_FILE = DATA / "faktury.json"
ARCHIV = DATA / "archiv"
ZALOHY = DATA / "zalohy"
SMAZANE = DATA / "smazane"
ZALOHY_POCET = 30
# Kopie dat v iCloud Drive. Zapíná ji jen server.main() – testy a import ji nechávají vypnutou.
ICLOUD_DEFAULT = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Faktury záloha"
ICLOUD = None

DEFAULT_SETTINGS = {
    "name": "",
    "street": "",
    "city": "",
    "zip": "",
    "ico": "",
    "registration": "Fyzická osoba zapsaná v živnostenském rejstříku.",
    "account": "",
    "iban": "",
    "email": "",
    "phone": "",
    "web": "",
    "vat_note": "Nejsem plátce DPH.",
    "footer_note": "",
    "due_days": 14,
    "side_activity": True,  # vedlejší činnost (student) – přehled hlídá limit pro sociální pojištění
    "expense_rate": 60,     # výdajový paušál v %, 0 = skutečné výdaje
}
EXPENSE_RATES = (80, 60, 40, 0)
# Údaje dodavatele, které se při vystavení „zmrazí“ do faktury.
SUPPLIER_FIELDS = ("name", "street", "city", "zip", "ico", "registration", "account",
                   "iban", "email", "phone", "web", "vat_note", "footer_note")
CUSTOMER_FIELDS = ("name", "ico", "dic", "street", "city", "zip", "country", "email")
CONTACT_FIELDS = CUSTOMER_FIELDS + ("note",)
STATUSES = ("issued", "paid", "cancelled")
# Doklad k příjmu bez faktury: rozpozná se podle začátku souboru.
DOC_KINDS = ((b"%PDF", ".pdf"), (b"\x89PNG", ".png"), (b"\xff\xd8\xff", ".jpg"))

_lock = threading.Lock()


# ---------- soubor ----------

def init():
    DATA.mkdir(exist_ok=True)
    ARCHIV.mkdir(exist_ok=True)
    if not DATA_FILE.exists():
        _save({"settings": dict(DEFAULT_SETTINGS), "contacts": [], "invoices": [], "incomes": []})
    with _lock:  # kontakty ze starších verzí dostanou uid, ať je poznají i ostatní aplikace (MejvOS)
        data = _load()
        if _ensure_uids(data):
            _save(data)


def _load():
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Soubor {DATA_FILE.name} je poškozený ({e}). "
                           f"Obnov ho z poslední zálohy ve složce data/zalohy.")
    data.setdefault("incomes", [])  # starší data příjmy bez faktury ještě nemají
    return data


def _save(data):
    """Zapíše nejdřív do dočasného souboru a pak ho prohodí – soubor se nikdy nezapíše napůl."""
    tmp = DATA_FILE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, DATA_FILE)


@contextmanager
def open_data(write=False):
    """Načte data; při write=True je po úspěšném dokončení uloží. Při chybě se nic neuloží."""
    with _lock:
        data = _load()
        yield data
        if write:
            _commit(data)


def _commit(data):
    _ensure_uids(data)
    daily_backup()
    _save(data)
    publish(data)
    if ICLOUD:
        _cloud_wake.set()


def daily_backup():
    """Před první změnou dne zkopíruje data do data/zalohy; nechá posledních 30 dní."""
    ZALOHY.mkdir(exist_ok=True)
    target = ZALOHY / f"faktury-{date.today().isoformat()}.json"
    if not target.exists() and DATA_FILE.exists():
        shutil.copyfile(DATA_FILE, target)
    for old in sorted(ZALOHY.glob("faktury-*.json"))[:-ZALOHY_POCET]:
        old.unlink()


def backup_now(label):
    """Okamžitá záloha (např. před importem) – tyhle se nemažou."""
    ZALOHY.mkdir(exist_ok=True)
    target = ZALOHY / f"{label}-{datetime.now().strftime('%Y-%m-%d-%H%M%S')}.json"
    shutil.copyfile(DATA_FILE, target)
    return target


# ---------- propojení s ostatními aplikacemi (MejvOS) ----------

_peer_sig = None


def _ensure_uids(data):
    """Každý kontakt má uid – podle něj ho poznají i ostatní aplikace (třeba Hodinovka)."""
    changed = False
    for c in data["contacts"]:
        if not c.get("uid"):
            c["uid"] = mejvos.new_uid()
            changed = True
        if not c.get("updated_at"):
            c["updated_at"] = c.get("created_at") or _now()
            changed = True
    return changed


def settings_ready(data):
    s = get_settings(data)
    return bool(s["name"] and s["ico"] and s["account"])


def publish(data):
    """Zveřejní ostatním aplikacím kontakty a stav faktur, které z nich přišly."""
    mejvos.publish_contacts(APP_ID, data["contacts"])
    mejvos.publish(APP_ID, "invoices", [
        {"app": inv["source"]["app"], "ref": inv["source"]["ref"], "id": inv["id"], "number": inv["number"],
         "status": inv["status"], "issue_date": inv["issue_date"], "due_date": inv["due_date"],
         "paid_date": inv["paid_date"], "total": inv["total"]}
        for inv in data["invoices"] if (inv.get("source") or {}).get("ref")], ready=settings_ready(data))


def sync_peers():
    """Převezme novější údaje propojených kontaktů z ostatních aplikací (stejné uid).
    Dívá se jen, když se od minule něco změnilo, takže je levné volat ho před každým požadavkem."""
    global _peer_sig
    sig = mejvos.signature("contacts", APP_ID)
    if sig == _peer_sig:
        return
    with _lock:
        data = _load()
        if mejvos.merge_contacts(data["contacts"], mejvos.peer_contacts(APP_ID)):
            _commit(data)
    _peer_sig = sig


def offered_contacts(data):
    """Kontakty z ostatních aplikací, které ve Fakturách ještě nejsou – nabízí se u faktury i v kontaktech."""
    return mejvos.offered_contacts(data["contacts"], mejvos.peer_contacts(APP_ID))


# ---------- záloha do iCloud Drive ----------

cloud_status = {"dir": None, "last": None, "error": None}
_cloud_wake = threading.Event()


def start_cloud_backup(target):
    """Spustí na pozadí kopírování dat do iCloud Drive – hned a pak po každé změně.
    Běží mimo zámek, takže pomalý iCloud (nebo dotaz macOS na oprávnění) nikdy nezdrží appku."""
    global ICLOUD
    ICLOUD = Path(target)
    cloud_status["dir"] = str(ICLOUD)
    threading.Thread(target=_cloud_worker, daemon=True, name="icloud").start()
    _cloud_wake.set()


def _cloud_worker():
    while True:
        _cloud_wake.wait()
        _cloud_wake.clear()
        cloud_sync()


def cloud_sync():
    """Zkopíruje faktury.json, archiv PDF, zálohy a smazané do ICLOUD.
    Jen přidává a přepisuje – nic nemaže, kromě denních záloh starších než posledních 30."""
    target = ICLOUD
    if target is None:
        return
    try:
        if not target.parent.is_dir():
            raise RuntimeError("iCloud Drive na tomhle Macu není zapnutý.")
        target.mkdir(exist_ok=True)
        files = [DATA_FILE] + [f for folder in (ARCHIV, ZALOHY, SMAZANE) if folder.is_dir()
                               for f in sorted(folder.rglob("*"))
                               if f.is_file() and not f.name.startswith(".") and not f.name.endswith(".tmp")]
        for src in files:
            _copy_if_changed(src, target / src.relative_to(DATA))
        for old in sorted((target / ZALOHY.name).glob("faktury-*.json"))[:-ZALOHY_POCET]:
            old.unlink()
        cloud_status.update(last=_now(), error=None)
    except Exception as e:  # záloha nesmí shodit server – chyba se ukáže v Nastavení
        cloud_status["error"] = str(e)
        print(f"Záloha do iCloud Drive selhala: {e}", file=sys.stderr, flush=True)


def _copy_if_changed(src, dst):
    st = src.stat()
    try:
        d = dst.stat()
        if d.st_size == st.st_size and int(d.st_mtime) == int(st.st_mtime):
            return
    except FileNotFoundError:
        pass
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.name}.tmp")
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)


# ---------- pomocné ----------

def _text(v):
    return "" if v is None else str(v).strip()


def _decimal(v, label):
    try:
        return Decimal(str(v).replace(",", ".").replace(" ", "").replace(" ", "") or "0")
    except InvalidOperation:
        raise ValueError(f"{label}: „{v}“ není číslo.")


def _money(d):
    return float(d.quantize(Decimal("0.01"), ROUND_HALF_UP))


def _date(v, label):
    try:
        return date.fromisoformat(_text(v)).isoformat()
    except ValueError:
        raise ValueError(f"{label}: neplatné datum.")


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _next_id(rows):
    return max((r["id"] for r in rows), default=0) + 1


def _find(rows, rid, label):
    for r in rows:
        if r["id"] == rid:
            return r
    raise LookupError(f"{label} neexistuje.")


def _trash(name):
    """Soubor z archivu se nemaže, jen přesune do data/smazane."""
    path = ARCHIV / name
    if path.exists():
        SMAZANE.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.move(path, SMAZANE / f"{stamp}-{path.name}")


def pdf_name(number, issue_date):
    safe = re.sub(r"[^\w.-]+", "-", number, flags=re.ASCII).strip("-") or "faktura"
    return f"{issue_date[:4]}/Faktura-{safe}.pdf"


# ---------- nastavení ----------

def get_settings(data):
    return {**DEFAULT_SETTINGS, **data.get("settings", {})}


def save_settings(data, values):
    s = get_settings(data)
    for key, default in DEFAULT_SETTINGS.items():
        if key not in values:
            continue
        v = values[key]
        if isinstance(default, bool):
            s[key] = v is True or _text(v).lower() in ("1", "true", "on")
        elif isinstance(default, int):
            try:
                s[key] = int(_text(v) or 0)
            except ValueError:
                raise ValueError(f"Nastavení {key}: zadej celé číslo.") from None
        else:
            s[key] = _text(v)
    if s["expense_rate"] not in EXPENSE_RATES:
        raise ValueError("Výdajový paušál může být 80, 60 nebo 40 %, případně skutečné výdaje.")
    data["settings"] = s
    return s


def supplier_from_settings(settings):
    return {k: settings.get(k, "") for k in SUPPLIER_FIELDS}


# ---------- kontakty ----------

def list_contacts(data):
    stats = {}
    for inv in data["invoices"]:
        st = stats.setdefault(inv.get("contact_id"), [0, 0.0])
        st[0] += 1
        if inv["status"] != "cancelled":
            st[1] += inv["total"]
    return [{**c, "invoice_count": stats.get(c["id"], [0])[0],
             "invoiced": round(stats.get(c["id"], [0, 0.0])[1], 2)} for c in data["contacts"]]


def get_contact(data, cid):
    return _find(data["contacts"], cid, "Kontakt")


def save_contact(data, values, cid=None):
    """Nový nebo upravený kontakt. Kontakt převzatý z jiné aplikace (třeba z Hodinovky) si nechá
    její uid, takže zůstanou propojené."""
    clean = {k: _text(values.get(k)) for k in CONTACT_FIELDS}
    if not clean["name"]:
        raise ValueError("Vyplň název nebo jméno kontaktu.")
    if cid is None:
        uid = _text(values.get("uid"))
        if not uid or any(c.get("uid") == uid for c in data["contacts"]):
            uid = mejvos.new_uid()
        contact = {"id": _next_id(data["contacts"]), "uid": uid, **clean, "created_at": _now(), "updated_at": _now()}
        data["contacts"].append(contact)
        return contact
    contact = get_contact(data, cid)
    contact.update(clean, updated_at=_now())
    return contact


def delete_contact(data, cid):
    data["contacts"] = [c for c in data["contacts"] if c["id"] != cid]
    for inv in data["invoices"]:
        if inv.get("contact_id") == cid:
            inv["contact_id"] = None  # faktura si údaje odběratele pamatuje sama


def find_contact(data, customer):
    """Najde kontakt podle IČO, případně podle přesného názvu."""
    ico, name = _text(customer.get("ico")), _text(customer.get("name"))
    for c in data["contacts"]:
        if ico and c["ico"] == ico:
            return c["id"]
    for c in data["contacts"]:
        if c["name"] == name:
            return c["id"]
    return None


# ---------- faktury ----------

def list_invoices(data):
    return sorted(data["invoices"], key=lambda i: (i["issue_date"], i["number"]), reverse=True)


def get_invoice(data, iid):
    return _find(data["invoices"], iid, "Faktura")


def _clean_items(items):
    out = []
    for i, it in enumerate(items or [], 1):
        desc = _text(it.get("description"))
        if not desc and not _text(it.get("price")):
            continue  # prázdný řádek
        if not desc:
            raise ValueError(f"Položka {i}: chybí popis.")
        qty = _decimal(it.get("quantity", 1), f"Položka {i}, množství")
        price = _decimal(it.get("price", 0), f"Položka {i}, cena")
        out.append({
            "description": desc,
            "quantity": float(qty),
            "unit": _text(it.get("unit")),
            "price": float(price),
            "amount": _money(qty * price),
        })
    if not out:
        raise ValueError("Faktura musí mít aspoň jednu položku.")
    return out


def variable_symbol(number):
    """Variabilní symbol = číslice z čísla faktury (max. 10 posledních)."""
    return re.sub(r"\D", "", number)[-10:]


def save_invoice(data, values, iid=None):
    """Vytvoří nebo upraví fakturu. Údaje dodavatele se berou z Nastavení jen při vytvoření
    (nebo když o to uživatel výslovně požádá), aby se staré faktury samy neměnily."""
    existing = get_invoice(data, iid) if iid is not None else None

    number = _text(values.get("number"))
    if not number:
        raise ValueError("Vyplň číslo faktury.")
    if any(i["number"] == number and i is not existing for i in data["invoices"]):
        raise ValueError(f"Faktura s číslem {number} už existuje.")
    issue = _date(values.get("issue_date"), "Datum vystavení")
    due = _date(values.get("due_date"), "Datum splatnosti")
    if due < issue:
        raise ValueError("Splatnost nemůže být dřív než vystavení.")

    customer = {k: _text((values.get("customer") or {}).get(k)) for k in CUSTOMER_FIELDS}
    if not customer["name"]:
        raise ValueError("Vyplň odběratele.")
    items = _clean_items(values.get("items"))
    total = _money(sum((Decimal(str(it["amount"])) for it in items), Decimal(0)))

    contact_id = values.get("contact_id") or None
    if contact_id is not None and not any(c["id"] == contact_id for c in data["contacts"]):
        contact_id = None  # kontakt mezitím někdo smazal
    uid = _text(values.get("contact_uid"))  # kontakt z jiné aplikace (třeba klient z Hodinovky)
    if contact_id is None and uid:
        contact_id = next((c["id"] for c in data["contacts"] if c.get("uid") == uid), None)
    if contact_id is None and values.get("save_contact"):
        contact_id = find_contact(data, customer) or save_contact(data, {**customer, "uid": uid})["id"]

    if values.get("supplier"):
        supplier = {k: _text(values["supplier"].get(k)) for k in SUPPLIER_FIELDS}
    elif existing and not values.get("refresh_supplier"):
        supplier = existing["supplier"]
    else:
        supplier = supplier_from_settings(get_settings(data))

    status = values.get("status") or (existing["status"] if existing else "issued")
    if status not in STATUSES:
        raise ValueError("Neplatný stav faktury.")
    paid_date = values.get("paid_date", existing["paid_date"] if existing else None) or None
    if status == "paid":
        paid_date = _date(paid_date or date.today().isoformat(), "Datum úhrady")

    fields = {
        "number": number,
        "contact_id": contact_id,
        "customer": customer,
        "supplier": supplier,
        "issue_date": issue,
        "due_date": due,
        "items": items,
        "total": total,
        "vs": variable_symbol(number),
        "note": _text(values.get("note")),
        "status": status,
        "paid_date": paid_date if status == "paid" else None,
        "updated_at": _now(),
    }
    if existing:
        existing.update(fields)
        return existing
    invoice = {"id": _next_id(data["invoices"]), **fields,
               "imported": bool(values.get("imported")), "pdf_file": None, "created_at": _now()}
    data["invoices"].append(invoice)
    return invoice


def create_linked_invoice(data, values):
    """Faktura, o kterou požádala jiná aplikace (třeba Hodinovka za odpracovaný čas).
    Číslo, data a údaje dodavatele doplní Faktury samy. Stejný požadavek (source.app + source.ref)
    poslaný znovu vrátí už vystavenou fakturu, takže nevznikne dvakrát.
    Odběratel se propojí s kontaktem podle uid, IČO nebo názvu; když žádný není, uloží se jako nový."""
    source = values.get("source") or {}
    app, ref = _text(source.get("app")), _text(source.get("ref"))
    if not app or not ref:
        raise ValueError("Chybí, ze které aplikace faktura přišla.")
    for inv in data["invoices"]:
        if (inv.get("source") or {}).get("app") == app and inv["source"].get("ref") == ref:
            return inv
    given = values.get("customer") or {}
    if not _text(given.get("name")):
        raise ValueError("Vyplň odběratele.")
    uid = _text(given.get("uid"))
    contact = next((c for c in data["contacts"] if uid and c.get("uid") == uid), None)
    if contact is None:
        cid = find_contact(data, given)
        contact = get_contact(data, cid) if cid else save_contact(data, given)
    # Co aplikace poslala, platí (třeba fakturace na jinou firmu); chybějící údaje doplní kontakt.
    customer = {k: _text(given.get(k)) or contact.get(k, "") for k in CUSTOMER_FIELDS}
    issue = date.today().isoformat()
    due = date.fromordinal(date.today().toordinal() + int(get_settings(data)["due_days"] or 0)).isoformat()
    inv = save_invoice(data, {
        "number": next_number(data),
        "issue_date": _date(values.get("issue_date") or issue, "Datum vystavení"),
        "due_date": _date(values.get("due_date") or due, "Datum splatnosti"),
        "contact_id": contact["id"],
        "customer": customer,
        "items": values.get("items"),
        "note": values.get("note"),
    })
    inv["source"] = {"app": app, "ref": ref, "name": _text(source.get("name")) or app, "link": _text(source.get("link"))}
    return inv


def set_status(data, iid, status, paid_date=None):
    if status not in STATUSES:
        raise ValueError("Neplatný stav faktury.")
    inv = get_invoice(data, iid)
    inv["status"] = status
    inv["paid_date"] = _date(paid_date or date.today().isoformat(), "Datum úhrady") \
        if status == "paid" else None
    inv["updated_at"] = _now()
    return inv


def mark_paid_many(data, changes):
    """Označí víc faktur jako zaplacené najednou: changes = [{"id": 1, "paid_date": "2026-03-20"}].
    Buď projdou všechny, nebo žádná (chyba zabrání uložení)."""
    if not changes:
        raise ValueError("Nevybral jsi žádnou fakturu.")
    return [set_status(data, int(ch["id"]), "paid", ch.get("paid_date")) for ch in changes]


def store_pdf(data, iid, content):
    """Uloží PDF faktury do archivu (data/archiv/ROK/Faktura-ČÍSLO.pdf)."""
    inv = get_invoice(data, iid)
    if not content.startswith(b"%PDF"):
        raise ValueError("Soubor není PDF.")
    name = pdf_name(inv["number"], inv["issue_date"])
    path = ARCHIV / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    if inv["pdf_file"] and inv["pdf_file"] != name:
        (ARCHIV / inv["pdf_file"]).unlink(missing_ok=True)
    inv["pdf_file"] = name
    return name


def attach_original_pdf(data, iid, source):
    """Přiloží původní PDF převzaté faktury (zkopíruje ho do archivu)."""
    inv = get_invoice(data, iid)
    name = pdf_name(inv["number"], inv["issue_date"])
    path = ARCHIV / name
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, path)
    inv["pdf_file"] = name
    return name


def delete_invoice(data, iid):
    """Smaže fakturu z evidence. Její PDF se nemaže, jen přesune do data/smazane."""
    inv = get_invoice(data, iid)
    data["invoices"].remove(inv)
    if inv["pdf_file"]:
        _trash(inv["pdf_file"])


# ---------- příjmy bez faktury ----------

def list_incomes(data):
    return sorted(data["incomes"], key=lambda i: (i["date"], i["id"]), reverse=True)


def get_income(data, iid):
    return _find(data["incomes"], iid, "Příjem")


def save_income(data, values, iid=None):
    """Příjem, ke kterému jsi nevystavil fakturu (vyúčtování, honorář…).
    Do limitů se počítá podle data přijetí, stejně jako zaplacené faktury."""
    existing = get_income(data, iid) if iid is not None else None
    received = _date(values.get("date"), "Datum přijetí")
    amount = _decimal(values.get("amount") or 0, "Částka")
    if not amount.is_finite() or amount <= 0:
        raise ValueError("Částka musí být větší než nula.")
    payer = _text(values.get("payer"))
    if not payer:
        raise ValueError("Vyplň, od koho peníze přišly.")
    fields = {
        "date": received,
        "amount": _money(amount),
        "payer": payer,
        "description": _text(values.get("description")),
        "updated_at": _now(),
    }
    if existing:
        existing.update(fields)
        return existing
    income = {"id": _next_id(data["incomes"]), **fields, "doc_file": None, "created_at": _now()}
    data["incomes"].append(income)
    return income


def store_income_doc(data, iid, content):
    """Uloží doklad k příjmu (PDF, PNG, JPG) do archivu: data/archiv/ROK/Prijem-DATUM-PLÁTCE.pdf.
    Předchozí doklad se přesune do data/smazane."""
    income = get_income(data, iid)
    ext = next((e for magic, e in DOC_KINDS if content.startswith(magic)), None)
    if not ext:
        raise ValueError("Doklad musí být PDF, PNG nebo JPG.")
    payer = unicodedata.normalize("NFKD", income["payer"]).encode("ascii", "ignore").decode()
    safe = re.sub(r"[^\w.-]+", "-", payer, flags=re.ASCII).strip("-.")[:40]
    stem = f"{income['date'][:4]}/Prijem-{income['date']}-{safe or income['id']}"
    if any(i is not income and (i["doc_file"] or "").startswith(stem + ".") for i in data["incomes"]):
        stem += f"-{income['id']}"
    if income["doc_file"]:
        _trash(income["doc_file"])
    path = ARCHIV / (stem + ext)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    income["doc_file"] = stem + ext
    income["updated_at"] = _now()
    return income


def delete_income(data, iid):
    income = get_income(data, iid)
    data["incomes"].remove(income)
    if income["doc_file"]:
        _trash(income["doc_file"])


def _number_parts(number, year):
    """Rozloží číslo faktury na (před pořadím, pořadí, za pořadím).
    Pořadí je poslední skupina číslic za rokem (2026001 → '2026', '001', '')."""
    i = number.find(year)
    head, tail = (number[:i + 4], number[i + 4:]) if i >= 0 else ("", number)
    m = re.search(r"(\d+)(\D*)$", tail)
    if not m:
        return None
    return head + tail[:m.start()], m.group(1), m.group(2)


def next_number(data):
    """Navrhne další číslo faktury podle formátu dosavadních faktur.
    Řada s rokem v čísle začíná každý rok od 1, řada bez roku pokračuje dál."""
    year = str(date.today().year)
    rows = sorted(data["invoices"], key=lambda i: (i["issue_date"], i["id"]))
    best = None
    for r in rows:
        y = r["issue_date"][:4]
        parts = _number_parts(r["number"], y)
        if not parts or (y in r["number"] and y != year):
            continue
        if best is None or int(parts[1]) > int(best[1]):
            best = parts
    if best:
        head, seq, tail = best
        candidate = f"{head}{int(seq) + 1:0{len(seq)}d}{tail}"
    elif rows:
        last = rows[-1]
        y = last["issue_date"][:4]
        parts = _number_parts(last["number"], y)
        if parts and y in last["number"]:
            head, seq, tail = parts
            candidate = f"{head.replace(y, year)}{1:0{len(seq)}d}{tail}"
        else:
            candidate = f"{year}0001"
    else:
        candidate = f"{year}0001"

    taken = {r["number"] for r in rows}
    while candidate in taken:
        head, seq, tail = _number_parts(candidate, year) or ("", "0", "")
        candidate = f"{head}{int(seq) + 1:0{len(seq)}d}{tail}"
    return candidate
