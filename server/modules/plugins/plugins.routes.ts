import fs from 'node:fs';
import http from 'node:http';

import express from 'express';

import { requireAdmin } from '@/modules/auth/index.js';

import type { createPluginsService } from './plugins.service.js';

function wildcardPath(req: express.Request): string {
  return ((req.params as Record<string, string>)['0'] ?? '').trim();
}

function routeParameter(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

/**
 * Plugins a restricted user may see and call. Plugin RPC runs with the
 * server's rights, so anything that can start work (e.g. scheduled prompts)
 * stays admin-only; only read-only dashboards belong here.
 */
const RESTRICTED_USER_PLUGINS = new Set(['claude-usage']);

function isRestrictedUser(req: express.Request): boolean {
  return (req as express.Request & { user?: { role?: string } }).user?.role === 'restricted';
}

/** Hides plugins outside RESTRICTED_USER_PLUGINS from restricted users (404, as if not installed). */
const requirePluginAccess: express.RequestHandler = (req, res, next) => {
  if (isRestrictedUser(req) && !RESTRICTED_USER_PLUGINS.has(routeParameter(req.params.name))) {
    res.status(404).json({ error: 'Plugin not found' });
    return;
  }
  next();
};

/** Creates plugin routes; transport streaming remains here while decisions live in the service. */
export function createPluginsRouter(service: ReturnType<typeof createPluginsService>): express.Router {
  const router = express.Router();
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.json(await operation(req)); } catch (error) { next(error); }
    };

  router.get('/', respond((req) => {
    const result = service.list();
    return isRestrictedUser(req)
      ? { ...result, plugins: result.plugins.filter((plugin) => RESTRICTED_USER_PLUGINS.has(plugin.name)) }
      : result;
  }));
  router.get('/:name/manifest', requirePluginAccess, respond((req) => service.getManifest(routeParameter(req.params.name))));
  router.get('/:name/assets/*', requirePluginAccess, async (req, res, next) => {
    try {
      const asset = service.resolveAsset(routeParameter(req.params.name), wildcardPath(req));
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      const stream = fs.createReadStream(asset.path);
      stream.on('error', next);
      stream.pipe(res);
    } catch (error) { next(error); }
  });
  router.put('/:name/enable', requireAdmin, respond((req) => service.setEnabled(routeParameter(req.params.name), req.body?.enabled)));
  router.post('/install', requireAdmin, respond((req) => service.install(req.body?.url)));
  router.post('/:name/update', requireAdmin, respond((req) => service.update(routeParameter(req.params.name))));
  router.all('/:name/rpc/*', requirePluginAccess, async (req, res, next) => {
    try {
      const { port, secrets } = await service.prepareRpc(routeParameter(req.params.name));
      const headers: Record<string, string> = {
        'content-type': String(req.headers['content-type'] ?? 'application/json'),
      };
      for (const [key, value] of Object.entries(secrets)) {
        headers[`x-plugin-secret-${key.toLowerCase()}`] = String(value);
      }
      const query = req.url.includes('?') ? `?${req.url.split('?').slice(1).join('?')}` : '';
      const proxyRequest = http.request({
        hostname: '127.0.0.1', port, path: `/${wildcardPath(req)}${query}`, method: req.method, headers,
      }, (proxyResponse) => {
        res.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
        proxyResponse.pipe(res);
      });
      proxyRequest.on('error', next);
      if (req.headers['content-length'] && req.body !== undefined) {
        const body = JSON.stringify(req.body);
        proxyRequest.setHeader('content-length', Buffer.byteLength(body));
        proxyRequest.write(body);
      }
      proxyRequest.end();
    } catch (error) { next(error); }
  });
  router.delete('/:name', requireAdmin, respond((req) => service.uninstall(routeParameter(req.params.name))));
  return router;
}
