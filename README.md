# Rozhľad: 360° virtuálne prehliadky

Jednoduchá webová aplikácia na tvorbu a prezeranie 360° prehliadok (podobne ako Kuula). Beží celá v prehliadači, bez servera a bez databázy, takže ju môžete hostovať zadarmo na GitHub Pages.

- Panorámy zobrazuje knižnica [Photo Sphere Viewer](https://photo-sphere-viewer.js.org/), ktorá je priložená v priečinku `vendor/`. Aplikácia nepotrebuje CDN a funguje aj offline.
- **Prehliadka**: čistý režim pre návštevníkov. Kliknutím na šípku sa presuniete do ďalšej miestnosti.
- **Editor**: bočný panel na správu scén, pridávanie bodov prechodu kliknutím do panorámy, premiestňovanie ťahaním a nastavenie PINu.
- Nastavenia sa ukladajú v prehliadači (localStorage a IndexedDB) a dajú sa exportovať ako ZIP alebo JSON.
- Prehliadku môžete chrániť **PINom**. Fotky aj nastavenia sa pri exporte zašifrujú (AES-256-GCM).

## Obsah repozitára

```
index.html          stránka aplikácie
style.css           vzhľad
app.js              logika (scény, body prechodu, editor, export a import, PIN)
zip.js              malá knižnica na čítanie a zápis ZIP súborov
pin-crypto.js       šifrovanie PINom (Web Crypto API)
vendor/             Photo Sphere Viewer, three.js, písmo a licencie
panoramas/          vzorové panorámy (po publikovaní vlastnej prehliadky ich nahradíte)
tools/              skript, ktorým boli vzorové panorámy vygenerované
.nojekyll           vypína spracovanie cez Jekyll na GitHub Pages
```

## Spustenie na vlastnom počítači

Stačí ľubovoľný lokálny webový server. Príklad s Pythonom:

```
cd priecinok-s-aplikaciou
python3 -m http.server 8000
```

Potom otvorte `http://localhost:8000`.

Poznámky:

- Priamym otvorením `index.html` (adresa `file://`) fungujú len vlastné nahraté fotky. Vzorové panorámy sa načítavajú zo súborov, čo prehliadače cez `file://` blokujú.
- Šifrovanie PINom vyžaduje zabezpečený kontext, teda HTTPS (GitHub Pages) alebo `localhost`.

## Nahratie na GitHub a spustenie cez GitHub Pages

Potrebujete bezplatný účet na [github.com](https://github.com). Pri bezplatnom účte musí byť repozitár **verejný**. Obsah prehliadky tak bude technicky dostupný každému, kto pozná adresu, preto použite PIN (pozri nižšie).

### 1. Vytvorte repozitár

1. Prihláste sa na GitHub a kliknite na **+** v pravom hornom rohu, potom na **New repository**.
2. Do poľa **Repository name** napíšte názov, napríklad `moja-prehliadka`. Z neho vznikne adresa.
3. Zvoľte **Public**.
4. Kliknite na **Create repository**.

### 2. Nahrajte súbory

1. Na stránke nového repozitára kliknite na odkaz **uploading an existing file** (alebo **Add file**, potom **Upload files**).
2. Otvorte priečinok s aplikáciou a pretiahnite do okna prehliadača **jeho obsah**: súbory `index.html`, `style.css`, `app.js`, `zip.js`, `pin-crypto.js`, `.nojekyll`, `README.md`, `LICENSE` a priečinky `vendor`, `panoramas` a `tools`. Priečinky pri pretiahnutí zachovajú svoju štruktúru. Súbor `index.html` musí byť v koreni repozitára, nie v podpriečinku.
3. Počkajte, kým sa všetko nahrá, a kliknite na zelené **Commit changes**.

Poznámka: cez webové rozhranie GitHub prijme súbory do 25 MB. Panorámy v rozlíšení 4096 × 2048 px majú zvyčajne 0,3 až 3 MB, takže to stačí. Skrytý súbor `.nojekyll` sa v niektorých správcoch súborov nezobrazuje. Ak ho medzi súbormi nevidíte, nevadí. Aplikácia bez neho funguje tiež.

### 3. Zapnite GitHub Pages

1. V repozitári otvorte **Settings** (Nastavenia).
2. V ľavom menu vyberte **Pages**.
3. V časti **Build and deployment** pri položke **Source** zvoľte **Deploy from a branch**.
4. Pri položke **Branch** vyberte `main` a priečinok `/ (root)`, potom kliknite na **Save**.
5. Po jednej až dvoch minútach sa na tej istej stránke zobrazí adresa:

```
https://VASE-MENO.github.io/moja-prehliadka/
```

Táto adresa je dostupná odkiaľkoľvek na svete. Ak stránka hneď po uložení nefunguje, chvíľu počkajte a obnovte ju.

## Ako publikovať vlastnú prehliadku

Editor ukladá prácu len do vášho prehliadača. Aby ju videli ostatní, musíte ju nahrať do repozitára:

1. Otvorte aplikáciu, prepnite sa na **Editor**, pridajte fotky a body prechodu.
2. Kliknite na **Uložiť a zdieľať**, potom na **Stiahnuť balík ZIP**.
3. ZIP rozbaľte. Obsahuje súbor `tour.json` a priečinok `panoramas`.
4. V repozitári na GitHube kliknite na **Add file**, potom **Upload files**. Nahrajte `tour.json` a priečinok `panoramas`. Existujúci súbor `tour.json` sa nahradí. Staré vzorové panorámy z priečinka `panoramas` môžete odstrániť (otvorte súbor, kliknite na ikonu koša a potvrďte).
5. Potvrďte tlačidlom **Commit changes**. Za minútu-dve je nová verzia na adrese stránky.

Keď aplikácia nájde súbor `tour.json`, načíta z neho prehliadku. Odkaz bez editora, ktorý pošlite návštevníkom, získate v dialógu **Uložiť a zdieľať** a vyzerá takto:

```
https://VASE-MENO.github.io/moja-prehliadka/?mode=tour
```

V tomto režime sa editor nezobrazí a aplikácia ignoruje všetko uložené v prehliadači. Návštevník tak vždy uvidí publikovanú verziu.

Prehliadku môžete vložiť aj do inej webovej stránky. Kód na vloženie (`<iframe>`) nájdete v tom istom dialógu.

## Ochrana PINom

PIN si nastavíte pre každú prehliadku zvlášť v **Editor, Nastavenia, Ochrana PINom**.

Ako to funguje:

- Pri stiahnutí balíka ZIP sa `tour.json` aj všetky fotky zašifrujú. Kľúč vzniká z PINu (PBKDF2-SHA256, 600 000 iterácií) a šifruje sa cez AES-256-GCM.
- Súbory v repozitári sú síce verejné, ale bez PINu sú nečitateľné. Názvy scén ani zoznam miestností sa nedajú zistiť. Súbory majú neutrálne názvy ako `panoramas/s-abc123.enc`.
- Návštevník pri otvorení adresy uvidí zamykaciu obrazovku. Fotky sa dešifrujú až v jeho prehliadači a PIN nikdy neopustí jeho zariadenie.
- PIN **nie je** súčasťou balíka. Pošlite ho návštevníkom samostatne, napríklad správou.
- Ak PIN zabudnete, súbory sa obnoviť nedajú. Nechajte si pôvodné fotky.

Čo PIN nerieši:

- Pretože nejde o server, ktorý by počítal chybné pokusy, môže niekto stiahnuť zašifrované súbory a skúšať PINy offline. **Sila ochrany teda závisí od dĺžky PINu.** Štvorčíselný PIN odradí náhodných návštevníkov, ale nie cieleného útočníka. Pre citlivý obsah použite aspoň 8 znakov s písmenami a číslami. Editor vám silu PINu ukáže.
- Návštevník, ktorý PIN pozná, môže fotky uložiť (rovnako ako pri každej webovej stránke).
- Šifrovanie funguje len cez HTTPS alebo `localhost`. GitHub Pages HTTPS používa.
- Ak je PIN nastavený a v repozitári nahráte nezašifrované súbory, zostanú verejné. Nahrávajte vždy balík stiahnutý po nastavení PINu.

## Vzorové panorámy

Štyri vzorové panorámy (obývačka, kuchyňa, spálňa, terasa) nie sú fotografie. Vygeneroval ich skript `tools/generate_samples.py` a sú voľné bez obmedzení (CC0). Slúžia na okamžité vyskúšanie aplikácie. Skript si môžete spustiť sami (`python3 tools/generate_samples.py`, vyžaduje `numpy` a `Pillow`).

## Vlastné fotky

- Formát: ekvirektangulárna panoráma 360° × 180° s pomerom strán 2:1, JPG, PNG alebo WebP. Odporúčané rozlíšenie je 4096 × 2048 px. Väčšie snímky sa na slabších telefónoch nemusia načítať.
- Fotky nahrajete cez **Vybrať fotky** alebo ich pretiahnete do okna prehliadača.
- Pri pridávaní dostanete upozornenie, ak snímka nemá pomer 2:1.

## Kde sa ukladajú údaje

Rozpracovaná prehliadka sa ukladá v tomto prehliadači: nastavenia v `localStorage`, nahraté fotky v `IndexedDB`. Ak vymažete údaje stránok, prehliadka zmizne. Preto ju pravidelne sťahujte ako ZIP. Tlačidlo **Obnoviť pôvodnú prehliadku** v nastaveniach zahodí lokálne zmeny.

## Riešenie problémov

| Problém | Riešenie |
| --- | --- |
| Po nahratí na GitHub je stránka prázdna alebo vidíte 404 | Skontrolujte, či je `index.html` v koreni repozitára a či je v nastaveniach Pages vybraná vetva `main` a priečinok `/ (root)`. Počkajte minútu a obnovte stránku. |
| Aplikácia po publikovaní stále ukazuje vzorový byt | Súbor `tour.json` nie je v koreni repozitára, alebo ho prehliadač drží v pamäti. Skúste Ctrl+F5. Ak ste aplikáciu používali ako editor, kliknite v nastaveniach na **Obnoviť pôvodnú prehliadku**. |
| Panoráma sa nezobrazí a vidíte chybu | Skontrolujte, či je fotka JPG, PNG alebo WebP a či nie je príliš veľká (odporúčame max. 8192 px na šírku). |
| Zašifrovanie pri exporte zlyhá | Aplikácia musí bežať cez HTTPS alebo `localhost`, nie cez `file://`. |
| Návštevník vidí editor | Pošlite mu odkaz s koncovkou `?mode=tour`. |

## Licencie

- Vlastný kód aplikácie: licencia MIT (súbor `LICENSE`).
- Photo Sphere Viewer a three.js: MIT. Písmo Bricolage Grotesque: SIL Open Font License. Ikony Lucide: ISC. Úplné znenia sú v `vendor/LICENSES.txt`.
- Vzorové panorámy: CC0.
