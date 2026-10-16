"""Připomínka daňového přiznání. Lhůta je daná zákonem a platí každý rok stejně:
do 1. 4., elektronicky do 1. 5. (OSVČ má datovou schránku, takže podává elektronicky).
Když konec lhůty připadne na víkend nebo svátek, posune se na nejbližší pracovní den."""
from datetime import date, timedelta

import db

# Státní svátky s pevným datem; Velký pátek a Velikonoční pondělí se počítají.
HOLIDAYS = ((1, 1), (5, 1), (5, 8), (7, 5), (7, 6), (9, 28), (10, 28), (11, 17), (12, 24), (12, 25), (12, 26))
SHOW_AFTER_DUE = 60  # neodkliknutá připomínka zmizí 60 dní po termínu


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
    """Konec lhůty: když připadne na víkend nebo svátek, je jím nejbližší další pracovní den."""
    while not is_workday(d):
        d += timedelta(days=1)
    return d


def deadline(year):
    """Lhůta pro daňové přiznání za rok `year`: (na papíře, elektronicky). Ve stejné lhůtě se platí daň."""
    return workday(date(year + 1, 4, 1)), workday(date(year + 1, 5, 1))


def _active(data, year):
    """Podnikal jsem v roce `year`? (Je v něm faktura nebo příjem bez faktury.)"""
    y = str(year)
    return any(inv["status"] != "cancelled" and (inv["issue_date"].startswith(y) or (inv.get("paid_date") or "").startswith(y))
               for inv in data["invoices"]) or any(i["date"].startswith(y) for i in data["incomes"])


def tax_return(data, today=None):
    """Připomínka přiznání za minulý rok. Je na řadě (season) od 1. 1. nejdéle 60 dní po termínu,
    a jen když uživatel v tom roce podnikal. Ukazuje se, dokud ji neodklikne (v nastavení tax_return_filed = rok);
    mimo tuhle dobu v Nastavení zaškrtávátko není."""
    today = today or date.today()
    year = today.year - 1
    paper, due = deadline(year)
    filed = db.get_settings(data)["tax_return_filed"] == year
    season = today <= due + timedelta(days=SHOW_AFTER_DUE) and _active(data, year)
    return {"year": year, "paper": paper.isoformat(), "due": due.isoformat(), "filed": filed,
            "season": season, "show": season and not filed}
