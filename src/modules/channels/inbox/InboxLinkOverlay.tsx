import { useLocation, useNavigate } from 'react-router-dom';

import { useIsAdmin } from '@/shared/hooks/useIsAdmin';
import InboxOverlay from '@/modules/channels/inbox/InboxOverlay';

/**
 * Rendered by the workspace shell: a `?inbox=<message id>` link (the "held for review"
 * notification) opens the Inbox at that message, whether or not the sidebar is shown.
 * Closing it drops the parameter so a reload does not open it again.
 */
export default function InboxLinkOverlay() {
  const isAdmin = useIsAdmin();
  const location = useLocation();
  const navigate = useNavigate();
  const messageId = new URLSearchParams(location.search).get('inbox');
  if (!isAdmin || !messageId) return null;

  const close = (open: boolean) => {
    if (open) return;
    const params = new URLSearchParams(location.search);
    params.delete('inbox');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true });
  };

  return <InboxOverlay key={messageId} open onOpenChange={close} initialMessageId={messageId} />;
}
