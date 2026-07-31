import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../utils/api';

export type AdminUser = {
  id: number;
  username: string;
  role: 'admin' | 'restricted';
  created_at: string;
  last_login: string | null;
  projectIds: string[];
};

export type AdminProjectOption = {
  projectId: string;
  displayName: string;
};

type ApiErrorPayload = { error?: { message?: string } | string };

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorPayload;
    if (typeof payload.error === 'string') return payload.error;
    if (payload.error?.message) return payload.error.message;
  } catch {
    // ignore body parse failures
  }
  return fallback;
}

export function useUsersSettings() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [projects, setProjects] = useState<AdminProjectOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const [usersResponse, projectsResponse] = await Promise.all([
        api.admin.listUsers(),
        api.projects(),
      ]);
      if (!usersResponse.ok) {
        setError(await readErrorMessage(usersResponse, 'Failed to load users'));
        return;
      }
      const usersPayload = (await usersResponse.json()) as { users?: AdminUser[] };
      setUsers(usersPayload.users ?? []);

      if (projectsResponse.ok) {
        const projectsPayload = (await projectsResponse.json()) as Array<{
          projectId: string;
          displayName?: string;
          path?: string;
        }>;
        setProjects(
          projectsPayload.map((project) => ({
            projectId: project.projectId,
            displayName: project.displayName || project.path || project.projectId,
          }))
        );
      }
    } catch (loadError) {
      console.error('Error loading users:', loadError);
      setError('Failed to load users');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createUser = useCallback(
    async (username: string, password: string): Promise<string | null> => {
      const response = await api.admin.createUser(username, password);
      if (!response.ok) {
        return readErrorMessage(response, 'Failed to create user');
      }
      await refresh();
      return null;
    },
    [refresh]
  );

  const deleteUser = useCallback(
    async (userId: number): Promise<string | null> => {
      const response = await api.admin.deleteUser(userId);
      if (!response.ok) {
        return readErrorMessage(response, 'Failed to delete user');
      }
      await refresh();
      return null;
    },
    [refresh]
  );

  const setUserPassword = useCallback(
    async (userId: number, password: string): Promise<string | null> => {
      const response = await api.admin.setUserPassword(userId, password);
      if (!response.ok) {
        return readErrorMessage(response, 'Failed to change password');
      }
      return null;
    },
    []
  );

  const setUserProjects = useCallback(
    async (userId: number, projectIds: string[]): Promise<string | null> => {
      const response = await api.admin.setUserProjects(userId, projectIds);
      if (!response.ok) {
        return readErrorMessage(response, 'Failed to update project access');
      }
      setUsers((current) =>
        current.map((user) => (user.id === userId ? { ...user, projectIds } : user))
      );
      return null;
    },
    []
  );

  return {
    users,
    projects,
    isLoading,
    error,
    refresh,
    createUser,
    deleteUser,
    setUserPassword,
    setUserProjects,
  };
}
