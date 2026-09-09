// Local AI via Ollama. Command parsing uses schema-constrained JSON output.
// The system prompt is assembled per language from shared/locales.json, so the
// model is instructed — and replies — in whatever language the instance is set to.
import { t, normalizeLang } from './i18n.js';
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';

export async function ollamaUp() {
  try { const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(6000) }); return r.ok; }
  catch { return false; }
}
export async function listModels() {
  try { const r = await fetch(OLLAMA + '/api/tags'); const j = await r.json(); return (j.models || []).map(m => m.name); }
  catch { return []; }
}

const ACTION_ENUM = ['start_timer', 'stop_timer', 'add_entry', 'create_client', 'create_project', 'create_person', 'set_filter', 'generate_report', 'export_pdf', 'navigate', 'delete_entry', 'delete_client'];

// JSON Schema handed to Ollama's `format` field — grammar-constrains the output.
const COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTION_ENUM },
          args: {
            type: 'object',
            properties: {
              clientName: { type: 'string' }, projectHint: { type: 'string' }, personName: { type: 'string' },
              projectName: { type: 'string' }, name: { type: 'string' },
              desc: { type: 'string' }, hours: { type: 'number' }, minutes: { type: 'number' },
              cost: { type: 'number' }, includedHours: { type: 'number' }, rate: { type: 'number' },
              tags: { type: 'array', items: { type: 'string' } },
              date: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' },
              from: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' },
              view: { type: 'string' },
            },
          },
        },
        required: ['action'],
      },
    },
  },
  required: ['reply', 'actions'],
};

const STRICT = {
  ro: '- Folosește DOAR aceste acțiuni: {ACTIONS}.\n- NU inventa ID-uri. Folosește nume (clientName, personName, projectHint) — serverul le rezolvă.\n- add_entry/start_timer: pune în desc CE a lucrat, cu cuvintele utilizatorului. desc nu e numele proiectului.\nRăspunde DOAR cu JSON conform schemei.',
  en: '- Use ONLY these actions: {ACTIONS}.\n- Do NOT invent IDs. Use names (clientName, personName, projectHint) — the server resolves them.\n- add_entry/start_timer: put WHAT was worked on in desc, in the user\u2019s words. desc is not the project name.\nAnswer ONLY with JSON matching the schema.',
  es: '- Usa SOLO estas acciones: {ACTIONS}.\n- NO inventes IDs. Usa nombres (clientName, personName, projectHint): el servidor los resuelve.\n- add_entry/start_timer: pon en desc EN QUÉ se trabajó, con las palabras del usuario. desc no es el nombre del proyecto.\nResponde SOLO con JSON conforme al esquema.',
  de: '- Verwende NUR diese Aktionen: {ACTIONS}.\n- Erfinde KEINE IDs. Verwende Namen (clientName, personName, projectHint) — der Server löst sie auf.\n- add_entry/start_timer: schreibe in desc, WORAN gearbeitet wurde, mit den Worten des Nutzers. desc ist nicht der Projektname.\nAntworte NUR mit JSON gemäß dem Schema.',
  fr: '- Utilise UNIQUEMENT ces actions : {ACTIONS}.\n- N\u2019invente PAS d\u2019ID. Utilise les noms (clientName, personName, projectHint) — le serveur les résout.\n- add_entry/start_timer : mets dans desc SUR QUOI la personne a travaillé, avec ses mots. desc n\u2019est pas le nom du projet.\nRéponds UNIQUEMENT avec du JSON conforme au schéma.',
};

function systemPrompt(lang) {
  const L = normalizeLang(lang);
  return [
    t(L, 'ai.sys'),
    (STRICT[L] || STRICT.ro).replace('{ACTIONS}', ACTION_ENUM.join(', ')),
    t(L, 'ai.verbs'),
    t(L, 'ai.time'),
    t(L, 'ai.example'),
  ].join('\n');
}

export async function parseCommand(text, ctx, model, lang = 'ro') {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const sys = systemPrompt(lang).replace('{TODAY}', today).replace('{MONTH_START}', monthStart).replaceAll('{YESTERDAY}', yesterday);
  const cat = t(normalizeLang(lang), 'ai.catalog', {
    clients: ctx.clients.map(c => c.name).join(', ') || '—',
    projects: ctx.projects.map(p => p.name).join(', ') || '—',
    people: ctx.people.map(p => p.name).join(', ') || '—',
  });
  const r = await fetch(OLLAMA + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, format: COMMAND_SCHEMA, options: { temperature: 0 },
      messages: [{ role: 'system', content: sys + '\n\n' + cat }, { role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
  const j = await r.json();
  return JSON.parse(j.message.content);
}

export async function generateReportText(prompt, model, onToken) {
  const r = await fetch(OLLAMA + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, options: { temperature: 0.3 }, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
  let full = '';
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try { const j = JSON.parse(ln); const t = j.message?.content || ''; if (t) { full += t; onToken?.(t); } } catch {}
    }
  }
  return full;
}
