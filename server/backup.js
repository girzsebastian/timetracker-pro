// Automatic, self-healing backups. A live SQLite copy is written to data/backups/
// on every write (debounced) and on a timer. Old backups rotate; recent ones are kept.
import { db } from './db.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
export const backupDir = join(here, '..', 'data', 'backups');
mkdirSync(backupDir, { recursive: true });

const KEEP = 40;                 // how many backup files to retain
const DEBOUNCE_MS = 4000;        // coalesce bursts of writes into one backup
let pending = null;

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function backupNow(reason = 'manual') {
  try {
    const file = join(backupDir, `timetracker-${stamp()}.db`);
    // VACUUM INTO produces a clean, consistent single-file copy (no -wal/-shm needed).
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    prune();
    return file;
  } catch (e) {
    console.error('  ⚠️  Backup failed:', e.message);
    return null;
  }
}

// only back up when there is actually something to lose
function hasData() {
  try {
    return db.prepare('SELECT COUNT(*) n FROM clients').get().n
      + db.prepare('SELECT COUNT(*) n FROM entries').get().n
      + db.prepare('SELECT COUNT(*) n FROM projects').get().n > 0;
  } catch { return false; }
}

export function scheduleBackup(reason = 'write') {
  if (!hasData()) return;
  clearTimeout(pending);
  pending = setTimeout(() => backupNow(reason), DEBOUNCE_MS);
}

function prune() {
  const files = readdirSync(backupDir)
    .filter(f => f.startsWith('timetracker-') && f.endsWith('.db'))
    .map(f => ({ f, t: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  files.slice(KEEP).forEach(x => { try { unlinkSync(join(backupDir, x.f)); } catch {} });
}

export function listBackups() {
  return readdirSync(backupDir)
    .filter(f => f.startsWith('timetracker-') && f.endsWith('.db'))
    .map(f => ({ file: f, size: statSync(join(backupDir, f)).size, mtime: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

// safety net: periodic snapshot even if a write hook is ever missed
setInterval(() => scheduleBackup('interval'), 10 * 60 * 1000).unref?.();
