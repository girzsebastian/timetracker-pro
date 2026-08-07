// Local AI via Ollama. Command parsing uses schema-constrained JSON output.
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';

export async function ollamaUp() {
  try { const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(1500) }); return r.ok; }
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
              cost: { type: 'number' }, includedHours: { type: 'number' },
              tags: { type: 'array', items: { type: 'string' } },
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

const SYS = `Ești asistentul unei aplicații de pontaj (time tracker) pentru o firmă de mentenanță software.
Transformi o comandă în limba română într-un plan de acțiuni JSON.
Reguli:
- Folosește DOAR aceste acțiuni: ${ACTION_ENUM.join(', ')}.
- NU inventa ID-uri. Folosește nume (clientName, personName, projectHint) — serverul le rezolvă.
- Pentru "pornește/începe cronometru" -> start_timer. Pentru "oprește/stop" -> stop_timer.
- Pentru "adaugă X ore la ..." -> add_entry cu hours/minutes.
- Pentru "filtrează pe ..." -> set_filter (clientName, personName, from, to, text, tags).
- Pentru "raport" -> generate_report. Pentru "PDF/exportă" -> export_pdf. Pentru "du-te la / deschide" -> navigate cu view (panou|inregistrari|clienti|proiecte|echipa|raport|setari).
- Datele: azi este {TODAY}. "luna asta" = de la {MONTH_START} până azi.
- reply = confirmare scurtă în română a ce vei face.
Răspunde DOAR cu JSON conform schemei.`;

export async function parseCommand(text, ctx, model) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const sys = SYS.replace('{TODAY}', today).replace('{MONTH_START}', monthStart);
  const cat = `Clienți: ${ctx.clients.map(c => c.name).join(', ') || '—'}
Proiecte: ${ctx.projects.map(p => p.name).join(', ') || '—'}
Persoane: ${ctx.people.map(p => p.name).join(', ') || '—'}`;
  const r = await fetch(OLLAMA + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, format: COMMAND_SCHEMA, options: { temperature: 0.1 },
      messages: [{ role: 'system', content: sys + '\n\nCatalog curent:\n' + cat }, { role: 'user', content: text }],
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
