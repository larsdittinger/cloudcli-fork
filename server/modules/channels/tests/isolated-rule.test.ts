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
  await withIsolatedDatabase(async (tempDir) => {
    // Real paths: macOS tmp lives behind the /var -> /private/var symlink, and a symlinked path is refused.
    const dir = fs.realpathSync(tempDir);
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

    // Only the isolated project's own directory, by its real path: a symlink or a subdirectory could be
    // repointed by the agent later, and a path that does not exist yet is nobody's project.
    const link = path.join(dir, 'support-link');
    fs.symlinkSync(isolatedPath, link);
    const sub = path.join(isolatedPath, 'sub');
    fs.mkdirSync(sub);
    for (const projectPath of [link, sub, path.join(isolatedPath, 'missing')]) {
      assert.throws(
        () => validateRuleInput({ ...open, projectPath }),
        (error: unknown) => (error as { code?: string }).code === 'RULE_OPEN_AUTONOMY',
        projectPath,
      );
    }

    // Replying automatically to anyone still takes the account's own switch, isolated or not.
    assert.throws(
      () => validateRuleInput({ ...open, projectPath: isolatedPath, replyMode: 'auto' }),
      (error: unknown) => (error as { code?: string }).code === 'RULE_OPEN_AUTONOMY' && /Reply automatically to anyone/.test((error as Error).message),
    );
  });
});

test('open bypass rule: a path inside the isolated root that belongs to no project is refused', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const dir = fs.realpathSync(tempDir);
    const root = path.join(dir, 'isolated');
    fs.mkdirSync(path.join(root, 'unregistered'), { recursive: true });
    const previous = process.env.CLOUDCLI_ISOLATED_ROOT;
    process.env.CLOUDCLI_ISOLATED_ROOT = root;
    try {
      for (const projectPath of [path.join(root, 'unregistered'), path.join(root, 'not-yet')]) {
        assert.throws(
          () => validateRuleInput({ name: 'x', conditions: {}, provider: 'claude', permissionMode: 'bypassPermissions', projectPath }),
          (error: unknown) => (error as { code?: string }).code === 'RULE_OPEN_AUTONOMY',
          projectPath,
        );
      }
    } finally {
      if (previous === undefined) delete process.env.CLOUDCLI_ISOLATED_ROOT;
      else process.env.CLOUDCLI_ISOLATED_ROOT = previous;
    }
  });
});
