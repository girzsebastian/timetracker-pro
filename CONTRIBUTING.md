# Contributing to TimeTracker Pro

Thanks for taking the time. TimeTracker Pro is a single Node process and one
SQLite file, and it is deliberately easy to get running — you should be tracking
demo time within a couple of minutes.

## Ground rules

- **Local-first is not negotiable.** Time entries, clients, rates and reports
  must never leave the machine. A change that sends data to a remote service
  without an explicit, user-initiated action will not be merged.
- **No telemetry.** No analytics SDKs, no crash reporters that phone home, no
  "anonymous" pings.
- **No account, no cloud, no subscription.** Features that need a server the
  user does not run belong in an issue first, not a pull request.
- **AI is optional.** Anything that talks to Ollama must degrade gracefully when
  Ollama is not running. The app has to be fully usable with no model at all.
- **Never touch the user's database in code paths you did not intend to.** All
  reads and writes go through `DATA_DIR`. Migrations must be additive and
  idempotent; a user upgrading must never lose an entry.
- **Keep dependencies few.** Fastify, better-sqlite3 and pdfmake are the whole
  runtime. If your change needs another package, say why in the pull request.

## Set up

    git clone https://github.com/girzsebastian/timetracker-pro.git
    cd timetracker-pro
    npm install

You need Node 22 or newer (`better-sqlite3` ships prebuilt binaries for it).

## Run against a throwaway database

    DATA_DIR=/tmp/tt-demo SEED_DEMO=1 PORT=5599 npm start

Open <http://localhost:5599>. `SEED_DEMO=1` fills the database with three fake
clients (Acme Studio, Clinica Vega, Lumen App) so every screen has something on
it. **Always set `DATA_DIR` while developing** so you never write into the
default `data/` folder, which is where a real installation keeps its hours.

`npm run dev` does the same with `node --watch`, restarting on file changes.

For local AI features (⌘K commands, the report summary) install
[Ollama](https://ollama.com), pull a small model, and point `OLLAMA_URL` at it.
Everything else works without it.

## Where code goes

    server/            Fastify routes, SQLite schema and migrations, Ollama client, PDF
    public/            the web app: plain HTML, CSS and JavaScript, no build step
    shared/            data both sides need, notably locales.json
    extension/         the Chrome extension that starts timers from the browser
    docs/media/        screenshots used by the READMEs

There is no bundler and no framework on the front end. That is a feature: a
contributor can read every file that runs in the browser in an afternoon.

## Languages

The interface ships in English, Romanian, Spanish, German and French. Adding a
language is a data change, not a code change: copy a block in
`shared/locales.json`, translate the values, and it appears in Settings. Please
translate from the English block, and keep placeholders such as `{count}`
intact.

## Test

There is no unit test suite yet; CI boots the server on a temporary database and
checks that the API and the front page answer. Before opening a pull request, do
the same by hand:

    DATA_DIR=$(mktemp -d) SEED_DEMO=1 PORT=5599 npm start
    curl -sf http://localhost:5599/api/state | head -c 200

Then click through whatever your change touches. Say in the pull request what
you tried and what you did *not* try. If you want to add a real test runner,
open an issue first so we agree on one.

## Code style

Match the file you are editing. In practice that means:

- ES modules, two-space indentation, no trailing whitespace, semicolons.
- Comments explain *why*, not *what*. Record the non-obvious reason a future
  reader would otherwise undo.
- User-facing strings go through `shared/locales.json`, never inline.
- User-facing errors are plain and specific. The app tells the user what failed
  and what to do; it does not say "Something went wrong".
- SQL lives in `server/`, parameterised, never string-concatenated.

## Pull requests

1. Branch off `main`.
2. Keep the change focused. One behaviour per PR.
3. Boot it on a throwaway `DATA_DIR` and click through what you changed.
4. Describe what you changed, and say explicitly what you tested.
5. If your change touches the database schema, exports, the Ollama client or
   anything network-facing, call that out in the description.

Small PRs get reviewed fast. Large architectural changes are much better started
as an issue.

## Good places to start

- More languages in `shared/locales.json`.
- Importers for Clockify, Toggl and Harvest CSV exports.
- Other local model backends besides Ollama (LM Studio, llama.cpp server).
- A real test runner and the first tests around the timer and billing logic.
- Accessibility of the web app: keyboard navigation, screen-reader labels.

Issues tagged [`good first issue`](https://github.com/girzsebastian/timetracker-pro/labels/good%20first%20issue)
are scoped small on purpose.

## Reporting bugs

Use the issue templates. A bug is much easier to fix with the Node or Docker
version, the browser, and whether Ollama was running. Never paste an export or a
database that contains real client names or rates — TimeTracker Pro exists so
that data stays yours.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## License and the CLA

TimeTracker Pro is [MIT](LICENSE) and the self-hosted application stays free
and open.

**By opening a pull request you accept [CLA.md](CLA.md).** There is nothing to
sign and no bot to answer — the pull request template asks you to confirm you
have read it, and that is all.

**You keep the copyright to everything you write.** The agreement grants the
project a licence, including the right to distribute contributions under terms
other than MIT. That matters because server-backed features — a hosted
instance, syncing between machines, shared team workspaces — may one day be
offered under different terms to fund the work, and that needs permission from
every copyright holder. Collected up front it costs one reply; collected two
years and twenty contributors later it is not collectable at all.

Nothing you contribute can be removed from the MIT-licensed version. What is
public stays public under MIT, permanently.

**Note for the maintainer:** acceptance happens only through pull requests. A
patch applied by hand from an issue, an email or a fork bypasses it entirely and
lands unlicensed code in the history — which is exactly the hole the agreement
exists to close. Route contributions through pull requests, or get the
contributor's written acceptance before committing.
