import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const apiMock = vi.hoisted(() => ({
  isolation: {
    status: vi.fn(),
    claudeLogin: vi.fn(),
    saveClaudeLogin: vi.fn(),
    checkClaudeLogin: vi.fn(),
    removeClaudeLogin: vi.fn(),
  },
}));

vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/shared/api');
  return { ...actual, api: apiMock };
});

// The assertions read the English texts.
await import('@/modules/i18n');
const { default: IsolationSettingsTab } = await import('@/modules/settings/tabs/isolation-settings/IsolationSettingsTab');

const TOKEN = `sk-ant-oat01-${'A1b2_C3d4-'.repeat(9)}WXYZ`;

const login = (overrides: Record<string, unknown> = {}) => ({
  source: 'setup-token',
  tokenSetAt: '2026-10-20T12:03:00.000Z',
  tokenLast4: 'WXYZ',
  credentialsExpiresAt: null,
  lastCheck: { ok: true, at: '2026-10-20T12:03:00.000Z', status: 200 },
  lastUpstream: { okAt: '2026-10-20T12:30:00.000Z' },
  ...overrides,
});

const running = { available: true, isolatedRoot: '/isolated', daemon: { running: true, ok: true, version: '3f9c2a1b7d4e5f60718293a4b5c6d7e8f9a0b1c2', claudeVersion: '2.1.280 (Claude Code)', projects: 2 }, claudeLogin: 'setup-token', isolatedProjects: 2 };

beforeEach(() => {
  apiMock.isolation.status.mockResolvedValue(json({ success: true, data: running }));
  apiMock.isolation.claudeLogin.mockResolvedValue(json({ success: true, data: login() }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('sandbox status: running, short daemon version, Claude version, isolated projects', async () => {
  render(<IsolationSettingsTab />);
  assert.ok(await screen.findByText('Running'));
  assert.ok(screen.getByText('3f9c2a1'));
  assert.equal(screen.queryByText(running.daemon.version), null, 'the full commit is only in the title');
  assert.ok(screen.getByText('2.1.280 (Claude Code)'));
  assert.ok(screen.getByText('2'));
});

test('isolation not set up: the tab says so and hides the rest', async () => {
  apiMock.isolation.status.mockResolvedValue(json({ success: true, data: { available: false, reason: 'CLOUDCLI_ISOLATED_ROOT is not set', daemon: null, claudeLogin: 'missing', isolatedProjects: 0 } }));
  render(<IsolationSettingsTab />);
  assert.ok(await screen.findByText(/Isolation is not set up on this instance/));
  assert.ok(screen.getByText(/CLOUDCLI_ISOLATED_ROOT is not set/));
  assert.equal(screen.queryByLabelText(/Paste the output of/), null);
  assert.equal(screen.queryByText('Long-lived token'), null);
});

test('sandbox down shows the reason', async () => {
  apiMock.isolation.status.mockResolvedValue(json({ success: true, data: { ...running, daemon: { running: false, ok: false, reason: 'daemon.sock: ECONNREFUSED' } } }));
  render(<IsolationSettingsTab />);
  assert.ok(await screen.findByText('Not running'));
  assert.ok(screen.getByText(/ECONNREFUSED/));
});

test('setup-token: long-lived token, last four characters, last check and last proxy result', async () => {
  render(<IsolationSettingsTab />);
  assert.ok(await screen.findByText('Long-lived token'));
  assert.ok(screen.getByText(/…WXYZ/));
  assert.ok(screen.getAllByText(/^OK/).length >= 2, 'check and proxy both OK');
});

test('token saved by the hub has no date', async () => {
  apiMock.isolation.claudeLogin.mockResolvedValue(json({ success: true, data: login({ tokenSetAt: null, lastCheck: null, lastUpstream: {} }) }));
  render(<IsolationSettingsTab />);
  assert.ok(await screen.findByText(/saved from the hub/));
  assert.ok(screen.getByText('Not checked yet'));
});

test('credentials: temporary login with its expiry and the advice to paste a long-lived token', async () => {
  apiMock.isolation.claudeLogin.mockResolvedValue(json({ success: true, data: login({ source: 'credentials', tokenSetAt: null, tokenLast4: null, credentialsExpiresAt: '2026-10-20T17:00:00.000Z', lastCheck: null }) }));
  render(<IsolationSettingsTab />);
  assert.ok(await screen.findByText('Temporary login of the instance'));
  assert.ok(screen.getByText(/Expires/));
  assert.ok(screen.getByText(/isolated agents stop working/));
  assert.equal(screen.queryByRole('button', { name: 'Remove token' }), null);
});

test('missing: no login, agents will not run', async () => {
  apiMock.isolation.claudeLogin.mockResolvedValue(json({ success: true, data: login({ source: 'missing', tokenSetAt: null, tokenLast4: null, lastCheck: null, lastUpstream: {} }) }));
  render(<IsolationSettingsTab />);
  assert.ok(await screen.findByText('No login — isolated agents will not run'));
  assert.equal((screen.getByRole('button', { name: 'Check' }) as HTMLButtonElement).disabled, true);
});

test('a 401 from the proxy says the token is invalid or revoked', async () => {
  apiMock.isolation.claudeLogin.mockResolvedValue(json({ success: true, data: login({ lastUpstream: { okAt: '2026-10-20T10:00:00.000Z', error: { at: '2026-10-20T12:40:00.000Z', status: 401, message: 'OAuth token has been revoked.' } } }) }));
  render(<IsolationSettingsTab />);
  assert.ok(await screen.findByText(/The token is invalid or has been revoked/));
  assert.ok(screen.getByText(/OAuth token has been revoked\./));
});

test('save sends the pasted text, clears the field and shows the new state', async () => {
  apiMock.isolation.claudeLogin.mockResolvedValue(json({ success: true, data: login({ source: 'missing', tokenSetAt: null, tokenLast4: null, lastCheck: null, lastUpstream: {} }) }));
  apiMock.isolation.saveClaudeLogin.mockResolvedValue(json({ success: true, data: login() }));
  render(<IsolationSettingsTab />);
  const box = await screen.findByLabelText(/Paste the output of/) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: `Your token:\n${TOKEN}\n` } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  assert.ok(await screen.findByText('Long-lived token'));
  assert.deepEqual(apiMock.isolation.saveClaudeLogin.mock.calls[0], [{ text: `Your token:\n${TOKEN}\n`, force: false }]);
  assert.equal(box.value, '', 'the token does not stay in the page');
  assert.ok(!document.body.innerHTML.includes(TOKEN.slice(13, 40)));
});

test('a refused token shows the error and keeps the old state', async () => {
  apiMock.isolation.saveClaudeLogin.mockResolvedValue(json({ success: false, error: { code: 'TOKEN_REJECTED', message: 'Anthropic refused the token (HTTP 401): OAuth access token is invalid.', details: { status: 401, message: 'OAuth access token is invalid.' } } }, 400));
  render(<IsolationSettingsTab />);
  fireEvent.change(await screen.findByLabelText(/Paste the output of/), { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const alert = await screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /Anthropic refused the token \(HTTP 401\)/);
  assert.match(alert.textContent ?? '', /OAuth access token is invalid/);
  assert.equal(screen.queryByRole('button', { name: 'Save without verification' }), null, 'a refused token cannot be forced');
  assert.equal((screen.getByLabelText(/Paste the output of/) as HTMLTextAreaElement).value, '', 'the refused token does not stay in the page');
});

test('Anthropic unreachable: save only after confirming to save unverified', async () => {
  apiMock.isolation.saveClaudeLogin
    .mockResolvedValueOnce(json({ success: false, error: { code: 'VERIFY_UNAVAILABLE', message: 'The token could not be verified: Anthropic is unreachable: fetch failed', details: { status: null, message: 'Anthropic is unreachable: fetch failed' } } }, 502))
    .mockResolvedValueOnce(json({ success: true, data: login({ lastCheck: { ok: false, unverified: true, at: '2026-10-20T12:03:00.000Z', error: 'Anthropic is unreachable: fetch failed' } }) }));
  render(<IsolationSettingsTab />);
  fireEvent.change(await screen.findByLabelText(/Paste the output of/), { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Save without verification' }));
  await waitFor(() => assert.equal(apiMock.isolation.saveClaudeLogin.mock.calls.length, 2));
  assert.deepEqual(apiMock.isolation.saveClaudeLogin.mock.calls[1], [{ text: TOKEN, force: true }]);
  assert.ok(await screen.findByText(/Not verified/));
});

test('Check verifies the current login and shows the result', async () => {
  apiMock.isolation.checkClaudeLogin.mockResolvedValue(json({ success: true, data: login({ lastCheck: { ok: false, at: '2026-10-20T13:00:00.000Z', status: 401, error: 'OAuth token has been revoked.' } }) }));
  render(<IsolationSettingsTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
  assert.ok(await screen.findByText(/Error \(HTTP 401\)/));
  assert.ok(screen.getByText(/The token is invalid or has been revoked/), 'a refused token is not shown as fine');
  assert.equal(apiMock.isolation.checkClaudeLogin.mock.calls.length, 1);
});

test('Remove token asks first, then falls back', async () => {
  apiMock.isolation.removeClaudeLogin.mockResolvedValue(json({ success: true, data: login({ source: 'credentials', tokenSetAt: null, tokenLast4: null, credentialsExpiresAt: '2026-10-20T17:00:00.000Z', lastCheck: null }) }));
  render(<IsolationSettingsTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove token' }));
  assert.equal(apiMock.isolation.removeClaudeLogin.mock.calls.length, 0, 'not without confirming');
  fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
  assert.ok(await screen.findByText('Temporary login of the instance'));
  assert.equal(apiMock.isolation.removeClaudeLogin.mock.calls.length, 1);
});

test('the guide tells to run claude setup-token and never paste the token into a chat', async () => {
  render(<IsolationSettingsTab />);
  await screen.findByText('Long-lived token');
  assert.ok(screen.getAllByText(/claude setup-token/).length >= 1);
  assert.ok(screen.getByText(/Do not paste the token into a chat/));
});

test('403 from Anthropic: the verification call was refused, not necessarily the token — save unverified is offered', async () => {
  apiMock.isolation.saveClaudeLogin.mockResolvedValue(json({ success: false, error: { code: 'VERIFY_UNAVAILABLE', message: 'The token could not be verified: nope', details: { status: 403, message: 'OAuth token does not meet scope requirement' } } }, 502));
  render(<IsolationSettingsTab />);
  fireEvent.change(await screen.findByLabelText(/Paste the output of/), { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const alert = await screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /refused the verification call \(HTTP 403\)/);
  assert.match(alert.textContent ?? '', /not necessarily the token/);
  assert.ok(screen.getByRole('button', { name: 'Save without verification' }));
  assert.equal((screen.getByLabelText(/Paste the output of/) as HTMLTextAreaElement).value, TOKEN, 'kept for the forced save');
});

test('sandbox status that cannot be loaded: an error instead of a spinner, no login form', async () => {
  apiMock.isolation.status.mockResolvedValue(json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500));
  render(<IsolationSettingsTab />);
  assert.ok(await screen.findByText(/Could not load the sandbox status/));
  assert.equal(screen.queryByLabelText(/Paste the output of/), null);
});

test('no login form while the sandbox status is still loading', async () => {
  let answer: (response: Response) => void = () => {};
  apiMock.isolation.status.mockReturnValue(new Promise<Response>((resolve) => { answer = resolve; }));
  render(<IsolationSettingsTab />);
  await waitFor(() => assert.equal(apiMock.isolation.claudeLogin.mock.calls.length, 1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByLabelText(/Paste the output of/), null);
  answer(json({ success: true, data: running }));
  assert.ok(await screen.findByLabelText(/Paste the output of/));
});
