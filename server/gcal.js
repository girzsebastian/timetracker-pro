// Google Calendar import via the calendar's secret iCal URL (read-only).
// No deps: minimal ICS parser + RRULE expansion for the common cases (DAILY/WEEKLY/MONTHLY/YEARLY).
// Events are cached 5 minutes so the calendar UI doesn't hammer Google.

let cache = { url: '', at: 0, events: [] };

const DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// unfold ICS continuation lines (lines starting with space/tab continue the previous one)
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

// 20260807T100000Z | 20260807T100000 | 20260807 -> Date (naive: TZID times treated as server-local)
function parseDt(v) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  return { date: z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
}

function parseVevent(lines) {
  const ev = { exdates: new Set() };
  for (const ln of lines) {
    const idx = ln.indexOf(':'); if (idx < 0) continue;
    const left = ln.slice(0, idx), val = ln.slice(idx + 1);
    const prop = left.split(';')[0];
    if (prop === 'DTSTART') ev.start = parseDt(val);
    else if (prop === 'DTEND') ev.end = parseDt(val);
    else if (prop === 'SUMMARY') ev.summary = val.replace(/\\,/g, ',').replace(/\\n/g, ' ').replace(/\\\\/g, '\\');
    else if (prop === 'RRULE') ev.rrule = Object.fromEntries(val.split(';').map(kv => kv.split('=')));
    else if (prop === 'EXDATE') val.split(',').forEach(x => { const d = parseDt(x); if (d) ev.exdates.add(+d.date); });
    else if (prop === 'UID') ev.uid = val;
    else if (prop === 'STATUS') ev.status = val;
    else if (prop === 'RECURRENCE-ID') ev.recurrenceId = parseDt(val);
  }
  return ev.start ? ev : null;
}

// expand one event into concrete occurrences inside [from, to]
function occurrences(ev, from, to) {
  const durMs = ev.end ? (+ev.end.date - +ev.start.date) : 60 * 60000;
  const out = [];
  const push = (startDate) => {
    if (ev.exdates.has(+startDate)) return;
    const endD = new Date(+startDate + durMs);
    if (startDate <= to && endD >= from) out.push({ start: startDate, end: endD, allDay: ev.start.allDay, summary: ev.summary || '(fără titlu)', uid: ev.uid });
  };
  if (!ev.rrule) { push(ev.start.date); return out; }

  const r = ev.rrule, freq = r.FREQ, interval = Math.max(1, +(r.INTERVAL || 1));
  const until = r.UNTIL ? parseDt(r.UNTIL)?.date : null;
  const count = r.COUNT ? +r.COUNT : null;
  const limit = until && until < to ? until : to;
  let made = 0, guard = 0;

  if (freq === 'WEEKLY') {
    const bydays = (r.BYDAY ? r.BYDAY.split(',') : []).map(d => DAY[d.slice(-2)]).filter(d => d != null);
    const days = bydays.length ? bydays : [ev.start.date.getDay()];
    let weekStart = new Date(ev.start.date); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // sunday of first week
    while (weekStart <= limit && guard++ < 1000) {
      for (const wd of days) {
        const occ = new Date(weekStart); occ.setDate(occ.getDate() + wd);
        occ.setHours(ev.start.date.getHours(), ev.start.date.getMinutes(), 0, 0);
        if (occ < ev.start.date) continue;
        if (count != null && made >= count) return out;
        made++;
        if (occ > limit) return out;
        push(occ);
      }
      weekStart.setDate(weekStart.getDate() + 7 * interval);
    }
  } else if (freq === 'DAILY' || freq === 'MONTHLY' || freq === 'YEARLY') {
    let occ = new Date(ev.start.date);
    while (occ <= limit && guard++ < 1000) {
      if (count != null && made >= count) break;
      made++;
      push(new Date(occ));
      if (freq === 'DAILY') occ.setDate(occ.getDate() + interval);
      else if (freq === 'MONTHLY') occ.setMonth(occ.getMonth() + interval);
      else occ.setFullYear(occ.getFullYear() + interval);
    }
  } else {
    push(ev.start.date); // unsupported freq: show at least the first occurrence
  }
  return out;
}

export async function gcalEvents(url, fromISO, toISO) {
  const now = Date.now();
  if (cache.url !== url || now - cache.at > 5 * 60000) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' la descărcarea calendarului');
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Link-ul nu pare a fi un calendar iCal');
    const lines = unfold(text);
    const events = []; let cur = null;
    for (const ln of lines) {
      if (ln === 'BEGIN:VEVENT') cur = [];
      else if (ln === 'END:VEVENT') { const ev = parseVevent(cur || []); if (ev) events.push(ev); cur = null; }
      else if (cur) cur.push(ln);
    }
    // overridden instances of recurring events (RECURRENCE-ID) replace the generated occurrence
    const overrides = new Set(events.filter(e => e.recurrenceId).map(e => e.uid + '@' + (+e.recurrenceId.date)));
    cache = { url, at: now, events, overrides };
  }
  const from = new Date(fromISO + 'T00:00:00'), to = new Date(toISO + 'T23:59:59');
  const out = [];
  for (const ev of cache.events) {
    if (ev.status === 'CANCELLED') continue;
    for (const o of occurrences(ev, from, to)) {
      if (ev.rrule && cache.overrides?.has(ev.uid + '@' + (+o.start))) continue;
      out.push({
        summary: o.summary, allDay: o.allDay,
        date: new Date(+o.start - o.start.getTimezoneOffset() * 60000).toISOString().slice(0, 10),
        startMin: o.allDay ? null : o.start.getHours() * 60 + o.start.getMinutes(),
        mins: o.allDay ? null : Math.max(15, Math.round((+o.end - +o.start) / 60000)),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.startMin ?? 0) - (b.startMin ?? 0));
}
