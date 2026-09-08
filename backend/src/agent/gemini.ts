import { Gemini } from '@google/adk';
import { GoogleGenAI } from '@google/genai';
import { getConfig, type AppConfig, type GeminiBackend } from '../config.js';

export interface GeminiBackendInfo {
  configured: boolean;
  backend: GeminiBackend | null;
  project: string | null;
  location: string | null;
  model: string;
}

export function geminiBackendInfo(config: AppConfig): GeminiBackendInfo {
  const g = config.gemini;
  return {
    configured: g.configured,
    backend: g.backend,
    project: g.backend === 'vertex-ai' ? g.project : null,
    location: g.backend === 'vertex-ai' ? g.location : null,
    model: g.model,
  };
}

export class GeminiNotConfiguredError extends Error {
  readonly code = 'GEMINI_NOT_CONFIGURED';
  readonly hint =
    'Set GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT for Vertex AI (or GEMINI_API_KEY for the Gemini API) and restart.';
  constructor() {
    super('Gemini is not configured');
  }
}

export function makeGeminiModel(config: AppConfig): Gemini {
  const g = config.gemini;
  if (g.backend === 'vertex-ai') {
    return new Gemini({ model: g.model, vertexai: true, project: g.project ?? undefined, location: g.location });
  }
  if (g.backend === 'gemini-api' && g.apiKey) {
    return new Gemini({ model: g.model, apiKey: g.apiKey, vertexai: false });
  }
  throw new GeminiNotConfiguredError();
}

export function makeGenAiClient(config: AppConfig): GoogleGenAI {
  const g = config.gemini;
  if (g.backend === 'vertex-ai') return new GoogleGenAI({ vertexai: true, project: g.project ?? undefined, location: g.location });
  if (g.backend === 'gemini-api' && g.apiKey) return new GoogleGenAI({ apiKey: g.apiKey });
  throw new GeminiNotConfiguredError();
}

export interface GeminiProbeResult {
  configured: boolean;
  backend: GeminiBackend | null;
  ok: boolean | null;
  latency_ms: number | null;
  error: string | null;
  model: string;
}

export async function probeGemini(timeoutMs = 8_000, config?: AppConfig): Promise<GeminiProbeResult> {
  const cfg = config ?? (await getConfig());
  const info = geminiBackendInfo(cfg);
  if (!info.configured) return { configured: false, backend: null, ok: null, latency_ms: null, error: 'not configured', model: info.model };
  const started = Date.now();
  let timer: NodeJS.Timeout | null = null;
  try {
    const ai = makeGenAiClient(cfg);
    const call = ai.models.generateContent({
      model: cfg.gemini.model,
      contents: 'Reply with the single word OK.',
      config: { maxOutputTokens: 4, temperature: 0 },
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Gemini ping timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    await Promise.race([call, timeout]);
    return { configured: true, backend: info.backend, ok: true, latency_ms: Date.now() - started, error: null, model: info.model };
  } catch (err) {
    return { configured: true, backend: info.backend, ok: false, latency_ms: Date.now() - started, error: summarizeGeminiError(err), model: info.model };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function summarizeGeminiError(err: unknown): string {
  const e = err as { message?: string; status?: number | string; code?: number | string };
  let msg = e?.message ?? String(err);
  const m = /"message"\s*:\s*"([^"]{1,300})"/.exec(msg);
  if (m) msg = m[1];
  const reason = /"reason"\s*:\s*"([A-Z_]+)"/.exec(String(e?.message ?? ''));
  const prefix = e?.status ?? e?.code;
  const out = `${prefix ? `${prefix} ` : ''}${msg}${reason && !msg.includes(reason[1]) ? ` (${reason[1]})` : ''}`;
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}
