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

  const api = (p, o) => fetch('/api' + p, o).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t('common.error')); return r.json(); });
  const act = (name, body) => api('/action/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const fetchEntries = (params) => { const q = new URLSearchParams(); Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, v); }); return api('/entries?' + q.toString()); };


  /* ---------- i18n ----------
     window.t / window.I18N / window.LANG / window.LOCALE come from /i18n.js, which
     the server renders from shared/locales.json and loads BEFORE this script — so
     translations are ready synchronously, with no fetch and no race.
     Static markup is translated from data-i18n* attributes; everything this file
     renders calls t() directly. */
  const t = (k, v) => (window.t ? window.t(k, v) : k);

  function applyI18n(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const n = el.getAttribute('data-i18n-n');
      el.textContent = t(el.dataset.i18n, n ? { n } : undefined);
    });
    root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
    root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    document.documentElement.lang = window.LANG || 'ro';
    const ex = document.getElementById('cmdExamples');
    if (ex) ex.innerHTML = t('cmd.examples') + ' ' +
      [1, 2, 3, 4, 5].map(i => '<b>\u201e' + t('cmd.ex' + i) + '\u201d</b>').join(' \u00b7 ');
  }

  function fillLangSelect(current, langs) {
    const sel = document.getElementById('sLang');
    if (!sel) return;
    sel.innerHTML = Object.entries(langs).map(([code, label]) =>
      '<option value="' + code + '"' + (code === current ? ' selected' : '') + '>' + label + '</option>').join('');
    sel.onchange = async () => {
      await api('/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
                               body: JSON.stringify({ lang: sel.value }) });
      // reload the generated dictionary, then repaint in place — no page reload,
      // so a running timer keeps ticking while the language changes
      await new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = '/i18n.js?ts=' + Date.now();
        sc.onload = res; sc.onerror = rej;
        document.head.appendChild(sc);
      });
      rebuildDateNames();
      applyI18n();
      toast(t('settings.lang_saved'));
      loadState();
      loadSettings();
    };
  }

  /* ---------- helpers ---------- */
  const client = id => ST.clients.find(c => c.id === id);
  const project = id => ST.projects.find(p => p.id === id);
  const person = id => ST.people.find(p => p.id === id);
  const fmtHM = m => { const h = Math.floor(m / 60), x = m % 60; return h + ':' + String(x).padStart(2, '0'); };
  const fmtHMlong = m => { const h = Math.floor(m / 60), x = m % 60; return h + 'h' + (x ? ' ' + x + 'm' : ''); };
  const fmtHrs = m => (m / 60).toFixed(1);
  const clock = min => min == null ? '' : String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const eur = n => Math.round(n).toLocaleString(LOC()) + ' €';
  const escp = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  /* Day and month names come from Intl on the active locale — nothing hardcoded,
     so adding a language needs no change here. Index 0 = Sunday, like Date.getDay(). */
  const LOC = () => window.LOCALE || 'ro-RO';
  const upper1 = x => x.charAt(0).toUpperCase() + x.slice(1);
  const dayNames = style => {
    const f = new Intl.DateTimeFormat(LOC(), { weekday: style });
    return [...Array(7)].map((_, i) => f.format(new Date(Date.UTC(2023, 0, 1 + i))));
  };
  const monthNames = () => {
    const f = new Intl.DateTimeFormat(LOC(), { month: 'long' });
    return [...Array(12)].map((_, i) => f.format(new Date(Date.UTC(2023, i, 15))));
  };
  const dowMonFirst = style => { const a = dayNames(style); return [...a.slice(1), a[0]]; };
  let DOW = dayNames('long'), DOWS = dayNames('short').map(upper1), MON = monthNames();
  const rebuildDateNames = () => {
    DOW = dayNames('long'); DOWS = dayNames('short').map(upper1); MON = monthNames();
    DOWS_MON.length = 0; DOWS_MON.push(...dowMonFirst('short').map(upper1));
  };
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
    if (c.personal) return { mins, cap: 0, overMins: 0, overCost: 0, hourly: false, hourlyCost: 0, variable: 0, total: 0, personal: true };
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
    if (v === 'raport') loadReportTables();
    if (v === 'activitate') loadActivity();
  }));
  function navTo(view) { const b = $$('.nav-item').find(n => n.dataset.view === view); if (b) b.click(); }

  /* ---------- filters ---------- */
  function fillSelect(el, items, ph, txt, valKey = 'id') { if (!el) return; const cur = el.value; el.innerHTML = (ph ? `<option value="">${ph}</option>` : '') + items.map(i => `<option value="${escp(i[valKey])}">${escp(txt(i))}</option>`).join(''); if (cur) el.value = cur; }
  function refreshDropdowns() {
    fillSelect($('#fClient'), ST.clients, t('filter.all_clients'), c => c.name);
    fillSelect($('#fPerson'), ST.people, t('filter.all_team'), p => p.name);
    fillSelect($('#rClient'), ST.clients, t('filter.all_clients'), c => c.name);
    fillSelect($('#rPerson'), ST.people, t('filter.all_team'), p => p.name);
    fillSelect($('#dClient'), ST.clients, t('filter.all_projects'), c => c.name);
    fillSelect($('#dPerson'), ST.people, t('filter.all'), p => p.name);
    const projOpt = p => `${p.name} · ${client(p.client_id)?.name || '—'}`;
    fillSelect($('#tProject'), ST.projects, t('common.project'), projOpt);
    fillSelect($('#tPerson'), ST.people, t('common.person'), p => p.name);
    fillSelect($('#pClient'), ST.clients, t('common.client'), c => c.name);
    fillSelect($('#rTags'), (ST.tags || []), t('filter.all_tags'), tg => tg.name, 'name');
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
    const biz = ST.clients.filter(c => !c.personal);
    const rev = biz.reduce((s, c) => s + (c.cost || 0), 0);
    $('#sideRevenue').innerHTML = `${t('dash.revenue')}<b>${eur(rev)}</b>${biz.length} ${t('dash.clients_n')} · ${ST.people.length} ${t('dash.in_team')}`;
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
      return `<div class="week-block"><div class="week-head"><b>${label}</b><span class="wt">${t('dash.week_total')}<b>${fmtHM(wTot)}</b></span></div>
        ${days.map(date => {
        const de = byDay[date].sort((a, b) => (b.start_min ?? 0) - (a.start_min ?? 0)), dTot = de.reduce((s, e) => s + (e.planned ? 0 : e.mins), 0);
        const d = new Date(date);
        return `<div class="day-block"><div class="day-bar"><span class="dt">${d.toLocaleDateString(LOC(), { weekday: 'short', day: 'numeric', month: 'short' })}</span><span style="display:flex;align-items:center;gap:4px"><span class="dtot">Total<b>${fmtHM(dTot)}</b></span><button class="day-add" data-add-day="${date}" title="${t('cal.add_day')}">+</button></span></div>
          ${de.map(e => {
          const pr = project(e.project_id);
          const range = e.start_min != null ? `${clock(e.start_min)} - ${clock(e.start_min + e.mins)}` : '';
          return `<div class="erow ${e.planned ? 'planned' : ''}" data-eid="${e.id}"><span class="e-dot" style="background:${pr?.color || '#556'}"></span>
            ${e.planned ? '<span class="pl-badge">PLAN</span>' : ''}
            <div class="e-desc"><div class="d1">${escp(e.desc || t('projects.none_desc'))}</div><div class="d2">${pr ? escp(pr.name) + ' · ' + escp(client(pr.client_id)?.name || '') : 'fără proiect'}</div></div>
            <div class="e-tags">${(e.tags || []).map(t => { const col = tagColor(t); return `<span class="tag"${col ? ` style="color:${col};border-color:${col}"` : ''}>${escp(t)}</span>`; }).join('')}</div>
            <span class="e-person">${escp(person(e.person_id)?.name || '')}</span>
            <span class="e-range">${range}</span><span class="e-dur">${fmtHM(e.mins)}</span>
            <button class="e-act" data-restart="${e.id}" title="${t('timer.restart')}">▷</button>
            <button class="e-act" data-del="entry:${e.id}" title="${t('common.delete')}">✕</button></div>`;
        }).join('')}</div>`;
      }).join('')}</div>`;
    }).join('') || `<div class="empty">${t('filter.no_entries_long')}</div>`;
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
    wrap.innerHTML = `<div class="at-head">▶ ${timers.length} ${timers.length === 1 ? t('timer.active_one') : t('timer.active_many')} — ${t('timer.active_hint')}</div>` +
      // NB: the map parameter is `tm`, not `t` — `t` is the translation function
      // and shadowing it here would call a timer object as if it were t().
      timers.map(tm => {
        const pr = project(tm.projectId);
        return `<div class="atimer" data-tid="${tm.id}" style="border-left:3px solid ${pr?.color || 'var(--green)'}">
          <span class="at-pulse"></span>
          <input class="at-desc" data-tf="desc" value="${escp(tm.desc)}" placeholder="${t('timer.desc')}">
          <select class="at-seg" data-tf="projectId"><option value="">${t('timer.no_project')}</option>${projOpts(tm.projectId)}</select>
          <select class="at-seg" data-tf="personId"><option value="">${t('timer.no_person')}</option>${personOpts(tm.personId)}</select>
          <input class="at-tags" data-tf="tags" list="tagOptions" value="${escp((tm.tags || []).join(', '))}" placeholder="${t('timer.tags')}">
          <span class="at-elapsed" data-start="${tm.start}">00:00:00</span>
          <button class="at-stop" data-stop="${tm.id}">${t('timer.stop')}</button>
          <button class="at-x" data-discard="${tm.id}" title="${t('timer.discard')}">✕</button>
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
  $('#cAdd').onclick = async () => { const n = $('#cName').value.trim(); if (!n) return; await act('create_client', { name: n, cost: +$('#cCost').value || 0, hours: +$('#cHours').value || 0, overage: +$('#cOver').value || 0, rate: +$('#cRate').value || 0, personal: $('#cPersonal').checked ? 1 : 0, color: $('#cColorTrig').dataset.color }); $('#cName').value = $('#cCost').value = $('#cHours').value = $('#cOver').value = $('#cRate').value = ''; $('#cPersonal').checked = false; resetTrig($('#cColorTrig')); toast('Client adăugat'); loadState(); };
  $('#pAdd').onclick = async () => { const n = $('#pName').value.trim(); if (!n) return; await act('create_project', { name: n, clientId: $('#pClient').value, rate: +$('#pRate').value || 0, color: $('#pColorTrig').dataset.color }); $('#pName').value = $('#pRate').value = ''; resetTrig($('#pColorTrig')); toast('Proiect adăugat'); loadState(); };
  $('#eAdd').onclick = async () => { const n = $('#eName').value.trim(); if (!n) return; await act('create_person', { name: n }); $('#eName').value = ''; toast(t('team.added')); loadState(); };
  $('#tgAdd').onclick = async () => { const n = $('#tgName').value.trim(); if (!n) return; await act('create_tag', { name: n, color: $('#tgColorTrig').dataset.color }); $('#tgName').value = ''; resetTrig($('#tgColorTrig')); toast('Tag adăugat'); loadState(); };
  document.addEventListener('click', async e => {
    const stop = e.target.closest('[data-stop]');
    if (stop) {
      const r = stop.closest('.atimer');
      await act('stop_timer', { id: stop.dataset.stop, desc: r.querySelector('.at-desc').value.trim(), projectId: r.querySelector('[data-tf="projectId"]').value, personId: r.querySelector('[data-tf="personId"]').value, tags: parseTags(r.querySelector('.at-tags').value) });
      toast(t('timer.saved')); await loadState();
      if ($('#view-panou').classList.contains('active')) loadDashboard();
      if ($('#view-calendar').classList.contains('active')) loadCalendar();
      return;
    }
    const disc = e.target.closest('[data-discard]');
    if (disc) { if (!confirm(t('timer.discard_ask'))) return; await act('discard_timer', { id: disc.dataset.discard }); toast(t('timer.discarded')); loadState(); return; }
    const del = e.target.closest('[data-del]');
    if (del) { const [type, id] = del.dataset.del.split(':'); const map = { entry: 'delete_entry', client: 'delete_client', project: 'delete_project', person: 'delete_person', tag: 'delete_tag' }; if (type === 'client' && !confirm('Ștergi clientul și proiectele lui?')) return; await act(map[type], { id }); toast(t('common.deleted')); loadState(); if ($('#view-panou').classList.contains('active')) loadDashboard(); return; }
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
    $('#emProject').innerHTML = `<option value="">${t('projects.no_project')}</option>` + ST.projects.map(p => `<option value="${p.id}">${escp(projOpt(p))}</option>`).join('');
    $('#emPerson').innerHTML = '<option value="">— nimeni —</option>' + ST.people.map(p => `<option value="${p.id}">${escp(p.name)}</option>`).join('');
  }
  function openEntryModal() { emFillSelects(); emVeil.classList.add('open'); setTimeout(() => $('#emDesc').focus(), 50); }
  function closeEntryModal() { emVeil.classList.remove('open'); emEditId = null; }
  function openEntryNew(dateISO, prefill = {}) {
    emEditId = null;
    $('#emTitle').textContent = t('modal.add');
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
    $('#emTitle').textContent = en.planned ? t('modal.edit_planned') : t('modal.edit');
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
    if (mins < 1) { toast(t('modal.need_duration')); return; }
    const st = $('#emStart').value; // "HH:MM" or ""
    const startMin = st ? (+st.slice(0, 2) * 60 + +st.slice(3, 5)) : null;
    const payload = { date: $('#emDate').value, mins, desc: $('#emDesc').value.trim(), projectId: $('#emProject').value, personId: $('#emPerson').value, tags: parseTags($('#emTags').value), startMin, planned: $('#emPlanned').checked ? 1 : 0 };
    try {
      if (emEditId) await act('update_entry', { id: emEditId, ...payload });
      else { const r = await act('add_entry', { ...payload, recurWeeks: +$('#emRecur').value || 0 }); if (r.recurred) toast(`${t('modal.added_recur', { n: r.recurred })}`); }
      if (emEditId || !+$('#emRecur').value) toast(emEditId ? t('modal.updated') : t('modal.added'));
      afterEntryChange();
    } catch (e) { toast('Eroare: ' + e.message); }
  };
  $('#emDone').onclick = async () => {
    if (!emEditId) return;
    try { await act('update_entry', { id: emEditId, planned: 0 }); toast('✓ Marcat ca lucrat'); afterEntryChange(); }
    catch (e) { toast('Eroare: ' + e.message); }
  };
  $('#emDelete').onclick = async () => {
    if (!emEditId || !confirm(t('modal.delete_ask'))) return;
    try { await act('delete_entry', { id: emEditId }); toast(t('common.deleted')); afterEntryChange(); }
    catch (e) { toast('Eroare: ' + e.message); }
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && emVeil.classList.contains('open')) closeEntryModal(); });

  /* ---------- DASHBOARD ---------- */
  async function loadDashboard() {
    const wMon = mondayOf(new Date()), wSun = addDays(wMon, 6);
    const now = new Date(), mStart = iso(new Date(now.getFullYear(), now.getMonth(), 1)), mEnd = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    const df = { from: iso(wMon), to: iso(wSun), clientId: dFilter.clientId, personId: dFilter.personId, planned: 'exclude' };
    const [weekEnts, monthEnts, histEnts] = await Promise.all([
      fetchEntries(df),
      fetchEntries({ from: mStart, to: mEnd, planned: 'exclude' }),
      fetchEntries({ from: iso(addDays(now, -56)), planned: 'exclude' }),
    ]);
    renderPersonal(weekEnts, histEnts, wMon);

    const total = weekEnts.reduce((s, e) => s + e.mins, 0);
    // top project / client this week
    const byPr = {}; weekEnts.forEach(e => byPr[e.project_id] = (byPr[e.project_id] || 0) + e.mins);
    const topPr = Object.entries(byPr).sort((a, b) => b[1] - a[1])[0];
    const byCl = {}; weekEnts.forEach(e => { const pr = project(e.project_id); if (pr) byCl[pr.client_id] = (byCl[pr.client_id] || 0) + e.mins; });
    const topCl = Object.entries(byCl).sort((a, b) => b[1] - a[1])[0];
    const extraMonth = ST.clients.reduce((s, c) => s + clientBilling(c, monthEnts).variable, 0);

    $('#dashStats').innerHTML = `
      <div class="dstat"><small>${t('dash.total_week')}</small><b>${fmtHM(total)}</b></div>
      <div class="dstat"><small>${t('dash.top_project')}</small><b style="font-size:19px">${topPr ? escp(project(topPr[0])?.name || '—') : '—'}</b><div class="sub">${topPr ? fmtHM(topPr[1]) : ''}</div></div>
      <div class="dstat"><small>${t('dash.extra_billed')}</small><b style="color:var(--amber)">${eur(extraMonth)}</b><div class="sub">${t('dash.extra_sub')}</div></div>`;

    // bar chart: hours per weekday
    const perDay = Array(7).fill(0);
    weekEnts.forEach(e => { const idx = (new Date(e.date).getDay() + 6) % 7; perDay[idx] += e.mins; });
    const maxMin = Math.max(60, ...perDay);
    const maxH = Math.ceil(maxMin / 60);
    $('#dTotal').textContent = fmtHM(total);
    const glines = 4;
    $('#dashChart').innerHTML = total === 0
      ? `<div class="chart-empty"><span class="ce-ic">▢</span><div>${t('dash.empty_week')}</div></div>`
      : `<div class="chart">
          <div class="yax">${Array.from({ length: glines + 1 }, (_, i) => `<div class="yl">${(maxH * (glines - i) / glines).toFixed(1)}h</div>`).join('')}</div>
          <div class="grid">${Array.from({ length: glines + 1 }, () => `<div class="gline"></div>`).join('')}</div>
          ${perDay.map((m, i) => `<div class="bcol"><div class="btip">${upper1(dowMonFirst('long')[i])}: ${fmtHMlong(m)}</div><div class="bar" style="height:${m / (maxH * 60) * 100}%"></div><div class="bx">${upper1(dowMonFirst('short')[i])}</div></div>`).join('')}
        </div>`;

    // top activities (by description) this week
    const byDesc = {}; weekEnts.forEach(e => { const k = e.desc || t('projects.none_desc'); byDesc[k] = (byDesc[k] || 0) + e.mins; });
    const top = Object.entries(byDesc).sort((a, b) => b[1] - a[1]).slice(0, 8);
    $('#topActivities').innerHTML = top.map(([name, m], i) => `<div class="top-row"><span class="tr-dot" style="background:${['#2f9bf0', '#4bd08a', '#f0b429', '#e1b339', '#38c6e0', '#a78bfa', '#f16a6a', '#94a3b8'][i]}"></span><span class="tr-name">${escp(name)}</span><span class="tr-h">${fmtHM(m)}</span></div>`).join('') || '<div class="empty" style="padding:20px">—</div>';

    // client package cards (this month): subscription with overage, or hourly rate
    $('#clientCards').innerHTML = ST.clients.map(c => {
      const b = clientBilling(c, monthEnts), pct = b.cap ? Math.min(100, b.mins / b.cap * 100) : 0, over = b.overMins > 0;
      if (b.personal) {
        return `<div class="cli-card" style="border-left:3px solid ${c.color || 'var(--accent)'}"><div class="cli-top"><b>${escp(c.name)}</b><span class="rev" style="color:var(--ink3)">personal</span></div>
          <div class="cli-hrs"><em>${fmtHMlong(b.mins)}</em> luna asta</div>
          <div class="pbar"><div style="width:${b.mins ? 100 : 0}%"></div></div><div class="cli-st">${t('clients.personal_line')}</div></div>`;
      }
      if (b.hourly) {
        return `<div class="cli-card" style="border-left:3px solid ${c.color || 'var(--accent)'}"><div class="cli-top"><b>${escp(c.name)}</b><span class="rev">${eur(b.total)} luna asta</span></div>
          <div class="cli-hrs"><em>${fmtHMlong(b.mins)}</em> ${c.rate ? '× ' + c.rate + ' €/h' : 'la tarif per proiect'}</div>
          <div class="pbar"><div style="width:${b.mins ? 100 : 0}%"></div></div><div class="cli-st">${t('clients.hourly_line')}</div></div>`;
      }
      const st = !b.cap ? `<div class="cli-st">${t('clients.no_package')}</div>`
        : over ? `<div class="cli-st over">⚠ +${fmtHMlong(b.overMins)} extra → ${eur(b.overCost)}</div>`
        : pct > 80 ? `<div class="cli-st warn">${t('clients.near_limit')}</div>` : `<div class="cli-st ok">${t('clients.in_package')} · ${fmtHMlong(b.cap - b.mins)} ${t('clients.remaining')}</div>`;
      return `<div class="cli-card" style="border-left:3px solid ${c.color || 'var(--accent)'}"><div class="cli-top"><b>${escp(c.name)}</b><span class="rev">${eur(b.total || c.cost || 0)}${over ? ' facturat' : t('clients.per_month')}</span></div>
        <div class="cli-hrs"><em>${fmtHMlong(b.mins)}</em> ${b.cap ? 'din ' + fmtHMlong(b.cap) + ' incluse' : ''} ${c.overage ? '· ' + c.overage + ' €/h extra' : ''}</div>
        <div class="pbar ${over ? 'over' : ''}"><div style="width:${b.cap ? pct : (b.mins ? 100 : 0)}%"></div></div>${st}</div>`;
    }).join('') || '<div class="empty">Niciun client.</div>';
  }

  /* ---------- DEZVOLTARE PERSONALĂ ---------- */
  function renderPersonal(weekEnts, histEnts, wMon) {
    const el = $('#persoPanel'); if (!el) return;
    const goal = +(ST.settings?.weeklyGoal || 0);
    const gi = $('#pdGoal'); if (gi && document.activeElement !== gi) gi.value = goal || '';
    const weekMins = weekEnts.reduce((s, e) => s + e.mins, 0);

    // streak: zile consecutive cu ore lucrate, numărând înapoi de azi (azi gol nu rupe seria)
    const daysWith = new Set(histEnts.map(e => e.date));
    let streak = 0; const today = iso(new Date());
    for (let i = 0; i < 60; i++) {
      const d = iso(addDays(new Date(), -i));
      if (daysWith.has(d)) streak++;
      else if (d !== today) break;
    }

    // săptămâna trecută (aceeași zi-limită ca azi, comparație corectă la mijloc de săptămână)
    const lwMon = addDays(wMon, -7);
    const dayIdx = Math.floor((startOfDay(new Date()) - wMon) / 86400000);
    const lwCut = iso(addDays(lwMon, dayIdx));
    const lastWeekSame = histEnts.filter(e => e.date >= iso(lwMon) && e.date <= lwCut).reduce((s, e) => s + e.mins, 0);
    const diff = weekMins - lastWeekSame;

    // sesiuni pe săptămâna curentă
    const sessions = weekEnts.map(e => e.mins);
    const maxSes = sessions.length ? Math.max(...sessions) : 0;
    const deep = weekEnts.filter(e => e.mins >= 90).reduce((s, e) => s + e.mins, 0);
    const deepPct = weekMins ? Math.round(deep / weekMins * 100) : 0;

    // lucru târziu (începe după 22:00 sau se termină după 23:00) în ultimele 7 zile
    const late = histEnts.filter(e => e.date >= iso(addDays(new Date(), -7)) && e.start_min != null && (e.start_min >= 22 * 60 || e.start_min + e.mins > 23 * 60)).length;

    // medie pe zi activă, ultimele 4 săptămâni
    const m28 = histEnts.filter(e => e.date >= iso(addDays(new Date(), -28)));
    const activeDays = new Set(m28.map(e => e.date)).size;
    const avg = activeDays ? Math.round(m28.reduce((s, e) => s + e.mins, 0) / activeDays) : 0;

    // ore pe clienți personali (fitness, învățare, proiecte proprii) săptămâna asta
    const persIds = ST.projects.filter(p => client(p.client_id)?.personal).map(p => p.id);
    const persEnts = weekEnts.filter(e => persIds.includes(e.project_id));
    const persMins = persEnts.reduce((s, e) => s + e.mins, 0);
    const byPersProj = {}; persEnts.forEach(e => { const n = project(e.project_id)?.name || '—'; byPersProj[n] = (byPersProj[n] || 0) + e.mins; });
    const persDetail = Object.entries(byPersProj).sort((a, b) => b[1] - a[1]).map(([n, m]) => `${escp(n)} <b>${fmtHMlong(m)}</b>`).join(' · ');
    const persHtml = persIds.length
      ? `<div class="pd-pers">☆ <b>${fmtHMlong(persMins)}</b> ${t('dash.personal_week')}${persDetail ? ' — ' + persDetail : ''}</div>`
      : `<div class="pd-pers hint">☆ ${t('dash.personal_hint')}</div>`;

    const pct = goal ? Math.min(100, weekMins / (goal * 60) * 100) : 0;
    const goalHtml = goal
      ? `<div class="pd-goal"><div class="pd-goal-t">${fmtHMlong(weekMins)} din ${goal}h obiectiv <b style="color:${pct >= 100 ? 'var(--green)' : 'var(--ink)'}">${Math.round(pct)}%</b></div><div class="pbar ${pct >= 100 ? '' : ''}"><div style="width:${pct}%"></div></div></div>`
      : `<div class="hint" style="margin:4px 0 10px">${t('dash.goal_hint')}</div>`;

    el.innerHTML = goalHtml + persHtml + `<div class="pd-grid">
      <div class="pd-stat"><b>${streak}</b><small>${t('dash.streak')}</small></div>
      <div class="pd-stat"><b style="color:${diff >= 0 ? 'var(--green)' : 'var(--amber)'}">${diff >= 0 ? '+' : '−'}${fmtHMlong(Math.abs(diff))}</b><small>${t('dash.vs_last')}</small></div>
      <div class="pd-stat"><b>${fmtHMlong(avg)}</b><small>${t('dash.avg_day')}</small></div>
      <div class="pd-stat"><b>${deepPct}%</b><small>lucru profund (sesiuni ≥ 1h30)</small></div>
      <div class="pd-stat"><b>${fmtHMlong(maxSes)}</b><small>${t('dash.longest')}</small></div>
      <div class="pd-stat"><b style="color:${late ? 'var(--amber)' : 'var(--green)'}">${late}</b><small>${t('dash.late')}</small></div>
    </div>`;
  }
  $('#pdGoal')?.addEventListener('change', async () => {
    await api('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ weeklyGoal: +$('#pdGoal').value || 0 }) });
    toast('Obiectiv salvat'); await loadState(); loadDashboard();
  });

  /* ---------- CALENDAR (Zi / Săptămână / Lună) ---------- */
  const H0 = 0, H1 = 23, PX = 48;            // full 24h grid, 48px per hour
  const DOWS_MON = dowMonFirst('short').map(upper1);

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

  // overlapping blocks in a day column: each gets a lane, the cluster splits the width
  function layoutLanes(items) {
    const sorted = [...items].sort((a, b) => a.s - b.s || b.len - a.len);
    let cluster = [], lanes = [], clusterEnd = -1;
    const close = () => cluster.forEach(it => it.lanes = lanes.length);
    for (const it of sorted) {
      const end = it.s + it.len;
      if (cluster.length && it.s >= clusterEnd) { close(); cluster = []; lanes = []; }
      let li = lanes.findIndex(le => le <= it.s);
      if (li < 0) { li = lanes.length; lanes.push(0); }
      lanes[li] = end; it.lane = li;
      cluster.push(it); clusterEnd = Math.max(clusterEnd, end);
    }
    close();
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
      ? cap(start.toLocaleDateString(LOC(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))
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
      return `<div class="cal-day ${is ? 'today' : ''}"><div class="cd-name">${DOWS[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()].slice(0, 3)}</div><div class="cd-tot">${fmtHM(dayTot[k])}<button class="day-add" data-add-day="${k}" title="${t('cal.add_day')}">+</button></div></div>`;
    }).join('');

    // all-day strip (entries without a start time + all-day Google events)
    const gcalByDay = k => GCAL.filter(g => g.date === k);
    const allday = Array.from({ length: nDays }, (_, i) => byDay[iso(addDays(start, i))].filter(e => e.start_min == null));
    const alldayG = Array.from({ length: nDays }, (_, i) => gcalByDay(iso(addDays(start, i))).filter(g => g.allDay));
    const hasAllday = allday.some(a => a.length) || alldayG.some(a => a.length);
    $('#calAllday').style.display = hasAllday ? 'flex' : 'none';
    $('#calAllday').classList.toggle('one', nDays === 1);
    if (hasAllday) $('#calAllday').innerHTML = `<div class="cal-gut">${t('cal.allday')}</div>` + allday.map((list, i) => `<div class="ad-col">${list.map(e => { const pr = project(e.project_id); return `<div class="ad-chip ${e.planned ? 'planned' : ''}" data-eid="${e.id}" style="background:${pr?.color || '#556'}" title="${escp(e.desc)}">${e.planned ? '◌ ' : ''}${escp(e.desc || '—')} · ${fmtHM(e.mins)}</div>`; }).join('')}${alldayG[i].map(g => `<div class="ad-chip gcal" data-gcal="${GCAL.indexOf(g)}" title="${t('cal.gcal_tip')}">⧉ ${escp(g.summary)}</div>`).join('')}</div>`).join('');

    // grid
    const gutter = `<div class="cal-gutter">${Array.from({ length: H1 - H0 + 1 }, (_, i) => `<div class="cal-hour"><span class="hl">${String(H0 + i).padStart(2, '0')}:00</span></div>`).join('')}</div>`;
    const cols = Array.from({ length: nDays }, (_, i) => {
      const d = addDays(start, i), k = iso(d);
      const items = [
        ...byDay[k].filter(e => e.start_min != null).map(e => ({ kind: 'entry', e, s: e.start_min, len: Math.max(20, e.mins) })),
        ...gcalByDay(k).filter(g => !g.allDay).map(g => ({ kind: 'gcal', g, s: g.startMin, len: Math.max(20, g.mins) })),
      ];
      layoutLanes(items);
      const blocks = items.map(it => {
        const top = ((it.s - H0 * 60) / 60) * PX;
        const lane = it.lanes > 1 ? `left:calc(${it.lane * 100 / it.lanes}% + 2px);width:calc(${100 / it.lanes}% - 4px);right:auto;` : '';
        if (it.kind === 'gcal') {
          const h = Math.max(15, (it.g.mins / 60) * PX);
          return `<div class="gcal-ev" data-gcal="${GCAL.indexOf(it.g)}" style="top:${top}px;height:${h}px;${lane}">⧉ ${escp(it.g.summary)}</div>`;
        }
        const e = it.e, pr = project(e.project_id);
        const h = Math.max(15, (e.mins / 60) * PX);
        return `<div class="cal-block ${e.planned ? 'planned' : ''}" data-eid="${e.id}" style="top:${top}px;height:${h}px;background:${pr?.color || '#556'};${lane}"><div class="cb-t">${e.planned ? '◌ ' : ''}${escp(e.desc || '—')}</div><div class="cb-h">${clock(e.start_min)}–${clock(e.start_min + e.mins)}</div></div>`;
      }).join('');
      return `<div class="cal-col" data-date="${k}">${Array.from({ length: H1 - H0 + 1 }, () => `<div class="cal-hour"></div>`).join('')}${blocks}${k === todayISO ? nowLineHtml() : ''}</div>`;
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

  /* ---------- tooltip la hover în calendar ---------- */
  const calTip = $('#calTip');
  document.addEventListener('mousemove', e => {
    if (!$('#view-calendar').classList.contains('active') || calDrag) { calTip.classList.remove('show'); return; }
    const t = e.target.closest('.cal-block, .gcal-ev, .m-chip, .ad-chip');
    if (!t) { calTip.classList.remove('show'); return; }
    let html = '';
    if (t.dataset.gcal !== undefined) {
      const g = GCAL[+t.dataset.gcal];
      if (g) html = `<b>⧉ ${escp(g.summary)}</b><div class="ct-sub">Google Calendar${g.allDay ? ' · ' + t('cal.allday') : ` · ${clock(g.startMin)}–${clock(g.startMin + g.mins)} · ${fmtHMlong(g.mins)}`}</div><div class="ct-hint">${t('cal.gcal_hint')}</div>`;
    } else {
      const en = calEnts.find(x => x.id === t.dataset.eid) || ST.entries.find(x => x.id === t.dataset.eid);
      if (en) {
        const pr = project(en.project_id), pe = person(en.person_id);
        html = `<b>${en.planned ? '◌ ' : ''}${escp(en.desc || t('projects.none_desc'))}</b>
          <div class="ct-sub">${pr ? escp(pr.name) + ' · ' + escp(client(pr.client_id)?.name || '—') : 'fără proiect'}</div>
          <div class="ct-row">${en.start_min != null ? clock(en.start_min) + '–' + clock(en.start_min + en.mins) + ' · ' : ''}${fmtHMlong(en.mins)}${pe ? ' · ' + escp(pe.name) : ''}${en.planned ? ' · <i>planificat</i>' : ''}</div>
          ${(en.tags || []).length ? `<div class="ct-tags">${en.tags.map(tg => { const col = tagColor(tg); return `<span class="tag"${col ? ` style="color:${col};border-color:${col}"` : ''}>${escp(tg)}</span>`; }).join('')}</div>` : ''}`;
      }
    }
    if (!html) { calTip.classList.remove('show'); return; }
    calTip.innerHTML = html; calTip.classList.add('show');
    const w = calTip.offsetWidth, h = calTip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 16;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 16;
    calTip.style.left = x + 'px'; calTip.style.top = y + 'px';
  });

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
        else if (kind === 'client') { await act('update_client', { id, color }); toast(t('common.color_updated')); loadState(); }
        else if (kind === 'project') { await act('update_project', { id, color }); toast(t('common.color_updated')); loadState(); }
        else if (kind === 'tag') { await act('update_tag', { id, color }); toast(t('common.color_updated')); loadState(); }
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
    const billingPills = c => `
      <label class="pill" style="cursor:pointer">Abonament <input type="number" value="${c.cost || 0}" data-edit="cost:${c.id}" style="width:60px;background:transparent;border:none;color:var(--ink);font-weight:600;text-align:right"> €</label>
      <label class="pill" style="cursor:pointer">Incluse <input type="number" value="${c.hours || 0}" data-edit="hours:${c.id}" style="width:44px;background:transparent;border:none;color:var(--ink);font-weight:600;text-align:right"> h</label>
      <label class="pill" style="cursor:pointer">Extra <input type="number" value="${c.overage || 0}" data-edit="overage:${c.id}" style="width:44px;background:transparent;border:none;color:var(--amber);font-weight:600;text-align:right"> €/h</label>
      <label class="pill" style="cursor:pointer" title="${t('clients.rate_tip')}">Tarif <input type="number" value="${c.rate || 0}" data-edit="rate:${c.id}" style="width:44px;background:transparent;border:none;color:var(--green);font-weight:600;text-align:right"> €/h</label>`;
    $('#clientList').innerHTML = ST.clients.map(c => `<div class="lrow"><button type="button" class="sw-color" data-colortrig data-ck="client" data-id="${c.id}" data-color="${c.color || '#2f9bf0'}" style="background:${c.color || '#2f9bf0'}" title="culoare client"></button>
      <div style="min-width:0"><input class="name-edit" value="${escp(c.name)}" data-cname="${c.id}" title="${t('common.rename_tip')}"><div class="meta">${ST.projects.filter(p => p.client_id === c.id).length} proiecte${c.personal ? ' · ' + t('clients.no_billing_txt') : ''}</div></div>
      <div class="spacer"></div>
      ${c.personal ? '<span class="pill" style="color:var(--accent);border-color:var(--accent)">☆ Personal</span>' : billingPills(c)}
      <button class="pill" data-cpers="${c.id}" title="${c.personal ? t('clients.make_billable') : t('clients.make_personal')}" style="cursor:pointer">${c.personal ? '→ facturabil' : '→ personal'}</button>
      <button class="e-del" data-del="client:${c.id}">✕</button></div>`).join('') || `<div class="empty">${t('clients.empty')}</div>`;
    $$('[data-edit]').forEach(inp => inp.addEventListener('change', async () => { const [field, id] = inp.dataset.edit.split(':'); await act('update_client', { id, [field]: +inp.value || 0 }); toast('Actualizat'); loadState(); }));
    $$('[data-cname]').forEach(inp => inp.addEventListener('change', async () => { if (!inp.value.trim()) { loadState(); return; } await act('update_client', { id: inp.dataset.cname, name: inp.value.trim() }); toast(t('common.renamed')); loadState(); }));
    $$('[data-cpers]').forEach(b => b.addEventListener('click', async () => { const c = client(b.dataset.cpers); await act('update_client', { id: b.dataset.cpers, personal: c?.personal ? 0 : 1 }); toast(c?.personal ? t('clients.billable') : 'Marcat ca personal'); loadState(); }));
  }
  function renderProjects() {
    const cliOpts = sel => `<option value="">${t('clients.no_client')}</option>` + ST.clients.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${escp(c.name)}</option>`).join('');
    const row = p => {
      const c = client(p.client_id);
      const cliRate = c?.rate || 0;
      const eff = (p.rate || 0) || cliRate;
      const hint = !p.rate && cliRate ? `<div class="meta">${t('projects.inherited')} ${cliRate} €/h</div>` : '';
      const ratePill = c?.personal ? '' : `<label class="pill" style="cursor:pointer" title="${t('projects.rate_tip2')}">Tarif <input type="number" value="${p.rate || 0}" data-prate="${p.id}" min="0" style="width:44px;background:transparent;border:none;color:${eff ? 'var(--green)' : 'var(--ink)'};font-weight:600;text-align:right"> €/h</label>`;
      return `<div class="lrow"><button type="button" class="sw-color" data-colortrig data-ck="project" data-id="${p.id}" data-color="${p.color || '#2f9bf0'}" style="background:${p.color || '#2f9bf0'}" title="culoare proiect"></button>
      <div style="min-width:0"><input class="name-edit" value="${escp(p.name)}" data-pname="${p.id}" title="${t('common.rename_tip')}">${hint}</div>
      <div class="spacer"></div>
      ${ratePill}
      <select class="pill-sel" data-pclient="${p.id}" title="${t('projects.move')}">${cliOpts(p.client_id)}</select>
      <button class="e-del" data-del="project:${p.id}">✕</button></div>`;
    };
    // grouped per client: business clients first, then personal, then projects without a client
    const groups = [];
    const sortedClients = [...ST.clients].sort((a, b) => (a.personal || 0) - (b.personal || 0) || a.name.localeCompare(b.name, 'ro'));
    for (const c of sortedClients) {
      const prs = ST.projects.filter(p => p.client_id === c.id);
      if (prs.length) groups.push({ c, prs });
    }
    const orphans = ST.projects.filter(p => !p.client_id || !client(p.client_id));
    $('#projectList').innerHTML = groups.map(({ c, prs }) =>
      `<div class="pg-head"><span class="pg-dot" style="background:${c.color || '#2f9bf0'}"></span><b>${escp(c.name)}</b>${c.personal ? '<span class="pg-badge">☆ personal</span>' : ''}<span class="pg-n">${prs.length} ${prs.length === 1 ? 'proiect' : 'proiecte'}</span></div>
       <div class="pg-body">${prs.map(row).join('')}</div>`
    ).join('') + (orphans.length ? `<div class="pg-head"><span class="pg-dot" style="background:#556"></span><b>${t('clients.none')}</b><span class="pg-n">${orphans.length}</span></div><div class="pg-body">${orphans.map(row).join('')}</div>` : '') || `<div class="empty">${t('projects.empty')}</div>`;
    $$('[data-pname]').forEach(inp => inp.addEventListener('change', async () => { if (!inp.value.trim()) { loadState(); return; } await act('update_project', { id: inp.dataset.pname, name: inp.value.trim() }); toast(t('common.renamed')); loadState(); }));
    $$('[data-prate]').forEach(inp => inp.addEventListener('change', async () => { await act('update_project', { id: inp.dataset.prate, rate: +inp.value || 0 }); toast('Tarif actualizat'); loadState(); }));
    $$('[data-pclient]').forEach(sel => sel.addEventListener('change', async () => { await act('update_project', { id: sel.dataset.pclient, clientId: sel.value }); toast(t('clients.updated')); loadState(); }));
  }
  function renderPeople() {
    $('#peopleList').innerHTML = ST.people.map(p => `<div class="lrow"><span class="sw" style="background:var(--accent-h)"></span><div style="min-width:0"><input class="name-edit" value="${escp(p.name)}" data-ename="${p.id}" title="${t('common.rename_tip')}"></div><div class="spacer"></div><button class="e-del" data-del="person:${p.id}">✕</button></div>`).join('') || `<div class="empty">${t('team.empty')}</div>`;
    $$('[data-ename]').forEach(inp => inp.addEventListener('change', async () => { if (!inp.value.trim()) { loadState(); return; } await act('update_person', { id: inp.dataset.ename, name: inp.value.trim() }); toast(t('common.renamed')); loadState(); }));
  }
  function renderTags() {
    const el = $('#tagList'); if (!el) return;
    const count = name => ST.entries.filter(e => (e.tags || []).some(t => norm(t) === norm(name))).length;
    el.innerHTML = (ST.tags || []).map(tg => `<div class="lrow"><button type="button" class="sw-color" data-colortrig data-ck="tag" data-id="${tg.id}" data-color="${tg.color || '#2f9bf0'}" style="background:${tg.color || '#2f9bf0'}" title="${t('tags.color_tip')}"></button>
      <div style="min-width:0"><input class="name-edit" value="${escp(tg.name)}" data-tgname="${tg.id}" title="${t('common.rename_tip')}"></div>
      <div class="spacer"></div>
      <span class="meta">${count(tg.name)} ${t('common.entries_n')}</span>
      <button class="e-del" data-del="tag:${tg.id}">✕</button></div>`).join('') || `<div class="empty">${t('tags.empty')}</div>`;
    $$('[data-tgname]').forEach(inp => inp.addEventListener('change', async () => { if (!inp.value.trim()) { loadState(); return; } await act('update_tag', { id: inp.dataset.tgname, name: inp.value.trim() }); toast(t('common.renamed')); loadState(); }));
  }

  /* ---------- report ---------- */
  ['rClient', 'rPerson', 'rFrom', 'rTo', 'rTags'].forEach(id => $('#' + id)?.addEventListener('change', loadReportTables));
  function reportFilter() { return { clientId: $('#rClient').value, personId: $('#rPerson').value, from: $('#rFrom').value, to: $('#rTo').value, tags: $('#rTags').value ? [$('#rTags').value] : [], tip: $('#rTip').value }; }

  // period presets: this/last week, this/last month, everything
  $$('.rp-preset').forEach(b => b.onclick = () => {
    const t = new Date(); let from, to;
    const p = b.dataset.preset;
    if (p === 'saptamana') { from = mondayOf(t); to = addDays(from, 6); }
    else if (p === 'saptamana-1') { from = addDays(mondayOf(t), -7); to = addDays(from, 6); }
    else if (p === 'luna') { from = new Date(t.getFullYear(), t.getMonth(), 1); to = new Date(t.getFullYear(), t.getMonth() + 1, 0); }
    else if (p === 'luna-1') { from = new Date(t.getFullYear(), t.getMonth() - 1, 1); to = new Date(t.getFullYear(), t.getMonth(), 0); }
    $$('.rp-preset').forEach(x => x.classList.toggle('active', x === b));
    $('#rFrom').value = from ? iso(from) : ''; $('#rTo').value = to ? iso(to) : '';
    loadReportTables();
  });

  function reportParams() { const f = reportFilter(); return { clientId: f.clientId, personId: f.personId, from: f.from, to: f.to, tags: f.tags.join(','), planned: 'exclude' }; }

  // structured tables: per client / project / person / tag, with hourly value where applicable
  async function loadReportTables() {
    const el = $('#repTables'); if (!el) return;
    const f = reportFilter();
    const ents = await fetchEntries(reportParams());
    if (!ents.length) { el.innerHTML = `<div class="empty">${t('filter.no_entries')}</div>`; return; }
    const total = ents.reduce((s, e) => s + e.mins, 0);
    // hourly value of one entry: project rate, else client rate — only for clients without subscription
    const valOf = e => {
      const pr = project(e.project_id); if (!pr) return null;
      const c = client(pr.client_id); if (!c || c.personal) return null;
      if ((c.cost || 0) > 0 || (c.hours || 0) > 0) return null;
      const rate = (pr.rate || 0) || (c.rate || 0);
      return rate ? (e.mins / 60) * rate : null;
    };
    const group = (keyFn, nameFn) => {
      const m = {};
      ents.forEach(e => { const k = keyFn(e) ?? '-'; const g = m[k] = m[k] || { mins: 0, val: 0, hasVal: false }; g.mins += e.mins; const v = valOf(e); if (v != null) { g.val += v; g.hasVal = true; } });
      return Object.entries(m).map(([k, v]) => ({ name: nameFn(k), ...v })).sort((a, b) => b.mins - a.mins);
    };
    const byClient = group(e => project(e.project_id)?.client_id, k => k === '-' ? '(fără client)' : (client(k)?.name || '—'));
    const byProject = group(e => e.project_id, k => k === '-' ? '(fără proiect)' : (project(k)?.name || '—') + ' · ' + (client(project(k)?.client_id)?.name || '—'));
    const byPerson = group(e => e.person_id, k => k === '-' ? '(fără persoană)' : (person(k)?.name || '—'));
    const byTagM = {}; ents.forEach(e => (e.tags || []).forEach(t => byTagM[t] = (byTagM[t] || 0) + e.mins));
    const tagRows = Object.entries(byTagM).sort((a, b) => b[1] - a[1]).map(([t, m]) => ({ name: t, mins: m, hasVal: false, val: 0 }));
    const totVal = ents.reduce((s, e) => s + (valOf(e) || 0), 0);
    const tbl = (title, rows) => `<h3 class="rep-h">${title}</h3><table class="rep-t"><thead><tr><th></th><th>Ore</th><th>%</th><th>Valoare (orar)</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escp(r.name)}</td><td>${fmtHM(r.mins)}</td><td>${Math.round(r.mins / total * 100)}%</td><td>${r.hasVal ? eur(r.val) : '—'}</td></tr>`).join('')}</tbody></table>`;
    el.innerHTML = `<div class="rep-kpis">
        <div class="dstat"><small>Total ore</small><b>${fmtHM(total)}</b></div>
        <div class="dstat"><small>${t('pdf.entries')}</small><b>${ents.length}</b></div>
        <div class="dstat"><small>Valoare la tarif orar</small><b>${totVal ? eur(totVal) : '—'}</b></div>
        <div class="dstat"><small>${t('report.period')}</small><b style="font-size:15px">${f.from || t('common.beginning')} → ${f.to || t('common.today_lc')}</b></div>
      </div>
      ${tbl('Per client', byClient)}${tbl('Per proiect', byProject)}${tbl(t('report.per_person'), byPerson)}${tagRows.length ? tbl('Per tag', tagRows) : ''}
      <p class="hint">„Valoare (orar)" apare doar pentru clienții facturați la tarif orar; abonamentele se calculează lunar, în PDF și pe Panou.</p>`;
  }

  // CSV download of the filtered entries (Excel-friendly)
  $('#rCsv').onclick = async () => {
    const f = reportFilter();
    const ents = await fetchEntries(reportParams());
    const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const rows = [[t('modal.date'), t('common.start_col'), t('common.dur_min'), t('common.dur_hm'), t('modal.desc'), t('common.project'), t('common.client'), t('common.person'), t('nav.taguri')].join(',')];
    ents.forEach(e => { const pr = project(e.project_id); rows.push([e.date, e.start_min != null ? clock(e.start_min) : '', e.mins, fmtHM(e.mins), esc(e.desc), esc(pr?.name || ''), esc(client(pr?.client_id)?.name || ''), esc(person(e.person_id)?.name || ''), esc((e.tags || []).join(', '))].join(',')); });
    const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `timetracker-${f.from || 'tot'}${f.to ? '_' + f.to : ''}.csv`; a.click();
    toast(t('report.csv_done'));
  };
  $('#rGen').onclick = async () => {
    const out = $('#reportOut'), body = $('#reportBody'); out.style.display = 'block'; body.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
    try {
      const res = await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reportFilter()) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('common.error'));
      const reader = res.body.getReader(), dec = new TextDecoder(); let txt = ''; body.innerHTML = '';
      while (true) { const { done, value } = await reader.read(); if (done) break; txt += dec.decode(value, { stream: true }); body.innerHTML = mdToHtml(txt); }
    } catch (e) { body.innerHTML = `<p style="color:var(--red)">${escp(e.message)}</p><p class="hint">${t('report.check_ollama')}</p>`; }
  };
  $('#rPdf').onclick = () => { const p = new URLSearchParams(); const f = reportFilter(); Object.entries(f).forEach(([k, v]) => { if (k === 'tip') return; if (Array.isArray(v)) { if (v.length) p.set(k, v.join(',')); } else if (v) p.set(k, v); }); p.set('narrative', '1'); window.location = '/api/export.pdf?' + p.toString(); };
  $('#rCopy').onclick = () => { navigator.clipboard.writeText($('#reportBody').innerText); toast(t('common.copied')); };

  /* ---------- ACTIVITATE WEB (extensia de browser) ---------- */
  const ACT_CATS = [t('activity.cat.work'), t('activity.cat.learn'), 'Comunicare', t('activity.cat.music'), 'Social', 'Divertisment', t('activity.cat.ignore')];
  let actDays = 0;
  $$('.av-preset').forEach(b => b.onclick = () => { actDays = +b.dataset.days; $$('.av-preset').forEach(x => x.classList.toggle('active', x === b)); loadActivity(); });
  const fmtSec = s => { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h}h ${m}m` : `${m}m`; };
  async function loadActivity() {
    const to = iso(new Date()), from = iso(addDays(new Date(), -actDays));
    const { rows } = await api(`/activity?from=${from}&to=${to}`);
    const list = $('#actList'), sum = $('#actSummary');
    if (!rows.length) { sum.innerHTML = ''; list.innerHTML = `<div class="empty">${t('activity.empty_period')}</div>`; return; }
    const counted = rows.filter(r => r.category !== t('activity.cat.ignore'));
    const total = counted.reduce((s, r) => s + r.seconds, 0);
    const byCat = {}; counted.forEach(r => { const c = r.category || '(necatalogat)'; byCat[c] = (byCat[c] || 0) + r.seconds; });
    sum.innerHTML = `<div class="dstat"><small>${t('activity.total')}</small><b>${fmtSec(total)}</b></div>` +
      Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, s]) => `<div class="dstat"><small>${escp(c)}</small><b style="font-size:20px">${fmtSec(s)}</b><div class="sub">${total ? Math.round(s / total * 100) : 0}%</div></div>`).join('');
    const catOpts = sel => `<option value="">— alege —</option>` + ACT_CATS.map(c => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
    list.innerHTML = `<table class="rep-t"><thead><tr><th>Domeniu</th><th style="text-align:left">Categorie</th><th>Timp</th><th>%</th></tr></thead><tbody>` +
      rows.map(r => `<tr class="${r.category === t('activity.cat.ignore') ? 'act-ignored' : ''}"><td>${escp(r.domain)}</td>
        <td style="text-align:left"><select class="pill-sel" data-actcat="${escp(r.domain)}">${catOpts(r.category || '')}</select></td>
        <td>${fmtSec(r.seconds)}</td><td>${total && r.category !== t('activity.cat.ignore') ? Math.round(r.seconds / total * 100) + '%' : '—'}</td></tr>`).join('') + '</tbody></table>';
    $$('[data-actcat]').forEach(sel => sel.addEventListener('change', async () => {
      await api('/activity/category', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: sel.dataset.actcat, category: sel.value }) });
      toast(t('activity.cat_saved')); loadActivity();
    }));
  }

  async function loadAudit() { const rows = await api('/audit'); $('#auditList').innerHTML = rows.map(r => `<div class="audit-row"><span class="at">${r.ts.slice(11, 16)}</span><span class="av">${r.action}</span><span>${escp(r.source)}</span></div>`).join('') || `<div class="empty">${t('cmd.no_action')}</div>`; }

  async function loadSettings() {
    const s = await api('/settings');
    $('#aiDot').className = 'ai-dot ' + (s.ollama ? 'on' : 'off'); $('#aiDot2').className = 'ai-dot ' + (s.ollama ? 'on' : 'off');
    $('#sModel').innerHTML = (s.models.length ? s.models : [s.model]).map(m => `<option value="${m}">${m}</option>`).join(''); $('#sModel').value = s.model;
    $('#aiHint').innerHTML = s.ollama ? t('settings.ollama_ok', { models: s.models.join(', ') || '—' }) : t('settings.ollama_off');
    $('#sGcal').value = s.gcalUrl || '';
    if (s.langs) fillLangSelect(s.lang, s.langs);
  }
  $('#sGcalSave').onclick = async () => {
    await api('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gcalUrl: $('#sGcal').value.trim() }) });
    toast($('#sGcal').value.trim() ? t('settings.gcal_on') : t('settings.gcal_off'));
    if ($('#view-calendar').classList.contains('active')) loadCalendar();
  };
  $('#sSave').onclick = async () => { await api('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: $('#sModel').value }) }); toast(t('settings.model_saved')); };
  $('#sRefresh').onclick = loadSettings;
  $('#sExport').onclick = async () => { const d = await api('/state'); const b = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'timetracker-backup.json'; a.click(); };

  /* ---------- COMMAND CONSOLE ---------- */
  const veil = $('#cmdVeil'), input = $('#cmdInput'), stateEl = $('#cmdState'), body = $('#cmdBody'), goBtn = $('#cmdGo'), mic = $('#cmdMic');
  let resolvedActions = [];
  function openCmd() { veil.classList.add('open'); setTimeout(() => input.focus(), 50); setState('idle'); }
  function closeCmd() { veil.classList.remove('open'); stopListen(); }
  function setState(s) { const map = { idle: t('cmd.state.idle'), listening: t('cmd.state.listening'), thinking: t('cmd.state.thinking'), preview: t('common.confirm'), done: t('cmd.state.done') }; stateEl.textContent = map[s]; stateEl.className = 'cmd-state ' + (s === 'idle' ? '' : s); goBtn.textContent = s === 'preview' ? t('cmd.go') : t('cmd.interpret'); goBtn.style.background = s === 'preview' ? 'var(--green)' : 'var(--accent)'; }
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
    const verb = { start_timer: t('cmd.act.start_timer'), stop_timer: t('cmd.act.stop_timer'), add_entry: t('modal.add'), create_client: t('cmd.act.create_client'), create_project: t('cmd.act.create_project'), create_person: t('cmd.act.create_person'), set_filter: t('cmd.act.set_filter'), navigate: t('cmd.act.navigate'), generate_report: t('cmd.act.generate_report'), export_pdf: 'Export PDF', delete_entry: t('cmd.act.delete_entry'), delete_client: t('cmd.act.delete_client') };
    let html = res.reply ? `<div class="cmd-reply">${escp(res.reply)}</div>` : '';
    if (!resolvedActions.length) html += `<div class="cmd-hint">${t('cmd.none')}</div>`;
    resolvedActions.forEach((a, i) => {
      const kv = Object.entries(a.resolved || {}).filter(([k, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => `<span class="kv">${k}: <b>${escp(Array.isArray(v) ? v.join(', ') : v)}</b></span>`).join('');
      const amb = a.ambiguous ? `<div class="pc-amb">Care proiect? <select data-amb="${i}">${a.candidates.map(c => `<option value="${c.id}">${escp(c.name)}</option>`).join('')}</select></div>` : '';
      html += `<div class="pchip ${a.kind}" data-chip="${i}"><div class="pc-head"><span class="pc-verb">${verb[a.action] || a.action}</span><span class="pc-kind">${a.kind}</span></div><div class="pc-fields">${kv || '<span class="kv" style="color:var(--ink3)">—</span>'}</div>${amb}<div class="pc-done" style="display:none">✓ Executat</div></div>`;
    });
    body.innerHTML = html;
    $$('[data-amb]').forEach(sel => sel.addEventListener('change', () => { resolvedActions[+sel.dataset.amb].exec.projectId = sel.value; resolvedActions[+sel.dataset.amb].ambiguous = false; }));
    $('#cmdFyi').textContent = resolvedActions.some(a => a.kind !== 'read') ? t('cmd.review') : '';
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
    setTimeout(() => { resolvedActions = []; input.value = ''; body.innerHTML = `<div class="cmd-hint">${t('cmd.done_hint')}</div>`; setState('idle'); }, 1400);
  }

  /* ---------- speech ---------- */
  let recog = null, listening = false; const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  mic.onclick = () => { if (listening) stopListen(); else startListen(); };
  function startListen() { if (!SR) { toast(t('cmd.no_voice')); return; } recog = new SR(); recog.lang = LOC(); recog.interimResults = true; recog.continuous = false; recog.onresult = e => { let t = ''; for (const r of e.results) t += r[0].transcript; input.value = t; }; recog.onend = () => { listening = false; mic.classList.remove('listening'); setState('idle'); }; recog.onerror = () => { listening = false; mic.classList.remove('listening'); }; recog.start(); listening = true; mic.classList.add('listening'); setState('listening'); }
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

  applyI18n();
  loadState(); loadSettings();
})();
