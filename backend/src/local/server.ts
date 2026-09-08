import { createServer, type IncomingMessage } from 'node:http';
import { getConfig } from '../config.js';
import { router } from '../http/handlers.js';
import { closeClickHouse } from '../db/clickhouse.js';
import type { HttpRequest } from '../http/router.js';

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', reject);
  });
}

async function main(): Promise<void> {
  const cfg = await getConfig();
  const port = Number(process.env.PORT ?? cfg.port ?? 8787);
  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    let out;
    try {
      const body = await readBody(req);
      const request: HttpRequest = { method: req.method ?? 'GET', path: url.pathname, query, headers, body, baseUrl: `http://${req.headers.host ?? `127.0.0.1:${port}`}` };
      out = await router().handle(request);
    } catch (err) {
      out = { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: 'INTERNAL', message: (err as Error).message } }) };
    }
    res.writeHead(out.status, out.headers);
    res.end(out.body);
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search} -> ${out.status} ${Date.now() - started}ms`);
  });
  server.listen(port, () => {
    console.log(`[localelock] API listening on http://127.0.0.1:${port} (mode ${cfg.mode}, db ${cfg.clickhouse.database}, gemini ${cfg.gemini.backend ?? 'not configured'})`);
  });
  const shutdown = () => {
    server.close();
    closeClickHouse().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[localelock] failed to start:', (err as Error).message);
  process.exit(1);
});
