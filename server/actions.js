// Central action registry — the ONLY place that writes data.
// Both REST routes and the voice /api/command endpoint dispatch through here.
import { db } from './db.js';

const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const audit = (source, action, detail) =>
  db.prepare('INSERT INTO audit(source,action,detail) VALUES(?,?,?)').run(source, action, JSON.stringify(detail || {}));

/* ---------- read helpers ---------- */
export function catalog() {
  return {
    clients: db.prepare('SELECT * FROM clients ORDER BY name').all(),
    projects: db.prepare('SELECT * FROM projects').all(),
    people: db.prepare('SELECT * FROM people ORDER BY name').all(),
    tags: db.prepare('SELECT * FROM tags ORDER BY name').all(),
  };
}
export function listEntries(filter = {}) {
  const w = [], p = [];
  if (filter.projectId) { w.push('e.project_id=?'); p.push(filter.projectId); }
  if (filter.clientId) { w.push('e.project_id IN (SELECT id FROM projects WHERE client_id=?)'); p.push(filter.clientId); }
  if (filter.personId) { w.push('e.person_id=?'); p.push(filter.personId); }
  if (filter.from) { w.push('e.date>=?'); p.push(filter.from); }
  if (filter.to) { w.push('e.date<=?'); p.push(filter.to); }
  if (filter.text) { w.push('LOWER(e.desc) LIKE ?'); p.push('%' + norm(filter.text) + '%'); }
  if (filter.planned === 'exclude') w.push('COALESCE(e.planned,0)=0');
  if (filter.planned === 'only') w.push('COALESCE(e.planned,0)=1');
  const sql = 'SELECT * FROM entries e' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY date DESC, created_at DESC';
  let rows = db.prepare(sql).all(...p).map(r => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
  if (filter.tags?.length) { const want = filter.tags.map(norm); rows = rows.filter(r => r.tags.some(t => want.includes(norm(t)))); }
  return rows;
}
export function snapshot(filter) {
  return { ...catalog(), entries: listEntries(filter), timers: getTimers(), settings: { model: db.prepare("SELECT value FROM settings WHERE key='model'").get()?.value ? JSON.parse(db.prepare("SELECT value FROM settings WHERE key='model'").get().value) : 'qwen2.5:7b-instruct' } };
}
// multiple concurrent timers
export function getTimers() {
  return db.prepare('SELECT * FROM timers ORDER BY start ASC').all().map(t => ({
    id: t.id, desc: t.desc || '', projectId: t.project_id, personId: t.person_id,
    tags: JSON.parse(t.tags || '[]'), start: t.start,
  }));
}

/* ---------- fuzzy resolution ---------- */
function resolveOne(rows, name) {
  if (!name) return null;
  const n = norm(name);
  return rows.find(r => norm(r.name) === n)
    || rows.find(r => norm(r.name).includes(n) || n.includes(norm(r.name)))
    || null;
}
export function resolvePerson(name) { return resolveOne(db.prepare('SELECT * FROM people').all(), name); }
export function resolveClient(name) { return resolveOne(db.prepare('SELECT * FROM clients').all(), name); }
// client + hint -> ONE project, or { ambiguous, candidates }
export function resolveProject(clientName, projectHint) {
  const client = clientName ? resolveClient(clientName) : null;
  let projs = db.prepare('SELECT * FROM projects').all();
  if (client) projs = projs.filter(p => p.client_id === client.id);
  if (projectHint) {
    const hit = resolveOne(projs, projectHint);
    if (hit) return { project: hit, client };
  }
  if (projs.length === 1) return { project: projs[0], client };
  if (projs.length === 0) return { project: null, client };
  return { ambiguous: true, candidates: projs, client };
}

/* ---------- write actions (the registry) ---------- */
export const ACTIONS = {
  create_client({ name, cost = 0, hours = 0, overage = 0, rate = 0, color = '#2f9bf0' }, source = 'api') {
    if (!name?.trim()) throw new Error('Numele clientului lipsește');
    const dup = resolveClient(name);
    if (dup && norm(dup.name) === norm(name)) return { warning: 'exists', client: dup };
    const id = uid('c');
    db.prepare('INSERT INTO clients(id,name,cost,hours,overage,rate,color) VALUES(?,?,?,?,?,?,?)').run(id, name.trim(), +cost || 0, +hours || 0, +overage || 0, +rate || 0, color || '#2f9bf0');
    audit(source, 'create_client', { id, name });
    return { client: db.prepare('SELECT * FROM clients WHERE id=?').get(id) };
  },
  update_client({ id, name, cost, hours, overage, rate, color }, source = 'api') {
    const c = db.prepare('SELECT * FROM clients WHERE id=?').get(id);
    if (!c) throw new Error('Client inexistent');
    db.prepare('UPDATE clients SET name=?,cost=?,hours=?,overage=?,rate=?,color=? WHERE id=?')
      .run(name != null ? name.trim() : c.name, cost != null ? +cost : c.cost, hours != null ? +hours : c.hours, overage != null ? +overage : c.overage, rate != null ? +rate : c.rate, color != null ? color : c.color, id);
    audit(source, 'update_client', { id });
    return { client: db.prepare('SELECT * FROM clients WHERE id=?').get(id) };
  },
  create_person({ name }, source = 'api') {
    if (!name?.trim()) throw new Error('Numele lipsește');
    const id = uid('p');
    db.prepare('INSERT INTO people(id,name) VALUES(?,?)').run(id, name.trim());
    audit(source, 'create_person', { id, name });
    return { person: db.prepare('SELECT * FROM people WHERE id=?').get(id) };
  },
  create_tag({ name, color = '#2f9bf0' }, source = 'api') {
    if (!name?.trim()) throw new Error('Numele tagului lipsește');
    const n = norm(name);
    const dup = db.prepare('SELECT * FROM tags').all().find(t => norm(t.name) === n);
    if (dup) return { warning: 'exists', tag: dup };
    const id = uid('tg');
    db.prepare('INSERT INTO tags(id,name,color) VALUES(?,?,?)').run(id, name.trim(), color || '#2f9bf0');
    audit(source, 'create_tag', { id, name });
    return { tag: db.prepare('SELECT * FROM tags WHERE id=?').get(id) };
  },
  update_tag({ id, name, color }, source = 'api') {
    const t = db.prepare('SELECT * FROM tags WHERE id=?').get(id);
    if (!t) throw new Error('Tag inexistent');
    db.prepare('UPDATE tags SET name=?,color=? WHERE id=?')
      .run(name != null && name.trim() ? name.trim() : t.name, color != null ? color : t.color, id);
    audit(source, 'update_tag', { id });
    return { tag: db.prepare('SELECT * FROM tags WHERE id=?').get(id) };
  },
  delete_tag({ id }, source = 'api') {
    db.prepare('DELETE FROM tags WHERE id=?').run(id);
    audit(source, 'delete_tag', { id });
    return { ok: true };
  },
  update_person({ id, name }, source = 'api') {
    const p = db.prepare('SELECT * FROM people WHERE id=?').get(id);
    if (!p) throw new Error('Persoană inexistentă');
    if (name != null && name.trim()) db.prepare('UPDATE people SET name=? WHERE id=?').run(name.trim(), id);
    audit(source, 'update_person', { id });
    return { person: db.prepare('SELECT * FROM people WHERE id=?').get(id) };
  },
  create_project({ name, clientId, clientName, color = '#6366f1', rate = 0 }, source = 'api') {
    if (!name?.trim()) throw new Error('Numele proiectului lipsește');
    const cid = clientId || resolveClient(clientName)?.id || null;
    const id = uid('pr');
    db.prepare('INSERT INTO projects(id,name,client_id,color,rate) VALUES(?,?,?,?,?)').run(id, name.trim(), cid, color, +rate || 0);
    audit(source, 'create_project', { id, name });
    return { project: db.prepare('SELECT * FROM projects WHERE id=?').get(id) };
  },
  update_project({ id, name, color, clientId, rate }, source = 'api') {
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) throw new Error('Proiect inexistent');
    db.prepare('UPDATE projects SET name=?,color=?,client_id=?,rate=? WHERE id=?')
      .run(name != null ? name.trim() : p.name, color != null ? color : p.color, clientId !== undefined ? (clientId || null) : p.client_id, rate != null ? +rate : p.rate, id);
    audit(source, 'update_project', { id });
    return { project: db.prepare('SELECT * FROM projects WHERE id=?').get(id) };
  },
  add_entry({ date, mins, hours, minutes, desc = '', projectId, personId, tags = [], startMin = null, planned = 0, recurWeeks = 0 }, source = 'api') {
    const m = mins != null ? +mins : (+hours || 0) * 60 + (+minutes || 0);
    if (!m) throw new Error('Durata lipsește');
    const baseDate = date || new Date().toISOString().slice(0, 10);
    const ins = db.prepare('INSERT INTO entries(id,date,mins,desc,project_id,person_id,tags,start_min,planned) VALUES(?,?,?,?,?,?,?,?,?)');
    const mk = (d) => {
      const id = uid('e');
      ins.run(id, d, Math.round(m), desc, projectId || null, personId || null, JSON.stringify(tags || []), startMin != null ? Math.round(startMin) : null, planned ? 1 : 0);
      return id;
    };
    const id = mk(baseDate);
    // weekly recurrence: materialize copies for the next N weeks (planned entries only)
    const weeks = Math.min(52, Math.max(0, Math.round(+recurWeeks || 0)));
    const extra = [];
    for (let k = 1; k <= weeks; k++) {
      const d = new Date(baseDate + 'T00:00:00'); d.setDate(d.getDate() + 7 * k);
      extra.push(mk(d.toISOString().slice(0, 10)));
    }
    audit(source, 'add_entry', { id, mins: m, planned: planned ? 1 : 0, recur: weeks });
    return { entry: { ...db.prepare('SELECT * FROM entries WHERE id=?').get(id), tags }, recurred: extra.length };
  },
  update_entry({ id, date, mins, hours, minutes, desc, projectId, personId, tags, startMin, planned }, source = 'api') {
    const e = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
    if (!e) throw new Error('Înregistrare inexistentă');
    const m = mins != null ? +mins
      : (hours != null || minutes != null) ? (+hours || 0) * 60 + (+minutes || 0)
      : e.mins;
    if (!m || m < 1) throw new Error('Durata trebuie să fie cel puțin 1 minut');
    db.prepare('UPDATE entries SET date=?,mins=?,desc=?,project_id=?,person_id=?,tags=?,start_min=?,planned=? WHERE id=?').run(
      date || e.date,
      Math.round(m),
      desc != null ? desc : e.desc,
      projectId !== undefined ? (projectId || null) : e.project_id,
      personId !== undefined ? (personId || null) : e.person_id,
      tags != null ? JSON.stringify(tags) : e.tags,
      startMin !== undefined ? (startMin != null && startMin !== '' ? Math.round(startMin) : null) : e.start_min,
      planned !== undefined ? (planned ? 1 : 0) : (e.planned || 0),
      id
    );
    audit(source, 'update_entry', { id });
    const row = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
    return { entry: { ...row, tags: JSON.parse(row.tags || '[]') } };
  },
  start_timer({ desc = '', projectId, personId, tags = [] }, source = 'api') {
    const id = uid('t');
    db.prepare('INSERT INTO timers(id,desc,project_id,person_id,tags,start) VALUES(?,?,?,?,?,?)')
      .run(id, desc || '', projectId || null, personId || null, JSON.stringify(tags || []), Date.now());
    audit(source, 'start_timer', { id });
    return { timer: getTimers().find(t => t.id === id) };
  },
  // live-edit a running timer (project/person/tags/desc) so STOP saves the latest values
  update_timer({ id, desc, projectId, personId, tags }, source = 'api') {
    const t = db.prepare('SELECT * FROM timers WHERE id=?').get(id);
    if (!t) throw new Error('Cronometru inexistent');
    db.prepare('UPDATE timers SET desc=?,project_id=?,person_id=?,tags=? WHERE id=?').run(
      desc != null ? desc : t.desc,
      projectId !== undefined ? (projectId || null) : t.project_id,
      personId !== undefined ? (personId || null) : t.person_id,
      tags != null ? JSON.stringify(tags) : t.tags,
      id);
    return { timer: getTimers().find(x => x.id === id) };
  },
  // stop a specific timer (or the most recent). Explicit args override stored values,
  // so whatever the user changed right before pressing STOP is what gets saved.
  stop_timer(args = {}, source = 'api') {
    const row = args.id
      ? db.prepare('SELECT * FROM timers WHERE id=?').get(args.id)
      : db.prepare('SELECT * FROM timers ORDER BY start DESC LIMIT 1').get();
    if (!row) return { timer: null };
    const startD = new Date(row.start);
    const mins = Math.max(1, Math.round((Date.now() - row.start) / 60000));
    const startMin = startD.getHours() * 60 + startD.getMinutes();
    const desc = args.desc != null ? args.desc : row.desc;
    const projectId = args.projectId !== undefined ? (args.projectId || null) : row.project_id;
    const personId = args.personId !== undefined ? (args.personId || null) : row.person_id;
    const tags = args.tags != null ? args.tags : JSON.parse(row.tags || '[]');
    const r = ACTIONS.add_entry({ mins, desc: desc || '(cronometru)', projectId, personId, tags, date: startD.toISOString().slice(0, 10), startMin }, source);
    db.prepare('DELETE FROM timers WHERE id=?').run(row.id);
    audit(source, 'stop_timer', { id: row.id, mins });
    return { entry: r.entry, mins };
  },
  // discard a running timer without saving an entry
  discard_timer({ id }, source = 'api') {
    db.prepare('DELETE FROM timers WHERE id=?').run(id);
    audit(source, 'discard_timer', { id });
    return { ok: true };
  },
  delete_entry({ id }, source = 'api') { db.prepare('DELETE FROM entries WHERE id=?').run(id); audit(source, 'delete_entry', { id }); return { ok: true }; },
  delete_client({ id }, source = 'api') { db.prepare('DELETE FROM projects WHERE client_id=?').run(id); db.prepare('DELETE FROM clients WHERE id=?').run(id); audit(source, 'delete_client', { id }); return { ok: true }; },
  delete_project({ id }, source = 'api') { db.prepare('DELETE FROM projects WHERE id=?').run(id); return { ok: true }; },
  delete_person({ id }, source = 'api') { db.prepare('DELETE FROM people WHERE id=?').run(id); return { ok: true }; },
};

export function recentAudit(n = 30) { return db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(n); }
export { norm };
