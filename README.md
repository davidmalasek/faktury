<p align="center">
  <img src="static/icon.svg" width="112" alt="Ikona aplikace Faktury">
</p>

<h1 align="center">Faktury</h1>

<p align="center">
  Fakturace pro živnostníky, kteří nejsou plátci DPH.<br>
  Fakturu vystavíš za minutu a vždycky víš, kolik ti zůstane po dani a pojištění.
</p>

<p align="center">
  <a href="https://github.com/davidmalasek/faktury/releases/latest/download/Faktury.zip"><b>Stáhnout pro Mac</b></a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/prehled-dark.png">
  <img src="docs/prehled-light.png" alt="Přehled za rok: fakturace po měsících, odběratelé, odhad daně a pojištění a limit pro DPH">
</picture>

Pro živnostníky a svobodná povolání v Česku, kteří daň počítají výdajovým paušálem. Hodí se i na podnikání při studiu nebo vedle zaměstnání.

## Co za tebe vyřeší

- **Faktura za minutu.** Napíšeš IČO odběratele a jeho název s adresou se doplní sám. Číslo faktury i QR kód pro platbu doplní Faktury a hotové PDF jen pošleš.
- **Víš, kolik zaplatíš.** Průběžně vidíš, kolik za rok zaplatíš na dani a pojištění, a v lednu ti Faktury připomenou daňové přiznání.
- **Nepřetáhneš limity.** Faktury hlídají hranici pro DPH a u podnikání při studiu nebo zaměstnání i hranici, do které neplatíš sociální pojištění. Upozorní tě už u faktury, která by ji přetáhla.
- **Nic ti neuteče.** Vidíš, kdo ještě nezaplatil a komu už prošla splatnost.
- **Měříš odpracovaný čas?** S [Hodinovkou](https://github.com/davidmalasek/hodinovka) ho vyfakturuješ jedním kliknutím.

Bez účtu, bez předplatného a bez omezení počtu faktur.

## Instalace

Potřebuješ Mac s macOS 12 nebo novějším.

1. Stáhni **[Faktury.zip](https://github.com/davidmalasek/faktury/releases/latest/download/Faktury.zip)**. Safari ho samo rozbalí, jinak na něj dvakrát klikni.
2. Přetáhni **Faktury** do složky **Aplikace** a otevři je.
3. Napoprvé macOS napíše, že aplikaci nemůže ověřit, protože není placeně podepsaná u Applu. Klikni na **Hotovo**, otevři **Nastavení systému → Soukromí a zabezpečení**, sjeď dolů a u Faktur klikni na **Přesto otevřít**. Tohle je potřeba jen jednou.

Při prvním otevření se Faktury chvíli připravují. Když se macOS zeptá na přístup k iCloud Drive, klikni na **Povolit**, ať se ti tam data zálohují.
Pak v **Nastavení** vyplň svoje údaje, číslo účtu a výdajový paušál a můžeš fakturovat.

Nové verze se instalují samy.

## Tvoje data

Faktury, kontakty i PDF máš jen u sebe na Macu. Každý den se zálohují a po každé změně se kopie uloží do tvého iCloud Drive (složka **Faktury záloha**).
Faktury nemají žádný účet a nic nikam neposílají. Na internet se ptají jen registru firem ARES, když hledáš odběratele podle IČO, a jestli nevyšla nová verze.

## Daň a pojištění

Odhad počítá s výdajovým paušálem a s příjmy z podnikání (i s penězi, které ti přišly bez faktury) a platí pro roky 2025 až 2027.
Je orientační: daňové přiznání za tebe nevyplní a nenahrazuje účetní. Jak přesně počítá, najdeš v [docs/dane.md](docs/dane.md).

## Pro vývojáře

Jak Faktury fungují uvnitř a jak na nich pracovat, popisuje [docs/vyvoj.md](docs/vyvoj.md).

Licence [MIT](LICENSE). Přibalená knihovna [pdfmake](https://github.com/bpampuch/pdfmake) je pod licencí MIT a písmo Roboto pod licencí Apache 2.0.
