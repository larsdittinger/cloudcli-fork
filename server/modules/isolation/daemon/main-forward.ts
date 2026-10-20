// Dumb pass-through from 127.0.0.1:<forwardPort> to the main app's unix socket.
// Adds and checks nothing: identity is the run token in Authorization, verified by the app. Node builtins only.
import http from 'node:http';

export function createMainForward(mainSocketPath: string): http.Server {
  return http.createServer((req, res) => {
    const upstream = http.request(
      { socketPath: mainSocketPath, method: req.method, path: req.url, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.rawHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => res.destroy());
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0 }).end();
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
}
