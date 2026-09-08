import { ApiError } from './errors.js';

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
  baseUrl: string | null;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Handler = (req: HttpRequest, params: Record<string, string>) => Promise<HttpResponse>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-demo-key,authorization',
  'access-control-max-age': '86400',
};

export function json(status: number, body: unknown, extra: Record<string, string> = {}): HttpResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra }, body: JSON.stringify(body) };
}

export function text(status: number, body: string, extra: Record<string, string> = {}): HttpResponse {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra }, body };
}

export function parseJsonBody<T>(req: HttpRequest): T {
  if (!req.body || !req.body.trim()) return {} as T;
  try {
    return JSON.parse(req.body) as T;
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'Body must be valid JSON');
  }
}

export class Router {
  private routes: Route[] = [];
  private prod = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const source = path.replace(/\{([a-zA-Z_]+)\}/g, (_, k: string) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.routes.push({ method: method.toUpperCase(), pattern: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.add('GET', path, handler);
  }
  post(path: string, handler: Handler): this {
    return this.add('POST', path, handler);
  }

  async handle(req: HttpRequest): Promise<HttpResponse> {
    const method = req.method.toUpperCase();
    let path = req.path || '/';
    if (path === '/api' || path.startsWith('/api/')) path = path.slice(4) || '/';
    if (method === 'OPTIONS') return { status: 204, headers: { ...CORS_HEADERS }, body: '' };
    let res: HttpResponse;
    try {
      const match = this.routes.find((r) => r.method === method && r.pattern.test(path));
      if (!match) {
        const pathExists = this.routes.some((r) => r.pattern.test(path));
        throw new ApiError(pathExists ? 405 : 404, 'NOT_FOUND', pathExists ? `Method ${method} not allowed on ${path}` : `No route for ${method} ${path}`);
      }
      const m = match.pattern.exec(path)!;
      const params: Record<string, string> = {};
      match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      res = await match.handler({ ...req, path }, params);
    } catch (err) {
      res = errorResponse(err, this.prod);
    }
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }
}

export function errorResponse(err: unknown, prod: boolean): HttpResponse {
  if (err instanceof ApiError) return json(err.status, err.toBody());
  const e = err as { code?: string; message?: string; stack?: string; hint?: string };
  if (e?.code === 'GEMINI_NOT_CONFIGURED') return json(503, { error: { code: 'GEMINI_NOT_CONFIGURED', message: e.message, details: { hint: e.hint } } });
  const message = e?.message ?? String(err);
  console.error('[api] INTERNAL', prod ? message : e?.stack ?? message);
  return json(500, { error: { code: 'INTERNAL', message, ...(prod ? {} : { details: { stack: e?.stack } }) } });
}
