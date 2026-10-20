import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import {
  applySandboxOptions,
  buildSandboxEnv,
  sandboxCliArgs,
  DEFAULT_SANDBOX_MCP_DIR,
} from '@/modules/isolation/claude-sandbox-options.js';
import { daemonClient, SANDBOX_DOWN_TEXT, type SpawnRequest } from '@/modules/isolation/daemon-client.js';
import { isolationDb } from '@/modules/isolation/isolation.db.js';
import { runTokens } from '@/modules/isolation/run-tokens.js';
import { isolationEnvFor, withIsolatedDatabase, withIsolationEnv } from '@/modules/isolation/tests/helpers.js';

const CLAUDE_ENV_KEYS = [
  'PATH', 'LANG', 'TERM', 'HOME', 'TMPDIR', 'CLAUDE_CODE_TMPDIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY',
  'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'ENABLE_CLAUDEAI_MCP_SERVERS',
  'CLOUDCLI_RUN_TOKEN',
].sort();

const SDK_FLAGS = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--model', 'opus'];

function makeIsolated(dir: string, name = 'x', uid = 20001) {
  const projectPath = path.join(dir, 'isolated', name);
  fs.mkdirSync(projectPath, { recursive: true });
  const { project } = projectsDb.createProjectPath(projectPath, name);
  return isolationDb.markIsolated(project!.project_id, uid);
}

async function withIsolation(run: (dir: string) => Promise<void> | void) {
  await withIsolatedDatabase(async (dir) => {
    await withIsolationEnv(isolationEnvFor(dir), () => run(dir));
  });
}

/** A stand-in for the SandboxProcess the daemon client returns. */
function fakeProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kills: [] as string[],
    kill(signal: string) {
      proc.kills.push(signal);
      proc.killed = true;
      return true;
    },
  });
  return proc;
}

test('a project that is not isolated is left alone', async () => {
  await withIsolation(async (dir) => {
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain);
    const sdkOptions: Record<string, unknown> = { cwd: plain, env: { ...process.env } };
    assert.equal(applySandboxOptions(sdkOptions, { projectPath: plain, sessionId: 's1' }), null);
    assert.equal(sdkOptions.spawnClaudeCodeProcess, undefined);
  });
});

test('isolated: allowlisted env only, project settings only, sandbox MCP servers only', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    process.env.SECRET_X = 'leak-me';
    process.env.CLAUDE_CODE_ENABLE_CFC = '1';
    try {
      const sdkOptions: Record<string, any> = {
        cwd: project.projectPath,
        env: { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' },
        pathToClaudeCodeExecutable: '/usr/local/bin/claude',
        settingSources: ['project', 'user', 'local'],
        mcpServers: { 'cloudcli-browser': { type: 'http', url: 'http://127.0.0.1:3001/mcp', headers: { Authorization: 'Bearer main' } } },
      };
      const run = applySandboxOptions(sdkOptions, { projectPath: project.projectPath, sessionId: 's1' });
      assert.ok(run);
      const env = sdkOptions.env as Record<string, string>;
      assert.deepEqual(Object.keys(env).sort(), CLAUDE_ENV_KEYS);
      assert.equal(env.SECRET_X, undefined);
      assert.equal(env.CLAUDE_CODE_ENABLE_CFC, undefined);
      assert.equal(env.HOME, project.homeDir);
      // Its own temp dir: in the shared /tmp another isolated uid could squat the CLI's per-uid directory.
      assert.equal(env.TMPDIR, path.join(project.homeDir, '.tmp'));
      assert.equal(env.CLAUDE_CODE_TMPDIR, env.TMPDIR);
      assert.equal(env.LANG, 'C.UTF-8');
      assert.equal(env.HTTPS_PROXY, `http://${project.projectId}:${project.proxySecret}@127.0.0.1:7702`);
      assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
      assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
      // curl, wget, pip and git read the lowercase names (curl only those for plain http).
      assert.equal(env.https_proxy, env.HTTPS_PROXY);
      assert.equal(env.http_proxy, env.HTTPS_PROXY);
      assert.equal(env.no_proxy, env.NO_PROXY);
      assert.equal(env.NODE_USE_ENV_PROXY, '1');
      assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7701/anthropic');
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, env.CLOUDCLI_RUN_TOKEN);
      assert.equal(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0');
      assert.equal(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
      assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
      assert.equal(env.DISABLE_AUTOUPDATER, '1');
      // The owner's claude.ai connectors (Gmail, Drive…) never load in the sandbox.
      assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');

      const token = runTokens.resolve(env.CLOUDCLI_RUN_TOKEN);
      assert.deepEqual({ ...token, issuedAt: 0 }, { projectId: project.projectId, sessionId: 's1', purpose: 'claude', issuedAt: 0 });

      assert.deepEqual(sdkOptions.settingSources, ['project', 'local']);
      assert.equal('pathToClaudeCodeExecutable' in sdkOptions, false);
      assert.equal(typeof sdkOptions.spawnClaudeCodeProcess, 'function');
      assert.deepEqual(Object.keys(sdkOptions.mcpServers).sort(), ['cloudcli-channels', 'cloudcli-tasks']);
      const channels = sdkOptions.mcpServers['cloudcli-channels'];
      assert.equal(channels.command, 'node');
      assert.deepEqual(channels.args, [`${DEFAULT_SANDBOX_MCP_DIR}/channels-mcp.js`]);
      assert.equal(channels.env.CLOUDCLI_CHANNELS_API_URL, 'http://127.0.0.1:7701/api/channels-mcp');
      assert.equal(sdkOptions.mcpServers['cloudcli-tasks'].env.CLOUDCLI_TASKS_API_URL, 'http://127.0.0.1:7701/api/tasks-mcp');
      // The CLI passes --mcp-config on the command line, which other uids could read in /proc: the token is
      // only referenced there and expanded by the CLI from its own (private) environment.
      assert.equal(JSON.stringify(sdkOptions.mcpServers).includes(env.CLOUDCLI_RUN_TOKEN), false);
      assert.equal(channels.env.CLOUDCLI_CHANNELS_MCP_TOKEN, '${CLOUDCLI_RUN_TOKEN}');
      assert.equal(sdkOptions.mcpServers['cloudcli-tasks'].env.CLOUDCLI_TASKS_MCP_TOKEN, '${CLOUDCLI_RUN_TOKEN}');
      run.release();
      assert.equal(runTokens.resolve(env.CLOUDCLI_RUN_TOKEN), null);
    } finally {
      delete process.env.SECRET_X;
      delete process.env.CLAUDE_CODE_ENABLE_CFC;
    }
  });
});

test('disabled tools are missing; the MCP dir follows CLOUDCLI_SANDBOX_MCP_DIR', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    isolationDb.updateSettings(project.projectId, { tools: { tasks: false } });
    process.env.CLOUDCLI_SANDBOX_MCP_DIR = '/srv/mcp';
    try {
      const sdkOptions: Record<string, any> = { cwd: project.projectPath, env: {} };
      const run = applySandboxOptions(sdkOptions, { projectPath: project.projectPath, sessionId: 's1' })!;
      assert.deepEqual(Object.keys(sdkOptions.mcpServers), ['cloudcli-channels']);
      assert.deepEqual(sdkOptions.mcpServers['cloudcli-channels'].args, ['/srv/mcp/channels-mcp.js']);
      run.release();

      isolationDb.updateSettings(project.projectId, { tools: { channels: false } });
      const none: Record<string, any> = { cwd: project.projectPath, env: {}, mcpServers: { x: {} } };
      applySandboxOptions(none, { projectPath: project.projectPath, sessionId: 's1' })!.release();
      assert.deepEqual(none.mcpServers, {});
    } finally {
      delete process.env.CLOUDCLI_SANDBOX_MCP_DIR;
    }
  });
});

test('a Channels run carries the sender and message into the env and the run token', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const sdkOptions: Record<string, any> = { cwd: project.projectPath, env: {} };
    const channelContext = { messageId: 'm-1', threadKey: 't-1', sender: 'jan@firma.cz' };
    const run = applySandboxOptions(sdkOptions, { projectPath: project.projectPath, sessionId: 's1', channelContext, taskId: 7 })!;
    assert.equal(sdkOptions.env.CLOUDCLI_CHANNEL_SENDER, 'jan@firma.cz');
    assert.equal(sdkOptions.env.CLOUDCLI_CHANNEL_MESSAGE_ID, 'm-1');
    const token = runTokens.resolve(sdkOptions.env.CLOUDCLI_RUN_TOKEN)!;
    assert.deepEqual(token.channel, channelContext);
    assert.equal(token.taskId, 7);
    assert.equal(run.accepts({ channelContext, taskId: 7 }), true);
    assert.equal(run.accepts({ channelContext: { ...channelContext, sender: 'eve@evil.com' }, taskId: 7 }), false);
    assert.equal(run.accepts({}), false);
    run.release();
  });
});

test('buildSandboxEnv without Claude keys (scripts, terminal)', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const env = buildSandboxEnv(project, 'tok', { EXTRA: '1' }, { claude: false });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
    assert.equal(env.CLOUDCLI_RUN_TOKEN, 'tok');
    assert.equal(env.HOME, project.homeDir);
    assert.equal(env.TMPDIR, path.join(project.homeDir, '.tmp'));
    assert.equal(env.CLAUDE_CODE_TMPDIR, env.TMPDIR);
    assert.equal(env.EXTRA, '1');
    assert.ok(env.HTTPS_PROXY);
  });
});

test('only the CLI flags reach the daemon, whatever shape the SDK spawns in', () => {
  // Native binary: command is the binary, args are the flags (maybe after executableArgs).
  assert.deepEqual(sandboxCliArgs(['--max-old-space-size=4096', ...SDK_FLAGS]), SDK_FLAGS);
  assert.deepEqual(sandboxCliArgs(SDK_FLAGS), SDK_FLAGS);
  // Script run through node/bun: the script path comes first.
  assert.deepEqual(sandboxCliArgs(['/app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js', ...SDK_FLAGS]), SDK_FLAGS);
  assert.throws(() => sandboxCliArgs(['/app/cli.js', '--resume', 'x']), /stream-json/);
});

test('spawnClaudeCodeProcess goes to the daemon as the project uid and releases on exit', async () => {
  await withIsolation(async (dir) => {
    const project = makeIsolated(dir);
    const sub = path.join(project.projectPath, 'sub');
    fs.mkdirSync(sub);
    const seen: SpawnRequest[] = [];
    const proc = fakeProcess();
    const spawnMock = mock.method(daemonClient, 'spawn', (request: SpawnRequest) => {
      seen.push(request);
      return proc as never;
    });
    const shared: string[] = [];
    const shareMock = mock.method(daemonClient, 'shareTranscripts', async (p: { projectId: string }) => {
      shared.push(p.projectId);
      return { changed: 0 };
    });
    try {
      const sdkOptions: Record<string, any> = { cwd: project.projectPath, env: {} };
      const run = applySandboxOptions(sdkOptions, { projectPath: project.projectPath, sessionId: 's1' })!;
      const token = sdkOptions.env.CLOUDCLI_RUN_TOKEN as string;
      const abort = new AbortController();
      const returned = sdkOptions.spawnClaudeCodeProcess({
        command: 'node',
        args: ['/app/cli.js', ...SDK_FLAGS],
        cwd: sub,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', SECRET_Y: 'no' },
        signal: abort.signal,
      });
      assert.equal(returned, proc);
      assert.equal(seen.length, 1);
      assert.deepEqual({ ...seen[0], env: undefined }, {
        kind: 'claude',
        projectId: project.projectId,
        uid: project.uid,
        projectDir: project.projectPath,
        homeDir: project.homeDir,
        cwd: sub,
        args: SDK_FLAGS,
        env: undefined,
      });
      assert.equal(seen[0].env.SECRET_Y, undefined);
      assert.equal(seen[0].env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
      assert.deepEqual(Object.keys(seen[0].env).filter((key) => key !== 'CLAUDE_CODE_ENTRYPOINT').sort(), CLAUDE_ENV_KEYS);

      // The daemon's reason is kept for the chat (the SDK only says "exited with code 1").
      proc.emit('error', new Error('Sandbox: Rejected: uid does not match the project'));
      assert.equal(run.error(), 'Sandbox: Rejected: uid does not match the project');

      abort.abort();
      assert.deepEqual(proc.kills, ['SIGTERM']);

      assert.ok(runTokens.resolve(token));
      assert.deepEqual(shared, []);
      proc.emit('exit', 1, null);
      assert.equal(runTokens.resolve(token), null);
      // The CLI writes its transcript 0600: on exit the daemon makes it readable for the app.
      assert.deepEqual(shared, [project.projectId]);
    } finally {
      shareMock.mock.restore();
      spawnMock.mock.restore();
    }
  });
});

test('fails closed: isolation unavailable, or a path under the isolated root that is no project', async () => {
  await withIsolatedDatabase(async (dir) => {
    const env = isolationEnvFor(dir);
    let project: ReturnType<typeof makeIsolated>;
    await withIsolationEnv(env, () => { project = makeIsolated(dir); });
    // Env gone (sandbox not deployed) but the project is isolated in the DB.
    await withIsolationEnv(null, () => {
      assert.throws(
        () => applySandboxOptions({ cwd: project.projectPath, env: {} }, { projectPath: project.projectPath, sessionId: 's' }),
        (error: Error) => error.message.startsWith(SANDBOX_DOWN_TEXT),
      );
    });
    await withIsolationEnv(env, () => {
      const stray = path.join(env.CLOUDCLI_ISOLATED_ROOT, 'stray');
      fs.mkdirSync(stray);
      assert.throws(() => applySandboxOptions({ cwd: stray, env: {} }, { projectPath: stray, sessionId: 's' }), /izolovan/i);
      // An isolated session whose cwd points elsewhere still runs in the sandbox — or not at all.
      const elsewhere = path.join(dir, 'elsewhere');
      fs.mkdirSync(elsewhere);
      assert.throws(() => applySandboxOptions({ cwd: elsewhere, env: {} }, { projectPath: project.projectPath, sessionId: 's' }), /izolovan/i);
    });
  });
});
