import assert from 'node:assert/strict';

import { test } from 'vitest';

/**
 * English is the fallback and Czech is a language we keep complete, so a key
 * missing from either shows up as an untranslated string in the UI. These
 * checks fail when a key lands in one of them without the other — after an
 * upstream merge that is the signal to translate the new keys, not to relax
 * the test.
 */

type LocaleTree = { [key: string]: string | LocaleTree };

const enFiles = import.meta.glob<LocaleTree>('@/modules/i18n/locales/en/*.json', { eager: true, import: 'default' });
const csFiles = import.meta.glob<LocaleTree>('@/modules/i18n/locales/cs/*.json', { eager: true, import: 'default' });

// i18next picks the plural form by Intl.PluralRules: English uses one/other,
// Czech one/few/many/other ("many" is for fractions such as 1,5).
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const CS_PLURAL_FORMS = ['one', 'few', 'many', 'other'];

function namespaceOf(path: string): string {
  return path.split('/').pop()!.replace(/\.json$/, '');
}

function byNamespace(files: Record<string, LocaleTree>): Map<string, Record<string, string>> {
  return new Map(Object.entries(files).map(([path, tree]) => [namespaceOf(path), flatten(tree)]));
}

function flatten(tree: LocaleTree, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else flatten(value, path, out);
  }
  return out;
}

function placeholders(value: string): Set<string> {
  return new Set([...value.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((match) => match[1]));
}

const en = byNamespace(enFiles);
const cs = byNamespace(csFiles);

test('every English namespace has a Czech file', () => {
  assert.ok(en.size > 0, 'no English locale files found');
  assert.deepEqual([...en.keys()].filter((ns) => !cs.has(ns)), []);
});

test('every English key is translated to Czech, with all Czech plural forms', () => {
  const missing: string[] = [];
  for (const [ns, enKeys] of en) {
    const csKeys = cs.get(ns) ?? {};
    for (const key of Object.keys(enKeys)) {
      if (PLURAL_SUFFIX.test(key)) {
        const base = key.replace(PLURAL_SUFFIX, '');
        for (const form of CS_PLURAL_FORMS) {
          if (!(`${base}_${form}` in csKeys)) missing.push(`${ns}:${base}_${form}`);
        }
      } else if (!(key in csKeys)) {
        // A plain English key used with `count` may be split into plural forms
        // in Czech; then all of them must be there.
        const forms = CS_PLURAL_FORMS.map((form) => `${key}_${form}`);
        const present = forms.filter((form) => form in csKeys);
        if (present.length === 0) missing.push(`${ns}:${key}`);
        else missing.push(...forms.filter((form) => !(form in csKeys)).map((form) => `${ns}:${form}`));
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'keys missing in cs (add them to src/modules/i18n/locales/cs)');
});

test('every Czech key exists in English, the fallback language', () => {
  const missing: string[] = [];
  for (const [ns, csKeys] of cs) {
    const enKeys = en.get(ns) ?? {};
    for (const key of Object.keys(csKeys)) {
      if (key in enKeys) continue;
      const base = key.replace(PLURAL_SUFFIX, '');
      const hasEnglish = base in enKeys || `${base}_one` in enKeys || `${base}_other` in enKeys;
      if (!hasEnglish) missing.push(`${ns}:${key}`);
    }
  }
  assert.deepEqual(missing, [], 'keys missing in en (add them to src/modules/i18n/locales/en)');
});

test('Czech strings use only placeholders the English string provides', () => {
  const unknown: string[] = [];
  for (const [ns, csKeys] of cs) {
    const enKeys = en.get(ns) ?? {};
    for (const [key, value] of Object.entries(csKeys)) {
      const base = key.replace(PLURAL_SUFFIX, '');
      const english = enKeys[key] ?? enKeys[base] ?? enKeys[`${base}_other`] ?? enKeys[`${base}_one`];
      if (english === undefined) continue;
      const allowed = placeholders(english);
      for (const name of placeholders(value)) {
        if (!allowed.has(name) && name !== 'count') unknown.push(`${ns}:${key} {{${name}}}`);
      }
    }
  }
  assert.deepEqual(unknown, [], 'cs uses a placeholder the code may not pass');
});
