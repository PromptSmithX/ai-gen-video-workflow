// Minimal local HTTP/HTTPS forward proxy for testing Muse4AI with a direct (home) connection.
// Muse4AI requires a "healthy proxy" per account; point it at 127.0.0.1:<port> (no auth).
// Binds to loopback ONLY. Logs nothing about requests (no URLs, headers or bodies).
import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
import { URL } from 'node:url';
import console from 'node:console';

const HOST = '127.0.0.1';
const PORT = Number(process.env.LOCAL_PROXY_PORT || 8080);
const HOP_BY_HOP = new Set([
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const server = http.createServer((req, res) => {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end('Absolute URL required');
    return;
  }
  if (target.protocol !== 'http:') {
    res.writeHead(400).end('Only http:// is forwarded directly; use CONNECT for https');
    return;
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;

  const upstream = http.request(
    { hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers },
    (up) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
      res.writeHead(up.statusCode ?? 502, outHeaders);
      up.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = String(req.url).split(/:(?=\d+$)/);
  const port = Number(portStr || 443);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const fail = () => {
    if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    upstream.destroy();
  };
  upstream.on('error', fail);
  clientSocket.on('error', () => upstream.destroy());
});

server.on('clientError', (_err, socket) => {
  if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log(`local-proxy listening on ${HOST}:${PORT} (keep this window open while Muse4AI runs; Ctrl+C to stop)`);
});
