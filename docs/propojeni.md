# Propojení aplikací – jak spolu aplikace mluví

**Faktury**, **Hodinovka** a další aplikace, které přibudou, o sobě na jednom Macu vědí a spolupracují.
Každá aplikace funguje i sama. Když jsou na Macu dvě, najdou se a propojí se bez nastavování.
Propojení nemá žádný vlastní název: pro uživatele jsou to prostě aplikace, které spolu spolupracují.

Tenhle soubor je stejný ve všech propojených aplikacích. Kdo píše novou aplikaci, řídí se jím.

## Co se nemusí instalovat

Nic. Sdílená složka a společný kód jsou součástí každé aplikace:

- Každá aplikace nese stejný soubor `propojeni.py`. Je jedno, kterou si člověk stáhne dřív.
- Složku `~/Library/Application Support/Propojené aplikace` vytvoří ta aplikace, která se spustí první.
- Když druhá aplikace na Macu chybí, první ji nabídne nainstalovat jedním kliknutím (Nastavení → Propojené aplikace, nebo rovnou tam, kde je potřeba, třeba „Nainstalovat Faktury“ u vyfakturování). Stáhne poslední vydání z GitHubu, dá ho do složky Aplikace a spustí.
- Každá aplikace se sama aktualizuje z GitHubu, a s ní i její kopie `propojeni.py`.

## Sdílená složka

```
~/Library/Application Support/Propojené aplikace/
  apps/<id>.json        manifest: kdo jsem, kde běžím, co umím a jak mě spustit
  contacts/<id>.json    moje kontakty (klienti) ve společném tvaru
  invoices/<id>.json    stav faktur, které vznikly z jiné aplikace (zveřejňují Faktury)
```

Do složky zapisuje každá aplikace jen svoje soubory. Ostatní je jen čtou, takže druhá aplikace kvůli tomu nemusí běžet.
Soubory se zapisují atomicky (dočasný soubor a přejmenování), a jen když se jejich obsah změnil.
Ostatní aplikace tak poznají změnu podle otisku souborů (`propojeni.signature`) a jejich otevřená okna se samo obnoví (živé obnovení v `docs/styl.md`).
Při testech a s testovacími daty se do skutečné složky nezapisuje. Jinou složku nastaví proměnná `PROPOJENI_DIR`.

### Manifest (`apps/<id>.json`)

Zapisuje ho server aplikace při každém spuštění:

```json
{
  "id": "faktury",
  "name": "Faktury",
  "version": "1.2.0",
  "protocol": 2,
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
], "deleted": [
  {"app": "hodinovka", "ref": "…", "number": "20260011", "deleted_at": "2026-10-14T21:37:00+02:00"}
]}
```

- `ready` říká, jestli mají Faktury vyplněné údaje dodavatele (jméno, IČO, účet).
- `status` je `issued`, `paid` nebo `cancelled`.
- `deleted` jsou faktury, které uživatel smazal (posledních 500). Aplikace, ze které faktura přišla, podle toho zruší svoje vyúčtování, takže je odpracovaný čas zase k vyfakturování. Když se k témuž `ref` vystaví faktura znovu, z `deleted` zmizí.
- Faktura, která v `items` jen chybí, ale v `deleted` není (třeba po přeinstalování Faktur), se nikde neruší. Aplikace ji jen ukáže jako chybějící.

## API (`/api/os`)

Každá aplikace má na svém lokálním serveru:

| Požadavek | Kdo | Co dělá |
|---|---|---|
| `GET /api/os` | všechny | `id`, `name`, `version`, `protocol`, `provides` (Faktury navíc `ready`) |
| `GET /api/os/contacts` | `contacts` | kontakty ve společném tvaru |
| `POST /api/os/invoices` | `invoices` | vystaví fakturu, viz níže |
| `POST /api/os/invoices/delete` | `invoices` | smaže fakturu, která z aplikace přišla, viz níže |

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

`POST /api/os/invoices/delete` (Faktury, od verze 1.4.0) s `{"app": "hodinovka", "ref": "<uid vyúčtování>"}`:

- Nezaplacenou fakturu smaže a odpoví `{"deleted": true, "number": "…"}`.
- Zaplacenou nesmaže (je to příjem) a odpoví `400` s vysvětlením. Smazat ji jde jen přímo ve Fakturách.
- Stornovanou nechá v evidenci i v číselné řadě a odpoví `{"deleted": false, "status": "cancelled"}`.
- Když faktura neexistuje (už je smazaná), odpoví `{"deleted": false, "status": null}`. Opakovaný požadavek tedy nic nerozbije.

Volající aplikace (`propojeni.call`) při nedostupném serveru spustí druhou aplikaci přes `launch` a zkusí to znovu.
Když je aplikace nainstalovaná, ale ještě nikdy neběžela (manifest chybí), otevře ji (`open -g`) a počká, až se zapíše do sdílené složky.

## Bezpečnost

- Servery poslouchají jen na `127.0.0.1` a kontrolují hlavičku `Host`, takže se k nim nedostane nikdo ze sítě ani přes DNS rebinding.
- Požadavky, které něco mění, s cizí hlavičkou `Origin` (z webové stránky) se odmítnou.
- Aplikace volají jedna druhou ze serveru, ne z prohlížeče.

## Nová aplikace

1. Zkopíruj `propojeni.py` (stejný soubor jako ve Fakturách a v Hodinovce) a přidej aplikaci do `CATALOG`, a to ve všech aplikacích.
   Stejně tak složku `static/aplikace/` s ikonami: přidej do ní ikonu nové aplikace (kopii jejího `static/icon.svg`) a zkopíruj ji do všech aplikací.
2. Server při spuštění zavolá `propojeni.announce(...)`, po každém uložení `propojeni.publish_contacts(...)` a před každým požadavkem levné srovnání kontaktů (`merge_contacts` při změně `signature`).
3. Zveřejněné seznamy čti přes `propojeni.read(kind)`, volání přes `propojeni.call(app, …)`.
4. Vyber volný port (Faktury 8765, Hodinovka 8766) a URL schéma podle `id`.
5. Vzhled podle `docs/styl.md`.

Když se protokol změní nekompatibilně, zvyš `PROTOCOL`. Starší aplikace pak nové funkce jen nenabídnou, nic nespadne.

Sdílená složka se už nepřejmenovává: aplikace s jinou složkou by se navzájem nenašly.
Do protokolu 1 byla jinde (`OLD_HOME` v `propojeni.py`). Aplikace s protokolem 2 ji při spuštění přesunou sem a na staré místo dají odkaz, přes který ji najdou starší verze ostatních aplikací. Odkaz smažou, až mají všechny nainstalované aplikace protokol 2.
