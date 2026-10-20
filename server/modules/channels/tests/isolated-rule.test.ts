import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { validateRuleInput } from '@/modules/channels/rules.service.js';
import { withIsolatedDatabase } from '@/modules/channels/tests/helpers.js';
import { projectsDb } from '@/modules/database/index.js';
import { isolationDb } from '@/modules/isolation/index.js';

const OPEN_BYPASS_ERROR = 'A rule without a sender filter may not bypass permissions: anyone who writes in would steer the agent. Add the senders you trust, or keep the default permission mode.';

test('bypass rule without sender filter allowed only for isolated project', async () => {
  await withIsolatedDatabase(async (dir) => {
    const isolatedPath = path.join(dir, 'support-isolated');
    const plainPath = path.join(dir, 'support');
    fs.mkdirSync(isolatedPath);
    fs.mkdirSync(plainPath);
    const { project } = projectsDb.createProjectPath(isolatedPath, 'support-isolated');
    isolationDb.markIsolated(project!.project_id, 20001);
    projectsDb.createProjectPath(plainPath, 'support');

    const open = { name: 'anyone', conditions: {}, provider: 'claude', permissionMode: 'bypassPermissions' as const };

    // The sandbox is the boundary: an isolated project's agent may run on its own for anyone who writes in.
    validateRuleInput({ ...open, projectPath: isolatedPath });
    validateRuleInput({ ...open, projectPath: isolatedPath, conditions: { senders: ['*'] } });

    assert.throws(
      () => validateRuleInput({ ...open, projectPath: plainPath }),
      (error: unknown) => (error as { code?: string }).code === 'RULE_OPEN_AUTONOMY' && (error as Error).message === OPEN_BYPASS_ERROR,
    );

    // Replying automatically to anyone still takes the account's own switch, isolated or not.
    assert.throws(
      () => validateRuleInput({ ...open, projectPath: isolatedPath, replyMode: 'auto' }),
      (error: unknown) => (error as { code?: string }).code === 'RULE_OPEN_AUTONOMY' && /Reply automatically to anyone/.test((error as Error).message),
    );
  });
});
