// app.ts — the HTTP server: routing, auth, X-GitHub-Request-Id, body collection.
// Routes: GET /healthz (no auth), POST /api/graphql, POST /mcp, /api/v3/* (REST),
// /{owner}/{repo}.git/* (git smart HTTP). Everything else is a JSON 404.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './githttp.ts';

export interface App {
  forge: Forge;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  requestCount: () => number;
}

function jsonReply(res: ServerResponse, requestId: string, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

function rawReply(
  res: ServerResponse,
  requestId: string,
  status: number,
  headers: Record<string, string>,
  body: Buffer | string,
): void {
  res.writeHead(status, { 'x-github-request-id': requestId, ...headers });
  res.end(body);
}

/** The trial token from MAKEFUN_SHOP_TOKEN; empty in dev mode (auth is skipped). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (expected === '') return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const token = header.replace(/^(?:Bearer|token)\s+/i, '');
  return token === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): App {
  const forge = new Forge();
  let counter = 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      counter += 1;
      const requestId = `req-${counter}`;
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const method = req.method ?? 'GET';
        const pathname = decodeURIComponent(url.pathname);
        const segments = pathname.split('/').filter((part) => part !== '');

        if (method === 'GET' && pathname === '/healthz') {
          jsonReply(res, requestId, 200, { ok: true });
          return;
        }

        const body = await readBody(req);

        if (method === 'POST' && pathname === '/api/graphql') {
          if (!authorized(req)) {
            jsonReply(res, requestId, 401, { message: 'Bad credentials' });
            return;
          }
          const result = handleGraphQL(forge, body.toString('utf8'));
          rawReply(res, requestId, result.status, { 'content-type': 'application/json; charset=utf-8' }, result.body);
          return;
        }

        if (method === 'POST' && pathname === '/mcp') {
          if (!authorized(req)) {
            jsonReply(res, requestId, 401, { message: 'Bad credentials' });
            return;
          }
          const result = handleMcp(forge, body.toString('utf8'));
          rawReply(res, requestId, result.status, { 'content-type': 'application/json; charset=utf-8' }, result.body);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req)) {
            jsonReply(res, requestId, 401, { message: 'Bad credentials' });
            return;
          }
          const result = handleRest(forge, segments.slice(2), {
            method,
            query: url.searchParams,
            host: req.headers.host ?? '127.0.0.1',
            bodyText: body.toString('utf8'),
          });
          if (result.status === 204) {
            rawReply(res, requestId, 204, {}, '');
            return;
          }
          rawReply(res, requestId, result.status, { 'content-type': 'application/json; charset=utf-8', ...result.headers }, result.body);
          return;
        }

        if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
          if (!authorized(req)) {
            jsonReply(res, requestId, 401, { message: 'Bad credentials' });
            return;
          }
          const result = handleGit(forge, segments, {
            method,
            query: url.searchParams,
            headers: req.headers,
            body,
          });
          rawReply(res, requestId, result.status, result.headers, result.body);
          return;
        }

        jsonReply(res, requestId, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          jsonReply(res, requestId, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  };

  return { forge, handler, requestCount: () => counter };
}

export function startServer(port: number): ReturnType<typeof createServer> {
  const app = createApp();
  const server = createServer(app.handler);
  server.listen(port, '127.0.0.1');
  return server;
}
