// Branded PDF export — light "paper" theme, everything in one document. pdfmake, no Chromium.
import PdfPrinter from 'pdfmake';
import * as vfsModule from 'pdfmake/build/vfs_fonts.js';
import { db } from './db.js';
import { listEntries, catalog } from './actions.js';

// Roboto (bundled with pdfmake, full Romanian diacritics) embedded via vfs Buffers.
const vfs = vfsModule.default?.pdfMake?.vfs || vfsModule.default?.vfs || vfsModule.default || vfsModule.vfs;
const buf = name => Buffer.from(vfs[name], 'base64');
const fonts = { Roboto: {
  normal: buf('Roboto-Regular.ttf'), bold: buf('Roboto-Medium.ttf'),
  italics: buf('Roboto-Italic.ttf'), bolditalics: buf('Roboto-MediumItalic.ttf'),
} };
const printer = new PdfPrinter(fonts);
const GOLD = '#b9902a', INK = '#1e2230', SUB = '#6b7280', LINE = '#e5e7eb', GREEN = '#16a34a', RED = '#dc2626';
const fmtHM = m => { const h = Math.floor(m / 60), x = m % 60; return h + 'h' + (x ? ' ' + x + 'm' : ''); };
const MON = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];

export function buildReportPdf(filter = {}, narrative = '') {
  const { clients, projects, people } = catalog();
  const entries = listEntries(filter);
  const client = c => clients.find(x => x.id === c);
  const project = id => projects.find(p => p.id === id);
  const person = id => people.find(p => p.id === id);
  const total = entries.reduce((s, e) => s + e.mins, 0);

  // filter label
  const parts = [];
  if (filter.clientId) parts.push('Client: ' + (client(filter.clientId)?.name || ''));
  if (filter.personId) parts.push('Persoană: ' + (person(filter.personId)?.name || ''));
  if (filter.from || filter.to) parts.push('Perioadă: ' + (filter.from || '…') + ' → ' + (filter.to || '…'));
  if (filter.tags?.length) parts.push('Taguri: ' + filter.tags.join(', '));
  const now = new Date();

  // per-client hours vs package + overage billing
  const eur = n => Math.round(n).toLocaleString('ro-RO') + ' €';
  let totExtra = 0, totBilled = 0;
  const clientRows = clients.map(c => {
    const pids = projects.filter(p => p.client_id === c.id).map(p => p.id);
    const mins = entries.filter(e => pids.includes(e.project_id)).reduce((s, e) => s + e.mins, 0);
    const cap = (c.hours || 0) * 60;
    const hourly = !(c.cost || 0) && !cap && (c.rate || 0) > 0;
    const overMins = hourly ? 0 : Math.max(0, mins - cap);
    const overCost = (overMins / 60) * (c.overage || 0);
    const hourlyCost = hourly ? (mins / 60) * c.rate : 0;
    const variable = overCost + hourlyCost;
    const billed = (c.cost || 0) + variable;
    totExtra += variable; totBilled += billed;
    return [c.name, hourly ? c.rate + ' €/h' : (c.cost || 0) + ' €', cap ? fmtHM(cap) : '—', { text: fmtHM(mins), color: overMins ? RED : INK },
      { text: variable ? '+' + eur(variable) : '—', color: overCost ? RED : SUB, bold: !!variable },
      { text: eur(billed), bold: true }];
  });

  // per-person
  const byP = {}; entries.forEach(e => byP[e.person_id] = (byP[e.person_id] || 0) + e.mins);
  const personRows = people.map(p => [p.name, fmtHM(byP[p.id] || 0)]).filter(r => byP[r] !== undefined || true);

  // tags
  const byT = {}; entries.forEach(e => (e.tags || []).forEach(t => byT[t] = (byT[t] || 0) + e.mins));
  const tagRows = Object.entries(byT).sort((a, b) => b[1] - a[1]).map(([t, m]) => [t, fmtHM(m)]);

  // day-grouped log
  const groups = {}; entries.forEach(e => (groups[e.date] = groups[e.date] || []).push(e));
  const logStack = Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(date => {
    const d = new Date(date), tot = groups[date].reduce((s, e) => s + e.mins, 0);
    return [
      { text: d.toLocaleDateString('ro-RO', { weekday: 'long', day: 'numeric', month: 'long' }) + '  ·  ' + fmtHM(tot), style: 'dayHead', margin: [0, 8, 0, 3] },
      { table: { widths: ['*', 90, 60], body: groups[date].map(e => {
        const pr = project(e.project_id);
        return [
          { text: [{ text: e.desc + '\n', color: INK }, { text: (pr ? pr.name + ' · ' + (client(pr.client_id)?.name || '') : '—') + (e.tags?.length ? '  [' + e.tags.join(', ') + ']' : ''), color: SUB, fontSize: 8 }] },
          { text: person(e.person_id)?.name || '—', color: SUB, fontSize: 9 },
          { text: fmtHM(e.mins), alignment: 'right', bold: true },
        ];
      }) }, layout: 'noBorders', fontSize: 9 },
    ];
  }).flat();

  const narrStack = narrative ? [
    { text: 'Rezumat', style: 'h2', margin: [0, 16, 0, 6] },
    ...narrative.split('\n').filter(l => l.trim()).map(l => ({ text: l.replace(/^#+\s*/, '').replace(/\*\*/g, ''), margin: [0, 0, 0, 4], color: INK })),
  ] : [];

  const doc = {
    pageMargins: [40, 70, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 10, color: INK },
    header: {
      margin: [40, 24, 40, 0],
      columns: [
        { text: '⏱ TimeTracker', bold: true, fontSize: 14, color: INK },
        { text: 'Raport de activitate', alignment: 'right', color: SUB, margin: [0, 3, 0, 0] },
      ],
    },
    footer: (cur, tot) => ({ margin: [40, 0, 40, 0], columns: [
      { text: 'Generat ' + now.toLocaleDateString('ro-RO') + ' ' + now.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' }), color: SUB, fontSize: 8 },
      { text: cur + ' / ' + tot, alignment: 'right', color: SUB, fontSize: 8 },
    ] }),
    content: [
      { text: MON[now.getMonth()] + ' ' + now.getFullYear(), style: 'h1' },
      parts.length ? { text: parts.join('   ·   '), color: SUB, margin: [0, 2, 0, 0] } : {},
      { canvas: [{ type: 'line', x1: 0, y1: 8, x2: 515, y2: 8, lineWidth: 1, lineColor: LINE }] },

      // KPIs
      { columns: [
        kpi(fmtHM(total), 'Total lucrat'),
        kpi(clients.reduce((s, c) => s + (c.cost || 0), 0).toLocaleString('ro-RO') + ' €', 'Venit recurent/lună'),
        kpi(String(entries.length), 'Înregistrări'),
        kpi(total ? (clients.reduce((s, c) => s + (c.cost || 0), 0) / (total / 60)).toFixed(0) + ' €' : '—', 'Tarif efectiv/oră'),
      ], columnGap: 10, margin: [0, 14, 0, 0] },

      { text: 'Clienți — ore, pachet & costuri extra', style: 'h2', margin: [0, 18, 0, 6] },
      { table: { headerRows: 1, widths: ['*', 60, 55, 55, 65, 65], body: [
        ['Client', 'Abonament / Tarif', 'Incluse', 'Lucrate', 'Extra / Orar', 'Total facturat'].map(t => ({ text: t, style: 'th' })),
        ...clientRows,
        [{ text: 'TOTAL', bold: true, colSpan: 4, alignment: 'right' }, {}, {}, {}, { text: totExtra ? '+' + eur(totExtra) : '—', bold: true, color: totExtra ? RED : SUB }, { text: eur(totBilled), bold: true, color: GOLD }],
      ] }, layout: tableLayout() },

      { columns: [
        { width: '48%', stack: [
          { text: 'Pe persoană', style: 'h2', margin: [0, 18, 0, 6] },
          { table: { widths: ['*', 70], body: [['Persoană', 'Ore'].map(t => ({ text: t, style: 'th' })), ...personRows] }, layout: tableLayout() },
        ] },
        { width: '4%', text: '' },
        { width: '48%', stack: [
          { text: 'Pe tag', style: 'h2', margin: [0, 18, 0, 6] },
          tagRows.length ? { table: { widths: ['*', 70], body: [['Tag', 'Ore'].map(t => ({ text: t, style: 'th' })), ...tagRows] }, layout: tableLayout() } : { text: 'Fără taguri', color: SUB },
        ] },
      ] },

      ...narrStack,

      { text: 'Jurnal complet', style: 'h2', margin: [0, 18, 0, 8] },
      ...logStack,
      entries.length === 0 ? { text: 'Nicio înregistrare pentru filtrul selectat.', color: SUB } : {},
    ],
    styles: {
      h1: { fontSize: 22, bold: true, color: INK },
      h2: { fontSize: 13, bold: true, color: GOLD },
      th: { bold: true, fontSize: 9, color: SUB, fillColor: '#f8f9fb' },
      dayHead: { fontSize: 10, bold: true, color: SUB },
    },
  };
  return printer.createPdfKitDocument(doc);

  function kpi(val, lbl) { return { width: '*', stack: [{ text: val, fontSize: 18, bold: true, color: INK }, { text: lbl, fontSize: 8, color: SUB }], margin: [0, 0, 0, 0] }; }
}
function tableLayout() {
  return {
    hLineWidth: (i) => i === 1 ? 1 : 0.5, hLineColor: () => '#eceef2', vLineWidth: () => 0,
    paddingTop: () => 5, paddingBottom: () => 5, paddingLeft: () => 6, paddingRight: () => 6,
  };
}
