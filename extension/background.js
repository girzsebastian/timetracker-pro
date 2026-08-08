// TimeTracker Activity — contorizează DOAR tab-ul activ din fereastra focusată.
// Idle/lock => pauză. Bufferul se trimite la localhost:8888 o dată pe minut.
const API = 'http://localhost:8888/api/activity/ingest';
const IDLE_SECONDS = 90;

let cur = null; // { domain, start }

const hostOf = (url) => {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function getBuffer() { return (await chrome.storage.session.get('buf'))?.buf || {}; }
async function setBuffer(buf) { await chrome.storage.session.set({ buf }); }

async function flushCur() {
  if (!cur) return;
  const secs = Math.round((Date.now() - cur.start) / 1000);
  cur.start = Date.now();
  if (secs <= 0 || secs > 7200) return;
  const buf = await getBuffer();
  const key = today() + '|' + cur.domain;
  buf[key] = (buf[key] || 0) + secs;
  await setBuffer(buf);
}

async function switchTo(domain) {
  await flushCur();
  cur = domain ? { domain, start: Date.now() } : null;
}

async function updateActive() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  if (!enabled) return switchTo(null);
  try {
    const win = await chrome.windows.getLastFocused();
    if (!win || !win.focused) return switchTo(null);
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    const domain = tab?.url ? hostOf(tab.url) : null;
    if (domain !== (cur?.domain || null)) await switchTo(domain);
  } catch { await switchTo(null); }
}

async function send() {
  await flushCur();
  const buf = await getBuffer();
  const items = Object.entries(buf).map(([k, seconds]) => {
    const [date, domain] = [k.slice(0, 10), k.slice(11)];
    return { date, domain, seconds };
  });
  if (!items.length) return;
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) });
    if (r.ok) await setBuffer({});
  } catch { /* aplicația e oprită — păstrăm bufferul și reîncercăm */ }
}

chrome.tabs.onActivated.addListener(updateActive);
chrome.tabs.onUpdated.addListener((id, info, tab) => { if (tab.active && info.url) updateActive(); });
chrome.windows.onFocusChanged.addListener(updateActive);
chrome.idle.setDetectionInterval(IDLE_SECONDS);
chrome.idle.onStateChanged.addListener(async (state) => { state === 'active' ? updateActive() : switchTo(null); });

chrome.alarms.create('flush', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => { if (a.name === 'flush') { await updateActive(); await send(); } });

chrome.runtime.onStartup?.addListener(updateActive);
updateActive();
