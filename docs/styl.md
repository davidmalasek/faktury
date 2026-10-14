# Styl aplikací MejvOS

Společný vzhled i technika všech aplikací systému (Faktury, Hodinovka a další). Nová aplikace má vypadat a fungovat tak, aby se nedala poznat od ostatních.
Tenhle soubor je stejný ve všech repozitářích.

## Zásady

- **Jednoduše, jako od Applu.** Málo prvků, hodně vzduchu, žádné zbytečné rámečky ani barvy. Každá obrazovka má jeden hlavní úkol a jedno hlavní (modré) tlačítko.
- **Žádné přehlcení čísly.** Přehled = 4 karty s čísly nahoře, pod nimi nejvýš pár grafů a tabulek. Detaily až po kliknutí.
- **Nic nesmí spadnout.** Neplatný vstup hlásí srozumitelnou větou (toast), při chybě se neuloží nic, data se zálohují. Co jde odvodit, appka předvyplní, ale uživatel to vždycky může přepsat.
- **Česky a lidsky.** Tykání, krátké věty, žádný technický žargon („Server Faktur neběží – stiskni ⌘R“). Správné tvary čísel (1 záznam, 2 záznamy, 5 záznamů), pevná mezera v částkách (`12 500 Kč`), datum `14. 10. 2026`.
- **Data jsou u uživatele.** Žádný účet ani cloud. Data v čitelném JSON, denní zálohy, kopie do iCloud Drive.

## Vzhled

Všechno je v `static/app.css`. Novou aplikaci začni kopií z Faktur a jen přidávej.

**Barvy** (CSS proměnné, světlý i tmavý režim podle systému):

| Proměnná | Světlý | Tmavý | Použití |
|---|---|---|---|
| `--bg` | `#f5f5f7` | `#000000` | pozadí stránky |
| `--card` | `#ffffff` | `#1c1c1e` | karty, tabulky, dialogy |
| `--text` / `--muted` / `--faint` | `#1d1d1f` / `#6e6e73` / `#a1a1a6` | `#f5f5f7` / `#98989d` / `#6e6e73` | text, popisky, zástupný text |
| `--accent` | `#0071e3` | `#0a84ff` | hlavní tlačítko, odkazy, fokus |
| `--good-text` / `--bad-text` / `--warn` | zelená / červená / oranžová | | stavy (vždy s textem, nikdy jen barva) |
| `--fill` | šedá 12 % | 24 % | sekundární tlačítka, segmenty |
| `--viz` | `#2a78d6` | `#3987e5` | grafy (jeden odstín) |

**Písmo:** systémové (`-apple-system`, SF Pro), 15 px, mírně stažené (`letter-spacing: -0.01em`). Nadpis stránky 28 px / 600, nadpis karty 17 px / 600, popisky 13 px šedé. Čísla v tabulkách `tabular-nums`.

**Tvary:** karty `border-radius: 16px` a místo rámečku jemný stín (`--shadow`), tlačítka a pole 10 px, segmentový přepínač 9 px. Odsazení karet 22 px, mezery 16 px. Obsah má šířku nejvýš 1120 px.

**Pohyb:** krátké a tlumené (`cubic-bezier(0.2, 0.8, 0.2, 1)`, 0,15–0,3 s): stránka najede o 6 px, dialog se zvětší z 96 %, sloupce grafu vyrostou. Při `prefers-reduced-motion` se nehýbe nic.

**Ikona aplikace:** zaoblený čtverec s jemným svislým přechodem a bílým symbolem uprostřed, mřížka macOS (čtverec 824 px v plátně 1024 px, stín pod ním). Každá aplikace má svou barvu: Faktury modrá (`#3a9bff → #0066dd`), Hodinovka oranžová (`#ffb340 → #ff7a00`).

## Prvky

- **Horní lišta:** průsvitná (`backdrop-filter: blur`), vlevo ikona a název, vedle navigace jako pilulky (aktivní má šedé pozadí).
- **Hlavička stránky:** `h1` vlevo, akce vpravo (`.page-head`, `.actions`), nad ní odkaz zpět `‹ Seznam`.
- **Tlačítka:** `.btn` (šedé), `.btn.primary` (modré, jedno na obrazovku), `.btn.ghost` (jen text), `.danger` (červený text). Při čekání se tlačítko zablokuje a po 150 ms ukáže kolečko (`attempt()`).
- **Karty s čísly:** `.kpis` se 4 `.kpi` (popisek, velké číslo, šedý dovětek). Klikací karta vede na filtrovaný seznam.
- **Tabulky:** `.table-card` > `table.list`, šedé hlavičky 12 px, celý řádek je klikací (`data-href`), čísla vpravo. Na mobilu se méně důležité sloupce schovají (`.hide-sm`).
- **Hromadné akce:** zaškrtávací políčka a plovoucí lišta dole uprostřed (`.bulkbar`).
- **Filtry:** `.toolbar` se segmentovým přepínačem (`.segmented`), výběrem a hledáním.
- **Stavy:** tečka + text (`.status.paid`, `.overdue`, `.cancelled`).
- **Formuláře:** mřížka o 6 sloupcích (`.grid`, `.c1`–`.c6`), popisek nad polem, nápověda pod ním (`.hint`). Neuložené změny hlídá `leaveGuard`.
- **Upozornění:** `.notice` (oranžové), `.notice.info` (šedé), `.notice.bad` (červené). Krátká potvrzení přes toast dole.
- **Dialogy:** `<dialog>` se zaoblením 18 px a průhledným pozadím. Potvrzení přes `confirm()` (v aplikaci z toho je nativní sheet macOS): „Otázka?\n\nPodrobnosti“.
- **Grafy:** bez knihoven (`static/charts.js`): sloupce po měsících/dnech s popiskem maxima a tooltipem, vodorovné pruhy pro žebříčky. Jeden odstín modré.

## Technika

- **Backend:** Python 3.9+ jen se standardní knihovnou. `server.py` (HTTP server na `127.0.0.1`, kontrola `Host` a `Origin`), `db.py` (jeden JSON soubor, zámek, atomický zápis, denní zálohy, kopie do iCloud Drive), `update.py` (aktualizace z GitHub Releases).
- **Frontend:** čisté HTML, CSS a JavaScript bez buildu a bez závislostí. Jedna stránka s routerem v `location.hash` (`#/cas`, `#/faktura/12`).
- **Okno pro macOS:** malý program ve Swiftu (`macos/<Nazev>.swift`, AppKit + WebKit), který spustí server (`spustit.sh`) a ukáže ho ve vlastním okně. Nativní dialogy, ukládání souborů, zoom ⌘+ / ⌘−, odkazy `<id>://cesta`.
- **Instalace:** `<Nazev>.zip` z GitHub Releases. Aplikace si při prvním spuštění zkopíruje kód do `~/Library/Application Support/<Nazev>` a když na Macu není Python, stáhne vlastní.
- **Aktualizace:** při každém otevření se podívá na GitHub, nová verze se sama stáhne a nainstaluje (data se předtím zazálohují). Vydání = zvýšit `VERSION` a pushnout do `main`, GitHub Actions udělají zbytek.
- **Živé obnovení:** stránka se každé 2 s (a při návratu do okna) zeptá na `GET /api/rev`, otisk dat a toho, co zveřejnily ostatní aplikace (`db.revision()`). Když se změnil, překreslí se (`router(false)`, pozice i hledání zůstanou). Nikdy pod rukama: ne během požadavku, s otevřeným dialogem, vybranými řádky, rozepsaným textem ani neuloženými změnami. Odpovědi na změny posílají hlavičku `X-Rev`, takže vlastní změnu stránka znovu nenačítá.
- **Propojení:** `mejvos.py` a `docs/mejvos.md`.
- **Testy:** `python3 -m unittest discover tests` (data, server, aktualizace, propojení).
