"""Daně a pojištění: sazby a limity podle roku a termíny pro úřady.

Sazby a limity jsou v souboru limity.json, který je součástí aplikace. Když vyjdou nové (třeba rozhodná
částka na další rok), stačí je doplnit do limity.json v main na GitHubu: appka si je sama stáhne
a nemusí čekat na novou verzi. Termíny (daňové přiznání, přehledy pro ČSSZ a zdravotní pojišťovnu)
se počítají ze zákonných lhůt, a co uživatel odklikne, uloží se do nastavení (settings.done)."""
import calendar
import json
import os
import re
import threading
import time
import urllib.request
from datetime import date, timedelta

import db
from update import REPO

BUNDLED = db.ROOT / "limity.json"
URL = f"https://raw.githubusercontent.com/{REPO}/main/limity.json"
CHECK_EVERY = 6 * 3600  # GitHub se ptáme nejvýš jednou za 6 hodin
NUMBERS = ("social_limit", "tax_rate", "tax_credit", "student_credit", "health_rate", "social_rate",
           "social_base", "vat_limit", "vat_limit_now")
EXPENSE_RATES = ("80", "60", "40")

# Státní svátky s pevným datem; Velký pátek a Velikonoční pondělí se počítají.
HOLIDAYS = ((1, 1), (5, 1), (5, 8), (7, 5), (7, 6), (9, 28), (10, 28), (11, 17), (12, 24), (12, 25), (12, 26))
KINDS = ("dp", "cssz", "zp", "limity")
SKIP = "nepodavam"  # daňové přiznání nepodávám (příjmy do 50 000 Kč)
SHOW_AFTER_DUE = 60  # neodkliknutý termín zmizí 60 dní po lhůtě


# ---------- sazby a limity ----------

def validate(table):
    """Zkontroluje tabulku limitů, ať ani rozbitý soubor z GitHubu nic nerozbije. Vrátí ji, nebo vyhodí ValueError."""
    if not isinstance(table, dict) or not isinstance(table.get("years"), dict) or not table["years"]:
        raise ValueError("Tabulka limitů nemá žádný rok.")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(table.get("updated", ""))):
        raise ValueError("Tabulka limitů nemá datum aktualizace.")
    for year, row in table["years"].items():
        if not re.fullmatch(r"\d{4}", year) or not isinstance(row, dict):
            raise ValueError(f"Tabulka limitů: neplatný rok {year}.")
        caps = row.get("expense_caps")
        values = [row.get(k) for k in NUMBERS] + [caps.get(r) if isinstance(caps, dict) else None for r in EXPENSE_RATES]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 for v in values):
            raise ValueError(f"Tabulka limitů: v roce {year} chybí některá částka.")
    return table


def _read(path):
    try:
        return validate(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def cache_file():
    return db.DATA / "limity.json"


def table():
    """Platná tabulka limitů: přibalená k aplikaci, nebo stažená z GitHubu, když je novější."""
    bundled, cached = _read(BUNDLED), _read(cache_file())
    if cached and (not bundled or cached["updated"] > bundled["updated"]):
        return cached
    if not bundled:
        raise RuntimeError("Soubor limity.json chybí nebo je poškozený. Stáhni si Faktury znovu.")
    return bundled


def refresh():
    """Stáhne limity z GitHubu. Novější uloží do data/limity.json a vrátí True.
    Bez internetu, nebo když je soubor na GitHubu rozbitý, zůstanou dosavadní."""
    req = urllib.request.Request(URL, headers={"User-Agent": "Faktury", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            remote = validate(json.loads(r.read(1_000_000)))
    except (OSError, ValueError):
        return False
    if remote["updated"] <= table()["updated"]:
        return False
    target = cache_file()
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(remote, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, target)
    return True


def start_refresh():
    """Na pozadí se podívá po nových limitech hned po spuštění a pak každých 6 hodin."""
    def run():
        while True:
            refresh()
            time.sleep(CHECK_EVERY)
    threading.Thread(target=run, daemon=True, name="limity").start()


# ---------- pracovní dny ----------

def easter(year):
    """Velikonoční neděle (gregoriánský kalendář)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)


def is_workday(d):
    if d.weekday() >= 5 or (d.month, d.day) in HOLIDAYS:
        return False
    sunday = easter(d.year)
    return d not in (sunday - timedelta(days=2), sunday + timedelta(days=1))


def workday(d):
    """Když konec lhůty připadne na víkend nebo svátek, je jím nejbližší další pracovní den."""
    while not is_workday(d):
        d += timedelta(days=1)
    return d


def month_later(d):
    """Konec lhůty „do 1 měsíce“: stejný den dalšího měsíce (nebo poslední den, když tam takový není)."""
    year, month = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


# ---------- termíny ----------

def deadlines(year):
    """Lhůty za zdaňovací období `year`.
    Přiznání se podává do 3 měsíců, elektronicky o měsíc déle (OSVČ má datovou schránku, takže elektronicky musí).
    Přehledy pro ČSSZ a pojišťovnu do měsíce po lhůtě pro přiznání: když je přiznání podané do 1. 4., platí
    ta dřívější. Kdo přiznání podávat nemusí, podá přehled pojišťovně do 8. 4."""
    base = workday(date(year + 1, 4, 1))
    extended = workday(date(year + 1, 5, 1))
    return {
        "dp_base": base,
        "dp": extended,
        "review_base": workday(month_later(base)),
        "review": workday(month_later(extended)),
        "zp_no_dp": workday(date(year + 1, 4, 8)),
    }


def done_map(data):
    return data.setdefault("settings", {}).setdefault("done", {})


def set_done(data, key, value, today=None):
    """Odklikne (nebo vrátí) připomínku: value = datum podání, „nepodavam“ u přiznání, nebo None."""
    today = today or date.today()
    m = re.fullmatch(r"(dp|cssz|zp|limity)-(\d{4})", str(key or ""))
    if not m:
        raise ValueError("Neznámá připomínka.")
    done = done_map(data)
    if value in (None, ""):
        done.pop(key, None)
        return
    if value == SKIP:
        if m.group(1) != "dp":
            raise ValueError("Přehledy pro ČSSZ a pojišťovnu se podávají vždycky.")
    else:
        try:
            when = date.fromisoformat(str(value))
        except ValueError:
            raise ValueError("Neplatné datum podání.") from None
        if when > today:
            raise ValueError("Datum podání nemůže být v budoucnu.")
        value = when.isoformat()
    done[key] = value


def _active(data, year):
    """Podnikal jsem v roce `year`? (Je v něm faktura nebo příjem bez faktury.)"""
    y = str(year)
    return any(inv["status"] != "cancelled" and (inv["issue_date"].startswith(y) or (inv.get("paid_date") or "").startswith(y))
               for inv in data["invoices"]) or any(i["date"].startswith(y) for i in data["incomes"])


def reminders(data, today=None):
    """Co je potřeba podat na úřady za minulý rok. Ukazuje se od 1. 1., dokud to uživatel neodklikne,
    nejdéle 60 dní po termínu. Po podání přehledu ještě 8 dní připomíná doplatek pojistného."""
    today = today or date.today()
    year = today.year - 1
    if not _active(data, year):
        return {"year": year, "show": False, "items": []}
    t = deadlines(year)
    done = done_map(data)
    dp = done.get(f"dp-{year}")
    if dp == SKIP:
        cssz_due, zp_due = t["review_base"], t["zp_no_dp"]
    elif (dp and dp <= t["dp_base"].isoformat()) or (not dp and today <= t["dp_base"]):
        cssz_due = zp_due = t["review_base"]
    else:
        cssz_due = zp_due = t["review"]
    # Přiznání ještě není podané a do 1. 4. je čas: přehledy pak stačí podat až v pozdější lhůtě.
    later = t["review"] if not dp and today <= t["dp_base"] else None

    items = []
    for kind, label, office, due in (
        ("dp", "Daňové přiznání", "finanční úřad", t["dp"]),
        ("cssz", "Přehled pro ČSSZ", "správa sociálního zabezpečení", cssz_due),
        ("zp", "Přehled pro zdravotní pojišťovnu", "zdravotní pojišťovna", zp_due),
    ):
        value = done.get(f"{kind}-{year}")
        if kind == "dp":
            pay_by = t["dp"]  # daň se platí ve lhůtě pro přiznání
        elif value:
            pay_by = workday(date.fromisoformat(value) + timedelta(days=8))  # doplatek do 8 dnů od podání
        else:
            pay_by = None
        items.append({"key": f"{kind}-{year}", "kind": kind, "label": label, "office": office,
                      "due": due.isoformat(), "done": value, "pay_by": pay_by and pay_by.isoformat(),
                      "later": later.isoformat() if later and kind != "dp" else None})
    pending = any(not i["done"] and today <= date.fromisoformat(i["due"]) + timedelta(days=SHOW_AFTER_DUE) for i in items)
    paying = any(i["done"] and i["kind"] != "dp" and today <= date.fromisoformat(i["pay_by"]) for i in items)
    return {"year": year, "show": pending or paying, "dp_base": t["dp_base"].isoformat(),
            "zp_no_dp": t["zp_no_dp"].isoformat(), "items": items}
