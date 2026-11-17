// main.ts — the trial entrypoint.
// Lifecycle: listen on an ephemeral port, register it with the harness environment server,
// then poll /done until the trial finishes and exit 0. Without MAKEFUN_ENV_URL the server
// just runs standalone (dev mode) and prints its port.

import { request as httpRequest } from 'node:http';
import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface JsonResult {
  status: number;
  text: string;
}

function httpJson(url: string, method: string, body?: string): Promise<JsonResult> {
  return new Promise<JsonResult>((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function main(): Promise<void> {
  const app = createApp();
  const server = (await import('node:http')).createServer(app.handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) {
    console.error('could not determine the listening port');
    process.exit(1);
  }

  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  if (envUrl === '') {
    console.log(`forge listening on http://127.0.0.1:${port} (dev mode, no MAKEFUN_ENV_URL)`);
    return;
  }

  const base = envUrl.replace(/\/$/, '');
  let registered = false;
  for (let attempt = 0; attempt < 20 && !registered; attempt += 1) {
    try {
      const result = await httpJson(`${base}/register`, 'POST', JSON.stringify({ port }));
      if (result.status >= 200 && result.status < 300) {
        registered = true;
      } else if (result.status === 409) {
        console.error('register: another entry already registered (409)');
        process.exit(1);
      } else {
        await sleep(500);
      }
    } catch {
      await sleep(500);
    }
  }
  if (!registered) {
    console.error('register: could not register with the environment server');
    process.exit(1);
  }

  for (;;) {
    await sleep(500);
    try {
      const result = await httpJson(`${base}/done`, 'GET');
      if (result.status === 200) {
        const parsed = JSON.parse(result.text) as { done?: boolean };
        if (parsed.done === true) break;
      }
    } catch {
      // The environment server may restart; keep polling.
    }
  }

  server.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
