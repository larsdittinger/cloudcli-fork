import { ShieldAlert, ShieldCheck } from 'lucide-react';

import { cn } from '@/shared/utils';
import { formatWhen } from '@/modules/channels/ChannelBits';
import type { InjectionFinding, InjectionScan } from '@/modules/channels/types';

/** From this score the agent's prompt carries a warning (`WARN_SCORE` on the server). */
const WARNED_FROM = 0.3;

/** Where a finding sits, in the owner's words. */
function describeWhere(where: string): string {
  if (where === 'subject') return 'subject';
  if (where === 'text') return 'text';
  if (where === 'html') return 'HTML body';
  if (where.startsWith('html-hidden')) return `hidden in the HTML ${where.slice('html-hidden'.length).trim()}`.trim();
  if (where.startsWith('attachment:')) return `attachment ${where.slice('attachment:'.length)}`;
  if (where.startsWith('decoded:')) return `decoded ${where.slice('decoded:'.length)}`;
  return where;
}

function FindingList({ findings }: { findings: InjectionFinding[] }) {
  return (
    <ul className="space-y-1.5">
      {findings.map((finding) => (
        <li key={finding.id} className="text-xs">
          <span className="font-medium">{finding.label}</span>
          <span className="text-muted-foreground"> · {describeWhere(finding.where)}</span>
          <div className="mt-0.5 break-words rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground">„{finding.excerpt}"</div>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the prompt-injection filter found in a message: a warning card while it
 * holds the message, a note once the owner released it, and a quieter note when
 * the findings stayed under the threshold (the agent got the message with a warning).
 */
export default function InjectionNotice({ scan, quarantined }: { scan: InjectionScan; quarantined: boolean }) {
  if (quarantined) {
    return (
      <section aria-label="Prompt-injection warning" className="space-y-2 rounded-md border border-red-500/40 bg-red-500/10 p-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" aria-hidden />
          <div>
            <p className="font-semibold text-red-700 dark:text-red-200">Held: possible prompt injection</p>
            <p className="text-xs text-red-700/90 dark:text-red-200/90">
              The message may try to give orders to the agent. No agent has seen it, and agents cannot read it until you release it.
              Check the parts below — if it is harmless, release it.
            </p>
          </div>
          <span className="ml-auto shrink-0 text-[11px] text-red-700/80 dark:text-red-200/80">score {scan.score} / {scan.threshold}</span>
        </div>
        <FindingList findings={scan.findings} />
        {scan.notChecked?.length ? <p className="text-[11px] text-red-700/80 dark:text-red-200/80">Not checked: {scan.notChecked.join(', ')}</p> : null}
      </section>
    );
  }
  if (scan.error) {
    return <p className="text-xs text-amber-700 dark:text-amber-300">The prompt-injection filter failed on this message ({scan.error}), so it went on unchecked.</p>;
  }
  const notChecked = scan.notChecked?.length
    ? <p className="text-[11px] text-muted-foreground">Not checked: {scan.notChecked.join(', ')}</p>
    : null;
  if (scan.flagged && scan.releasedAt) {
    return (
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> You released this message {formatWhen(scan.releasedAt)} after the prompt-injection filter held it (score {scan.score}).
        </p>
        {notChecked}
      </div>
    );
  }
  if (scan.findings.length === 0) return notChecked;
  return (
    <details className={cn('rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs')}>
      <summary className="cursor-pointer text-amber-700 dark:text-amber-300">
        Suspicious phrases (score {scan.score}, below the threshold {scan.threshold}){scan.score >= WARNED_FROM ? ' — the agent was warned' : ''}
      </summary>
      <div className="mt-2 space-y-2"><FindingList findings={scan.findings} />{notChecked}</div>
    </details>
  );
}
