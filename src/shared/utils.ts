/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = import.meta.env.VITE_IS_PLATFORM === 'true';

/**
 * Environment Flag: Hide Community Links
 * When VITE_HIDE_COMMUNITY_LINKS=true, GitHub star/issues and Discord links
 * are hidden across the UI (self-hosted white-label deployments).
 */
export const SHOW_COMMUNITY_LINKS = import.meta.env.VITE_HIDE_COMMUNITY_LINKS !== 'true';
