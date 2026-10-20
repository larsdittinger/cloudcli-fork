import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

const json = (body: unknown, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => body }) as unknown as Response;

const apiMock = vi.hoisted(() => ({
  isolation: {
    status: vi.fn(),
    project: vi.fn(),
    saveProject: vi.fn(),
    blocked: vi.fn(),
    selfCheck: vi.fn(),
  },
  copyProject: { preview: vi.fn(), start: vi.fn(), progress: vi.fn(), cancel: vi.fn() },
}));

vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/shared/api');
  return { ...actual, api: apiMock };
});
vi.mock('@/shared/hooks/useIsAdmin', () => ({ useIsAdmin: () => true }));

// The assertions read the English texts.
await import('@/modules/i18n');
const { IsolationBadge, IsolationSettingsDialog, CopyProjectDialog, ProjectOptionsMenu } = await import('@/modules/isolation');

const project = (isolated: boolean): Project => ({
  projectId: isolated ? 'p-iso' : 'p-plain',
  displayName: isolated ? 'Support' : 'Plain',
  fullPath: isolated ? '/isolated/support' : '/workspace/plain',
  isolated,
  sessionMeta: { total: 0, hasMore: false },
}) as unknown as Project;

beforeEach(() => {
  apiMock.isolation.status.mockResolvedValue(json({ success: true, data: { available: true, daemon: { running: true, ok: true, projects: 2 }, claudeLogin: 'credentials', isolatedProjects: 2 } }));
  apiMock.isolation.project.mockResolvedValue(json({ success: true, data: { projectId: 'p-iso', allowlist: ['ethia.cz'], tools: { channels: true, tasks: false } } }));
  apiMock.isolation.blocked.mockResolvedValue(json({ success: true, data: [] }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('menu shows Izolace only for isolated', () => {
  const { unmount } = render(<ProjectOptionsMenu project={project(false)} onCopied={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Options for project/ }));
  assert.ok(screen.getByText('Copy agent…'));
  assert.equal(screen.queryByText('Isolation…'), null);
  unmount();
  render(<ProjectOptionsMenu project={project(true)} onCopied={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Options for project/ }));
  assert.ok(screen.getByText('Isolation…'));
});

test('badge shows the isolated label', () => {
  render(<IsolationBadge />);
  assert.ok(screen.getByText('Isolated'));
});

const preview = {
  suggestedName: 'Plain copy', sizeBytes: 2048, fileCount: 3, secretFiles: ['.env'],
  userScopeMcp: [{ name: 'gdrive', hasSecrets: true }, { name: 'docs', hasSecrets: false }],
  isolationAvailable: false,
};

test('copy dialog disables isolated checkbox when unavailable', async () => {
  apiMock.copyProject.preview.mockResolvedValue(json(preview));
  apiMock.isolation.status.mockResolvedValue(json({ success: true, data: { available: false, reason: 'missing CLOUDCLI_ISOLATED_ROOT', daemon: null } }));
  render(<CopyProjectDialog project={project(false)} open onOpenChange={() => {}} onCopied={() => {}} />);
  const box = await screen.findByLabelText(/^Isolated/);
  assert.equal((box as HTMLInputElement).disabled, true);
  assert.ok(screen.getByText(/Isolation is not set up on this instance, so the copy cannot be isolated/));
  assert.equal((screen.getByLabelText('Name of the copy') as HTMLInputElement).value, 'Plain copy');
});

test('copy dialog: isolated defaults leave out secrets and MCP keys, then reports the new project', async () => {
  apiMock.copyProject.preview.mockResolvedValue(json({ ...preview, isolationAvailable: true }));
  apiMock.copyProject.start.mockResolvedValue(json({ jobId: 'j1' }));
  const copied = { projectId: 'new', displayName: 'Plain copy', fullPath: '/isolated/plain-copy' };
  apiMock.copyProject.progress.mockResolvedValue(json({ copiedBytes: 2048, totalBytes: 2048, done: true, project: copied, warnings: [] }));
  const onCopied = vi.fn();
  render(<CopyProjectDialog project={project(false)} open onOpenChange={() => {}} onCopied={onCopied} />);
  fireEvent.click(await screen.findByLabelText(/^Isolated/));
  assert.equal((screen.getByLabelText('.env') as HTMLInputElement).checked, true, 'secret file excluded by default');
  assert.equal((screen.getByLabelText(/gdrive/) as HTMLInputElement).checked, false, 'keyed MCP not carried');
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await waitFor(() => assert.equal(onCopied.mock.calls.length, 1));
  assert.deepEqual(apiMock.copyProject.start.mock.calls[0], ['p-plain', { name: 'Plain copy', isolated: true, excludeSecretFiles: ['.env'], carryMcp: ['docs'] }]);
  assert.equal(onCopied.mock.calls[0][0].projectId, 'new');
});

test('settings dialog shows line errors', async () => {
  apiMock.isolation.saveProject.mockResolvedValue(json({ success: false, error: { code: 'INVALID_ALLOWLIST', message: 'bad' }, errors: [{ line: 2, message: 'Invalid domain "no good"' }] }, false, 400));
  render(<IsolationSettingsDialog project={project(true)} open onOpenChange={() => {}} />);
  const box = await screen.findByLabelText('Allowed addresses');
  assert.equal((box as HTMLTextAreaElement).value, 'ethia.cz');
  fireEvent.change(box, { target: { value: 'ethia.cz\nno good' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  assert.ok(await screen.findByText('Line 2: Invalid domain "no good"'));
});

test('Povolit adds blocked host to allowlist', async () => {
  apiMock.isolation.blocked.mockResolvedValue(json({ success: true, data: [
    { at: '2026-10-20T10:00:00.000Z', host: 'api.example.com', port: 443, kind: 'connect' },
    { at: '2026-10-20T10:01:00.000Z', host: 'imap.example.com', port: 993, kind: 'connect' },
  ] }));
  render(<IsolationSettingsDialog project={project(true)} open onOpenChange={() => {}} />);
  const allowButtons = await screen.findAllByRole('button', { name: 'Allow' });
  assert.equal(allowButtons.length, 2);
  fireEvent.click(allowButtons[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  const box = screen.getByLabelText('Allowed addresses') as HTMLTextAreaElement;
  assert.equal(box.value, 'ethia.cz\nimap.example.com:993\napi.example.com');
});

test('settings dialog saves tools and runs the isolation check', async () => {
  apiMock.isolation.saveProject.mockResolvedValue(json({ success: true, data: { daemonSync: { ok: true } } }));
  apiMock.isolation.selfCheck.mockResolvedValue(json({ success: true, data: { checks: [{ id: 'net', ok: true, detail: 'blocked' }, { id: 'fs', ok: false, detail: 'can read /etc' }] } }));
  render(<IsolationSettingsDialog project={project(true)} open onOpenChange={() => {}} />);
  await screen.findByLabelText('Allowed addresses');
  fireEvent.click(screen.getByRole('switch', { name: 'Tasks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.equal(apiMock.isolation.saveProject.mock.calls.length, 1));
  assert.deepEqual(apiMock.isolation.saveProject.mock.calls[0], ['p-iso', { allowlist: ['ethia.cz'], tools: { channels: true, tasks: true } }]);
  fireEvent.click(screen.getByRole('button', { name: 'Check isolation' }));
  assert.ok(await screen.findByText('can read /etc'));
});

test('Povolit is offered only for a valid hostname or IP with a non-web port', async () => {
  apiMock.isolation.blocked.mockResolvedValue(json({ success: true, data: [
    { at: '2026-10-20T10:00:00.000Z', host: '*.com', port: 443, kind: 'connect' },
    { at: '2026-10-20T10:00:01.000Z', host: '(invalid)', port: 443, kind: 'connect' },
    { at: '2026-10-20T10:00:02.000Z', host: '10.0.0.5', port: 443, kind: 'connect' },
    { at: '2026-10-20T10:00:03.000Z', host: 'localhost', port: 443, kind: 'connect' },
    { at: '2026-10-20T10:00:04.000Z', host: '10.0.0.5', port: 993, kind: 'connect' },
  ] }));
  render(<IsolationSettingsDialog project={project(true)} open onOpenChange={() => {}} />);
  const buttons = await screen.findAllByRole('button', { name: /^Allow/ });
  const enabled = buttons.filter((button) => !(button as HTMLButtonElement).disabled);
  assert.equal(buttons.length, 5);
  assert.equal(enabled.length, 1, 'only the IP with port 993');
  fireEvent.click(enabled[0]);
  assert.equal((screen.getByLabelText('Allowed addresses') as HTMLTextAreaElement).value, 'ethia.cz\n10.0.0.5:993');
});

test('a failing cancel shows an error instead of an unhandled rejection', async () => {
  apiMock.copyProject.preview.mockResolvedValue(json({ ...{ suggestedName: 'x', sizeBytes: 1, fileCount: 1, secretFiles: [], userScopeMcp: [], isolationAvailable: true } }));
  apiMock.copyProject.start.mockResolvedValue(json({ jobId: 'j1' }));
  apiMock.copyProject.progress.mockResolvedValue(json({ copiedBytes: 1, totalBytes: 10, done: false, warnings: [] }));
  apiMock.copyProject.cancel.mockRejectedValue(new Error('offline'));
  render(<CopyProjectDialog project={project(false)} open onOpenChange={() => {}} onCopied={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stop copying' }));
  assert.ok(await screen.findByText(/Copy failed: offline/));
});
