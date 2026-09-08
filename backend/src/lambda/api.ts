import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { router } from '../http/handlers.js';
import type { HttpRequest } from '../http/router.js';

async function warmup(): Promise<APIGatewayProxyStructuredResultV2> {
  const started = Date.now();
  try {
    const { catalogRisk } = await import('../domain/catalog.js');
    await catalogRisk();
    console.log(`[warmup] primed in ${Date.now() - started} ms`);
  } catch (err) {
    console.warn(`[warmup] failed after ${Date.now() - started} ms:`, (err as Error).message);
  }
  return { statusCode: 200, body: 'warm' };
}

export async function handler(event: APIGatewayProxyEventV2 & { source?: string }): Promise<APIGatewayProxyStructuredResultV2> {
  if (event?.source === 'aws.events' || (event as { warmup?: boolean }).warmup === true) return warmup();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers[k.toLowerCase()] = v;
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.queryStringParameters ?? {})) if (v !== undefined) query[k] = v;
  if (Object.keys(query).length === 0 && event.rawQueryString) {
    for (const [k, v] of new URLSearchParams(event.rawQueryString)) query[k] = v;
  }
  const body = event.body == null ? null : event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const host = headers.host ?? event.requestContext?.domainName;
  const stage = event.requestContext?.stage && event.requestContext.stage !== '$default' ? `/${event.requestContext.stage}` : '';
  const req: HttpRequest = {
    method: event.requestContext?.http?.method ?? 'GET',
    path: event.rawPath ?? '/',
    query,
    headers,
    body,
    baseUrl: host ? `https://${host}${stage}` : null,
  };
  const res = await router().handle(req);
  return { statusCode: res.status, headers: res.headers, body: res.body, isBase64Encoded: false };
}
