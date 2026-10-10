// The only module that talks to AI providers. Everything else calls
// generateStructured() so the provider/model can be swapped via AI_MODEL.
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import {
  NoObjectGeneratedError,
  Output,
  createProviderRegistry,
  generateText,
  type FlexibleSchema,
  type LanguageModel,
  type ModelMessage,
} from 'ai';

const providers = { anthropic, openai, google };
type ProviderName = keyof typeof providers;

const API_KEY_ENV: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

/** Jobs that can be routed to a different model via AI_MODEL_<JOB>. */
export type AiJob = 'extract' | 'plan';
const JOB_MODEL_ENV: Record<AiJob, string> = {
  extract: 'AI_MODEL_EXTRACT',
  plan: 'AI_MODEL_PLAN',
};

const REQUEST_TIMEOUT_MS = 180_000;

const registry = createProviderRegistry(providers);

function isProviderName(name: string): name is ProviderName {
  return Object.hasOwn(providers, name);
}

/** Parse "provider:model-id". Throws a readable error for bad input. */
export function parseModelSpec(spec: string): { provider: ProviderName; modelId: string } {
  const separator = spec.indexOf(':');
  const provider = spec.slice(0, separator).trim();
  const modelId = spec.slice(separator + 1).trim();
  if (separator === -1 || !provider || !modelId) {
    throw new Error(`Invalid model "${spec}". Use "<provider>:<model-id>", e.g. "anthropic:claude-opus-5-5".`);
  }
  if (!isProviderName(provider)) {
    const known = Object.keys(providers).join(', ');
    throw new Error(`Unknown AI provider "${provider}" in "${spec}". Supported: ${known}.`);
  }
  return { provider, modelId };
}

/** The model spec to use for a job: AI_MODEL_<JOB> if set, else AI_MODEL. */
export function modelSpecFor(job?: AiJob): string {
  const spec = (job && process.env[JOB_MODEL_ENV[job]]) || process.env.AI_MODEL;
  if (!spec) {
    throw new Error('AI_MODEL is not set. Add e.g. AI_MODEL=anthropic:claude-opus-5-5 to .env.');
  }
  return spec;
}

/**
 * Check every configured model spec is valid and has an API key.
 * Returns the specs in use; throws with a readable message otherwise.
 */
export function checkAiConfig(): string[] {
  const specs = new Set([modelSpecFor()]);
  for (const envName of Object.values(JOB_MODEL_ENV)) {
    const spec = process.env[envName];
    if (spec) specs.add(spec);
  }
  for (const spec of specs) {
    const { provider } = parseModelSpec(spec);
    const keyEnv = API_KEY_ENV[provider];
    if (!process.env[keyEnv]) {
      throw new Error(`${keyEnv} is not set, but "${spec}" uses the ${provider} provider.`);
    }
  }
  return [...specs];
}

function resolveModel(spec: string): LanguageModel {
  const { provider, modelId } = parseModelSpec(spec);
  return registry.languageModel(`${provider}:${modelId}`);
}

export interface GenerateStructuredOptions<T> {
  schema: FlexibleSchema<T>;
  system: string;
  prompt: string;
  /** Which AI_MODEL_<JOB> override to use. */
  job?: AiJob;
  /** Explicit "provider:model-id", overriding env config (used by dev scripts). */
  model?: string;
}

/**
 * Ask the model for output matching `schema`. If the response doesn't
 * validate, retry once with the validation error so the model can fix it.
 */
export async function generateStructured<T>(options: GenerateStructuredOptions<T>): Promise<T> {
  const { schema, system, prompt, job } = options;
  const model = resolveModel(options.model ?? modelSpecFor(job));
  const output = Output.object({ schema });
  const messages: ModelMessage[] = [{ role: 'user', content: prompt }];

  try {
    const result = await generateText({
      model,
      system,
      messages,
      output,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return result.output;
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;

    const reason = error.cause instanceof Error ? error.cause.message : error.message;
    if (error.text) messages.push({ role: 'assistant', content: error.text });
    messages.push({
      role: 'user',
      content: `That response did not match the required format: ${reason}\nRespond again with output that matches the schema exactly.`,
    });

    const result = await generateText({
      model,
      system,
      messages,
      output,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return result.output;
  }
}
