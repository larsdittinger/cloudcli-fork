// pluginsRoutes: used by the server entrypoint to mount protected plugin-management endpoints.
export { pluginsRoutes } from './plugins.module.js';

// startEnabledPluginServers: used by the server entrypoint to start enabled plugin subprocesses.
export { startEnabledPluginServers } from './plugin-process.service.js';
// stopAllPlugins: used by the server entrypoint to stop plugin subprocesses during shutdown.
export { stopAllPlugins } from './plugin-process.service.js';
// getPluginPort: used by WebSocket setup in the server entrypoint to proxy plugin connections.
export { getPluginPort } from './plugin-process.service.js';
// disablePlugin: used by Schedules to switch the replaced cron plugin off after importing its tasks.
export { disablePlugin } from './plugin-process.service.js';
// isPluginEnabled: used by Schedules to import the cron plugin's tasks paused when the plugin was off.
export { isPluginEnabled } from './plugin-process.service.js';
