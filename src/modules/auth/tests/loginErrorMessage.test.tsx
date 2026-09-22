import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/modules/auth/context/AuthContext';
import LoginForm from '@/modules/auth/LoginForm';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const login = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    auth: {
      status: () => Promise.resolve(new Response('{"needsSetup":false}', { status: 200 })),
      user: () => Promise.resolve(new Response('{}', { status: 401 })),
      login: (username: string, password: string) => login(username, password),
    },
    user: {
      onboardingStatus: () => Promise.resolve(new Response('{"hasCompletedOnboarding":true}', { status: 200 })),
    },
  },
}));

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function submitCredentials() {
  render(
    <AuthProvider>
      <LoginForm />
    </AuthProvider>,
  );

  fireEvent.change(screen.getByLabelText('login.username'), { target: { value: 'diti' } });
  fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'spatne' } });
  fireEvent.click(screen.getByRole('button', { name: 'login.submit' }));
}

describe('LoginForm failure feedback', () => {
  beforeEach(() => {
    localStorage.clear();
    login.mockReset();
  });

  // The server rejects bad credentials with the structured AppError envelope
  // `{ success: false, error: { code, message } }`. Rendering that object as a
  // React child throws, so the user was left staring at a form that did
  // nothing rather than at "Invalid username or password".
  it('shows the message from a structured AppError envelope', async () => {
    login.mockResolvedValue(jsonResponse(
      { success: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid username or password' } },
      401,
    ));

    await submitCredentials();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Invalid username or password');
    });
  });

  it('still shows the message from a legacy string envelope', async () => {
    login.mockResolvedValue(jsonResponse({ success: false, error: 'Too many attempts' }, 429));

    await submitCredentials();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Too many attempts');
    });
  });

  it('falls back to a generic message when the body carries no text', async () => {
    login.mockResolvedValue(jsonResponse({ success: false }, 500));

    await submitCredentials();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('errors.loginFailed');
    });
  });
});
