import { useAuth } from '../components/auth/context/AuthContext';

/**
 * Returns true unless the logged-in user has the 'restricted' role.
 * Users without a role (platform mode, pre-role tokens) count as admins,
 * matching the server-side requireAdmin behavior.
 */
export function useIsAdmin(): boolean {
  const { user } = useAuth();
  return user?.role !== 'restricted';
}
