# Faktury pro vývojáře

Jak Faktury fungují uvnitř a jak na nich pracovat. Pro běžné používání stačí [README](../README.md).

## Vývojová instalace

Vývojová instalace běží přímo ze složky projektu a data má v její podsložce `data`.
Potřebuje Python 3.9+ a vývojářské nástroje od Applu (`xcode-select --install`), ze kterých se sestaví okno aplikace:

```sh
git clone https://github.com/davidmalasek/faktury && cd faktury
./instalovat.sh                           # sestaví Faktury.app do Aplikací (spouští Faktury z této složky)
python3 server.py --open                  # ruční spuštění v prohlížeči
python3 -m unittest discover tests        # testy
python3 import_data.py soubor.json --zkouska   # import starých faktur i s PDF (formát popsán v souboru)
```

Bez závislostí: backend na standardní knihovně Pythonu a frontend v čistém JavaScriptu.
PDF vytváří knihovna pdfmake, přibalená ve `static/vendor`.
Testovací data: `FAKTURY_DATA=/jina/slozka FAKTURY_PORT=8799 python3 server.py`. Do iCloudu se zálohují, jen když nastavíš `FAKTURY_ICLOUD`, a do sdílené složky propojených aplikací se zapíšou, jen když nastavíš `PROPOJENI_DIR`.

Vzhled, technika i texty jsou společné pro všechny propojené aplikace a popisuje je [styl.md](styl.md).
Propojení s Hodinovkou a dalšími aplikacemi popisuje [propojeni.md](propojeni.md) a obstarává ho `propojeni.py`. Ten soubor je stejný ve všech aplikacích, takže když ho měníš, změň ho i v Hodinovce.

## Okno aplikace

Okno je v `macos/Faktury.swift` (AppKit a WebKit) a sestavuje ho `macos/sestavit.sh`, a to ve dvou podobách.
Vývojová podoba (`instalovat.sh`) spouští Faktury ze složky projektu. Podoba ke stažení (`Faktury.zip` z GitHub Actions) nese kód v sobě a při spuštění ho nakopíruje do `~/Library/Application Support/Faktury`.
Použije Python 3.9+, který na Macu už je (Homebrew, vývojářské nástroje od Applu). Když žádný není, stáhne si do stejné složky Python z [python-build-standalone](https://github.com/astral-sh/python-build-standalone) (asi 25 MB, verze a kontrolní součty jsou v `spustit.sh`).
Po změně `macos/` nebo přesunutí složky projektu spusť `./instalovat.sh` znovu.

Server běží na pozadí i po zavření okna, takže další otevření je hned. Dokud běží, appka funguje i v prohlížeči na adrese http://localhost:8765.
Poslouchá jen na `127.0.0.1`, takže se k ní nedostane nikdo jiný ze sítě. Ven jde jen dotaz do registru ARES a na GitHub kvůli aktualizacím.

## Data

Data jsou ve složce `~/Library/Application Support/Faktury/data` (ve vývojové instalaci ve složce `data` projektu). Přesnou cestu ukazuje Nastavení.

| Cesta | Co obsahuje |
|---|---|
| `data/faktury.json` | faktury, kontakty, nastavení (čitelný text) |
| `data/archiv/ROK/` | PDF všech faktur a doklady k příjmům bez faktury |
| `data/zalohy/` | automatická záloha před první změnou každého dne (30 dní) a před každým importem a aktualizací |
| `data/smazane/` | PDF smazaných faktur a dokladů (nic se nemaže natrvalo) |
| iCloud Drive → `Faktury záloha` | kopie všeho výše, aktualizuje se po každé změně |
| `~/Library/Application Support/Propojené aplikace` | co si Faktury a Hodinovka navzájem ukazují (kontakty, stav faktur z Hodinovky) |

Složka `data` se do gitu záměrně neukládá, protože obsahuje osobní údaje klientů.
Z iCloudu se nic nemaže, kromě denních záloh starších než 30 dní.

**Obnovení ze zálohy:** zavři okno Faktur, vypni server (v Terminálu `kill $(cat ~/Library/Application\ Support/Faktury/data/server.pid)`) a jedním z těchto způsobů vrať soubor `data/faktury.json`:
- zkopíruj na jeho místo vybraný soubor z `data/zalohy`,
- nebo celý obsah složky `Faktury záloha` z iCloud Drive zkopíruj do `data/`.

## Aktualizace a vydání

Faktury se při každém otevření podívají na GitHub, jestli nevyšla nová verze, a samy ji nainstalují. Před aktualizací se data zazálohují a data aktualizace nikdy nepřepíše. Soubory, které v nové verzi už nejsou, aktualizace smaže.
Aktualizace mění jen soubory ve složce Faktur, ne samotnou aplikaci, takže se macOS na nic znovu neptá.
Výjimečně se změní i okno aplikace. Pak se stáhne nová Faktury.app a appku je potřeba zavřít a otevřít. macOS se potom může jednou znovu zeptat na iCloud Drive.

**Vydání nové verze:** zvyš číslo v souboru `VERSION` (třeba z `1.0.0` na `1.1.0`) a pushni do `main`.
Když projdou testy a zkouška aplikace na macOS, GitHub Actions vytvoří vydání `v1.1.0` s `Faktury.zip` a seznamem commitů od minulé verze. Ostatním se pak nová verze nainstaluje při dalším otevření Faktur.
Commity bez změny `VERSION` se nikomu neinstalují.
Ve vývojové kopii z gitu se aktualizace neinstalují, aby nepřepsaly rozdělanou práci.

## Každý rok

Jak se počítá daň a pojištění, popisuje [dane.md](dane.md). Sazby a limity jsou na začátku `static/app.js` a je potřeba je každý rok zkontrolovat:
- doplnit rozhodnou částku pro sociální pojištění do `SOCIAL_LIMITS` (zveřejňuje se na podzim předchozího roku: 2,4násobek průměrné mzdy zaokrouhlený nahoru, 2027: 123 992 Kč),
- od roku 2027 se má vrátit sleva na studenta 4 020 Kč. Až bude platit, je potřeba ji přičíst k `TAX_CREDIT`.

Hranice upozornění na limity (75 % a 90 %) jsou v `static/charts.js` (`LIMIT_WARN`, `LIMIT_BAD`).
