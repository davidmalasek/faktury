<p align="center">
  <img src="static/icon.svg" width="112" alt="Ikona aplikace Faktury">
</p>

<h1 align="center">Faktury</h1>

<p align="center">
  Jednoduchá fakturace pro živnostníky, kteří nejsou plátci DPH.<br>
  Běží na tvém Macu a data zůstávají u tebe. Bez účtu, bez předplatného a bez limitu faktur nebo kontaktů.
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/prehled-dark.png">
  <img src="docs/prehled-light.png" alt="Přehled za rok: fakturace po měsících, odběratelé, odhad daně a pojištění a limit pro DPH">
</picture>
<p align="center"><sub>Přehled s ukázkovými daty</sub></p>

## Pro koho to je

Pro OSVČ v Česku (živnostníky i svobodná povolání), kteří:

- **nejsou plátci DPH**,
- počítají daň s **výdajovým paušálem** (nebo výdaje neřeší),
- chtějí vystavit fakturu za minutu a mít přehled, kolik zaplatí na dani a pojištění.

Hodí se i při podnikání během studia nebo vedle zaměstnání (vedlejší činnost). Appka hlídá limit, do kterého se neplatí sociální pojištění.

## Co umí

- **Faktury v PDF s QR Platbou.** Číselná řada se vede sama a variabilní symbol se bere z čísla faktury. Fakturu můžeš upravit, duplikovat nebo stornovat (PDF pak dostane vodoznak).
- **Kontakty s načtením z ARES.** Stačí zadat IČO a název s adresou se doplní.
- **Přehled za rok:** příjmy po měsících, největší odběratelé, co čeká na platbu a co je po splatnosti.
- **Odhad daně a pojištění** z přijatých plateb a výdajového paušálu.
- **Hlídání limitů:** obrat pro registraci k DPH a rozhodná částka pro sociální pojištění. Varuje už při psaní faktury, která by limit přetáhla.
- **Příjmy bez faktury** (třeba vyúčtování od pořadatele) i s přiloženým dokladem.
- **Zálohy:** každý den automaticky, po každé změně kopie do iCloud Drive. Smazané PDF se jen přesunou stranou.
- **Import starých faktur** z JSON souboru i s původními PDF.

Faktury jsou v korunách a appka je česky.

## Požadavky

- **Mac s macOS 12 nebo novějším** (Apple Silicon i Intel). Okno aplikace, záloha do iCloudu i tlačítko „Ukázat ve Finderu“ jsou psané pro Mac.
- **Internet** pro načítání firem z ARES a pro aktualizace. Když na Macu není Python, Faktury si při prvním spuštění stáhnou vlastní (asi 25 MB).

Nic dalšího instalovat nemusíš.

## Instalace

1. Stáhni **[Faktury.zip](https://github.com/davidmalasek/faktury/releases/latest/download/Faktury.zip)**. Safari ZIP samo rozbalí, jinak na něj dvakrát klikni.
2. Přetáhni **Faktury** do složky **Aplikace**.
3. Otevři Faktury. Napoprvé je macOS nepustí a napíše, že aplikaci nemůže ověřit. Je to proto, že appka není placeně podepsaná u Applu.
   Klikni na **Hotovo**, otevři **Nastavení systému → Soukromí a zabezpečení**, sjeď dolů a u hlášky o Fakturách klikni na **Přesto otevřít** a potvrď. Tohle je potřeba jen jednou.

Když na Macu není Python, Faktury si ho při prvním otevření stáhnou, takže chvíli trvá, než naběhnou. Pak se macOS zeptá, jestli smí přistupovat k iCloud Drive kvůli záloze. Klikni na **Povolit**.
Když omylem zakážeš: Nastavení systému → Soukromí a zabezpečení → Soubory a složky → Faktury.

Faktury se otevřou ve vlastním okně. Najdeš je přes Spotlight (⌘ mezerník → „Faktury“) nebo v Launchpadu a můžeš si je nechat v Docku.
PDF faktur a zálohu dat uložíš přes běžný dialog, velikost stránky změníš ⌘+ a ⌘−.

Než vystavíš první fakturu, vyplň v **Nastavení** svoje údaje, číslo účtu a výdajový paušál.

Server Faktur běží na pozadí i po zavření okna, takže další otevření je hned. Dokud běží, appka funguje i v prohlížeči na adrese http://localhost:8765.

## Aktualizace

Faktury se při každém otevření podívají na GitHub, jestli nevyšla nová verze. Když ano, samy ji stáhnou a nainstalují. Trvá to pár vteřin a pak se stránka sama načte znovu.
Před aktualizací se data zazálohují a data aktualizace nikdy nepřepíše. Kterou verzi máš, uvidíš v **Nastavení** dole.

Aktualizace mění jen soubory ve složce Faktur, ne samotnou aplikaci, takže se macOS na nic znovu neptá.
Výjimečně se změní i okno aplikace. Pak se stáhne nová Faktury.app a appku je potřeba zavřít a otevřít. macOS se potom může jednou znovu zeptat na iCloud Drive.

## Soukromí

Appka nemá žádný vlastní server ani účet a nic nikam neposílá. Data leží jen ve složce `data` u tebe na disku a v kopii na tvém iCloud Drive.
Ven jde jen dotaz do veřejného registru ARES, když načítáš firmu podle IČO, a dotaz na GitHub, jestli nevyšla nová verze.
Appka poslouchá jen na `127.0.0.1`, takže se k ní nedostane nikdo jiný ze sítě.

## Kde jsou data

Data jsou ve složce `~/Library/Application Support/Faktury/data` (ve vývojové instalaci ve složce `data` projektu). Přesnou cestu najdeš v Nastavení.

| Cesta | Co obsahuje |
|---|---|
| `data/faktury.json` | faktury, kontakty, nastavení (čitelný text) |
| `data/archiv/ROK/` | PDF všech faktur a doklady k příjmům bez faktury |
| `data/zalohy/` | automatická záloha před první změnou každého dne (30 dní) a před každým importem a aktualizací |
| `data/smazane/` | PDF smazaných faktur a dokladů (nic se nemaže natrvalo) |
| iCloud Drive → `Faktury záloha` | kopie všeho výše, aktualizuje se po každé změně |

Složka `data` se do gitu záměrně neukládá, protože obsahuje osobní údaje klientů.
Stav zálohy do iCloudu je vidět v Nastavení. Z iCloudu se nic nemaže, kromě denních záloh starších než 30 dní.

**Obnovení:** zavři okno Faktur, vypni server (v Terminálu `kill $(cat ~/Library/Application\ Support/Faktury/data/server.pid)`) a jedním z těchto způsobů vrať soubor `data/faktury.json`:
- zkopíruj na jeho místo vybraný soubor z `data/zalohy`,
- nebo celý obsah složky `Faktury záloha` z iCloud Drive zkopíruj do `data/`.

## Daň a pojištění

Přehled ukazuje, kolik za vybraný rok zaplatíš v dalším roce: daň z příjmů a u vedlejší činnosti i zdravotní a sociální pojištění (částka může vyjít i 0 Kč).
Zisk se počítá jako přijaté platby (včetně příjmů bez faktury) minus výdajový paušál a paušál se nastavuje v Nastavení.

- **Daň:** 15 % ze zisku zaokrouhleného dolů na stovky minus sleva na poplatníka (30 840 Kč).
- **Zdravotní pojištění:** 13,5 % z poloviny zisku. Při studiu nebo zaměstnání se od roku 2026 neplatí zálohy a celé pojistné se doplácí po podání přehledu.
- **Sociální pojištění:** 29,2 % z 55 % zisku, ale jen když zisk za rok dosáhne rozhodné částky. Měřák v kartě hlídá, kolik ještě můžeš přijmout.
- **DPH:** když obrat za kalendářní rok přesáhne 2 000 000 Kč, budeš plátce od 1. 1. dalšího roku. Nad 2 536 500 Kč hned ode dne po překročení.

Počítá se jen s příjmy z podnikání. Jiné příjmy (třeba brigáda), skutečné výdaje a sazba daně 23 % pro velmi vysoké příjmy se nezohledňují.

**Varování u limitů:** u DPH, sociálního pojištění a hranice, kterou ještě pokryje sleva na dani, appka ukazuje ✅ / ⚠️ (od 75 %) / 🔴 (od 90 %, po překročení nebo když by limit přetáhly čekající platby).
Upozornění jsou nahoře v Přehledu (za letošek), v měřácích a ve formuláři faktury i příjmu, když by částka limit přetáhla.
Hranice 75 % a 90 % se mění v `static/charts.js` (`LIMIT_WARN`, `LIMIT_BAD`).

> Částky jsou orientační a platí pro roky 2025 a 2026. Daňové přiznání ani přehledy pro pojišťovny appka nevyplní a nenahrazuje účetní ani daňového poradce.

## Příjmy bez faktury

Peníze, které ti přišly bez vystavené faktury (třeba vyúčtování od pořadatele), zapíšeš přes Faktury → **Příjem bez faktury**.
Vyplníš datum přijetí, částku a od koho peníze přišly. Volitelně přiložíš doklad (PDF, PNG nebo JPG).
Takový příjem se nepočítá do číselné řady faktur, ale započítá se do daně a pojištění i do obratu pro DPH.
V Přehledu je vidět v tabulce za daný rok a kliknutím ho upravíš nebo smažeš.

## Pro vývoj

Vývojová instalace běží přímo ze složky projektu a data má v její podsložce `data`.
Potřebuje Python 3.9+ a vývojářské nástroje od Applu (`xcode-select --install`), ze kterých se sestaví okno aplikace:

```sh
git clone https://github.com/davidmalasek/faktury && cd faktury
./instalovat.sh                           # sestaví Faktury.app do Aplikací (spouští Faktury z této složky)
python3 server.py --open                  # ruční spuštění v prohlížeči
python3 -m unittest discover tests        # testy
python3 import_data.py soubor.json --zkouska   # import starých dat (formát popsán v souboru)
```

Bez závislostí: backend na standardní knihovně Pythonu a frontend v čistém JavaScriptu.
PDF vytváří knihovna pdfmake, přibalená ve `static/vendor`.
Testovací data: `FAKTURY_DATA=/jina/slozka FAKTURY_PORT=8799 python3 server.py`. Do iCloudu se zálohují, jen když nastavíš `FAKTURY_ICLOUD`.

Okno aplikace je v `macos/Faktury.swift` (AppKit a WebKit) a sestavuje ho `macos/sestavit.sh`, a to ve dvou podobách.
Vývojová podoba (`instalovat.sh`) spouští Faktury ze složky projektu. Podoba ke stažení (`Faktury.zip` z GitHub Actions) nese kód v sobě a při spuštění ho nakopíruje do `~/Library/Application Support/Faktury`.
Použije Python 3.9+, který na Macu už je (Homebrew, vývojářské nástroje od Applu). Když žádný není, stáhne si do stejné složky Python z [python-build-standalone](https://github.com/astral-sh/python-build-standalone) (verze a kontrolní součty jsou v `spustit.sh`).
Po změně `macos/` nebo přesunutí složky projektu spusť `./instalovat.sh` znovu.

**Vydání nové verze:** zvyš číslo v souboru `VERSION` (třeba z `1.0.0` na `1.1.0`) a pushni do `main`.
Když projdou testy a zkouška aplikace na macOS, GitHub Actions vytvoří vydání `v1.1.0` s `Faktury.zip` a seznamem commitů od minulé verze. Ostatním se pak nová verze nainstaluje při dalším otevření Faktur.
Commity bez změny `VERSION` se nikomu neinstalují.
Ve vývojové kopii z gitu se aktualizace neinstalují, aby nepřepsaly rozdělanou práci.

**Každý rok** je potřeba zkontrolovat sazby a limity na začátku `static/app.js`:
- doplnit rozhodnou částku pro sociální pojištění do `SOCIAL_LIMITS` (zveřejňuje se na podzim předchozího roku, 2026: 117 521 Kč),
- od roku 2027 se má vrátit sleva na studenta 4 020 Kč. Až bude platit, je potřeba ji přičíst k `TAX_CREDIT`.

## Licence

[MIT](LICENSE). Přibalená knihovna [pdfmake](https://github.com/bpampuch/pdfmake) je pod licencí MIT a písmo Roboto pod licencí Apache 2.0.
