# Dance Lead Machine™ — Live AI Receptionist

This is a real, working web app: a chat widget that uses an actual Claude AI model to
understand inquiries, qualify leads, book appointments, distribute them across your
instructors, and save everything to a real database. It is not a simulation — once
it's deployed, it's genuinely live on the internet.

It has **zero external code dependencies** (no `npm install` needed) — it only uses
things built into Node.js itself. That means fewer things that can break when you
deploy it.

## What you need before this can go live

Two free accounts. Neither costs anything to sign up for (the AI account has a small
pay-as-you-go cost once you're using it for real, more on that below).

### 1. An Anthropic account (for the AI's brain)

This is what lets the receptionist actually understand messages, instead of just
matching keywords.

1. Go to **https://console.anthropic.com/** and create an account.
2. Once logged in, find **API Keys** in the left sidebar and create a new key.
3. Copy the key — it starts with `sk-ant-...`. You'll paste this into your hosting
   service in Step 2 below. Keep it private, like a password.
4. Anthropic bills per message the AI processes — for a studio testing this out, that's
   pennies a day. You can set a spending limit in the console so you're never surprised.

### 2. A hosting account (to put it on the internet)

This is the "address" people will actually visit. We recommend **Render**
(https://render.com) because it's free to start and simple to set up, but any Node.js
host works (Railway, Fly.io, etc.).

1. Go to **https://render.com** and create a free account.
2. Click **New +** → **Web Service**.
3. Connect it to wherever you've put this code (see "Getting the code online" below).
4. When it asks for settings:
   - **Build Command:** leave blank (there's nothing to install!)
   - **Start Command:** `npm start`
   - **Node version:** 22 or newer (Render usually auto-detects this)
5. Under **Environment Variables**, add:
   - `ANTHROPIC_API_KEY` → paste the key from Step 1
   - `STUDIO_NAME` → your studio's name (optional, defaults to "Dance Lead Machine Studio")
6. Click **Create Web Service**. After a minute or two, Render gives you a real web
   address like `https://your-studio-name.onrender.com` — that's your live AI Receptionist.

**Note on the free tier:** Render's free web services fall asleep after inactivity and
take ~30 seconds to wake back up on the next visit. That's fine for testing; if you want
it always instantly awake, Render's cheapest paid tier (a few dollars a month) removes
that delay.

**Note on the database:** this app stores leads in a small database file that lives on
the server itself. On Render's free tier, that file can be wiped when the service
restarts. For actually running your business on this, add a "Persistent Disk" in Render
(a few dollars a month) and set `DB_PATH=/var/data/dance_lead_machine.db` (pointing at
that disk) as an environment variable — that keeps your leads safe permanently. I'm
flagging this clearly because it's the one thing that's easy to miss with a free-tier
deploy.

### Getting the code online

Render (and most hosts) deploy from a GitHub repository. If you don't already have one:

1. Create a free GitHub account at **https://github.com** if you don't have one.
2. Create a new repository (name it anything, e.g. `dance-lead-machine`).
3. Upload this entire folder's contents to that repository (GitHub's website lets you
   drag-and-drop files if you're not familiar with git — look for "uploading an existing
   file" in GitHub's docs).
4. Back in Render, point the Web Service at that repository.

## Trying it locally first (optional, for the technically curious)

If you have Node.js 22+ installed on your own computer, you can run this before
deploying anywhere:

```
cp .env.example .env
# edit .env and paste in your real ANTHROPIC_API_KEY
npm start
```

Then open **http://localhost:3000** in your browser.

## What's actually real here vs. still simulated

**Real:** the AI understanding messages (calls the actual Claude API), the database
(leads persist for real), the appointment booking logic, the instructor workload
distribution, the follow-up message *scheduling*.

**Still simulated:** actually sending texts/emails. The Follow-Up tab shows you exactly
what would be sent and when, but doesn't send it yet — that's the next real integration
(a service like Twilio for texts, or SendGrid for email), which is a good next step once
this piece is live and you're happy with how it works.

## Testing this yourself

Run `npm test` to see the full automated test suite (32 checks covering the whole
booking flow, instructor distribution, and follow-up sequences) run against a mocked AI
response — this doesn't need a real API key and won't cost anything, it's just here so
you (or anyone helping you maintain this) can verify nothing's broken after a change.

## Project structure

```
src/
  server.js   — the web server and all API routes
  ai.js       — the real Claude API call + the AI's instructions (system prompt)
  logic.js    — deterministic business rules (categories, slots, instructor picking, follow-up templates)
  db.js       — the database (uses Node's built-in SQLite, no install needed)
  router.js   — tiny internal routing helper
public/
  index.html, app.js, styles.css — the chat widget + dashboard the browser shows
test/
  run_tests.js         — automated test suite (mocked AI, no real key needed)
  e2e_browser_test.js  — full browser test using Playwright (optional, needs Playwright installed)
```
