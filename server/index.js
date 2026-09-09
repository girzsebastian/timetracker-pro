import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { db, getSetting, setSetting } from './db.js';
import { ACTIONS, catalog, listEntries, snapshot, getTimers, recentAudit,
  resolvePerson, resolveClient, resolveProject } from './actions.js';
import { ollamaUp, listModels, parseCommand, generateReportText } from './ollama.js';
import { buildReportPdf } from './pdf.js';
import { scheduleBackup, backupNow, listBackups, backupDir } from './backup.js';
import { gcalEvents } from './gcal.js';
import { t, LANGS, normalizeLang, browserBundle } from './i18n.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: false });

/* ---------- auth (activ doar când APP_PASSWORD e setat, ex. pe server) ---------- */
if (process.env.APP_PASSWORD) {
  const { timingSafeEqual } = await import('crypto');
  const expected = Buffer.from(`${process.env.APP_USER || 'sebastian'}:${process.env.APP_PASSWORD}`);
  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization || '';
    const given = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64') : Buffer.alloc(0);
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      reply.header('www-authenticate', 'Basic realm="TimeTracker"');
      return reply.code(401).send({ error: 'authentication required' });
    }
  });
}

await app.register(fastifyStatic, { root: join(here, '..', 'public'), prefix: '/' });

const model = () => getSetting('model', 'qwen2.5:7b-instruct');
// TT_LANG sets the language for a fresh install; existing instances keep
// whatever is stored, so nobody's UI changes language on an update.
const lang = () => normalizeLang(getSetting('lang', process.env.TT_LANG || 'ro'));
const T = (key, vars) => t(lang(), key, vars);

/* The dictionary as a plain script, so app.js has translations before it runs.
   Generated from shared/locales.json on every request — no build step. */
app.get('/i18n.js', async (req, reply) => {
  reply.header('content-type', 'application/javascript; charset=utf-8');
  reply.header('cache-control', 'no-store');
  return browserBundle(lang());
});
const fmtHM = m => { const h = Math.floor(m / 60), x = m % 60; return h + 'h' + (x ? ' ' + x + 'm' : ''); };

/* ---------- data ---------- */
app.get('/api/state', async (req) => snapshot(parseFilter(req.query)));
app.get('/api/entries', async (req) => listEntries(parseFilter(req.query)));
app.get('/api/catalog', async () => catalog());
app.get('/api/audit', async () => recentAudit(40));

function parseFilter(q = {}) {
  return {
    clientId: q.clientId || null, projectId: q.projectId || null, personId: q.personId || null,
    from: q.from || null, to: q.to || null, text: q.text || null,
    tags: q.tags ? String(q.tags).split(',').map(s => s.trim()).filter(Boolean) : [],
    planned: q.planned || null,
  };
}

/* ---------- direct actions (REST) — same registry the voice layer uses ---------- */
app.post('/api/action/:name', async (req, reply) => {
  const fn = ACTIONS[req.params.name];
  if (!fn) return reply.code(404).send({ error: T('err.unknown_action') });
  try { const r = fn(req.body || {}, 'ui'); scheduleBackup(req.params.name); return r; }
  catch (e) { return reply.code(400).send({ error: e.message }); }
});

/* ---------- backups ---------- */
app.get('/api/backups', async () => ({ dir: backupDir, backups: listBackups() }));
app.post('/api/backups', async () => ({ ok: true, file: backupNow('manual') }));

/* ---------- settings ---------- */
app.get('/api/settings', async () => ({ model: model(), ollama: await ollamaUp(), models: await listModels(), gcalUrl: getSetting('gcalUrl', ''), lang: lang(), langs: LANGS }));
app.post('/api/settings', async (req) => {
  if (req.body.model) setSetting('model', req.body.model);
  if (req.body.gcalUrl !== undefined) setSetting('gcalUrl', String(req.body.gcalUrl).trim());
  if (req.body.lang !== undefined) setSetting('lang', normalizeLang(String(req.body.lang)));
  if (req.body.weeklyGoal !== undefined) setSetting('weeklyGoal', Math.max(0, +req.body.weeklyGoal || 0));
  return { ok: true, model: model(), lang: lang() };
});

/* ---------- activitate browser (extensia trimite timp per domeniu, tab activ) ---------- */
app.post('/api/activity/ingest', async (req, reply) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const up = db.prepare('INSERT INTO web_activity(date,domain,seconds) VALUES(?,?,?) ON CONFLICT(date,domain) DO UPDATE SET seconds=seconds+excluded.seconds');
  let ok = 0;
  for (const it of items) {
    const d = String(it.domain || '').toLowerCase().slice(0, 200);
    const s = Math.round(+it.seconds || 0);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : new Date().toISOString().slice(0, 10);
    if (!d || s <= 0 || s > 7200) continue;
    up.run(date, d, s); ok++;
  }
  return { ok };
});
app.get('/api/activity', async (req) => {
  const from = req.query.from || '0000', to = req.query.to || '9999';
  const rows = db.prepare(`SELECT a.domain, SUM(a.seconds) seconds, c.category
    FROM web_activity a LEFT JOIN domain_cats c ON c.domain=a.domain
    WHERE a.date>=? AND a.date<=? GROUP BY a.domain ORDER BY seconds DESC`).all(from, to);
  return { rows };
});
app.post('/api/activity/category', async (req) => {
  const d = String(req.body?.domain || '').toLowerCase();
  const cat = String(req.body?.category || '').trim();
  if (!d) return { ok: false };
  if (cat) db.prepare('INSERT INTO domain_cats(domain,category) VALUES(?,?) ON CONFLICT(domain) DO UPDATE SET category=excluded.category').run(d, cat);
  else db.prepare('DELETE FROM domain_cats WHERE domain=?').run(d);
  return { ok: true };
});

/* ---------- Google Calendar (import read-only prin link iCal secret) ---------- */
app.get('/api/gcal', async (req, reply) => {
  const url = getSetting('gcalUrl', '');
  if (!url) return { events: [] };
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const to = req.query.to || from;
  try { return { events: await gcalEvents(url, from, to) }; }
  catch (e) { return reply.code(502).send({ error: 'Google Calendar: ' + e.message }); }
});

/* ---------- VOICE / TEXT COMMAND ---------- */
// text -> local LLM -> resolved preview (no writes yet). Reads auto-flag; writes need confirm.
app.post('/api/command', async (req, reply) => {
  const text = (req.body?.text || '').trim();
  if (!text) return reply.code(400).send({ error: T('err.empty_text') });
  if (!(await ollamaUp())) return reply.code(503).send({ error: T('err.ollama_start') });

  let plan;
  try { plan = await parseCommand(text, catalog(), model(), lang()); }
  catch (e) { return reply.code(502).send({ error: 'AI: ' + e.message }); }

  const resolved = [];
  for (const a of (plan.actions || [])) {
    const r = resolveAction(a, text);
    resolved.push(r);
  }
  return { reply: plan.reply || '', resolved };
});

const WRITE = new Set(['start_timer', 'stop_timer', 'add_entry', 'create_client', 'create_project', 'create_person', 'delete_entry', 'delete_client']);
const DESTRUCTIVE = new Set(['delete_entry', 'delete_client']);
const READ = new Set(['set_filter', 'navigate', 'generate_report', 'export_pdf']);

function resolveAction(a, sourceText = '') {
  const args = a.args || {};
  const out = { action: a.action, kind: READ.has(a.action) ? 'read' : DESTRUCTIVE.has(a.action) ? 'destructive' : 'write', resolved: {}, exec: {} };
  try {
    if (a.action === 'start_timer' || a.action === 'add_entry') {
      const person = args.personName ? resolvePerson(args.personName) : null;
      const pr = resolveProject(args.clientName, args.projectHint || args.projectName);
      if (pr.ambiguous) { out.ambiguous = true; out.candidates = pr.candidates.map(p => ({ id: p.id, name: p.name })); }
      const hm = s => /^\d{1,2}:\d{2}$/.test(s || '') ? +s.split(':')[0] * 60 + +s.split(':')[1] : null;
      const startMin = hm(args.startTime);
      const endMin = hm(args.endTime);
      // durata din interval, calculată aici — modelele mici greșesc aritmetica
      if (startMin != null && endMin != null) {
        const mins = (endMin - startMin + 1440) % 1440 || null;
        if (mins) { args.hours = Math.floor(mins / 60); args.minutes = mins % 60; }
      }
      let date = /^\d{4}-\d{2}-\d{2}$/.test(args.date || '') ? args.date : null;
      // plasă de siguranță: dacă modelul a omis data dar fraza spune clar "ieri"/"alaltăieri"
      if (!date) {
        const t = sourceText.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const ago = /\balaltaieri\b/.test(t) ? 2 : /\bieri\b/.test(t) ? 1 : 0;
        if (ago) date = new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
      }
      out.resolved = {
        client: pr.client?.name, project: pr.project?.name, person: person?.name,
        tags: args.tags || [], hours: args.hours, minutes: args.minutes, desc: args.desc,
        ...(date ? { data: date } : {}), ...(startMin != null ? { început: args.startTime } : {}),
      };
      out.exec = { desc: args.desc || (pr.project?.name || ''), projectId: pr.project?.id || null, personId: person?.id || null, tags: args.tags || [], hours: args.hours, minutes: args.minutes, ...(date ? { date } : {}), ...(startMin != null ? { startMin } : {}) };
    } else if (a.action === 'stop_timer') {
      out.resolved = { active: getTimers().length };
    } else if (a.action === 'create_client') {
      out.resolved = { name: args.name, cost: args.cost || 0, hours: args.includedHours || args.hours || 0 };
      out.exec = { name: args.name, cost: args.cost || 0, hours: args.includedHours || args.hours || 0 };
    } else if (a.action === 'create_person') {
      out.resolved = { name: args.name }; out.exec = { name: args.name };
    } else if (a.action === 'create_project') {
      const c = args.clientName ? resolveClient(args.clientName) : null;
      out.resolved = { name: args.name, client: c?.name }; out.exec = { name: args.name, clientId: c?.id };
    } else if (a.action === 'set_filter') {
      const c = args.clientName ? resolveClient(args.clientName) : null;
      const p = args.personName ? resolvePerson(args.personName) : null;
      out.exec = { clientId: c?.id || null, personId: p?.id || null, from: args.from || null, to: args.to || null, text: args.text || null, tags: args.tags || [] };
      out.resolved = { client: c?.name, person: p?.name, from: args.from, to: args.to, text: args.text, tags: args.tags || [] };
    } else if (a.action === 'navigate') {
      out.exec = { view: args.view }; out.resolved = { view: args.view };
    } else if (a.action === 'generate_report' || a.action === 'export_pdf') {
      const c = args.clientName ? resolveClient(args.clientName) : null;
      out.exec = { clientId: c?.id || null, from: args.from, to: args.to }; out.resolved = { client: c?.name, from: args.from, to: args.to };
    }
  } catch (e) { out.error = e.message; }
  return out;
}

// confirmed execution of a resolved write action
app.post('/api/command/execute', async (req, reply) => {
  const { action, exec } = req.body || {};
  const fn = ACTIONS[action];
  if (!fn) return reply.code(400).send({ error: T('err.unknown_action') });
  try { const r = fn(exec || {}, 'voice'); scheduleBackup(action); return r; }
  catch (e) { return reply.code(400).send({ error: e.message }); }
});

/* ---------- AI REPORT (streamed narrative) ---------- */
app.post('/api/report', async (req, reply) => {
  if (!(await ollamaUp())) return reply.code(503).send({ error: T('err.ollama_down') });
  const filter = parseFilter(req.body || {});
  filter.planned = 'exclude'; // raportul acoperă doar timp lucrat
  const tip = req.body?.tip || 'intern';
  const entries = listEntries(filter);
  if (!entries.length) return reply.code(400).send({ error: T('err.no_entries') });
  const { clients, projects, people } = catalog();
  const client = c => clients.find(x => x.id === c);
  const project = id => projects.find(p => p.id === id);
  const person = id => people.find(p => p.id === id);
  const total = entries.reduce((s, e) => s + e.mins, 0);
  const lines = [...entries].reverse().map(e => {
    const pr = project(e.project_id);
    return `- ${e.date} · ${fmtHM(e.mins)} · ${person(e.person_id)?.name || '—'} · ${pr ? pr.name + ' (' + (client(pr.client_id)?.name || '') + ')' : ''} · ${e.desc}${e.tags?.length ? ' [' + e.tags.join(', ') + ']' : ''}`;
  });
  const audience = T(tip === 'client' ? 'ai.report_client' : 'ai.report_internal');
  const prompt = `${T('ai.report_lang')} ${audience}
${T('ai.report_total', { total: fmtHM(total), n: entries.length })}
${T('ai.report_entries')}
${lines.join('\n')}
${T('ai.report_struct')}`;

  reply.raw.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  try {
    await generateReportText(prompt, model(), t => reply.raw.write(t));
  } catch (e) { reply.raw.write('\n[' + T('common.error') + ': ' + e.message + ']'); }
  reply.raw.end();
});

/* ---------- PDF ---------- */
app.get('/api/export.pdf', async (req, reply) => {
  const filter = parseFilter(req.query);
  filter.planned = 'exclude'; // PDF-ul acoperă doar timp lucrat
  let narrative = '';
  if (req.query.narrative === '1' && await ollamaUp()) {
    try {
      const entries = listEntries(filter);
      if (entries.length) {
        const total = entries.reduce((s, e) => s + e.mins, 0);
        narrative = await generateReportText(T('ai.pdf_narrative', { n: entries.length, total: fmtHM(total) }), model());
      }
    } catch {}
  }
  const doc = buildReportPdf(filter, narrative);
  reply.header('content-type', 'application/pdf');
  reply.header('content-disposition', 'attachment; filename="raport-timetracker.pdf"');
  reply.send(doc);
  doc.end();
});

/* ---------- boot ---------- */
const PORT = process.env.PORT || 5555;
await app.listen({ port: PORT, host: '0.0.0.0' });
const up = await ollamaUp();
backupNow('startup');
console.log(`\n  ⏱  TimeTracker Pro → http://localhost:${PORT}`);
console.log(`  🗄  Database: data/timetracker.db`);
console.log(`  🌍  Language: ${lang()}  (change it in Settings)`);
console.log(`  💾  Auto-backup: data/backups/ (on every change + at startup)`);
console.log(`  🤖  Ollama: ${up ? 'connected · model ' + model() : 'NOT CONNECTED (run "ollama serve" + install a model)'}\n`);
