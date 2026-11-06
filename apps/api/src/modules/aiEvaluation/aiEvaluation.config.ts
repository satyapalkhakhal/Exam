// modules/aiEvaluation/aiEvaluation.config.ts
// Typed `ai.openai` config (Admin -> Integrations), its defaults and the
// readiness check. The API key is a sealed secret (systemConfig SECRET_FIELDS);
// it is read here and handed to the OpenAI client, never logged or returned.

import { getConfig } from '../systemConfig/index.js';

export interface AiConfig {
  enabled: boolean;
  apiKey: string;
  model: string;
  concurrency: number;
  gradingInstructions: string;
}

export const AI_KEY = 'ai.openai';

export const AI_DEFAULTS: AiConfig = {
  enabled: false,
  apiKey: '',
  model: '',
  concurrency: 3,
  gradingInstructions: '',
};

export const mergeAi = (raw: Partial<AiConfig>): AiConfig => {
  const out = { ...AI_DEFAULTS, ...raw };
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) out.concurrency = AI_DEFAULTS.concurrency;
  return out;
};

export const getAiConfig = async (): Promise<AiConfig> => mergeAi(await getConfig<Partial<AiConfig>>(AI_KEY));

const filled = (v: string): boolean => v.trim() !== '';

/** A key and a model are present (enough to make a call, e.g. the connection test). */
export const hasAiCredentials = (cfg: AiConfig): boolean => filled(cfg.apiKey) && filled(cfg.model);

/** Enabled AND key and model present: the gate for starting a run. */
export const isAiReady = (cfg: AiConfig): boolean => cfg.enabled && hasAiCredentials(cfg);
