import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

// The assertions read the English labels.
import '@/modules/i18n';
import BackgroundTasksTab from '@/modules/chat/composer/BackgroundTasksTab';
import { isEscapeClaimedElsewhere } from '@/modules/chat/utils/escapeOwnership';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { BackgroundTask } from '@/shared/types';

/**
 * Escape stops a running chat — and with it every background agent of the
 * session. An Escape meant to close a dialog or a popover over the chat must
 * not do that too.
 */

test('nothing open over the chat: Escape is the stop shortcut', () => {
  assert.equal(isEscapeClaimedElsewhere(), false);
});

test('an open modal dialog claims Escape for itself', () => {
  render(
    <Dialog open onOpenChange={() => {}}>
      <DialogContent><DialogTitle>Agent</DialogTitle></DialogContent>
    </Dialog>,
  );
  assert.equal(isEscapeClaimedElsewhere(), true);
});

test('the unfolded background-agents list claims Escape until it folds', () => {
  const task: BackgroundTask = {
    taskId: 'a6d28bc06febf1598',
    taskType: 'local_agent',
    description: 'count',
    toolUseId: 'toolu_1',
    subagentType: null,
    startedAt: Date.now(),
    activity: null,
    toolUses: null,
  };
  render(<BackgroundTasksTab tasks={[task]} />);
  assert.equal(isEscapeClaimedElsewhere(), false);

  fireEvent.click(screen.getByRole('button'));
  assert.equal(isEscapeClaimedElsewhere(), true);

  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(isEscapeClaimedElsewhere(), false);
});
