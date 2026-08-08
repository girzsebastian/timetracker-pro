const fmt = s => { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

(async () => {
  const t = document.getElementById('toggle');
  const { enabled = true } = await chrome.storage.local.get('enabled');
  t.checked = enabled;
  t.onchange = () => chrome.storage.local.set({ enabled: t.checked });

  const list = document.getElementById('list'), status = document.getElementById('status');
  try {
    const r = await fetch(`http://localhost:8888/api/activity?from=${today()}&to=${today()}`);
    const { rows } = await r.json();
    const shown = rows.filter(x => x.category !== 'Ignoră').slice(0, 8);
    list.innerHTML = shown.length
      ? shown.map(x => `<div class="row"><span class="d">${x.domain}</span><span class="t">${fmt(x.seconds)}</span></div>`).join('')
      : '<div class="off">Nimic încă azi.</div>';
    status.textContent = 'Conectat la TimeTracker (localhost:8888)';
  } catch {
    list.innerHTML = '<div class="off">TimeTracker nu răspunde.</div>';
    status.textContent = 'Pornește aplicația: docker start timetracker';
  }
})();
