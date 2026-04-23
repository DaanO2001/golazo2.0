# 🚀 Golazo — Stap-voor-stap handleiding: Online zetten met Supabase

---

## Wat ga je doen?
Je zet de Golazo app online zodat jij en je vrienden hem kunnen gebruiken via een link.
Dit duurt ongeveer **15–20 minuten**, geen technische kennis nodig.

---

## STAP 1 — Maak een gratis Supabase account aan

1. Ga naar **https://supabase.com**
2. Klik op **"Start your project"** (groen knopje)
3. Meld je aan met je Google account (of maak een account aan)
4. Je zit nu in het Supabase dashboard

---

## STAP 2 — Maak een nieuw project aan

1. Klik op **"New project"**
2. Vul in:
   - **Name:** `golazo` (of een andere naam)
   - **Database Password:** kies een wachtwoord en sla het ergens op
   - **Region:** kies `West EU (Ireland)` — dat is het dichtst bij Nederland
3. Klik op **"Create new project"**
4. ⏳ Wacht 1–2 minuten terwijl het project aanmaakt (je ziet een voortgangsbalk)

---

## STAP 3 — Maak de database tabel aan

Dit is de "opslagplek" voor alle data van je app.

1. Klik in het linkermenu op **"SQL Editor"** (het icoon ziet eruit als `< >`)
2. Klik op **"New query"**
3. Kopieer en plak de volgende code in het tekstveld:

```sql
-- Maak de tabel aan
CREATE TABLE golazo_state (
  id TEXT PRIMARY KEY,
  state_json JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Zorg dat iedereen de tabel kan lezen en schrijven (geen login nodig)
ALTER TABLE golazo_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all" ON golazo_state
  FOR ALL USING (true) WITH CHECK (true);

-- Zet realtime updates aan
ALTER PUBLICATION supabase_realtime ADD TABLE golazo_state;
```

4. Klik op de groene **"Run"** knop (of druk op Ctrl+Enter)
5. Je ziet onderin: `Success. No rows returned` — dat is goed! ✅

---

## STAP 4 — Kopieer je Supabase gegevens

Je hebt twee dingen nodig: de **URL** en de **Anon Key**.

1. Klik in het linkermenu op **"Project Settings"** (tandwiel-icoon, onderaan)
2. Klik op **"API"**
3. Je ziet nu:
   - **Project URL** — bijvoorbeeld `https://abcdefgh.supabase.co`
   - **Project API keys → anon public** — een lange code die begint met `eyJ...`
4. Kopieer beide en bewaar ze even (in een notitie of Word-document)

---

## STAP 5 — Zet de app online via Netlify

Netlify is een gratis website-host. Hier zet je jouw `golazo_supabase.html` online.

1. Ga naar **https://netlify.com**
2. Klik op **"Sign up"** en meld je aan (bijv. met Google)
3. Je zit nu op het Netlify dashboard
4. Scroll naar beneden — je ziet een grijze vlak met de tekst:
   **"Want to deploy a new site without connecting to Git? Drag and drop your site output folder here"**
5. **Hernoem je bestand eerst:**
   - Je hebt het bestand `golazo_supabase.html` gedownload
   - Hernoem dit naar `index.html`
6. Sleep het bestand `index.html` naar dat grijze vlak op Netlify
7. Netlify geeft je automatisch een link, zoals: `https://magical-name-123.netlify.app`
8. **Dat is jouw app-link! 🎉**

---

## STAP 6 — Koppel Supabase aan de app

De eerste keer dat je de app opent, zie je een scherm om Supabase te koppelen.

1. Open je Netlify-link in de browser
2. Je ziet het scherm **"Koppel Supabase"**
3. Vul in:
   - **Supabase URL:** de URL uit Stap 4 (bijv. `https://abcdefgh.supabase.co`)
   - **Supabase Anon Key:** de lange `eyJ...` code uit Stap 4
4. Klik op **"Verbinden"**
5. De app laadt op — klaar! ✅

> **Let op:** Dit doe jij eenmalig. Je vrienden openen gewoon de link — zij zien geen configuratiescherm, zij gaan direct naar het spelerskeuzescherm.

---

## STAP 7 — Deel de link met je vrienden

1. Stuur de Netlify-link (bijv. `https://magical-name-123.netlify.app`) naar je vrienden via WhatsApp, iMessage, etc.
2. Zij openen de link op hun telefoon of laptop
3. Ze zien het scherm **"Wie ben jij?"** en klikken op hun naam
4. Ze vullen hun voorspellingen in — die worden direct voor iedereen zichtbaar opgeslagen ✅

---

## Hoe werkt het voor jou als Admin?

1. Open de app via de link
2. Klik op **"ADMIN"** rechtsboven
3. Voeg spelers toe, stel de wedstrijd in, vul de uitslag in
4. Alles wat jij invult verschijnt **direct** bij al je vrienden — geen refresh nodig

---

## Veelgestelde vragen

**Moeten mijn vrienden ook een Supabase account aanmaken?**
Nee. Alleen jij hebt een account nodig. Vrienden openen gewoon de link.

**Is het gratis?**
Ja. Supabase en Netlify zijn beide gratis voor klein gebruik zoals dit.

**Wat als ik de link vergeet?**
Log in op netlify.com, kijk bij "Sites" — je ziet jouw app.

**Kan ik de link mooier maken?**
Ja! Op Netlify kun je gratis een eigen naam kiezen, bijv. `golazo-vrienden.netlify.app`. Ga naar je site op Netlify → "Site settings" → "Change site name".

**Werkt het ook op telefoon?**
Ja, de app is volledig mobiel-vriendelijk.

**Wat als ik een nieuwe wedstrijd wil?**
Ga als Admin naar de app → klik op "ADMIN" → klik op "🔄 Nieuw rondje". Dan worden alle voorspellingen gewist maar blijven de spelers staan.

---

## Samenvatting van wat je nodig hebt

| Wat | Waar |
|-----|------|
| Supabase URL | Supabase → Project Settings → API |
| Supabase Anon Key | Supabase → Project Settings → API |
| App-bestand | `golazo_supabase.html` (hernoem naar `index.html`) |
| Hosting | Netlify (gratis, drag & drop) |

---

*Veel plezier met Golazo! 🎉⚽*
