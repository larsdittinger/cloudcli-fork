// authRoutes: used by the server entrypoint to mount public authentication endpoints.
export { authRoutes } from './auth.module.js';

// authenticateToken: used by the server entrypoint to protect authenticated API modules.
export { authenticateToken } from './auth.middleware.js';
// authenticateWebSocket: used by WebSocket setup to verify connection tokens.
export { authenticateWebSocket } from './auth.middleware.js';
// validateApiKey: used by the server entrypoint for optional API-wide key validation.
export { validateApiKey } from './auth.middleware.js';
// requireAdmin: used by the server entrypoint and route modules to gate admin-only endpoints.
export { requireAdmin } from './auth.middleware.js';

// Session access helpers: used by Projects, Providers, Browser, and the chat WebSocket to
// keep restricted users inside their own chats and granted projects; chats shared with them,
// or every chat of an assigned project with the "sees all chats" flag, are read-only.
export {
  assertProjectIdAccess,
  assertProjectPathAccess,
  canAccessProjectPath,
  assertSessionAccess,
  assertSessionRead,
  canAccessSession,
  canReadSession,
  isSessionReadOnlyFor,
  resolveSessionOwnerScope,
} from './session-access.js';
export type { SessionAccessUser } from './session-access.js';
