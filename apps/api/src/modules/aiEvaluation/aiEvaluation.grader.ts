// modules/aiEvaluation/aiEvaluation.grader.ts
// The model boundary. Services depend on the `AiGrader` interface; tests inject
// a fake, so no test ever calls OpenAI. The real implementation uses the
// official SDK with Structured Outputs built from AiGradeOutputSchema (Responses
// API + zodTextFormat). It sets no temperature, so it is safe for reasoning
// models that reject the parameter. The SDK's own retries are off: BullMQ owns
// retries so a 429 retry-after can set the job delay. Marks coming back are
// clamped by `normaliseMarks`, never trusted.

import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { AiGradeOutputSchema, type AiGradeOutput } from '@exam/shared';
import { AiOutputError, AiProviderError } from './aiEvaluation.errors.js';
import type { AiConfig } from './aiEvaluation.config.js';

export interface GradeRequest {
  model: string;
  system: string;
  user: string;
}

export interface GradeResult {
  output: AiGradeOutput;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface AiGrader {
  grade(req: GradeRequest): Promise<GradeResult>;
}

/** Marks to the nearest 0.5, kept within 0…max (max itself rounded down to a 0.5 step). */
export function normaliseMarks(raw: number, max: number): number {
  if (!Number.isFinite(raw)) throw new AiOutputError('The model returned non-numeric marks');
  const cap = Math.floor(Math.max(0, max) * 2) / 2;
  const stepped = Math.round(raw * 2) / 2;
  return Math.min(cap, Math.max(0, stepped));
}

const retryAfterMs = (headers: unknown): number | null => {
  const get = (name: string): string | null => {
    if (headers && typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
    return null;
  };
  const ms = Number(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(get('retry-after'));
  if (Number.isFinite(s) && s > 0) return s * 1_000;
  return null;
};

/** Maps an SDK failure to a safe AiProviderError (no provider text, which may echo key fragments). */
export function toProviderError(err: unknown): AiProviderError {
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    if (status === 429) return new AiProviderError('OpenAI rate limit or quota reached (429)', 429, retryAfterMs(err.headers));
    if (status === 401 || status === 403) return new AiProviderError(`OpenAI rejected the API key (${status})`, status);
    if (status === 404) return new AiProviderError('OpenAI model not found or not available to this key (404)', status);
    if (status === 400) return new AiProviderError('OpenAI rejected the request (400); check the model name', status);
    if (status !== null) return new AiProviderError(`OpenAI error (${status})`, status);
  }
  return new AiProviderError('Could not reach OpenAI');
}

export function createOpenAiGrader(getConfig: () => Promise<AiConfig>): AiGrader {
  let cached: { key: string; client: OpenAI } | undefined;
  const clientFor = (apiKey: string): OpenAI => {
    if (cached?.key !== apiKey) cached = { key: apiKey, client: new OpenAI({ apiKey, maxRetries: 0, timeout: 120_000 }) };
    return cached.client;
  };

  return {
    async grade(req) {
      const cfg = await getConfig();
      if (!cfg.apiKey) throw new AiProviderError('OpenAI API key is not set');
      let response;
      try {
        response = await clientFor(cfg.apiKey).responses.parse({
          model: req.model,
          instructions: req.system,
          input: req.user,
          store: false,
          text: { format: zodTextFormat(AiGradeOutputSchema, 'grade') },
        });
      } catch (err) {
        // The SDK throws its own parse error when the JSON does not match the schema.
        if (err instanceof OpenAI.APIError || err instanceof OpenAI.APIConnectionError) throw toProviderError(err);
        throw new AiOutputError();
      }
      const parsed = AiGradeOutputSchema.safeParse(response.output_parsed);
      if (!parsed.success) throw new AiOutputError();
      return {
        output: parsed.data,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        model: response.model,
      };
    },
  };
}
