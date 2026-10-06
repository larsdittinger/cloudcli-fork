import { useState } from 'react';
import { Bot, Check, Loader2, X } from 'lucide-react';

import { Button } from '@/shared/ui';
import { formatWhen } from '@/modules/channels';
import type { ChannelAccount } from '@/modules/channels';

type Props = {
  proposal: NonNullable<ChannelAccount['proposal']>;
  /** Shown above the buttons when approving now would not work yet (e.g. a missing password). */
  warning?: string | null;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
};

/**
 * Used by AccountCard and RuleList for configuration an agent proposed through
 * MCP: it stays disabled until the admin approves it here.
 */
export default function ProposalNotice({ proposal, warning, onApprove, onReject }: Props) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: 'approve' | 'reject', action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5 font-medium text-amber-800 dark:text-amber-200">
        <Bot className="h-3.5 w-3.5" aria-hidden />
        Proposed by an agent · waiting for approval
        <span className="font-normal text-muted-foreground">
          {formatWhen(proposal.createdAt)}{proposal.projectPath ? ` · from ${proposal.projectPath}` : ''}
        </span>
      </div>
      {proposal.note && <p className="mt-1 whitespace-pre-wrap text-foreground">{proposal.note}</p>}
      <p className="mt-1 text-muted-foreground">Disabled until approved. Check the settings above (Edit to change them), then approve.</p>
      {warning && <p className="mt-1 text-amber-800 dark:text-amber-200">{warning}</p>}
      {error && <p role="alert" className="mt-1 text-red-600 dark:text-red-300">{error}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => { void run('approve', onApprove); }} disabled={busy !== null}>
          {busy === 'approve' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="mr-1 h-3.5 w-3.5" aria-hidden />}
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => { void run('reject', onReject); }} disabled={busy !== null}>
          {busy === 'reject' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="mr-1 h-3.5 w-3.5" aria-hidden />}
          Reject
        </Button>
      </div>
    </div>
  );
}
