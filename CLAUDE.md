# Faktury

Fakturace pro živnostníky (neplátce DPH) na Macu. Je propojená s Hodinovkou (github.com/davidmalasek/hodinovka) a dalšími aplikacemi, které přibudou.

- Vzhled, technika i texty podle `docs/styl.md`. Platí i pro každou další propojenou aplikaci, ať vypadají a fungují stejně.
- Propojení aplikací podle `docs/propojeni.md`. Soubory `propojeni.py`, `docs/propojeni.md`, `docs/styl.md` a ikony aplikací ve `static/aplikace/` jsou stejné ve všech aplikacích: když je měníš, změň je všude.
- Bez závislostí: Python 3.9+ jen se standardní knihovnou, čistý JavaScript bez buildu (pdfmake je přibalený). Testy `python3 -m unittest discover tests` musí projít i na Pythonu 3.9.
- Texty v aplikaci i komentáře v kódu česky, uživateli se tyká. README a texty v aplikaci jsou pro běžné lidi s Macem, technické věci patří do `docs/`. Propojení aplikací nemá žádný vlastní název (ani v kódu a dokumentaci).
- Okno pro macOS (`macos/Faktury.swift`) jde zkompilovat jen na Macu, ověřuje ho GitHub Actions.
- Pracuj rovnou v `main`, žádné další větve ani pull requesty.
- Vydání: zvýšit `VERSION` a pushnout do `main`.
