// SQLite layer — one file, WAL, schema on boot. Mirrors the old localStorage shape.
import Database from 'better-sqlite3';
import { t, normalizeLang } from './i18n.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets you run a throwaway instance (demo, screenshots, tests) without
// touching the real database. Defaults to ./data, so existing setups are unchanged.
const dataDir = process.env.DATA_DIR || join(here, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, 'timetracker.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  cost REAL DEFAULT 0, hours REAL DEFAULT 0, overage REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, client_id TEXT, color TEXT DEFAULT '#6366f1',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, mins INTEGER NOT NULL, desc TEXT,
  project_id TEXT, person_id TEXT, tags TEXT DEFAULT '[]', start_min INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT DEFAULT '#2f9bf0',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS timer (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT);
CREATE TABLE IF NOT EXISTS timers (
  id TEXT PRIMARY KEY, desc TEXT, project_id TEXT, person_id TEXT,
  tags TEXT DEFAULT '[]', start INTEGER, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS web_activity (
  date TEXT NOT NULL, domain TEXT NOT NULL, seconds INTEGER DEFAULT 0,
  PRIMARY KEY (date, domain)
);
CREATE TABLE IF NOT EXISTS domain_cats (domain TEXT PRIMARY KEY, category TEXT);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')),
  source TEXT, action TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id);
CREATE INDEX IF NOT EXISTS idx_entries_person ON entries(person_id);
`);

// migrations for pre-existing DBs (add columns if missing)
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!cols('clients').includes('overage')) db.exec('ALTER TABLE clients ADD COLUMN overage REAL DEFAULT 0');
if (!cols('clients').includes('color')) db.exec("ALTER TABLE clients ADD COLUMN color TEXT DEFAULT '#2f9bf0'");
if (!cols('entries').includes('start_min')) db.exec('ALTER TABLE entries ADD COLUMN start_min INTEGER');
if (!cols('clients').includes('rate')) db.exec('ALTER TABLE clients ADD COLUMN rate REAL DEFAULT 0');
if (!cols('projects').includes('hours')) db.exec('ALTER TABLE projects ADD COLUMN hours REAL DEFAULT 0');
if (!cols('projects').includes('rate')) db.exec('ALTER TABLE projects ADD COLUMN rate REAL DEFAULT 0');
if (!cols('entries').includes('planned')) db.exec('ALTER TABLE entries ADD COLUMN planned INTEGER DEFAULT 0');
if (!cols('clients').includes('personal')) db.exec('ALTER TABLE clients ADD COLUMN personal INTEGER DEFAULT 0');

// settings helpers
export const getSetting = (k, def = null) => {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  return r ? JSON.parse(r.value) : def;
};
export const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(k, JSON.stringify(v));

// seed demo data ONLY when explicitly requested (SEED_DEMO=1). Production starts empty.
const SEED_LANG = normalizeLang(process.env.TT_LANG || 'ro');
const S = (key) => t(SEED_LANG, key);

if (process.env.SEED_DEMO === '1' && db.prepare('SELECT COUNT(*) n FROM clients').get().n === 0 && getSetting('seeded') !== true) {
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const insC = db.prepare('INSERT INTO clients(id,name,cost,hours,overage) VALUES(?,?,?,?,?)');
  const insP = db.prepare('INSERT INTO people(id,name) VALUES(?,?)');
  const insPr = db.prepare('INSERT INTO projects(id,name,client_id,color) VALUES(?,?,?,?)');
  const insE = db.prepare('INSERT INTO entries(id,date,mins,desc,project_id,person_id,tags,start_min) VALUES(?,?,?,?,?,?,?,?)');
  const p1 = uid('p'), p2 = uid('p');
  insP.run(p1, 'Ana Pop'); insP.run(p2, 'Radu Ionescu');
  const c1 = uid('c'), c2 = uid('c'), c3 = uid('c');
  insC.run(c1, 'Clinica Vega', 400, 8, 45); insC.run(c2, 'Lumen App', 200, 5, 40); insC.run(c3, 'Acme Studio', 600, 12, 50);
  const pr1 = uid('pr'), pr2 = uid('pr'), pr3 = uid('pr');
  insPr.run(pr1, S('seed.p1'), c1, '#e1b339'); insPr.run(pr2, S('seed.p2'), c2, '#38c6e0'); insPr.run(pr3, S('seed.p3'), c3, '#4bd08a');
  const day = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  insE.run(uid('e'), day(1), 95, S('seed.e1'), pr1, p1, JSON.stringify([S('seed.tag_maint'), 'bug']), 9 * 60 + 15);
  insE.run(uid('e'), day(2), 140, S('seed.e2'), pr1, p2, JSON.stringify([S('seed.tag_changes')]), 11 * 60);
  insE.run(uid('e'), day(3), 60, S('seed.e3'), pr2, p1, JSON.stringify([S('seed.tag_maint')]), 14 * 60 + 30);
  insE.run(uid('e'), day(3), 120, S('seed.e4'), pr3, p2, JSON.stringify([S('seed.tag_changes')]), 10 * 60);
  insE.run(uid('e'), day(5), 210, S('seed.e5'), pr3, p2, JSON.stringify([S('seed.tag_support'), 'bug']), 9 * 60 + 30);
  insE.run(uid('e'), day(6), 45, S('seed.e6'), pr1, p1, JSON.stringify(['bug']), 16 * 60);
  insE.run(uid('e'), day(8), 180, S('seed.e7'), pr3, p1, JSON.stringify([S('seed.tag_changes')]), 13 * 60);
  insE.run(uid('e'), day(4), 360, S('seed.e8'), pr3, p2, JSON.stringify([S('seed.tag_changes')]), 8 * 60);
  setSetting('seeded', true);
}
