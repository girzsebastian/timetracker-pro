// One dictionary for everything the user reads: the browser UI, the PDF export,
// server error messages and the AI prompts. `shared/locales.json` is the single
// source — the browser gets it verbatim through GET /i18n.js, so there is never
// a second copy to keep in sync.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
export const DICT = JSON.parse(readFileSync(join(here, '..', 'shared', 'locales.json'), 'utf8'));

export const LANGS = DICT._meta.langs;              // { ro: 'Română', en: 'English', … }
export const LOCALES = DICT._meta.locales;          // { ro: 'ro-RO', … } for Intl
export const DEFAULT_LANG = 'ro';

export const isLang = (l) => Object.prototype.hasOwnProperty.call(LANGS, l);
export const normalizeLang = (l) => (isLang(l) ? l : DEFAULT_LANG);

/** t('en', 'err.no_client') → 'No such client'. Falls back to Romanian, then to
 *  the key itself, so a missing translation degrades instead of blanking the UI. */
export function t(lang, key, vars) {
  const row = DICT[key];
  let s = (row && (row[lang] ?? row[DEFAULT_LANG])) ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** The dictionary as a browser script — no fetch, no race with app.js. */
export function browserBundle(lang) {
  return `/* generated from shared/locales.json — edit that file, not this */
window.I18N = ${JSON.stringify(DICT)};
window.LANG = ${JSON.stringify(normalizeLang(lang))};
window.LOCALE = ${JSON.stringify(LOCALES[normalizeLang(lang)] || 'ro-RO')};
window.t = function (key, vars) {
  var row = window.I18N[key];
  var s = (row && (row[window.LANG] != null ? row[window.LANG] : row.ro));
  if (s == null) s = key;
  if (vars) for (var k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
};
`;
}
