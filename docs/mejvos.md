# MejvOS – jak spolu aplikace mluví

MejvOS je skupina malých aplikací pro Mac, které o sobě vědí a spolupracují: **Faktury**, **Hodinovka** a další, které přibudou.
Každá aplikace funguje i sama. Když jsou na Macu dvě, najdou se a propojí se bez nastavování.

Tenhle soubor je stejný ve všech repozitářích systému. Kdo píše novou aplikaci, řídí se jím.

## Co se nemusí instalovat

Nic. Sdílená složka a společný kód jsou součástí každé aplikace:

- Každá aplikace nese stejný soubor `mejvos.py`. Je jedno, kterou si člověk stáhne dřív.
- Složku `~/Library/Application Support/MejvOS` vytvoří ta aplikace, která se spustí první.
- Když druhá aplikace na Macu chybí, první ji nabídne nainstalovat jedním kliknutím (Nastavení → Propojené aplikace, nebo rovnou tam, kde je potřeba, třeba „Nainstalovat Faktury“ u vyfakturování). Stáhne poslední vydání z GitHubu, dá ho do složky Aplikace a spustí.
- Každá aplikace se sama aktualizuje z GitHubu, a s ní i její kopie `mejvos.py`.

## Sdílená složka

```
~/Library/Application Support/MejvOS/
  apps/<id>.json        manifest: kdo jsem, kde běžím, co umím a jak mě spustit
  contacts/<id>.json    moje kontakty (klienti) ve společném tvaru
  invoices/<id>.json    stav faktur, které vznikly z jiné aplikace (zveřejňují Faktury)
```

Do složky zapisuje každá aplikace jen svoje soubory. Ostatní je jen čtou, takže druhá aplikace kvůli tomu nemusí běžet.
Soubory se zapisují atomicky (dočasný soubor a přejmenování).
Při testech a s testovacími daty se do skutečné složky nezapisuje. Jinou složku nastaví proměnná `MEJVOS_DIR`.

### Manifest (`apps/<id>.json`)

Zapisuje ho server aplikace při každém spuštění:

```json
{
  "id": "faktury",
  "name": "Faktury",
  "version": "1.2.0",
  "protocol": 1,
  "url": "http://localhost:8765",
  "api": "http://localhost:8765/api/os",
  "scheme": "faktury",
  "bundle": "local.faktury",
  "provides": ["contacts", "invoices"],
  "launch": {"command": ["/bin/bash", "…/Faktury/spustit.sh"], "env": {"FAKTURY_APP": "/Applications/Faktury.app"}},
  "pid": 1234,
  "updated_at": "2026-10-14T21:37:00+02:00"
}
```

- Když soubor ze `launch.command` zmizel, aplikace byla odinstalovaná a ostatní ji přeskočí.
- `launch` spustí jen server na pozadí, bez okna (použije se, když druhá aplikace potřebuje něco udělat a server zrovna neběží).
- `scheme` je URL schéma okna aplikace: `faktury://faktura/12` otevře okno Faktur na stránce `#/faktura/12`.

### Kontakty (`contacts/<id>.json`)

```json
{"app": "hodinovka", "updated_at": "…", "items": [
  {"uid": "…", "name": "Kavárna U Mlýna", "ico": "", "dic": "", "street": "", "city": "", "zip": "", "country": "", "email": "", "updated_at": "…"}
]}
```

- Každý kontakt má `uid` (UUID). Podle něj se pozná stejný klient ve všech aplikacích.
- Když si aplikace převezme kontakt od jiné (uživatel ho vybere), uloží si ho **se stejným uid**. Od té chvíle jsou propojené.
- Propojené kontakty se srovnávají samy: aplikace převezme novější údaje (podle `updated_at`). Přenáší se jen vyplněné hodnoty, takže jiná aplikace nikdy nic nesmaže, a smazání kontaktu se nepřenáší.
- Kontakty, které aplikace ještě nemá (podle uid, IČO i přesného názvu), nabízí uživateli při výběru klienta nebo odběratele.
- Jen jméno je povinné. Klient z Hodinovky nemusí mít IČO ani adresu.

### Faktury (`invoices/<id>.json`)

Faktury zveřejňují stav faktur, které vznikly z jiné aplikace:

```json
{"app": "faktury", "ready": true, "items": [
  {"app": "hodinovka", "ref": "…", "id": 12, "number": "20260012", "status": "issued", "issue_date": "…", "due_date": "…", "paid_date": null, "total": 9843.0}
]}
```

- `ready` říká, jestli mají Faktury vyplněné údaje dodavatele (jméno, IČO, účet).
- `status` je `issued`, `paid` nebo `cancelled`. Když faktura se svým `ref` v seznamu chybí, byla smazaná.

## API (`/api/os`)

Každá aplikace má na svém lokálním serveru:

| Požadavek | Kdo | Co dělá |
|---|---|---|
| `GET /api/os` | všechny | `id`, `name`, `version`, `protocol`, `provides` (Faktury navíc `ready`) |
| `GET /api/os/contacts` | `contacts` | kontakty ve společném tvaru |
| `POST /api/os/invoices` | `invoices` | vystaví fakturu, viz níže |

`POST /api/os/invoices` (Faktury):

```json
{
  "customer": {"uid": "…", "name": "Kavárna U Mlýna", "ico": "…", "street": "…", "city": "…", "zip": "…"},
  "items": [{"description": "Web kavárny", "quantity": 11.58, "unit": "hod", "price": 850}],
  "note": "Období: 28. 9. – 14. 10. 2026",
  "source": {"app": "hodinovka", "name": "Hodinovka", "ref": "<uid vyúčtování>", "link": "hodinovka://vyuctovani/<uid>"}
}
```

- Číslo faktury, datum vystavení, splatnost a údaje dodavatele doplní Faktury samy (`issue_date` a `due_date` jde poslat).
- **Stejné `source.app` + `source.ref` vrátí už vystavenou fakturu**, takže opakovaný požadavek (třeba po výpadku) nikdy nevytvoří fakturu dvakrát.
- Odběratel se propojí s kontaktem podle `uid`, pak podle IČO nebo názvu. Když žádný není, uloží se jako nový kontakt (se stejným uid). Poslané údaje mají přednost, chybějící doplní kontakt. Fakturovat jde tedy i na jinou firmu než obvykle.
- Odpověď: `201` a `{"id", "number", "status", "total", "issue_date", "due_date"}`. Chyba: `400` a `{"error": "text pro uživatele"}`.

Volající aplikace (`mejvos.call`) při nedostupném serveru spustí druhou aplikaci přes `launch` a zkusí to znovu.
Když je aplikace nainstalovaná, ale ještě nikdy neběžela (manifest chybí), otevře ji (`open -g`) a počká, až se přihlásí.

## Bezpečnost

- Servery poslouchají jen na `127.0.0.1` a kontrolují hlavičku `Host`, takže se k nim nedostane nikdo ze sítě ani přes DNS rebinding.
- Požadavky, které něco mění, s cizí hlavičkou `Origin` (z webové stránky) se odmítnou.
- Aplikace volají jedna druhou ze serveru, ne z prohlížeče.

## Nová aplikace

1. Zkopíruj `mejvos.py` (stejný soubor jako ve Fakturách a v Hodinovce) a přidej aplikaci do `CATALOG`, a to ve všech aplikacích.
2. Server při spuštění zavolá `mejvos.announce(...)`, po každém uložení `mejvos.publish_contacts(...)` a před každým požadavkem levné srovnání kontaktů (`merge_contacts` při změně `signature`).
3. Zveřejněné seznamy čti přes `mejvos.read(kind)`, volání přes `mejvos.call(app, …)`.
4. Vyber volný port (Faktury 8765, Hodinovka 8766) a URL schéma podle `id`.
5. Vzhled podle `docs/styl.md`.

Když se protokol změní nekompatibilně, zvyš `PROTOCOL`. Starší aplikace pak nové funkce jen nenabídnou, nic nespadne.

Název systému je v `mejvos.py` (`NAME`). Podle něj se jmenuje i sdílená složka, takže se už nemění: aplikace s jiným názvem by se navzájem nenašly.
