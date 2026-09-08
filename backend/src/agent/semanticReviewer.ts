import { InMemoryRunner, LlmAgent } from '@google/adk';
import type { Event } from '@google/adk';
import { Type, type Schema } from '@google/genai';
import { z } from 'zod';
import { APP_NAME, SEMANTIC_REVIEWER_AGENT_NAME, type SemanticReview, type SemanticReviewInput, type SemanticReviewOutput } from '../domain/constants.js';
import type { AppConfig } from '../config.js';
import { makeGeminiModel, summarizeGeminiError } from './gemini.js';

export const SEMANTIC_GENAI_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ['MEANING_PRESERVED', 'MEANING_SHIFTED', 'MEANING_REVERSED'], description: 'Semantic relationship of the target to the source.' },
    severity: { type: Type.STRING, enum: ['low', 'medium', 'high'], description: 'Impact of the deviation on the viewer.' },
    confidence: { type: Type.NUMBER, minimum: 0, maximum: 1, description: 'Decimal between 0 and 1, e.g. 0.95. Never a percentage or a 1-5 rating.' },
    explanation: { type: Type.STRING, description: 'One or two sentences justifying the verdict.' },
    suggested_target_text: { type: Type.STRING, nullable: true, description: 'Corrected Spanish subtitle line (max 42 characters), or null when no change is needed.' },
  },
  required: ['verdict', 'severity', 'confidence', 'explanation', 'suggested_target_text'],
};

export const SEMANTIC_OUTPUT_SCHEMA = z.object({
  verdict: z.enum(['MEANING_PRESERVED', 'MEANING_SHIFTED', 'MEANING_REVERSED']),
  severity: z.enum(['low', 'medium', 'high']),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  suggested_target_text: z.string().nullable(),
});

export const SEMANTIC_INSTRUCTION = [
  'You are a senior Spanish subtitle QC reviewer for film. You receive exactly one narrowed source/target pair. Judge ONLY semantic fidelity (meaning, polarity, intent) of the Spanish target against the English source. Ignore timing, reading speed, and glossary; those are checked deterministically elsewhere.',
  '- If the target contradicts or reverses the source: verdict MEANING_REVERSED, severity high.',
  '- If meaning is preserved (natural phrasing differences are fine): verdict MEANING_PRESERVED, severity low, suggested_target_text null.',
  '- Otherwise MEANING_SHIFTED with severity by impact.',
  'confidence is a decimal between 0 and 1 (for example 0.95), never a percentage and never a 1-5 rating.',
  'suggested_target_text must be a natural Latin American Spanish subtitle line of at most 42 characters that faithfully conveys the source, or null when no change is needed. Return only the structured result.',
].join('\n');

export class SemanticReviewError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly hint: string | null = null,
  ) {
    super(message);
  }
}

export function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 1 && value >= 0) return value;
  if (value > 1 && value <= 5) return Math.min(1, value / 5);
  if (value > 5 && value <= 100) return Math.min(1, value / 100);
  return value < 0 ? 0 : 1;
}

export function extractOutput(stateValue: unknown, text: string | null): SemanticReviewOutput {
  const candidates: unknown[] = [];
  if (stateValue && typeof stateValue === 'object') candidates.push(stateValue);
  if (text) {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          candidates.push(JSON.parse(trimmed.slice(start, end + 1)));
        } catch {
        }
      }
    }
  }
  for (const c of candidates) {
    const withNormalized =
      c && typeof c === 'object' && 'confidence' in (c as Record<string, unknown>)
        ? { ...(c as Record<string, unknown>), confidence: normalizeConfidence(Number((c as Record<string, unknown>).confidence)) }
        : c;
    const parsed = SEMANTIC_OUTPUT_SCHEMA.safeParse(withNormalized);
    if (parsed.success) {
      const out = parsed.data;
      const suggestion = out.suggested_target_text?.trim();
      return { ...out, suggested_target_text: suggestion ? suggestion : null };
    }
  }
  throw new SemanticReviewError('Gemini did not return a valid structured semantic review', true, 'Retry the release gate; if it persists, check the model name and Vertex AI quota on /health?deep=1.');
}

export interface SemanticReviewOptions {
  config: AppConfig;
  attempts?: number;
  timeoutMs?: number;
}

export async function reviewSemanticPair(input: SemanticReviewInput, opts: SemanticReviewOptions): Promise<SemanticReview> {
  const { config } = opts;
  const attempts = opts.attempts ?? 2;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const backend = config.gemini.backend ?? 'vertex-ai';

  const agent = new LlmAgent({
    name: SEMANTIC_REVIEWER_AGENT_NAME,
    description: 'Judges semantic fidelity of one narrowed subtitle source/target pair.',
    model: makeGeminiModel(config),
    instruction: SEMANTIC_INSTRUCTION,
    generateContentConfig: { temperature: 0 },
    outputSchema: SEMANTIC_GENAI_SCHEMA,
    outputKey: 'review',
  });

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = new Date();
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const runner = new InMemoryRunner({ agent, appName: APP_NAME });
      const session = await runner.sessionService.createSession({ appName: APP_NAME, userId: 'semantic-reviewer' });
      let stateValue: unknown = null;
      let text: string | null = null;
      for await (const ev of runner.runAsync({
        userId: 'semantic-reviewer',
        sessionId: session.id,
        newMessage: { role: 'user', parts: [{ text: JSON.stringify(input) }] },
        abortSignal: controller.signal,
      })) {
        const e = ev as Event;
        if (e.author !== agent.name) continue;
        const delta = e.actions?.stateDelta as Record<string, unknown> | undefined;
        if (delta && delta.review !== undefined) stateValue = delta.review;
        const partText = (e.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
        if (partText) text = partText;
      }
      const output = extractOutput(stateValue, text);
      return {
        framework: 'google-adk',
        agent_name: 'semantic_reviewer',
        model: config.gemini.model,
        backend,
        input,
        output,
        raw_text: text,
        started_at: startedAt.toISOString(),
        latency_ms: Date.now() - t0,
      };
    } catch (err) {
      lastError = err instanceof SemanticReviewError ? err : new Error(controller.signal.aborted ? `Semantic review timed out after ${timeoutMs} ms` : summarizeGeminiError(err));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SemanticReviewError(
    `Semantic review failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${lastError?.message ?? 'unknown error'}`,
    true,
    (lastError as SemanticReviewError | null)?.hint ?? 'Check Gemini status on /health?deep=1 and retry the release gate.',
  );
}
