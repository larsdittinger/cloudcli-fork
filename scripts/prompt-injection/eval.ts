/**
 * Measures the Channels prompt-injection filter on the corpus built by dataset.py.
 *
 *   npx tsx --tsconfig server/tsconfig.json scripts/prompt-injection/eval.ts [--split holdout|train] [--sensitivity normal|strict]
 *                                                                          [--sample 3000] [--dump]
 *
 * Reports, per source: how many attacks were held (detection) and how many benign
 * messages were held by mistake (false positives). `--dump` writes the misses and
 * false alarms to $PI_DATA/eval-<split>-{fn,fp}.jsonl for review.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { scanForInjection } from '@/modules/channels/injection/injection-scanner.js';
import type { InjectionSensitivity } from '@/modules/channels/injection/injection-scanner.js';

type Row = { source: string; split: string; label: number; lang: string; subject: string; text: string; html: string };

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const split = flag('split', 'holdout');
const sensitivity = flag('sensitivity', 'normal') as InjectionSensitivity;
const sample = Number(flag('sample', '4000'));
const dump = args.includes('--dump');
const data = process.env.PI_DATA ?? path.join(os.homedir(), '.cache', 'cloudcli-prompt-injection');

const EMAIL_RELEVANT = new Set(['llmail_p1', 'llmail_p2', 'bipia', 'agentsec', 'agentic5k', 'boundary_pairs', 'piarena', 'synthetic_docs', 'synthetic_v2', 'enron_test', 'enron_train_ham', 'enron_train_spam', 'llmail_fp', 'handwritten', 'notinject', 'inbox', 'deepset']);

/** The first `sample` rows per source and label: the same rows every run, so numbers stay comparable. */
function keep(row: Row, perSourceSeen: Map<string, number>): boolean {
  const key = `${row.source}:${row.label}`;
  const seen = (perSourceSeen.get(key) ?? 0) + 1;
  perSourceSeen.set(key, seen);
  return seen <= sample;
}

async function main(): Promise<void> {
  const file = path.join(data, 'corpus', `${split}.jsonl`);
  const stream = readline.createInterface({ input: fs.createReadStream(file) });
  const stats = new Map<string, { attacks: number; caught: number; benign: number; falseAlarms: number }>();
  const byLang = new Map<string, { attacks: number; caught: number; benign: number; falseAlarms: number }>();
  const fn: unknown[] = [];
  const fp: unknown[] = [];
  const perSourceSeen = new Map<string, number>();
  const findingCounts = new Map<string, { attack: number; benign: number }>();
  const started = Date.now();

  for await (const line of stream) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Row;
    if (!keep(row, perSourceSeen)) continue;
    const scan = scanForInjection({ subject: row.subject, text: row.text, html: row.html || null }, sensitivity);
    const entry = stats.get(row.source) ?? { attacks: 0, caught: 0, benign: 0, falseAlarms: 0 };
    const lang = byLang.get(row.lang || 'en') ?? { attacks: 0, caught: 0, benign: 0, falseAlarms: 0 };
    for (const target of [entry, lang]) {
      if (row.label === 1) {
        target.attacks += 1;
        if (scan.flagged) target.caught += 1;
      } else {
        target.benign += 1;
        if (scan.flagged) target.falseAlarms += 1;
      }
    }
    stats.set(row.source, entry);
    byLang.set(row.lang || 'en', lang);
    for (const finding of scan.findings) {
      const count = findingCounts.get(finding.id) ?? { attack: 0, benign: 0 };
      if (row.label === 1) count.attack += 1;
      else count.benign += 1;
      findingCounts.set(finding.id, count);
    }
    const record = { source: row.source, lang: row.lang, score: scan.score, findings: scan.findings.map((f) => `${f.id}@${f.where}: ${f.excerpt}`), subject: row.subject, text: row.text.slice(0, 1500) };
    if (row.label === 1 && !scan.flagged && fn.length < 3000) fn.push(record);
    if (row.label === 0 && scan.flagged && fp.length < 3000) fp.push(record);
  }

  const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '—');
  console.log(`split=${split} sensitivity=${sensitivity} sample≤${sample}/source/label  (${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
  console.log('source                  attacks  caught      benign  false alarms');
  const totals = { email: { attacks: 0, caught: 0, benign: 0, falseAlarms: 0 }, other: { attacks: 0, caught: 0, benign: 0, falseAlarms: 0 } };
  for (const [source, entry] of [...stats.entries()].sort()) {
    const bucket = EMAIL_RELEVANT.has(source) ? totals.email : totals.other;
    bucket.attacks += entry.attacks;
    bucket.caught += entry.caught;
    bucket.benign += entry.benign;
    bucket.falseAlarms += entry.falseAlarms;
    console.log(`${source.padEnd(22)} ${String(entry.attacks).padStart(8)}  ${pct(entry.caught, entry.attacks).padStart(6)}  ${String(entry.benign).padStart(10)}  ${pct(entry.falseAlarms, entry.benign).padStart(6)} (${entry.falseAlarms})`);
  }
  for (const [name, entry] of Object.entries(totals)) {
    console.log(`${`= ${name === 'email' ? 'mail/doc sets' : 'chat jailbreak sets'}`.padEnd(22)} ${String(entry.attacks).padStart(8)}  ${pct(entry.caught, entry.attacks).padStart(6)}  ${String(entry.benign).padStart(10)}  ${pct(entry.falseAlarms, entry.benign).padStart(6)} (${entry.falseAlarms})`);
  }
  console.log('\nlanguage   attacks  caught      benign  false alarms');
  for (const [lang, entry] of [...byLang.entries()].sort((a, b) => b[1].attacks + b[1].benign - a[1].attacks - a[1].benign).slice(0, 14)) {
    console.log(`${lang.padEnd(8)} ${String(entry.attacks).padStart(8)}  ${pct(entry.caught, entry.attacks).padStart(6)}  ${String(entry.benign).padStart(10)}  ${pct(entry.falseAlarms, entry.benign).padStart(6)} (${entry.falseAlarms})`);
  }
  console.log('\nsignature                               on attacks  on benign');
  for (const [id, count] of [...findingCounts.entries()].sort((a, b) => b[1].attack - a[1].attack)) {
    console.log(`${id.padEnd(40)} ${String(count.attack).padStart(9)}  ${String(count.benign).padStart(9)}`);
  }
  if (dump) {
    fs.writeFileSync(path.join(data, `eval-${split}-fn.jsonl`), fn.map((r) => JSON.stringify(r)).join('\n'));
    fs.writeFileSync(path.join(data, `eval-${split}-fp.jsonl`), fp.map((r) => JSON.stringify(r)).join('\n'));
    console.log(`\nwrote ${fn.length} misses and ${fp.length} false alarms to ${data}/eval-${split}-{fn,fp}.jsonl`);
  }
}

void main();
