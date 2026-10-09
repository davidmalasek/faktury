#!/usr/bin/env python3
"""Import starých faktur a kontaktů z JSON souboru.

    python3 import_data.py soubor.json            # import
    python3 import_data.py soubor.json --zkouska  # jen ukáže, co by se stalo

Formát souboru:
{
  "settings": {"name": "...", ...},                       # nepovinné – doplní prázdná pole v Nastavení
  "contacts": [{"name": "...", "ico": "...", ...}],
  "invoices": [{
      "number": "20260001", "issue_date": "2026-03-09", "due_date": "2026-03-23",
      "customer": {"name": "...", "ico": "...", "street": "...", "city": "...", "zip": "..."},
      "supplier": {...},                                  # nepovinné – jinak z Nastavení
      "items": [{"description": "...", "quantity": 1, "unit": "", "price": 1000}],
      "total": 1000,                                      # kontrola proti součtu položek
      "status": "issued" | "paid", "paid_date": "...",    # nepovinné
      "pdf": "cesta/k/puvodni.pdf"                        # nepovinné – původní PDF faktury
  }]
}

Nic se nepřepisuje: existující kontakty (stejné IČO / název) a faktury (stejné číslo) se přeskočí.
Před importem se udělá záloha do data/zalohy. Když cokoli selže, neuloží se nic.
"""
import json
import sys
from pathlib import Path

import db


class DryRun(Exception):
    pass


def run(source, dry_run=False):
    spec = json.loads(Path(source).read_text(encoding="utf-8"))
    base = Path(source).resolve().parent
    log = []

    db.init()
    if not dry_run:
        log.append(f"Záloha před importem: {db.backup_now('pred-importem').name}")
    try:
        with db.open_data(write=True) as data:
            if spec.get("settings"):
                current = db.get_settings(data)
                missing = {k: v for k, v in spec["settings"].items() if not current.get(k)}
                if missing:
                    db.save_settings(data, missing)
                    log.append(f"Nastavení: doplněno {', '.join(missing)}")

            for c in spec.get("contacts", []):
                if db.find_contact(data, c):
                    log.append(f"Kontakt už existuje, přeskakuji: {c['name']}")
                else:
                    db.save_contact(data, c)
                    log.append(f"Kontakt přidán: {c['name']}")

            for inv in spec.get("invoices", []):
                if any(i["number"] == inv["number"] for i in data["invoices"]):
                    log.append(f"Faktura {inv['number']} už existuje, přeskakuji")
                    continue
                pdf = (base / inv["pdf"]) if inv.get("pdf") else None
                if pdf and not pdf.is_file():
                    raise ValueError(f"Faktura {inv['number']}: PDF {pdf} neexistuje.")
                contact_id = db.find_contact(data, inv["customer"])
                saved = db.save_invoice(data, {**inv, "contact_id": contact_id,
                                               "save_contact": True, "imported": True})
                if "total" in inv and abs(saved["total"] - float(inv["total"])) > 0.005:
                    raise ValueError(f"Faktura {inv['number']}: součet položek {saved['total']} "
                                     f"nesedí s částkou {inv['total']}.")
                if pdf and not dry_run:
                    db.attach_original_pdf(data, saved["id"], pdf)
                log.append(f"Faktura {saved['number']} převzata: {saved['customer']['name']}, "
                           f"{saved['total']:.2f} Kč" + (" + původní PDF" if pdf else ""))
            if dry_run:
                raise DryRun
    except DryRun:
        log.append("ZKOUŠKA – nic nebylo uloženo.")
    return log


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for line in run(sys.argv[1], dry_run="--zkouska" in sys.argv):
        print(line)
