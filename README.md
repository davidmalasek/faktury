# Faktury

Jednoduchá fakturace pro neplátce DPH. Běží jen na tomhle Macu, bez předplatného a bez limitu kontaktů.

## Instalace a spuštění

```sh
./instalovat.sh
```

Skript vytvoří **Faktury.app** ve složce Aplikace. Pak ji spustíš přes Spotlight (⌘ mezerník → „Faktury“), Launchpad nebo Finder → Aplikace.
Otevře se v prohlížeči na adrese http://localhost:8765.

Faktury.app jen spustí `spustit.sh` z této složky. Když složku projektu přesuneš, spusť `./instalovat.sh` znovu.

Při prvním spuštění se macOS zeptá, jestli smí Faktury přistupovat ke složce Dokumenty a k iCloud Drive. Klikni na **Povolit**.
Když omylem zakážeš: Nastavení systému → Soukromí a zabezpečení → Soubory a složky → Faktury.

## Kde jsou data

| Cesta | Co obsahuje |
|---|---|
| `data/faktury.json` | faktury, kontakty, nastavení (čitelný text) |
| `data/archiv/ROK/` | PDF všech faktur a doklady k příjmům bez faktury |
| `data/zalohy/` | automatická záloha před první změnou každého dne (30 dní) a před každým importem |
| `data/smazane/` | PDF smazaných faktur a dokladů (nic se nemaže natrvalo) |
| iCloud Drive → `Faktury záloha` | kopie všeho výše, aktualizuje se po každé změně |

Složka `data` se do gitu záměrně neukládá, protože obsahuje osobní údaje klientů.
Stav zálohy do iCloudu je vidět v Nastavení. Z iCloudu se nic nemaže, kromě denních záloh starších než 30 dní.

**Obnovení:** zavři appku (`kill $(cat data/server.pid)`) a jedním z těchto způsobů vrať soubor `data/faktury.json`:
- zkopíruj na jeho místo vybraný soubor z `data/zalohy`,
- nebo celý obsah složky `Faktury záloha` z iCloud Drive zkopíruj do `data/`.

## Sociální pojištění (vedlejší činnost)

Přehled hlídá rozhodnou částku. Když zisk za rok dosáhne této částky, musíš platit sociální pojištění.
Zisk se počítá jako přijaté platby (včetně příjmů bez faktury) minus výdajový paušál a paušál se nastavuje v Nastavení.
Částky jsou v `static/app.js` v konstantě `SOCIAL_LIMITS` a každý rok je potřeba doplnit novou hodnotu (2026: 117 521 Kč).

## Příjmy bez faktury

Peníze, které ti přišly bez vystavené faktury (třeba vyúčtování od pořadatele), zapíšeš přes Faktury → **Příjem bez faktury**.
Vyplníš datum přijetí, částku a od koho peníze přišly. Volitelně přiložíš doklad (PDF, PNG nebo JPG).
Takový příjem se nepočítá do číselné řady faktur, ale započítá se do limitu pro sociální pojištění i do obratu pro DPH.
V Přehledu je vidět v tabulce za daný rok a kliknutím ho upravíš nebo smažeš.

## Pro vývoj

```sh
python3 server.py --open                  # ruční spuštění
python3 -m unittest discover tests        # testy
python3 import_data.py soubor.json --zkouska   # import starých dat (formát popsán v souboru)
```

Bez závislostí: Python 3 ze systému nebo z Homebrew a knihovna pdfmake (přibalená ve `static/vendor`).
Testovací data: `FAKTURY_DATA=/jina/slozka FAKTURY_PORT=8799 python3 server.py`. Do iCloudu se zálohují, jen když nastavíš `FAKTURY_ICLOUD`.
