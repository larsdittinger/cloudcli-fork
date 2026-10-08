import { useState } from 'react';
import { ListTodo } from 'lucide-react';

import { Button, Tooltip } from '@/shared/ui';
import { useIsAdmin } from '@/shared/hooks/useIsAdmin';
import { cn } from '@/shared/utils';
import { useAgentTasksAttention } from '@/modules/agent-tasks/hooks/useAgentTasksAttention';
import AllTasksOverlay from '@/modules/agent-tasks/AllTasksOverlay';

type Props = { className?: string; iconClassName?: string };

/** Sidebar header entry to every project's agent tasks; the badge counts the ones that need the owner. */
export default function AllTasksButton({ className, iconClassName }: Props) {
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const { total } = useAgentTasksAttention(isAdmin);

  if (!isAdmin) return null;
  const label = total > 0 ? `All agent tasks — ${total} need${total === 1 ? 's' : ''} you` : 'All agent tasks';

  return (
    <>
      <Tooltip content={label} position="bottom">
        <Button
          variant="ghost"
          size="icon"
          className={cn('relative h-8 w-8', className)}
          aria-label={label}
          onClick={() => setOpen(true)}
        >
          <ListTodo className={cn('h-4 w-4', iconClassName)} aria-hidden />
          {total > 0 && (
            <span aria-hidden className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white">
              {total > 99 ? '99+' : total}
            </span>
          )}
        </Button>
      </Tooltip>
      {open && <AllTasksOverlay onClose={() => setOpen(false)} />}
    </>
  );
}
