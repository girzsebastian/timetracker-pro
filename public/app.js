/* TimeTracker Pro — Clockify-style UI, API-driven, voice console. */
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  let ST = { clients: [], projects: [], people: [], entries: [], timer: null };
  let FILTER = { clientId: '', personId: '', text: '', from: '', to: '', tags: '' };
  let dFilter = { clientId: '', personId: '' };
  let calMode = 'week';
  let calRef = startOfDay(new Date());
  let calEnts = [];
  let calKeepScroll = false;
  let GCAL = []; // Google Calendar events for the visible window (read-only)

  const api = (p, o) => fetch('/api' + p, o).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Eroare'); return r.json(); });
  const act = (name, body) => api('/action/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const fetchEntries = (params) => { const q = new URLSearchParams(); Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, v); }); return api('/entries?' + q.toString()); };

  /* ---------- helpers ---------- */
  const client = id => ST.clients.find(c => c.id === id);
  const project = id => ST.projects.find(p => p.id === id);
  const person = id => ST.people.find(p => p.id === id);
  const fmtHM = m => { const h = Math.floor(m / 60), x = m % 60; return h + ':' + String(x).padStart(2, '0'); };
  const fmtHMlong = m => { const h = Math.floor(m / 60), x = m % 60; return h + 'h' + (x ? ' ' + x + 'm' : ''); };
  const fmtHrs = m => (m / 60).toFixed(1);
  const clock = min => min == null ? '' : String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const eur = n => Math.round(n).toLocaleString('ro-RO') + ' €';
  const escp = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const DOW = ['duminică', 'luni', 'marți', 'miercuri', 'joi', 'vineri', 'sâmbătă'];
  const DOWS = ['Dum', 'Lun', 'Mar', 'Mie', 'Joi', 'Vin', 'Sâm'];
  const MON = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
  function mondayOf(d) { d = new Date(d); const g = (d.getDay() + 6) % 7; d.setDate(d.getDate() - g); d.setHours(0, 0, 0, 0); return d; }
  function startOfDay(d) { d = new Date(d); d.setHours(0, 0, 0, 0); return d; }
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const snap15 = m => Math.round(m / 15) * 15;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  function iso(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }
  function qs() { const p = new URLSearchParams(); Object.entries(FILTER).forEach(([k, v]) => { if (v) p.set(k, v); }); return p.toString(); }
  function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

  // overage computation over a set of entries
  // two billing models: subscription (cost + included hours + overage) OR hourly.
  // hourly: each entry is billed at the project's rate, falling back to the client's default rate.
  function clientBilling(c, entries) {
    const cprojects = ST.projects.filter(p => p.client_id === c.id);
    const pids = cprojects.map(p => p.id);
    const rel = entries.filter(e => pids.includes(e.project_id) && !e.planned);
    const mins = rel.reduce((s, e) => s + e.mins, 0);
    const cap = (c.hours || 0) * 60;
    const subscription = (c.cost || 0) > 0 || cap > 0;
    const rateOf = pid => (cprojects.find(p => p.id === pid)?.rate || 0) || (c.rate || 0);
    const overMins = subscription ? Math.max(0, mins - cap) : 0;
    const overCost = (overMins / 60) * (c.overage || 0);
    const hourlyCost = subscription ? 0 : rel.reduce((s, e) => s + (e.mins / 60) * rateOf(e.project_id), 0);
    const hourly = !subscription && (hourlyCost > 0 || (c.rate || 0) > 0 || cprojects.some(p => (p.rate || 0) > 0));
    return { mins, cap, overMins, overCost, hourly, hourlyCost, variable: overCost + hourlyCost, total: (c.cost || 0) + overCost + hourlyCost };
  }

  /* ---------- nav ---------- */
  $$('.nav-item').forEach(b => b.addEventListener('click', () => {
    $$('.view').forEach(v => v.classList.remove('active'));
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    $('#view-' + b.dataset.view).classList.add('active');
    b.classList.add('active');
    const v = b.dataset.view;
    if (v === 'panou') loadDashboard();
    if (v === 'calendar') loadCalendar();
    if (v === 'jurnal') loadAudit();
    if (v === 'setari') loadSettings();
  }));
  function navTo(view) { const b = $$('.nav-item').find(n => n.dataset.view === view); if (b) b.click(); }

  /* ---------- filters ---------- */
  function fillSelect(el, items, ph, txt, valKey = 'id') { if (!el) return; const cur = el.value; el.innerHTML = (ph ? `<option value="">${ph}</option>` : '') + items.map(i => `<option value="${escp(i[valKey])}">${escp(txt(i))}</option>`).join(''); if (cur) el.value = cur; }
  function refreshDropdowns() {
    fillSelect($('#fClient'), ST.clients, 'Toți clienții', c => c.name);
    fillSelect($('#fPerson'), ST.people, 'Toată echipa', p => p.name);
    fillSelect($('#rClient'), ST.clients, 'Toți clienții', c => c.name);
    fillSelect($('#rPerson'), ST.people, 'Toată echipa', p => p.name);
    fillSelect($('#dClient'), ST.clients, 'Toate proiectele', c => c.name);
    fillSelect($('#dPerson'), ST.people, 'Toți', p => p.name);
    const projOpt = p => `${p.name} · ${client(p.client_id)?.name || '—'}`;
    fillSelect($('#tProject'), ST.projects, 'Proiect', projOpt);
    fillSelect($('#tPerson'), ST.people, 'Persoană', p => p.name);
    fillSelect($('#pClient'), ST.clients, 'Client', c => c.name);
    fillSelect($('#rTags'), (ST.tags || []), 'Toate tagurile', t => t.name, 'name');
  }
  ['fClient', 'fPerson', 'fText', 'fFrom', 'fTo', 'fTags'].forEach(id => {
    const el = $('#' + id); const map = { fClient: 'clientId', fPerson: 'personId', fText: 'text', fFrom: 'from', fTo: 'to', fTags: 'tags' };
    el.addEventListener(id === 'fText' || id === 'fTags' ? 'input' : 'change', debounce(() => { FILTER[map[id]] = el.value; loadState(); }, 300));
  });
  $('#fClear').onclick = () => { FILTER = { clientId: '', personId: '', text: '', from: '', to: '', tags: '' }; syncFilterUI(); loadState(); };
  function syncFilterUI() { $('#fClient').value = FILTER.clientId; $('#fPerson').value = FILTER.personId; $('#fText').value = FILTER.text; $('#fFrom').value = FILTER.from; $('#fTo').value = FILTER.to; $('#fTags').value = FILTER.tags; }
  $('#dClient').onchange = () => { dFilter.clientId = $('#dClient').value; loadDashboard(); };
  $('#dPerson').onchange = () => { dFilter.personId = $('#dPerson').value; loadDashboard(); };

  /* ---------- state / cronometru ---------- */
  async function loadState() { ST = await api('/state?' + qs()); refreshDropdowns(); renderTimer(); renderCronometru(); renderClients(); renderProjects(); renderPeople(); renderTags(); renderSide(); renderTagOptions(); }
  function renderTagOptions() {
    const used = ST.entries.flatMap(e => e.tags || []);
    const managed = (ST.tags || []).map(t => t.name);
    const tags = [...new Set([...managed, ...used])].sort((a, b) => a.localeCompare(b, 'ro'));
    const dl = $('#tagOptions'); if (dl) dl.innerHTML = tags.map(t => `<option value="${escp(t)}">`).join('');
  }

  function renderSide() {
    const rev = ST.clients.reduce((s, c) => s + (c.cost || 0), 0);
    $('#sideRevenue').innerHTML = `Venit recurent<b>${eur(rev)}</b>${ST.clients.length} clienți · ${ST.people.length} în echipă`;
  }

  function renderCronometru() {
    // group by week then day
    const byWeek = {};
    ST.entries.forEach(e => { const wk = iso(mondayOf(new Date(e.date))); (byWeek[wk] = byWeek[wk] || []).push(e); });
    const weeks = Object.keys(byWeek).sort((a, b) => b.localeCompare(a));
    $('#entriesList').innerHTML = weeks.map(wk => {
      const ents = byWeek[wk], wTot = ents.reduce((s, e) => s + (e.planned ? 0 : e.mins), 0);
      const mon = new Date(wk), sun = addDays(mon, 6);
      const label = `${mon.getDate()} ${MON[mon.getMonth()].slice(0, 3)} – ${sun.getDate()} ${MON[sun.getMonth()].slice(0, 3)} ${sun.getFullYear()}`;
      const byDay = {}; ents.forEach(e => (byDay[e.date] = byDay[e.date] || []).push(e));
      const days = Object.keys(byDay).sort((a, b) => b.localeCompare(a));
      return `<div class="week-block"><div class="week-head"><b>${label}</b><span class="wt">Total săptămână<b>${fmtHM(wTot)}</b></span></div>
        ${days.map(date => {
        const de = byDay[date].sort((a, b) => (b.start_min ?? 0) - (a.start_min ?? 0)), dTot = de.reduce((s, e) => s + (e.planned ? 0 : e.mins), 0);
        const d = new Date(date);
        return `<div class="day-block"><div class="day-bar"><span class="dt">${d.toLocaleDateString('ro-RO', { weekday: 'short', day: 'numeric', month: 'short' })}</span><span style="display:flex;align-items:center;gap:4px"><span class="dtot">Total<b>${fmtHM(dTot)}</b></span><button class="day-add" data-add-day="${date}" title="Adaugă în ziua asta">+</button></span></div>
          ${de.map(e => {
          const pr = project(e.project_id);
          const range = e.start_min != null ? `${clock(e.start_min)} - ${clock(e.start_min + e.mins)}` : '';
          return `<div class="erow ${e.planned ? 'planned' : ''}" data-eid="${e.id}"><span class="e-dot" style="background:${pr?.color || '#556'}"></span>
            ${e.planned ? '<span class="pl-badge">PLAN</span>' : ''}
            <div class="e-desc"><div class="d1">${escp(e.desc || '(fără descriere)')}</div><div class="d2">${pr ? escp(pr.name) + ' · ' + escp(client(pr.client_id)?.name || '') : 'fără proiect'}</div></div>
            <div class="e-tags">${(e.tags || []).map(t => { const col = tagColor(t); return `<span class="tag"${col ? ` style="color:${col};border-color:${col}"` : ''}>${escp(t)}</span>`; }).join('')}</div>
            <span class="e-person">${escp(person(e.person_id)?.name || '')}</span>
            <span class="e-range">${range}</span><span class="e-dur">${fmtHM(e.mins)}</span>
            <button class="e-act" data-restart="${e.id}" title="Repornește">▷</button>
            <button class="e-act" data-del="entry:${e.id}" title="Șterge">✕</button></div>`;
        }).join('')}</div>`;
      }).join('')}</div>`;
    }).join('') || '<div class="empty">Nicio înregistrare pentru filtrul curent. Pornește cronometrul sau spune „Dă-i drumul".</div>';
  }

  /* ---------- timers (multiple, concurrent) ---------- */
  let tick = null;
  const parseTags = s => s.split(',').map(t => t.trim()).filter(Boolean);

  function renderTimer() {
    const timers = ST.timers || [];
    $('#tElapsed').textContent = timers.length ? '▶ ' + timers.length : '';
    renderActiveTimers(timers);
  }

  function renderActiveTimers(timers) {
    const wrap = $('#activeTimers');
    if (!timers.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; if (tick) { clearInterval(tick); tick = null; } return; }
    wrap.style.display = 'flex';
    const projOpts = sel => ST.projects.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${escp(p.name)} · ${escp(client(p.client_id)?.name || '—')}</option>`).join('');
    const personOpts = sel => ST.people.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${escp(p.name)}</option>`).join('');
    wrap.innerHTML = `<div class="at-head">▶ ${timers.length} ${timers.length === 1 ? 'cronometru activ' : 'cronometre active'} — se salvează ce e aici când dai STOP</div>` +
      timers.map(t => {
        const pr = project(t.projectId);
        return `<div class="atimer" data-tid="${t.id}" style="border-left:3px solid ${pr?.color || 'var(--green)'}">
          <span class="at-pulse"></span>
          <input class="at-desc" data-tf="desc" value="${escp(t.desc)}" placeholder="La ce lucrezi?">
          <select class="at-seg" data-tf="projectId"><option value="">— proiect —</option>${projOpts(t.projectId)}</select>
          <select class="at-seg" data-tf="personId"><option value="">— persoană —</option>${personOpts(t.personId)}</select>
          <input class="at-tags" data-tf="tags" list="tagOptions" value="${escp((t.tags || []).join(', '))}" placeholder="taguri">
          <span class="at-elapsed" data-start="${t.start}">00:00:00</span>
          <button class="at-stop" data-stop="${t.id}">STOP</button>
          <button class="at-x" data-discard="${t.id}" title="Renunță (nu salvează)">✕</button>
        </div>`;
      }).join('');
    // live-persist edits so STOP always saves the latest values
    wrap.querySelectorAll('.atimer').forEach(row => {
      const tid = row.dataset.tid;
      row.querySelectorAll('[data-tf]').forEach(el => {
        const isSel = el.tagName === 'SELECT';
        const save = async () => { const f = el.dataset.tf; const val = f === 'tags' ? parseTags(el.value) : el.value; try { await act('update_timer', { id: tid, [f]: val }); } catch {} };
        el.addEventListener(isSel ? 'change' : 'input', isSel ? save : debounce(save, 500));
      });
    });
    if (!tick) tick = setInterval(paintElapsed, 1000); paintElapsed();
  }
  function paintElapsed() {
    const p = n => String(n).padStart(2, '0');
    $$('.at-elapsed').forEach(el => { const s = Math.max(0, Math.floor((Date.now() - +el.dataset.start) / 1000)); el.textContent = `${p(Math.floor(s / 3600))}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}`; });
  }
  // top bar START always launches a NEW timer (you can run several at once)
  $('#tBtn').addEventListener('click', async () => {
    await act('start_timer', { desc: $('#tDesc').value.trim(), projectId: $('#tProject').value, personId: $('#tPerson').value, tags: parseTags($('#tTags').value) });
    $('#tDesc').value = ''; $('#tTags').value = ''; toast('Cronometru pornit'); loadState();
  });

  /* ---------- CRUD ---------- */
  const resetTrig = (el, c = '#2f9bf0') => { el.dataset.color = c; el.style.background = c; };
  $('#cAdd').onclick = async () => { const n = $('#cName').value.trim(); if (!n) return; await act('create_client', { name: n, cost: +$('#cCost').value || 0, hours: +$('#cHours').value || 0, overage: +$('#cOver').value || 0, rate: +$('#cRate').value || 0, color: $('#cColorTrig').dataset.color }); $('#cName').value = $('#cCost').value = $('#cHours').value = $('#cOver').value = $('#cRate').value = ''; resetTrig($('#cColorTrig')); toast('Client adăugat'); loadState(); };
  $('#pAdd').onclick = async () => { const n = $('#pName').value.trim(); if (!n) return; await act('create_project', { name: n, clientId: $('#pClient').value, rate: +$('#pRate').value || 0, color: $('#pColorTrig').dataset.color }); $('#pName').value = $('#pRate').value = ''; resetTrig($('#pColorTrig')); toast('Proiect adăugat'); loadState(); };
  $('#eAdd').onclick = async () => { const n = $('#eName').value.trim(); if (!n) return; await act('create_person', { name: n }); $('#eName').value = ''; toast('Persoană adăugată'); loadState(); };
  $('#tgAdd').onclick = async () => { const n = $('#tgName').value.trim(); if (!n) return; await act('create_tag', { name: n, color: $('#tgColorTrig').dataset.color }); $('#tgName').value = ''; resetTrig($('#tgColorTrig')); toast('Tag adăugat'); loadState(); };
  document.addEventListener('click', async e => {
    const stop = e.target.closest('[data-stop]');
    if (stop) {
      const r = stop.closest('.atimer');
      await act('stop_timer', { id: stop.dataset.stop, desc: r.querySelector('.at-desc').value.trim(), projectId: r.querySelector('[data-tf="projectId"]').value, personId: r.querySelector('[data-tf="personId"]').value, tags: parseTags(r.querySelector('.at-tags').value) });
      toast('Înregistrare salvată'); await loadState();
      if ($('#view-panou').classList.contains('active')) loadDashboard();
      if ($('#view-calendar').classList.contains('active')) loadCalendar();
      return;
    }
    const disc = e.target.closest('[data-discard]');
    if (disc) { if (!confirm('Renunți la acest cronometru? Timpul nu se salvează.')) return; await act('discard_timer', { id: disc.dataset.discard }); toast('Renunțat'); loadState(); return; }
    const del = e.target.closest('[data-del]');
    if (del) { const [type, id] = del.dataset.del.split(':'); const map = { entry: 'delete_entry', client: 'delete_client', project: 'delete_project', person: 'delete_person', tag: 'delete_tag' }; if (type === 'client' && !confirm('Ștergi clientul și proiectele lui?')) return; await act(map[type], { id }); toast('Șters'); loadState(); if ($('#view-panou').classList.contains('active')) loadDashboard(); return; }
    const rs = e.target.closest('[data-restart]');
    if (rs) { const en = ST.entries.find(x => x.id === rs.dataset.restart); if (en) { await act('start_timer', { desc: en.desc, projectId: en.project_id, personId: en.person_id, tags: en.tags }); toast('Cronometru pornit'); loadState(); } return; }
    const row = e.target.closest('[data-eid]');
    if (row && !e.target.closest('button') && !e.target.closest('.cal-block')) { const id = row.dataset.eid; const en = ST.entries.find(x => x.id === id) || calEnts.find(x => x.id === id); if (en) { openEntryEdit(en); return; } }
    const gc = e.target.closest('[data-gcal]');
    if (gc) { const g = GCAL[+gc.dataset.gcal]; if (g) openEntryNew(g.date, { desc: g.summary, startMin: g.startMin, mins: g.mins || 60 }); return; }
    const addDay = e.target.closest('[data-add-day]');
    if (addDay) { openEntryNew(addDay.dataset.addDay); return; }
  });

  /* ---------- ENTRY MODAL (add / edit) ---------- */
  const emVeil = $('#entryVeil');
  let emEditId = null;
  function emFillSelects() {
    const projOpt = p => `${p.name} · ${client(p.client_id)?.name || '—'}`;
    $('#emProject').innerHTML = '<option value="">— fără proiect —</option>' + ST.projects.map(p => `<option value="${p.id}">${escp(projOpt(p))}</option>`).join('');
    $('#emPerson').innerHTML = '<option value="">— nimeni —</option>' + ST.people.map(p => `<option value="${p.id}">${escp(p.name)}</option>`).join('');
  }
  function openEntryModal() { emFillSelects(); emVeil.classList.add('open'); setTimeout(() => $('#emDesc').focus(), 50); }
  function closeEntryModal() { emVeil.classList.remove('open'); emEditId = null; }
  function openEntryNew(dateISO, prefill = {}) {
    emEditId = null;
    $('#emTitle').textContent = 'Adaugă înregistrare';
    $('#emDelete').style.display = 'none'; $('#emDone').style.display = 'none';
    $('#emDesc').value = prefill.desc || ''; $('#emTags').value = '';
    $('#emDate').value = dateISO || iso(new Date());
    $('#emStart').value = prefill.startMin != null ? clock(prefill.startMin) : '';
    $('#emHours').value = prefill.mins ? Math.floor(prefill.mins / 60) : ''; $('#emMins').value = prefill.mins ? prefill.mins % 60 : '';
    $('#emPlanned').checked = !!prefill.planned; $('#emRecur').value = '0'; $('#emRecurWrap').style.display = '';
    openEntryModal();
    $('#emProject').value = ''; $('#emPerson').value = '';
  }
  function openEntryEdit(en) {
    emEditId = en.id;
    $('#emTitle').textContent = en.planned ? 'Editează planificarea' : 'Editează înregistrarea';
    $('#emDelete').style.display = 'inline-flex';
    $('#emDone').style.display = en.planned ? 'inline-flex' : 'none';
    $('#emDesc').value = en.desc || '';
    $('#emTags').value = (en.tags || []).join(', ');
    $('#emDate').value = en.date;
    $('#emStart').value = en.start_min != null ? clock(en.start_min) : '';
    $('#emHours').value = Math.floor(en.mins / 60); $('#emMins').value = en.mins % 60;
    $('#emPlanned').checked = !!en.planned; $('#emRecur').value = '0'; $('#emRecurWrap').style.display = 'none';
    openEntryModal();
    $('#emProject').value = en.project_id || ''; $('#emPerson').value = en.person_id || '';
  }
  function afterEntryChange() { closeEntryModal(); loadState().then(() => { if ($('#view-panou').classList.contains('active')) loadDashboard(); if ($('#view-calendar').classList.contains('active')) loadCalendar(); }); }
  $('#emClose').onclick = closeEntryModal; $('#emCancel').onclick = closeEntryModal;
  emVeil.addEventListener('click', e => { if (e.target === emVeil) closeEntryModal(); });
  $('#addManual').onclick = () => openEntryNew(iso(new Date()));
  $('#emSave').onclick = async () => {
    const h = +$('#emHours').value || 0, m = +$('#emMins').value || 0, mins = h * 60 + m;
    if (mins < 1) { toast('Pune o durată (ore/minute).'); return; }
    const st = $('#emStart').value; // "HH:MM" or ""
    const startMin = st ? (+st.slice(0, 2) * 60 + +st.slice(3, 5)) : null;
    const payload = { date: $('#emDate').value, mins, desc: $('#emDesc').value.trim(), projectId: $('#emProject').value, personId: $('#emPerson').value, tags: parseTags($('#emTags').value), startMin, planned: $('#emPlanned').checked ? 1 : 0 };
    try {
      if (emEditId) await act('update_entry', { id: emEditId, ...payload });
      else { const r = await act('add_entry', { ...payload, recurWeeks: +$('#emRecur').value || 0 }); if (r.recurred) toast(`Adăugat + ${r.recurred} repetări`); }
      if (emEditId || !+$('#emRecur').value) toast(emEditId ? 'Înregistrare actualizată' : 'Înregistrare adăugată');
      afterEntryChange();
    } catch (e) { toast('Eroare: ' + e.message); }
  };
  $('#emDone').onclick = async () => {
    if (!emEditId) return;
    try { await act('update_entry', { id: emEditId, planned: 0 }); toast('✓ Marcat ca lucrat'); afterEntryChange(); }
    catch (e) { toast('Eroare: ' + e.message); }
  };
  $('#emDelete').onclick = async () => {
    if (!emEditId || !confirm('Ștergi această înregistrare?')) return;
    try { await act('delete_entry', { id: emEditId }); toast('Șters'); afterEntryChange(); }
    catch (e) { toast('Eroare: ' + e.message); }
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && emVeil.classList.contains('open')) closeEntryModal(); });

  /* ---------- DASHBOARD ---------- */
  async function loadDashboard() {
    const wMon = mondayOf(new Date()), wSun = addDays(wMon, 6);
    const now = new Date(), mStart = iso(new Date(now.getFullYear(), now.getMonth(), 1)), mEnd = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    const df = { from: iso(wMon), to: iso(wSun), clientId: dFilter.clientId, personId: dFilter.personId, planned: 'exclude' };
    const [weekEnts, monthEnts] = await Promise.all([fetchEntries(df), fetchEntries({ from: mStart, to: mEnd, planned: 'exclude' })]);

    const total = weekEnts.reduce((s, e) => s + e.mins, 0);
    // top project / client this week
    const byPr = {}; weekEnts.forEach(e => byPr[e.project_id] = (byPr[e.project_id] || 0) + e.mins);
    const topPr = Object.entries(byPr).sort((a, b) => b[1] - a[1])[0];
    const byCl = {}; weekEnts.forEach(e => { const pr = project(e.project_id); if (pr) byCl[pr.client_id] = (byCl[pr.client_id] || 0) + e.mins; });
    const topCl = Object.entries(byCl).sort((a, b) => b[1] - a[1])[0];
    const extraMonth = ST.clients.reduce((s, c) => s + clientBilling(c, monthEnts).variable, 0);

    $('#dashStats').innerHTML = `
      <div class="dstat"><small>Total timp (săptămâna)</small><b>${fmtHM(total)}</b></div>
      <div class="dstat"><small>Top proiect</small><b style="font-size:19px">${topPr ? escp(project(topPr[0])?.name || '—') : '—'}</b><div class="sub">${topPr ? fmtHM(topPr[1]) : ''}</div></div>
      <div class="dstat"><small>Extra facturat (luna)</small><b style="color:var(--amber)">${eur(extraMonth)}</b><div class="sub">ore extra + tarif orar</div></div>`;

    // bar chart: hours per weekday
    const perDay = Array(7).fill(0);
    weekEnts.forEach(e => { const idx = (new Date(e.date).getDay() + 6) % 7; perDay[idx] += e.mins; });
    const maxMin = Math.max(60, ...perDay);
    const maxH = Math.ceil(maxMin / 60);
    $('#dTotal').textContent = fmtHM(total);
    const glines = 4;
    $('#dashChart').innerHTML = total === 0
      ? `<div class="chart-empty"><span class="ce-ic">▢</span><div>Nicio activitate în această săptămână</div></div>`
      : `<div class="chart">
          <div class="yax">${Array.from({ length: glines + 1 }, (_, i) => `<div class="yl">${(maxH * (glines - i) / glines).toFixed(1)}h</div>`).join('')}</div>
          <div class="grid">${Array.from({ length: glines + 1 }, () => `<div class="gline"></div>`).join('')}</div>
          ${perDay.map((m, i) => `<div class="bcol"><div class="btip">${['Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri', 'Sâmbătă', 'Duminică'][i]}: ${fmtHMlong(m)}</div><div class="bar" style="height:${m / (maxH * 60) * 100}%"></div><div class="bx">${['Lun', 'Mar', 'Mie', 'Joi', 'Vin', 'Sâm', 'Dum'][i]}</div></div>`).join('')}
        </div>`;

    // top activities (by description) this week
    const byDesc = {}; weekEnts.forEach(e => { const k = e.desc || '(fără descriere)'; byDesc[k] = (byDesc[k] || 0) + e.mins; });
    const top = Object.entries(byDesc).sort((a, b) => b[1] - a[1]).slice(0, 8);
    $('#topActivities').innerHTML = top.map(([name, m], i) => `<div class="top-row"><span class="tr-dot" style="background:${['#2f9bf0', '#4bd08a', '#f0b429', '#e1b339', '#38c6e0', '#a78bfa', '#f16a6a', '#94a3b8'][i]}"></span><span class="tr-name">${escp(name)}</span><span class="tr-h">${fmtHM(m)}</span></div>`).join('') || '<div class="empty" style="padding:20px">—</div>';

    // client package cards (this month): subscription with overage, or hourly rate
    $('#clientCards').innerHTML = ST.clients.map(c => {
      const b = clientBilling(c, monthEnts), pct = b.cap ? Math.min(100, b.mins / b.cap * 100) : 0, over = b.overMins > 0;
      if (b.hourly) {
        return `<div class="cli-card" style="border-left:3px solid ${c.color || 'var(--accent)'}"><div class="cli-top"><b>${escp(c.name)}</b><span class="rev">${eur(b.total)} luna asta</span></div>
          <div class="cli-hrs"><em>${fmtHMlong(b.mins)}</em> ${c.rate ? '× ' + c.rate + ' €/h' : 'la tarif per proiect'}</div>
          <div class="pbar"><div style="width:${b.mins ? 100 : 0}%"></div></div><div class="cli-st">Tarif orar · fără abonament</div></div>`;
      }
      const st = !b.cap ? `<div class="cli-st">Fără pachet</div>`
        : over ? `<div class="cli-st over">⚠ +${fmtHMlong(b.overMins)} extra → ${eur(b.overCost)}</div>`
        : pct > 80 ? `<div class="cli-st warn">Aproape de limită</div>` : `<div class="cli-st ok">În pachet · ${fmtHMlong(b.cap - b.mins)} rămase</div>`;
      return `<div class="cli-card" style="border-left:3px solid ${c.color || 'var(--accent)'}"><div class="cli-top"><b>${escp(c.name)}</b><span class="rev">${eur(b.total || c.cost || 0)}${over ? ' facturat' : '/lună'}</span></div>
        <div class="cli-hrs"><em>${fmtHMlong(b.mins)}</em> ${b.cap ? 'din ' + fmtHMlong(b.cap) + ' incluse' : ''} ${c.overage ? '· ' + c.overage + ' €/h extra' : ''}</div>
        <div class="pbar ${over ? 'over' : ''}"><div style="width:${b.cap ? pct : (b.mins ? 100 : 0)}%"></div></div>${st}</div>`;
    }).join('') || '<div class="empty">Niciun client.</div>';
  }

  /* ---------- CALENDAR (Zi / Săptămână / Lună) ---------- */
  const H0 = 0, H1 = 23, PX = 48;            // full 24h grid, 48px per hour
  const DOWS_MON = ['Lun', 'Mar', 'Mie', 'Joi', 'Vin', 'Sâm', 'Dum'];

  $('#wPrev').onclick = () => shiftCal(-1);
  $('#wNext').onclick = () => shiftCal(1);
  $('#calToday').onclick = () => { calRef = startOfDay(new Date()); loadCalendar(); };
  $$('#calModes button').forEach(b => b.onclick = () => {
    calMode = b.dataset.mode;
    $$('#calModes button').forEach(x => x.classList.toggle('active', x === b));
    loadCalendar();
  });
  function shiftCal(dir) {
    if (calMode === 'week') calRef = addDays(calRef, 7 * dir);
    else if (calMode === 'day') calRef = addDays(calRef, dir);
    else { const d = new Date(calRef); d.setDate(1); d.setMonth(d.getMonth() + dir); calRef = d; }
    loadCalendar();
  }

  async function loadCalendar() {
    const scroll = $('.cal-scroll'), monthEl = $('#calMonth');
    if (calMode === 'month') {
      $('#calHead').style.display = 'none'; $('#calAllday').style.display = 'none';
      scroll.style.display = 'none'; monthEl.style.display = 'block';
      await renderMonth();
    } else {
      $('#calHead').style.display = 'flex'; scroll.style.display = ''; monthEl.style.display = 'none';
      await renderTimeGrid();
    }
  }

  function nowLineHtml() {
    const n = new Date(); const top = ((n.getHours() * 60 + n.getMinutes() - H0 * 60) / 60) * PX;
    return `<div class="cal-now" style="top:${top}px"><span class="cal-now-dot"></span></div>`;
  }

  async function renderTimeGrid() {
    const nDays = calMode === 'day' ? 1 : 7;
    const start = calMode === 'day' ? startOfDay(calRef) : mondayOf(calRef);
    const end = addDays(start, nDays - 1);
    $('#wLabel').textContent = calMode === 'day'
      ? cap(start.toLocaleDateString('ro-RO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))
      : `${start.getDate()} ${MON[start.getMonth()].slice(0, 3)} – ${end.getDate()} ${MON[end.getMonth()].slice(0, 3)} ${end.getFullYear()}`;

    const scroll = $('.cal-scroll'), prevScroll = scroll.scrollTop;
    const [ents, gcal] = await Promise.all([
      fetchEntries({ from: iso(start), to: iso(end) }),
      api(`/gcal?from=${iso(start)}&to=${iso(end)}`).then(r => r.events || []).catch(() => []),
    ]);
    calEnts = ents; GCAL = gcal;
    const todayISO = iso(new Date());
    const byDay = {}, dayTot = {};
    for (let i = 0; i < nDays; i++) { const k = iso(addDays(start, i)); byDay[k] = []; dayTot[k] = 0; }
    ents.forEach(e => { if (byDay[e.date]) { byDay[e.date].push(e); dayTot[e.date] += e.mins; } });

    // header
    $('#calHead').classList.toggle('one', nDays === 1);
    $('#calHead').innerHTML = '<div class="cal-gut"></div>' + Array.from({ length: nDays }, (_, i) => {
      const d = addDays(start, i), k = iso(d), is = k === todayISO;
      return `<div class="cal-day ${is ? 'today' : ''}"><div class="cd-name">${DOWS[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()].slice(0, 3)}</div><div class="cd-tot">${fmtHM(dayTot[k])}<button class="day-add" data-add-day="${k}" title="Adaugă în ziua asta">+</button></div></div>`;
    }).join('');

    // all-day strip (entries without a start time + all-day Google events)
    const gcalByDay = k => GCAL.filter(g => g.date === k);
    const allday = Array.from({ length: nDays }, (_, i) => byDay[iso(addDays(start, i))].filter(e => e.start_min == null));
    const alldayG = Array.from({ length: nDays }, (_, i) => gcalByDay(iso(addDays(start, i))).filter(g => g.allDay));
    const hasAllday = allday.some(a => a.length) || alldayG.some(a => a.length);
    $('#calAllday').style.display = hasAllday ? 'flex' : 'none';
    $('#calAllday').classList.toggle('one', nDays === 1);
    if (hasAllday) $('#calAllday').innerHTML = '<div class="cal-gut">toată ziua</div>' + allday.map((list, i) => `<div class="ad-col">${list.map(e => { const pr = project(e.project_id); return `<div class="ad-chip ${e.planned ? 'planned' : ''}" data-eid="${e.id}" style="background:${pr?.color || '#556'}" title="${escp(e.desc)}">${e.planned ? '◌ ' : ''}${escp(e.desc || '—')} · ${fmtHM(e.mins)}</div>`; }).join('')}${alldayG[i].map(g => `<div class="ad-chip gcal" data-gcal="${GCAL.indexOf(g)}" title="Google Calendar — click pentru a transforma în înregistrare">⧉ ${escp(g.summary)}</div>`).join('')}</div>`).join('');

    // grid
    const gutter = `<div class="cal-gutter">${Array.from({ length: H1 - H0 + 1 }, (_, i) => `<div class="cal-hour"><span class="hl">${String(H0 + i).padStart(2, '0')}:00</span></div>`).join('')}</div>`;
    const cols = Array.from({ length: nDays }, (_, i) => {
      const d = addDays(start, i), k = iso(d);
      const timed = byDay[k].filter(e => e.start_min != null);
      const blocks = timed.map(e => {
        const pr = project(e.project_id);
        const top = ((e.start_min - H0 * 60) / 60) * PX;
        const h = Math.max(15, (e.mins / 60) * PX);
        return `<div class="cal-block ${e.planned ? 'planned' : ''}" data-eid="${e.id}" style="top:${top}px;height:${h}px;background:${pr?.color || '#556'}"><div class="cb-t">${e.planned ? '◌ ' : ''}${escp(e.desc || '—')}</div><div class="cb-h">${clock(e.start_min)}–${clock(e.start_min + e.mins)}</div></div>`;
      }).join('');
      const gblocks = gcalByDay(k).filter(g => !g.allDay).map(g => {
        const top = ((g.startMin - H0 * 60) / 60) * PX;
        const h = Math.max(15, (g.mins / 60) * PX);
        return `<div class="gcal-ev" data-gcal="${GCAL.indexOf(g)}" style="top:${top}px;height:${h}px" title="Google Calendar — click pentru a transforma în înregistrare">⧉ ${escp(g.summary)}</div>`;
      }).join('');
      return `<div class="cal-col" data-date="${k}">${Array.from({ length: H1 - H0 + 1 }, () => `<div class="cal-hour"></div>`).join('')}${gblocks}${blocks}${k === todayISO ? nowLineHtml() : ''}</div>`;
    }).join('');
    $('#calGrid').innerHTML = gutter + cols;

    // scroll: preserve on drag-refresh, otherwise focus around now / morning
    if (calKeepScroll) { scroll.scrollTop = prevScroll; calKeepScroll = false; }
    else { const t = new Date(); scroll.scrollTop = (t >= start && t <= addDays(end, 1)) ? Math.max(0, (t.getHours() - 2) * PX) : 7 * PX; }
  }

  async function renderMonth() {
    const first = new Date(calRef.getFullYear(), calRef.getMonth(), 1);
    const gridStart = mondayOf(first);
    const gridEnd = addDays(mondayOf(new Date(calRef.getFullYear(), calRef.getMonth() + 1, 0)), 6);
    $('#wLabel').textContent = `${cap(MON[calRef.getMonth()])} ${calRef.getFullYear()}`;
    const ents = await fetchEntries({ from: iso(gridStart), to: iso(gridEnd) });
    calEnts = ents;
    const byDay = {}; ents.forEach(e => (byDay[e.date] = byDay[e.date] || []).push(e));
    const todayISO = iso(new Date()), curMonth = calRef.getMonth();

    const head = DOWS_MON.map(d => `<div class="mcell-h">${d}</div>`).join('');
    const cells = [];
    for (let cur = new Date(gridStart); cur <= gridEnd; cur = addDays(cur, 1)) {
      const d = new Date(cur), k = iso(d);
      const list = (byDay[k] || []).slice().sort((a, b) => (a.start_min ?? 0) - (b.start_min ?? 0));
      const tot = list.reduce((s, e) => s + (e.planned ? 0 : e.mins), 0);
      const chips = list.slice(0, 3).map(e => { const pr = project(e.project_id); return `<div class="m-chip ${e.planned ? 'planned' : ''}" data-eid="${e.id}" style="border-left-color:${pr?.color || '#556'}" title="${escp(e.desc)}">${e.planned ? '◌ ' : ''}${e.start_min != null ? '<b>' + clock(e.start_min) + '</b> ' : ''}${escp(e.desc || '—')}</div>`; }).join('');
      const more = list.length > 3 ? `<div class="m-more">+${list.length - 3} altele</div>` : '';
      cells.push(`<div class="mcell ${d.getMonth() === curMonth ? '' : 'out'} ${k === todayISO ? 'today' : ''}" data-add-day="${k}"><div class="mcell-top"><span class="mday">${d.getDate()}</span>${tot ? `<span class="mtot">${fmtHM(tot)}</span>` : ''}</div>${chips}${more}</div>`);
    }
    $('#calMonth').innerHTML = `<div class="m-head">${head}</div><div class="m-grid">${cells.join('')}</div>`;
  }

  // drag-to-move on the time grid (vertical = new start time, horizontal = new day in week view)
  let calDrag = null;
  const grid = $('#calGrid');
  grid.addEventListener('pointerdown', e => {
    const block = e.target.closest('.cal-block'); if (!block || e.button !== 0) return;
    e.preventDefault();
    const cols = $$('#calGrid .cal-col');
    const en = calEnts.find(x => x.id === block.dataset.eid);
    calDrag = {
      id: block.dataset.eid, block, mins: en?.mins || 60, moved: false,
      startX: e.clientX, startY: e.clientY, origTop: parseFloat(block.style.top),
      cols, colW: cols[0]?.getBoundingClientRect().width || 0, gridLeft: cols[0]?.getBoundingClientRect().left || 0,
      date: block.parentElement.dataset.date, targetDate: block.parentElement.dataset.date,
    };
    block.classList.add('dragging'); block.setPointerCapture(e.pointerId);
  });
  grid.addEventListener('pointermove', e => {
    if (!calDrag) return;
    const dx = e.clientX - calDrag.startX, dy = e.clientY - calDrag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) calDrag.moved = true;
    const maxTop = (H1 - H0 + 1) * PX - calDrag.block.offsetHeight;
    const newTop = clamp(calDrag.origTop + dy, 0, maxTop);
    calDrag.block.style.top = newTop + 'px';
    if (calMode !== 'day' && calDrag.colW) {
      const idx = clamp(Math.floor((e.clientX - calDrag.gridLeft) / calDrag.colW), 0, calDrag.cols.length - 1);
      const col = calDrag.cols[idx];
      if (col && col !== calDrag.block.parentElement) { col.appendChild(calDrag.block); calDrag.targetDate = col.dataset.date; }
    }
    const sm = clamp(snap15((newTop / PX) * 60 + H0 * 60), 0, 24 * 60 - calDrag.mins);
    const hh = calDrag.block.querySelector('.cb-h'); if (hh) hh.textContent = `${clock(sm)}–${clock(sm + calDrag.mins)}`;
  });
  async function endDrag(e) {
    if (!calDrag) return; const d = calDrag; calDrag = null;
    d.block.classList.remove('dragging');
    if (!d.moved) { const en = calEnts.find(x => x.id === d.id); if (en) openEntryEdit(en); return; }
    const startMin = clamp(snap15((parseFloat(d.block.style.top) / PX) * 60 + H0 * 60), 0, 24 * 60 - d.mins);
    try { calKeepScroll = true; await act('update_entry', { id: d.id, startMin, date: d.targetDate }); toast('Mutat'); }
    catch (err) { toast('Eroare: ' + err.message); }
    loadCalendar();
  }
  grid.addEventListener('pointerup', endDrag);
  grid.addEventListener('pointercancel', () => { if (calDrag) { calDrag.block.classList.remove('dragging'); calDrag = null; loadCalendar(); } });

  // live current-time line
  setInterval(() => {
    if (!$('#view-calendar').classList.contains('active') || calMode === 'month') return;
    const n = new Date(), top = ((n.getHours() * 60 + n.getMinutes() - H0 * 60) / 60) * PX;
    $$('.cal-now').forEach(el => el.style.top = top + 'px');
  }, 60000);

  /* ---------- color palette picker (presets + custom) ---------- */
  const PALETTE = ['#2f9bf0', '#4bd08a', '#f0b429', '#f16a6a', '#a78bfa', '#38c6e0', '#fb923c', '#ec4899', '#14b8a6', '#84cc16', '#64748b', '#e11d48'];
  const colorPop = $('#colorPop');
  let colorCb = null;
  function openColorPop(anchor, current, cb) {
    colorCb = cb;
    $('#cpGrid').innerHTML = PALETTE.map(c => `<button type="button" class="cp-sw ${String(current).toLowerCase() === c.toLowerCase() ? 'sel' : ''}" style="background:${c}" data-c="${c}" title="${c}"></button>`).join('');
    $('#cpCustom').value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#2f9bf0';
    colorPop.classList.add('open');
    const r = anchor.getBoundingClientRect(), pw = 208;
    colorPop.style.top = (r.bottom + window.scrollY + 6) + 'px';
    colorPop.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - pw - 8)) + 'px';
  }
  function closeColorPop() { colorPop.classList.remove('open'); colorCb = null; }
  $('#cpGrid').addEventListener('click', e => { const b = e.target.closest('[data-c]'); if (!b || !colorCb) return; colorCb(b.dataset.c); closeColorPop(); });
  $('#cpCustom').addEventListener('change', () => { if (colorCb) { colorCb($('#cpCustom').value); closeColorPop(); } });
  document.addEventListener('click', e => {
    const trig = e.target.closest('[data-colortrig]');
    if (trig) {
      const kind = trig.dataset.ck, id = trig.dataset.id, cur = trig.dataset.color || '#2f9bf0';
      openColorPop(trig, cur, async (color) => {
        if (kind === 'newclient' || kind === 'newproject' || kind === 'newtag') { trig.dataset.color = color; trig.style.background = color; }
        else if (kind === 'client') { await act('update_client', { id, color }); toast('Culoare actualizată'); loadState(); }
        else if (kind === 'project') { await act('update_project', { id, color }); toast('Culoare actualizată'); loadState(); }
        else if (kind === 'tag') { await act('update_tag', { id, color }); toast('Culoare actualizată'); loadState(); }
      });
      return;
    }
    if (colorPop.classList.contains('open') && !colorPop.contains(e.target)) closeColorPop();
  });

  // color helper: managed tag -> its color (for coloring tag chips)
  function tagColor(name) { const t = (ST.tags || []).find(x => norm(x.name) === norm(name)); return t?.color || null; }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }

  /* ---------- lists ---------- */
  function renderClients() {
    $('#clientList').innerHTML = ST.clients.map(c => `<div class="lrow"><button type="button" class="sw-color" data-colortrig data-ck="client" data-id="${c.id}" data-color="${c.color || '#2f9bf0'}" style="background:${c.color || '#2f9bf0'}" title="culoare client"></button>
      <div style="min-width:0"><input class="name-edit" value="${escp(c.name)}" data-cname="${c.id}" title="click pentru a redenumi"><div class="meta">${ST.projects.filter(p => p.client_id === c.id).length} proiecte</div></div>
      <div class="spacer"></div>
      <label class="pill" style="cursor:pointer">Abonament <input type="number" value="${c.cost || 0}" data-edit="cost:${c.id}" style="width:60px;background:transparent;border:none;color:var(--ink);font-weight:600;text-align:right"> €</label>
      <label class="pill" style="cursor:pointer">Incluse <input type="number" value="${c.hours || 0}" data-edit="hours:${c.id}" style="width:44px;background:transparent;border:none;color:var(--ink);font-weight:600;text-align:right"> h</label>
      <label class="pill" style="cursor:pointer">Extra <input type="number" value="${c.overage || 0}" data-edit="overage:${c.id}" style="width:44px;background:transparent;border:none;color:var(--amber);font-weight:600;text-align:right"> €/h</label>
      <label class="pill" style="cursor:pointer" title="pentru clienți fără abonament: ore lucrate × tarif">Tarif <input type="number" value="${c.rate || 0}" data-edit="rate:${c.id}" style="width:44px;background:transparent;border:none;color:var(--green);font-weight:600;text-align:right"> €/h</label>
      <button class="e-del" data-del="client:${c.id}">✕</button></div>`).join('') || '<div class="empty">Niciun client. Adaugă primul mai sus.</div>';
    $$('[data-edit]').forEach(inp => inp.addEventListener('change', async () => { const [field, id] = inp.dataset.edit.split(':'); await act('update_client', { id, [field]: +inp.value || 0 }); toast('Actualizat'); loadState(); }));
    $$('[data-cname]').forEach(inp => inp.addEventListener('change', async () => { if (!inp.value.trim()) { loadState(); return; } await act('update_client', { id: inp.dataset.cname, name: inp.value.trim() }); toast('Redenumit'); loadState(); }));
  }
  function renderProjects() {
    const cliOpts = sel => `<option value="">— fără client —</option>` + ST.clients.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${escp(c.name)}</option>`).join('');
    $('#projectList').innerHTML = ST.projects.map(p => {
      const cliRate = client(p.client_id)?.rate || 0;
      const eff = (p.rate || 0) || cliRate;
      const hint = !p.rate && cliRate ? `<div class="meta">moștenit de la client: ${cliRate} €/h</div>` : '';
      return `<div class="lrow"><button type="button" class="sw-color" data-colortrig data-ck="project" data-id="${p.id}" data-color="${p.color || '#2f9bf0'}" style="background:${p.color || '#2f9bf0'}" title="culoare proiect"></button>
      <div style="min-width:0"><input class="name-edit" value="${escp(p.name)}" data-pname="${p.id}" title="click pentru a redenumi">${hint}</div>
      <div class="spacer"></div>
      <label class="pill" style="cursor:pointer" title="cost per oră pentru acest proiect; 0 = se folosește tariful clientului">Tarif <input type="number" value="${p.rate || 0}" data-prate="${p.id}" min="0" style="width:44px;background:transparent;border:none;color:${eff ? 'var(--green)' : 'var(--ink)'};font-weight:600;text-align:right"> €/h</label>
      <select class="pill-sel" data-pclient="${p.id}" title="client">${cliOpts(p.client_id)}</select>
      <button class="e-del" data-del="project:${p.id}">✕</button></div>`;
    }).join('') || '<div class="empty">Niciun proiect. Adaugă primul mai sus.</div>';
    $$('[data-pname]').forEach(inp => inp.addEventListener('change', async () => { if (!inp.value.trim()) { loadState(); return; } await act('update_project', { id: inp.dataset.pname, name: inp.value.trim() }); toast('Redenumit'); loadState(); }));
    $$('[data-prate]').forEach(inp => inp.addEventListener('change', async () => { await act('update_project', { id: inp.dataset.prate, rate: +inp.value || 0 }); toast('Tarif actualizat'); loadState(); }));
    $$('[data-pclient]').forEach(sel => sel.addEventListener('change', async () => { await act('update_project', { id: sel.dataset.pclient, clientId: sel.value }); toast('Client actualizat'); loadState(); }));
  }
  function renderPeople() {
    $('#peopleList').innerHTML = ST.people.map(p => `<div class="lrow"><span class="sw" style="background:var(--accent-h)"></span><div style="min-width:0"><input class="name-edit" value="${escp(p.name)}" data-ename="${p.id}" title="click pentru a redenumi"></div><div class="spacer"></div><button class="e-del" data-del="person:${p.id}">✕</button></div>`).join('') || '<div class="empty">Nicio persoană. Adaugă prima mai sus.</div>';
    $$('[data-ename]').forEach(inp => inp.addEventListener('change', async () => { if (!inp.value.trim()) { loadState(); return; } await act('update_person', { id: inp.dataset.ename, name: inp.value.trim() }); toast('Redenumit'); loadState(); }));
  }
  function renderTags() {
    const el = $('#tagList'); if (!el) return;
    const count = name => ST.entries.filter(e => (e.tags || []).some(t => norm(t) === norm(name))).length;
    el.innerHTML = (ST.tags || []).map(t => `<div class="lrow"><button type="button" class="sw-color" data-colortrig data-ck="tag" data-id="${t.id}" data-color="${t.color || '#2f9bf0'}" style="background:${t.color || '#2f9bf0'}" title="culoare tag"></button>
      <div style="min-width:0"><input class="name-edit" value="${escp(t.name)}" data-tgname="${t.id}" title="click pentru a redenumi"></div>
      <div class="spacer"></div>
      <span class="meta">${count(t.name)} înregistrări</span>
      <button class="e-del" data-del="tag:${t.id}">✕</button></div>`).join('') || '<div class="empty">Niciun tag. Creează primul mai sus.</div>';
    $$('[data-tgname]').forEach(inp => inp.addEventListener('change', async () => { if (!inp.value.trim()) { loadState(); return; } await act('update_tag', { id: inp.dataset.tgname, name: inp.value.trim() }); toast('Redenumit'); loadState(); }));
  }

  /* ---------- report ---------- */
  ['rClient', 'rPerson', 'rFrom', 'rTo'].forEach(id => $('#' + id)?.addEventListener('change', () => { }));
  function reportFilter() { return { clientId: $('#rClient').value, personId: $('#rPerson').value, from: $('#rFrom').value, to: $('#rTo').value, tags: $('#rTags').value ? [$('#rTags').value] : [], tip: $('#rTip').value }; }
  $('#rGen').onclick = async () => {
    const out = $('#reportOut'), body = $('#reportBody'); out.style.display = 'block'; body.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
    try {
      const res = await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reportFilter()) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Eroare');
      const reader = res.body.getReader(), dec = new TextDecoder(); let txt = ''; body.innerHTML = '';
      while (true) { const { done, value } = await reader.read(); if (done) break; txt += dec.decode(value, { stream: true }); body.innerHTML = mdToHtml(txt); }
    } catch (e) { body.innerHTML = `<p style="color:var(--red)">${escp(e.message)}</p><p class="hint">Verifică Ollama în Setări.</p>`; }
  };
  $('#rPdf').onclick = () => { const p = new URLSearchParams(); const f = reportFilter(); Object.entries(f).forEach(([k, v]) => { if (k === 'tip') return; if (Array.isArray(v)) { if (v.length) p.set(k, v.join(',')); } else if (v) p.set(k, v); }); p.set('narrative', '1'); window.location = '/api/export.pdf?' + p.toString(); };
  $('#rCopy').onclick = () => { navigator.clipboard.writeText($('#reportBody').innerText); toast('Copiat'); };

  async function loadAudit() { const rows = await api('/audit'); $('#auditList').innerHTML = rows.map(r => `<div class="audit-row"><span class="at">${r.ts.slice(11, 16)}</span><span class="av">${r.action}</span><span>${escp(r.source)}</span></div>`).join('') || '<div class="empty">Nicio acțiune.</div>'; }

  async function loadSettings() {
    const s = await api('/settings');
    $('#aiDot').className = 'ai-dot ' + (s.ollama ? 'on' : 'off'); $('#aiDot2').className = 'ai-dot ' + (s.ollama ? 'on' : 'off');
    $('#sModel').innerHTML = (s.models.length ? s.models : [s.model]).map(m => `<option value="${m}">${m}</option>`).join(''); $('#sModel').value = s.model;
    $('#aiHint').innerHTML = s.ollama ? `✓ Ollama conectat. Modele: ${s.models.join(', ') || '—'}` : 'Ollama nu rulează. Pornește <span class="kbd">ollama serve</span> apoi <span class="kbd">ollama pull qwen2.5:7b-instruct</span>.';
    $('#sGcal').value = s.gcalUrl || '';
  }
  $('#sGcalSave').onclick = async () => {
    await api('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gcalUrl: $('#sGcal').value.trim() }) });
    toast($('#sGcal').value.trim() ? 'Google Calendar conectat' : 'Google Calendar deconectat');
    if ($('#view-calendar').classList.contains('active')) loadCalendar();
  };
  $('#sSave').onclick = async () => { await api('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: $('#sModel').value }) }); toast('Model salvat'); };
  $('#sRefresh').onclick = loadSettings;
  $('#sExport').onclick = async () => { const d = await api('/state'); const b = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'timetracker-backup.json'; a.click(); };

  /* ---------- COMMAND CONSOLE ---------- */
  const veil = $('#cmdVeil'), input = $('#cmdInput'), stateEl = $('#cmdState'), body = $('#cmdBody'), goBtn = $('#cmdGo'), mic = $('#cmdMic');
  let resolvedActions = [];
  function openCmd() { veil.classList.add('open'); setTimeout(() => input.focus(), 50); setState('idle'); }
  function closeCmd() { veil.classList.remove('open'); stopListen(); }
  function setState(s) { const map = { idle: 'Idle', listening: 'Ascult…', thinking: 'Interpretez…', preview: 'Confirmă', done: 'Executat' }; stateEl.textContent = map[s]; stateEl.className = 'cmd-state ' + (s === 'idle' ? '' : s); goBtn.textContent = s === 'preview' ? 'Dă-i drumul ✓' : 'Interpretează'; goBtn.style.background = s === 'preview' ? 'var(--green)' : 'var(--accent)'; }
  $('#cmdLaunch').onclick = openCmd; $('#cmdCancel').onclick = closeCmd;
  veil.addEventListener('click', e => { if (e.target === veil) closeCmd(); });
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); veil.classList.contains('open') ? closeCmd() : openCmd(); } if (e.key === 'Escape' && veil.classList.contains('open')) closeCmd(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); goBtn.click(); } });
  goBtn.onclick = async () => {
    if (resolvedActions.length) return executeAll();
    const text = input.value.trim(); if (!text) return;
    setState('thinking'); body.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
    try { const res = await api('/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); renderPreview(res); setState('preview'); }
    catch (e) { body.innerHTML = `<p style="color:var(--red)">${escp(e.message)}</p>`; setState('idle'); }
  };
  function renderPreview(res) {
    resolvedActions = res.resolved || [];
    const verb = { start_timer: 'Pornește cronometru', stop_timer: 'Oprește cronometru', add_entry: 'Adaugă înregistrare', create_client: 'Client nou', create_project: 'Proiect nou', create_person: 'Persoană nouă', set_filter: 'Filtrează', navigate: 'Navighează', generate_report: 'Generează raport', export_pdf: 'Export PDF', delete_entry: 'Șterge înregistrare', delete_client: 'Șterge client' };
    let html = res.reply ? `<div class="cmd-reply">${escp(res.reply)}</div>` : '';
    if (!resolvedActions.length) html += '<div class="cmd-hint">Nu am identificat nicio acțiune. Reformulează.</div>';
    resolvedActions.forEach((a, i) => {
      const kv = Object.entries(a.resolved || {}).filter(([k, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => `<span class="kv">${k}: <b>${escp(Array.isArray(v) ? v.join(', ') : v)}</b></span>`).join('');
      const amb = a.ambiguous ? `<div class="pc-amb">Care proiect? <select data-amb="${i}">${a.candidates.map(c => `<option value="${c.id}">${escp(c.name)}</option>`).join('')}</select></div>` : '';
      html += `<div class="pchip ${a.kind}" data-chip="${i}"><div class="pc-head"><span class="pc-verb">${verb[a.action] || a.action}</span><span class="pc-kind">${a.kind}</span></div><div class="pc-fields">${kv || '<span class="kv" style="color:var(--ink3)">—</span>'}</div>${amb}<div class="pc-done" style="display:none">✓ Executat</div></div>`;
    });
    body.innerHTML = html;
    $$('[data-amb]').forEach(sel => sel.addEventListener('change', () => { resolvedActions[+sel.dataset.amb].exec.projectId = sel.value; resolvedActions[+sel.dataset.amb].ambiguous = false; }));
    $('#cmdFyi').textContent = resolvedActions.some(a => a.kind !== 'read') ? 'Verifică, apoi „Dă-i drumul".' : '';
  }
  async function executeAll() {
    for (let i = 0; i < resolvedActions.length; i++) {
      const a = resolvedActions[i];
      try {
        if (a.action === 'set_filter') { FILTER = { clientId: a.exec.clientId || '', personId: a.exec.personId || '', text: a.exec.text || '', from: a.exec.from || '', to: a.exec.to || '', tags: (a.exec.tags || []).join(',') }; syncFilterUI(); navTo('cronometru'); await loadState(); }
        else if (a.action === 'navigate') { navTo(a.exec.view); }
        else if (a.action === 'generate_report') { navTo('raport'); setTimeout(() => $('#rGen').click(), 200); }
        else if (a.action === 'export_pdf') { const p = new URLSearchParams(); if (a.exec.clientId) p.set('clientId', a.exec.clientId); if (a.exec.from) p.set('from', a.exec.from); if (a.exec.to) p.set('to', a.exec.to); p.set('narrative', '1'); window.location = '/api/export.pdf?' + p.toString(); }
        else { await api('/command/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: a.action, exec: a.exec }) }); }
        const chip = $(`[data-chip="${i}"]`); if (chip) { chip.classList.add('executed'); chip.querySelector('.pc-done').style.display = 'block'; }
      } catch (e) { toast('Eroare: ' + e.message); }
    }
    setState('done'); await loadState(); if ($('#view-panou').classList.contains('active')) loadDashboard();
    setTimeout(() => { resolvedActions = []; input.value = ''; body.innerHTML = '<div class="cmd-hint">Gata. Spune altă comandă sau închide (Esc).</div>'; setState('idle'); }, 1400);
  }

  /* ---------- speech ---------- */
  let recog = null, listening = false; const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  mic.onclick = () => { if (listening) stopListen(); else startListen(); };
  function startListen() { if (!SR) { toast('Vocea nu e disponibilă aici. Folosește Wispr Flow sau scrie.'); return; } recog = new SR(); recog.lang = 'ro-RO'; recog.interimResults = true; recog.continuous = false; recog.onresult = e => { let t = ''; for (const r of e.results) t += r[0].transcript; input.value = t; }; recog.onend = () => { listening = false; mic.classList.remove('listening'); setState('idle'); }; recog.onerror = () => { listening = false; mic.classList.remove('listening'); }; recog.start(); listening = true; mic.classList.add('listening'); setState('listening'); }
  function stopListen() { if (recog) try { recog.stop(); } catch { } listening = false; mic.classList.remove('listening'); }

  function mdToHtml(md) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;'), lines = esc(md).split('\n'); let html = '', inList = false;
    const inl = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
    for (let ln of lines) {
      if (/^###\s/.test(ln)) { if (inList) { html += '</ul>'; inList = false; } html += '<h3>' + inl(ln.replace(/^###\s/, '')) + '</h3>'; }
      else if (/^##?\s/.test(ln)) { if (inList) { html += '</ul>'; inList = false; } html += '<h2>' + inl(ln.replace(/^##?\s/, '')) + '</h2>'; }
      else if (/^\s*[-*]\s/.test(ln)) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inl(ln.replace(/^\s*[-*]\s/, '')) + '</li>'; }
      else if (ln.trim() === '') { if (inList) { html += '</ul>'; inList = false; } }
      else { if (inList) { html += '</ul>'; inList = false; } html += '<p>' + inl(ln) + '</p>'; }
    }
    if (inList) html += '</ul>'; return html;
  }

  loadState(); loadSettings();
})();
