# Security Policy

## Supported versions

TimeTracker Pro is a young project. Only `main` and the latest tagged release
receive fixes.

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub Security Advisories:
<https://github.com/girzsebastian/timetracker-pro/security/advisories/new>

Please include what you can: the commit or version, how you run it (Node
directly or Docker), reproduction steps, and the impact you believe it has. You
will get an acknowledgement within a few days, and credit in the release notes
unless you would rather not be named.

## What is in scope

TimeTracker Pro's central promise is that your time entries, clients and rates
stay in a SQLite file on your machine. Anything that breaks that is the
highest-severity class of bug here:

- Entry, client, rate or report data leaving the host without an explicit user
  action (the only outbound calls the app makes by design are to the Ollama URL
  you configure and to Google Calendar import, which you trigger).
- Bypassing the optional `APP_USER` / `APP_PASSWORD` basic auth when it is set.
- Reading or writing outside `DATA_DIR`, or reaching the database of another
  instance on the same host.
- Injection through the ⌘K text and voice command parser: a crafted command
  that writes something other than what the confirmation dialog showed.
- Injection into the generated PDF or CSV exports (formula injection in CSV,
  script or resource loading in PDF).
- The Chrome extension under `extension/` talking to a host other than the one
  the user configured.

## What is not in scope

- The server binds `0.0.0.0` inside the container so Docker can map the port;
  the documented run command publishes it on `127.0.0.1` only. Exposing it
  further is a deployment choice, not a vulnerability. Set basic auth if you do.
- There is no multi-user permission model. Everyone who can reach the port and
  pass basic auth sees everything. That is the design, not a bug.
- Vulnerabilities in Ollama, the models you run through it, or `better-sqlite3`
  belong upstream, though a heads-up here is welcome if TimeTracker Pro's usage
  makes them worse.
