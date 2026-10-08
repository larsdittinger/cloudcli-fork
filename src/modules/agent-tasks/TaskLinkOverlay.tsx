import { useLocation, useNavigate } from 'react-router-dom';

import { useIsAdmin } from '@/shared/hooks/useIsAdmin';
import AllTasksOverlay from '@/modules/agent-tasks/AllTasksOverlay';

/** The task number in `?task=N`, or null. */
function readTaskLink(search: string): number | null {
  const id = Number(new URLSearchParams(search).get('task'));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Rendered by the workspace shell: a `?task=N` link (a task notification, a
 * shared link) opens that task's card above the board of all tasks. Closing it
 * drops the parameter so a reload does not open it again.
 */
export default function TaskLinkOverlay() {
  const isAdmin = useIsAdmin();
  const location = useLocation();
  const navigate = useNavigate();
  const taskId = readTaskLink(location.search);
  if (!isAdmin || taskId === null) return null;

  const close = () => {
    const params = new URLSearchParams(location.search);
    params.delete('task');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true });
  };

  return <AllTasksOverlay key={taskId} initialTaskId={taskId} onClose={close} />;
}
