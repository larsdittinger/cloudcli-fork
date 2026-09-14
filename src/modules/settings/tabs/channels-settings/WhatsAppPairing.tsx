import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import type { AccountStatus } from '@/modules/channels';

type Pairing = { qrDataUrl: string | null; pairingCode: string | null; status: AccountStatus; statusDetail: string | null };

/** Shown inside a WhatsApp account card while it waits to be linked: the QR, or a pairing code for a phone number. */
export default function WhatsAppPairing({ accountId, phoneNumber, onPaired }: { accountId: string; phoneNumber?: string; onPaired: () => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [phone, setPhone] = useState(phoneNumber ?? '');
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const data = await readApiJson<{ data: Pairing }>(await api.channels.pairing(accountId));
        if (!active) return;
        setPairing(data.data);
        if (data.data.status === 'connected') onPaired();
      } catch {
        // Keep the last state; the next tick retries.
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [accountId, onPaired]);

  const requestCode = async () => {
    setRequesting(true);
    setError(null);
    try {
      const data = await readApiJson<{ data: { pairingCode: string } }>(await api.channels.requestPairingCode(accountId, phone));
      setPairing((current) => current ? { ...current, pairingCode: data.data.pairingCode } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="mt-3 grid gap-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 sm:grid-cols-[auto_1fr]">
      <div className="flex items-center justify-center">
        {pairing?.qrDataUrl ? (
          <img src={pairing.qrDataUrl} alt="WhatsApp pairing QR code" className="h-48 w-48 rounded bg-white p-1" />
        ) : (
          <div className="flex h-48 w-48 items-center justify-center rounded border border-dashed border-border text-xs text-muted-foreground">
            <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> Waiting for QR…
          </div>
        )}
      </div>
      <div className="space-y-2 text-sm">
        <p className="font-medium">Link this number</p>
        <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
          <li>Open WhatsApp on the phone → Settings → Linked devices → Link a device.</li>
          <li>Scan the QR code, or use a pairing code with the phone number below.</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-56" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+420 777 123 456" />
          <Button size="sm" variant="outline" onClick={requestCode} disabled={requesting || phone.replace(/\D/g, '').length < 8}>
            {requesting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />} Get pairing code
          </Button>
        </div>
        {pairing?.pairingCode && (
          <p className="font-mono text-2xl tracking-[0.3em]">{pairing.pairingCode}</p>
        )}
        {pairing?.statusDetail && <p className="text-xs text-muted-foreground">{pairing.statusDetail}</p>}
        {error && <p className="text-xs text-red-600 dark:text-red-300">{error}</p>}
      </div>
    </div>
  );
}
