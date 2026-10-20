import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { daemonClient, isolationDb, runTokens, SANDBOX_DOWN_TEXT } from '@/modules/isolation/index.js';
import type { SpawnRequest } from '@/modules/isolation/index.js';
import { ClaudeForkProvider } from '@/modules/providers/list/claude/claude-fork.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { listBusyClaudeCliSessions } from '@/modules/providers/services/claude-cli-liveness.service.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/providers/tests/isolation-test-env.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const FLAGS = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];

type Record_ = {
  options?: Record<string, any>;
  createQueryCalls: number;
  localSpawn: boolean;
  stdin: string;
};

/**
 * Behaves like the SDK's query(): spawns the CLI through `spawnClaudeCodeProcess` when it is set (a local spawn
 * otherwise, which these tests must never see for an isolated project), feeds the prompt into stdin, yields the
 * scripted messages, and fails like the SDK when the process exits non-zero.
 */
function sdkLikeQuery(record: Record_, messages: Array<Record<string, unknown>> = []) {
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    record.createQueryCalls += 1;
    record.options = options as Record<string, any>;
    const spawn = (options as Record<string, any>).spawnClaudeCodeProcess;
    const iterator = (async function* () {
      if (typeof spawn !== 'function') {
        record.localSpawn = true;
        for await (const _message of prompt) break;
        return;
      }
      const proc = spawn({ command: '/opt/claude/claude', args: [...FLAGS], cwd: (options as Record<string, any>).cwd, env: (options as Record<string, any>).env, signal: new AbortController().signal });
      const exited = new Promise<number | null>((resolve) => proc.once('exit', (code: number | null) => resolve(code)));
      void (async () => {
        for await (const message of prompt) proc.stdin.write(`${JSON.stringify(message)}\n`);
        proc.stdin.end();
      })();
      for (const message of messages) yield message;
      const code = await exited;
      if (code !== 0) throw new Error(`Claude Code process exited with code ${code}`);
    })();
    return Object.assign(iterator, {
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      stopTask: async () => {},
      close: () => {},
    });
  };
  return createQuery;
}

/** A sandbox process that exits 0 once its stdin ends. */
function fakeSandboxProcess(record: Record_) {
  const stdin = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kill: () => true,
  });
  stdin.on('data', (chunk: Buffer) => { record.stdin += chunk.toString(); });
  stdin.on('finish', () => setImmediate(() => proc.emit('exit', 0, null)));
  return proc;
}

function contextFor(createQuery: NonNullable<ProviderRuntimeContext['createQuery']>): ProviderRuntimeContext {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };
}

const newRecord = (): Record_ => ({ createQueryCalls: 0, localSpawn: false, stdin: '' });
const writerFor = (sent: NormalizedMessage[]) => ({ send: (message: NormalizedMessage) => { sent.push(message); }, userId: null });
const errorsOf = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'error').map((message) => String((message as { content?: unknown }).content));

function isolatedProject(dir: string) {
  const projectPath = path.join(dir, 'isolated', 'x');
  fs.mkdirSync(projectPath, { recursive: true });
  const { project } = projectsDb.createProjectPath(projectPath, 'x');
  return isolationDb.markIsolated(project!.project_id, 20001);
}

test('fails closed when daemon socket missing', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const project = isolatedProject(dir);
      const record = newRecord();
      const sent: NormalizedMessage[] = [];
      await queryClaudeSDK('ahoj', { sessionId: 'iso-s1', cwd: project.projectPath, projectPath: project.projectPath }, writerFor(sent) as never, contextFor(sdkLikeQuery(record)));
      assert.equal(record.localSpawn, false);
      assert.equal(record.createQueryCalls, 1);
      const errors = errorsOf(sent);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].startsWith(SANDBOX_DOWN_TEXT), errors[0]);
      assert.ok(sent.some((message) => message.kind === 'complete' && (message as { exitCode?: number }).exitCode === 1));
    });
  });
});

test('fails closed when the instance has no sandbox configured', async () => {
  await withIsolatedDatabase(async (dir) => {
    let project!: ReturnType<typeof isolatedProject>;
    await withIsolationEnv(isolationEnvFor(dir), () => { project = isolatedProject(dir); });
    await withIsolationEnv(null, async () => {
      const record = newRecord();
      const sent: NormalizedMessage[] = [];
      await queryClaudeSDK('ahoj', { sessionId: 'iso-s2', cwd: project.projectPath, projectPath: project.projectPath }, writerFor(sent) as never, contextFor(sdkLikeQuery(record)));
      assert.equal(record.createQueryCalls, 0);
      const errors = errorsOf(sent);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].startsWith(SANDBOX_DOWN_TEXT), errors[0]);
    });
  });
});

test('uses spawnClaudeCodeProcess for isolated project; release on exit revokes run token', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const project = isolatedProject(dir);
      const upload = path.join(dir, 'assets', 'stored-abc.txt');
      fs.mkdirSync(path.dirname(upload), { recursive: true });
      fs.writeFileSync(upload, 'obsah');
      const record = newRecord();
      const spawned: SpawnRequest[] = [];
      let tokenWhileRunning: unknown = 'unset';
      const spawnMock = mock.method(daemonClient, 'spawn', (request: SpawnRequest) => {
        spawned.push(request);
        tokenWhileRunning = runTokens.resolve(request.env.CLOUDCLI_RUN_TOKEN);
        return fakeSandboxProcess(record) as never;
      });
      const adoptMock = mock.method(daemonClient, 'adopt', async () => ({ ok: true, warnings: [] }));
      try {
        const sent: NormalizedMessage[] = [];
        const messages = [
          { type: 'system', subtype: 'init', session_id: 'native-iso' },
          { type: 'result', subtype: 'success', session_id: 'native-iso', is_error: false, result: 'ok', usage: {} },
        ];
        await queryClaudeSDK(
          'ahoj',
          {
            sessionId: 'iso-s3',
            cwd: project.projectPath,
            projectPath: project.projectPath,
            files: [{ path: upload, name: 'poznamky.txt' }],
            channelContext: { messageId: 'm-9', threadKey: 't-9', sender: 'jan@firma.cz' },
          },
          writerFor(sent) as never,
          contextFor(sdkLikeQuery(record, messages)),
        );
        assert.deepEqual(errorsOf(sent), []);
        assert.equal(spawned.length, 1);
        assert.equal(spawned[0].kind, 'claude');
        assert.equal(spawned[0].uid, project.uid);
        assert.deepEqual(spawned[0].args, FLAGS);
        assert.equal(spawned[0].env.CLOUDCLI_CHANNEL_SENDER, 'jan@firma.cz');
        assert.equal(record.options?.pathToClaudeCodeExecutable, undefined);
        assert.deepEqual(record.options?.settingSources, ['project', 'local']);

        // The upload was copied into the project, and the prompt names the copy.
        const staged = path.join(project.projectPath, '.cloudcli-attachments', 'uploads', 'stored-abc.txt');
        assert.equal(fs.readFileSync(staged, 'utf8'), 'obsah');
        assert.ok(record.stdin.includes(staged), record.stdin);
        assert.equal(record.stdin.includes(upload), false);
        assert.deepEqual(adoptMock.mock.calls[0].arguments[1], ['.cloudcli-attachments/uploads']);

        assert.ok(tokenWhileRunning && typeof tokenWhileRunning === 'object');
        assert.equal(runTokens.resolve(spawned[0].env.CLOUDCLI_RUN_TOKEN), null);
      } finally {
        spawnMock.mock.restore();
        adoptMock.mock.restore();
      }
    });
  });
});

test('the daemon refusing the spawn shows its reason in the chat', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const project = isolatedProject(dir);
      const record = newRecord();
      const spawnMock = mock.method(daemonClient, 'spawn', () => {
        const proc = fakeSandboxProcess(record);
        setImmediate(() => {
          proc.emit('error', new Error('Sandbox: Rejected: uid does not match the project'));
          proc.emit('exit', 1, null);
        });
        return proc as never;
      });
      try {
        const sent: NormalizedMessage[] = [];
        await queryClaudeSDK('ahoj', { sessionId: 'iso-s4', cwd: project.projectPath, projectPath: project.projectPath }, writerFor(sent) as never, contextFor(sdkLikeQuery(record)));
        assert.deepEqual(errorsOf(sent), ['Sandbox: Rejected: uid does not match the project']);
      } finally {
        spawnMock.mock.restore();
      }
    });
  });
});

test('non-isolated unchanged', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const plain = path.join(dir, 'plain');
      fs.mkdirSync(plain);
      process.env.SOME_HOST_VAR = 'kept';
      try {
        const record = newRecord();
        const sent: NormalizedMessage[] = [];
        await queryClaudeSDK('ahoj', { sessionId: 'plain-s1', cwd: plain, projectPath: plain }, writerFor(sent) as never, contextFor(sdkLikeQuery(record)));
        assert.equal(record.options?.spawnClaudeCodeProcess, undefined);
        assert.equal(record.options?.env.SOME_HOST_VAR, 'kept');
        assert.deepEqual(record.options?.settingSources, ['project', 'user', 'local']);
        assert.equal(record.localSpawn, true);
      } finally {
        delete process.env.SOME_HOST_VAR;
      }
    });
  });
});

test('forking a session of an isolated project is refused', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const project = isolatedProject(dir);
      await assert.rejects(
        new ClaudeForkProvider().forkSession({
          providerSessionId: 'native-x',
          jsonlPath: path.join(project.homeDir, '.claude', 'projects', 'p', 'native-x.jsonl'),
          projectPath: project.projectPath,
        }),
        (error: unknown) => error instanceof AppError && error.code === 'FORK_UNSUPPORTED_ISOLATED' && /[Ii]zolovan/.test(error.message),
      );
    });
  });
});

test('a follow-up turn of an isolated session counts as busy from the runtime, not from pid files', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const project = isolatedProject(dir);
      const plainSessions = await listBusyClaudeCliSessions({
        liveSessionIds: () => ['iso-live', 'iso-idle'],
        isMidTurn: (id) => id === 'iso-live',
        session: (id) => ({ provider_session_id: `native-${id}`, project_path: project.projectPath }),
      });
      // (The developer's own ~/.claude/sessions may list real sessions too; only ours matter here.)
      assert.deepEqual(plainSessions.map((entry) => entry.providerSessionId).filter((id) => id.startsWith('native-iso')), ['native-iso-live']);
    });
  });
});

test('a provider session id that belongs to a session of another project aborts the isolated run', async () => {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), async () => {
      const project = isolatedProject(dir);
      const ceo = path.join(dir, 'workspace', 'ceo');
      fs.mkdirSync(ceo, { recursive: true });
      sessionsDb.createSession('ceo-native', 'claude', ceo, 'CEO', undefined, undefined, null);
      const record = newRecord();
      const spawnMock = mock.method(daemonClient, 'spawn', () => fakeSandboxProcess(record) as never);
      const assigned: string[] = [];
      try {
        const sent: NormalizedMessage[] = [];
        const writer = { ...writerFor(sent), setSessionId: (id: string) => { assigned.push(id); } };
        const messages = [
          { type: 'system', subtype: 'init', session_id: 'ceo-native' },
          { type: 'result', subtype: 'success', session_id: 'ceo-native', is_error: false, result: 'ok', usage: {} },
        ];
        await queryClaudeSDK('ahoj', { sessionId: 'iso-s5', cwd: project.projectPath, projectPath: project.projectPath }, writer as never, contextFor(sdkLikeQuery(record, messages)));
        assert.deepEqual(assigned, []);
        assert.equal(sent.some((message) => message.kind === 'session_created'), false);
        const errors = errorsOf(sent);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /ceo-native/);
        assert.equal(sessionsDb.getSessionByProviderSessionId('ceo-native')?.project_path, ceo);
      } finally {
        spawnMock.mock.restore();
      }
    });
  });
});
