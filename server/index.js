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
      return reply.code(401).send({ error: 'autentificare necesară' });
    }
  });
}

await app.register(fastifyStatic, { root: join(here, '..', 'public'), prefix: '/' });

const model = () => getSetting('model', 'qwen2.5:7b-instruct');
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
  };
}

/* ---------- direct actions (REST) — same registry the voice layer uses ---------- */
app.post('/api/action/:name', async (req, reply) => {
  const fn = ACTIONS[req.params.name];
  if (!fn) return reply.code(404).send({ error: 'acțiune necunoscută' });
  try { const r = fn(req.body || {}, 'ui'); scheduleBackup(req.params.name); return r; }
  catch (e) { return reply.code(400).send({ error: e.message }); }
});

/* ---------- backups ---------- */
app.get('/api/backups', async () => ({ dir: backupDir, backups: listBackups() }));
app.post('/api/backups', async () => ({ ok: true, file: backupNow('manual') }));

/* ---------- settings ---------- */
app.get('/api/settings', async () => ({ model: model(), ollama: await ollamaUp(), models: await listModels() }));
app.post('/api/settings', async (req) => { if (req.body.model) setSetting('model', req.body.model); return { ok: true, model: model() }; });

/* ---------- VOICE / TEXT COMMAND ---------- */
// text -> local LLM -> resolved preview (no writes yet). Reads auto-flag; writes need confirm.
app.post('/api/command', async (req, reply) => {
  const text = (req.body?.text || '').trim();
  if (!text) return reply.code(400).send({ error: 'text gol' });
  if (!(await ollamaUp())) return reply.code(503).send({ error: 'Ollama nu rulează. Pornește-l (ollama serve) și instalează un model.' });

  let plan;
  try { plan = await parseCommand(text, catalog(), model()); }
  catch (e) { return reply.code(502).send({ error: 'AI: ' + e.message }); }

  const resolved = [];
  for (const a of (plan.actions || [])) {
    const r = resolveAction(a);
    resolved.push(r);
  }
  return { reply: plan.reply || '', resolved };
});

const WRITE = new Set(['start_timer', 'stop_timer', 'add_entry', 'create_client', 'create_project', 'create_person', 'delete_entry', 'delete_client']);
const DESTRUCTIVE = new Set(['delete_entry', 'delete_client']);
const READ = new Set(['set_filter', 'navigate', 'generate_report', 'export_pdf']);

function resolveAction(a) {
  const args = a.args || {};
  const out = { action: a.action, kind: READ.has(a.action) ? 'read' : DESTRUCTIVE.has(a.action) ? 'destructive' : 'write', resolved: {}, exec: {} };
  try {
    if (a.action === 'start_timer' || a.action === 'add_entry') {
      const person = args.personName ? resolvePerson(args.personName) : null;
      const pr = resolveProject(args.clientName, args.projectHint || args.projectName);
      if (pr.ambiguous) { out.ambiguous = true; out.candidates = pr.candidates.map(p => ({ id: p.id, name: p.name })); }
      out.resolved = {
        client: pr.client?.name, project: pr.project?.name, person: person?.name,
        tags: args.tags || [], hours: args.hours, minutes: args.minutes, desc: args.desc,
      };
      out.exec = { desc: args.desc || (pr.project?.name || ''), projectId: pr.project?.id || null, personId: person?.id || null, tags: args.tags || [], hours: args.hours, minutes: args.minutes };
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
  if (!fn) return reply.code(400).send({ error: 'acțiune necunoscută' });
  try { const r = fn(exec || {}, 'voice'); scheduleBackup(action); return r; }
  catch (e) { return reply.code(400).send({ error: e.message }); }
});

/* ---------- AI REPORT (streamed narrative) ---------- */
app.post('/api/report', async (req, reply) => {
  if (!(await ollamaUp())) return reply.code(503).send({ error: 'Ollama nu rulează.' });
  const filter = parseFilter(req.body || {});
  const tip = req.body?.tip || 'intern';
  const entries = listEntries(filter);
  if (!entries.length) return reply.code(400).send({ error: 'Nicio înregistrare' });
  const { clients, projects, people } = catalog();
  const client = c => clients.find(x => x.id === c);
  const project = id => projects.find(p => p.id === id);
  const person = id => people.find(p => p.id === id);
  const total = entries.reduce((s, e) => s + e.mins, 0);
  const lines = [...entries].reverse().map(e => {
    const pr = project(e.project_id);
    return `- ${e.date} · ${fmtHM(e.mins)} · ${person(e.person_id)?.name || '—'} · ${pr ? pr.name + ' (' + (client(pr.client_id)?.name || '') + ')' : ''} · ${e.desc}${e.tags?.length ? ' [' + e.tags.join(', ') + ']' : ''}`;
  });
  const audience = tip === 'client'
    ? 'Un raport pentru CLIENT (extern). Ton profesional, orientat spre valoarea livrată. Explică ce s-a făcut și de ce contează.'
    : 'Un raport INTERN. Ton direct, productivitate: cât s-a lucrat, pe ce, distribuție pe persoane, ce a consumat timpul, observații de eficiență.';
  const prompt = `Scrie un raport în limba română, Markdown. ${audience}
Total: ${fmtHM(total)} pe ${entries.length} înregistrări.
Înregistrări:
${lines.join('\n')}
Structurează cu titluri (##), rezumat la început, grupare pe teme, concluzii. Nu inventa activități. Concis.`;

  reply.raw.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  try {
    await generateReportText(prompt, model(), t => reply.raw.write(t));
  } catch (e) { reply.raw.write('\n[Eroare: ' + e.message + ']'); }
  reply.raw.end();
});

/* ---------- PDF ---------- */
app.get('/api/export.pdf', async (req, reply) => {
  const filter = parseFilter(req.query);
  let narrative = '';
  if (req.query.narrative === '1' && await ollamaUp()) {
    try {
      const entries = listEntries(filter);
      if (entries.length) {
        const total = entries.reduce((s, e) => s + e.mins, 0);
        narrative = await generateReportText(`Scrie un rezumat scurt (3-5 propoziții) în română despre ${entries.length} activități, total ${fmtHM(total)}. Fără liste, doar proză.`, model());
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
console.log(`  🗄  Bază de date: data/timetracker.db`);
console.log(`  💾  Backup automat: data/backups/ (la fiecare modificare + startup)`);
console.log(`  🤖  Ollama: ${up ? 'conectat · model ' + model() : 'NECONECTAT (pornește "ollama serve" + instalează un model)'}\n`);
