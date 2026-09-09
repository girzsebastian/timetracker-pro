# TimeTracker Pro

**A local, self-hosted Clockify replacement — built for people who work on several things at once.**

Run as many timers as you have contexts. One for the refactor, one for the bug you got pulled into, one for the review you're doing while the build runs. Each keeps its own project, person and tags, and each saves as its own entry when you stop it. Your data stays in a SQLite file on your machine, the AI runs locally through Ollama, and there is no account, no cloud and no subscription.

Available in **English, Romanian, Spanish, German and French** — switchable from Settings, no restart.

<p align="center">
  <img src="docs/media/01-concurrent-timers.jpg" alt="Three timers running at once, each on its own project" width="820">
</p>

> [Citește în română](README.ro.md)

---

## Why

Clockify, Toggl and Harvest all assume one timer, because they were designed for someone who does one task at a time and bills it. That is not how a lot of development work actually goes: you start something, an agent is generating in the background, you review a PR, a client pings you, you come back. By the end of the day you know you worked, but the tracker has one entry and a guess.

TimeTracker Pro assumes the opposite. **Multiple concurrent timers are the default, not a workaround.** Start one per context, stop them as each context closes, and the day reconstructs itself accurately instead of from memory.

The rest follows from the same idea: it should cost nothing to run, work without an internet connection, and never hold your data hostage. It is a Node process and one `.db` file.

---

## What you get

| | |
|---|---|
| <img src="docs/media/02-dashboard.jpg" width="400"><br>**Dashboard** — hours per day, top project, billable overage | <img src="docs/media/03-clients-packages.jpg" width="400"><br>**Clients & packages** — retainer (€/month + included hours) or hourly rate |
| <img src="docs/media/04-reports.jpg" width="400"><br>**Reports** — per client, project, person and tag; PDF and CSV export | <img src="docs/media/05-calendar.jpg" width="400"><br>**Calendar** — day / week / month, planned work, Google Calendar import |

**Timers.** As many as you need, running at the same time. Each carries a description, project, person and tags, all editable while it runs — stop saves whatever is current. A persistent timer survives a browser refresh and a server restart.

**Clients and billing.** Two models that can coexist: a retainer (€/month with included hours and an overage rate) or a plain hourly rate, set on the client and overridable per project. The dashboard shows hours consumed against each package.

**Reports and PDF.** Filter by client, person, text, date range or tags — the filter drives the dashboard, the entry list, the report and the export together. The PDF is a branded document with KPIs, package usage, breakdowns per person and per tag, a full day-by-day log, and an optional AI-written summary.

**Voice and text commands (⌘K).** Type or dictate *"start a timer for maintenance on Acme Studio, person Ana, tag bug"*. A local model parses it, shows you exactly what it resolved (which client, which project, which person), and you confirm before anything is written.

<p align="center">
  <img src="docs/media/06-voice-console.jpg" alt="The ⌘K command console" width="620">
</p>

Reads run immediately; **writes require visual confirmation and deletes require double confirmation.** The AI can only call the same action registry the REST API uses — it has no privileged path to the database.

**Web activity (optional).** A browser extension in `extension/` counts time on the active tab of the focused window (idle pauses it) and sends it only to your local instance. You categorise each domain yourself; nothing is auto-labelled and nothing leaves your machine.

**Languages.** English, Romanian, Spanish, German and French. Switching in Settings changes the interface, the PDF export, the error messages *and* the language the AI expects your ⌘K commands in — immediately, without a reload, so a running timer keeps ticking. Dates, month names and number formatting follow the chosen locale rather than being hardcoded.

<p align="center">
  <img src="docs/media/07-language-setting.jpg" alt="The language setting" width="720">
</p>

Every string lives in one file, [`shared/locales.json`](shared/locales.json) — the server hands it to the browser and imports it for the PDF and error paths, so there is no second copy to drift. Adding a language means adding its code to `_meta.langs` and filling in the values; nothing in the code needs to change.

**Planned work.** Mark an entry as planned and it shows hatched in the calendar without counting toward billing until you mark it done. Optionally repeats weekly.

---

## Running it

```bash
npm install
npm start                     # http://localhost:5555
```

Or in Docker, which is how it is meant to run day to day:

```bash
docker build -t timetracker .
docker run -d --name timetracker --restart unless-stopped \
  -p 127.0.0.1:8888:5555 \
  -v "$PWD/data:/app/data" \
  -e OLLAMA_URL=http://host.docker.internal:11434 \
  timetracker
```

Your database is the single file `data/timetracker.db` — **backup is copying that file.** The app also writes timestamped copies into `data/backups/`.

To try it with demo data without touching a real database:

```bash
DATA_DIR=/tmp/tt-demo SEED_DEMO=1 PORT=5599 npm start
```

`TT_LANG` sets the language of a **fresh** install (and of its demo data) — `TT_LANG=en npm start`. Existing instances keep whatever is stored, so an update never changes anyone's language. After the first run, use Settings.

### Local AI (optional, free)

1. Install [Ollama](https://ollama.com)
2. `ollama pull qwen2.5:7b-instruct` (~4–5 GB, once)
3. Pick the model in **Settings**

Everything except the AI features works without it. No API key is ever needed — the model runs on your machine, so commands and reports cost nothing and never leave it.

### Exposing it

For local use there is no auth, by design. If you host it somewhere reachable, set `APP_PASSWORD` (and optionally `APP_USER`) and it will require a login.

---

## How it is built

```
server/
  index.js    Fastify — serves the UI and the REST API
  db.js       SQLite (better-sqlite3, WAL) + schema + optional demo seed
  actions.js  central action registry — the only thing that writes — plus a fuzzy resolver
  i18n.js     the dictionary: t(lang, key), and the browser bundle served at /i18n.js
  ollama.js   local AI: constrained-JSON command parsing, streaming reports
  pdf.js      PDF export (pdfmake, Roboto with diacritics)
public/       vanilla UI — no framework, no build step
extension/    browser extension for web activity
shared/       locales.json — every user-facing string, in all languages
data/         your database (gitignored)
```

**Stack:** Node 20, Fastify, better-sqlite3, vanilla JS, Ollama, pdfmake. No framework, no build step, no cloud account.

The single most important rule: **every write goes through `actions.js`.** The REST API, the UI and the AI all call the same registry, which is why the AI cannot do anything the API cannot, and why every action lands in the audit log.

Architecture and UX decisions were argued out by a council of AI agents — the record is in [DECISION-RECORD.md](./DECISION-RECORD.md).

---

## Contributing

Issues and pull requests are welcome. Useful directions: more languages (add a block to `shared/locales.json` — no code changes needed), other local model backends, and importers from Clockify/Toggl exports.

## License

MIT — see [LICENSE](LICENSE).
