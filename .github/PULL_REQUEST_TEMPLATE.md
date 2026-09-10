## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- What was wrong or missing. -->

## How I tested

<!-- Be specific and be honest about what you did NOT check. -->

- [ ] Booted on a throwaway database (`DATA_DIR=$(mktemp -d) SEED_DEMO=1 PORT=5599 npm start`) and clicked through what I changed
- [ ] I have read [CLA.md](../CLA.md) and I accept it for this and my future contributions
- Node version and browser:
- Manually verified:

## Local-first checklist

- [ ] No entries, clients, rates or reports leave the machine without an explicit user action
- [ ] No telemetry or analytics added
- [ ] Works with Ollama not running
- [ ] No new runtime dependency (or explained above)
- [ ] Schema changes are additive and idempotent; an existing database upgrades without losing data

<!-- If your change touches the database schema, exports, the Ollama client or anything network-facing, say so here. -->
