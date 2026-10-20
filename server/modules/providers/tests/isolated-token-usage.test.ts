import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/providers/tests/isolation-test-env.js';

/** Token usage reads a Claude transcript's tail; in an isolated home the agent may swap it for a FIFO or a link. */
function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still blocked after ${ms} ms`)), ms);
    }),
  ]);
}

test('token usage of an isolated session: a FIFO or symlinked transcript is refused at once', async () => {
  await withIsolatedDatabase(async (dir) => {
    const env = isolationEnvFor(dir);
    await withIsolationEnv(env, async () => {
      const transcripts = path.join(env.CLOUDCLI_ISOLATED_HOMES, 'p1', '.claude', 'projects', 'enc');
      fs.mkdirSync(transcripts, { recursive: true });
      const usageRow = `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 7, output_tokens: 3 } } })}\n`;
      const regular = path.join(transcripts, 'ok.jsonl');
      fs.writeFileSync(regular, usageRow);
      const fifo = path.join(transcripts, 'fifo.jsonl');
      execFileSync('mkfifo', [fifo]);
      fs.writeFileSync(path.join(dir, 'secret.jsonl'), usageRow);
      const link = path.join(transcripts, 'link.jsonl');
      fs.symlinkSync(path.join(dir, 'secret.jsonl'), link);

      const serviceFor = (jsonlPath: string) => createProviderTokenUsageService({
        getSessionById: () => ({ session_id: 's', provider: 'claude', provider_session_id: 's', jsonl_path: jsonlPath, project_path: '/isolated/p' }) as never,
        isProviderSessionSuperseded: () => false,
      });
      const usage = await serviceFor(regular).getSessionTokenUsage('s');
      assert.ok(usage.used > 0);
      await within(assert.rejects(serviceFor(fifo).getSessionTokenUsage('s')));
      await assert.rejects(serviceFor(link).getSessionTokenUsage('s'));
    });
  });
});
