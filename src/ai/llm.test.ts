import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAiConfig, modelSpecFor, parseModelSpec } from './llm.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Stub env vars for one test; '' clears a variable that may be set in the shell. */
function stubEnv(vars: Record<string, string>) {
  const defaults = {
    AI_MODEL: '',
    AI_MODEL_EXTRACT: '',
    AI_MODEL_PLAN: '',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    GOOGLE_GENERATIVE_AI_API_KEY: '',
  };
  for (const [name, value] of Object.entries({ ...defaults, ...vars })) vi.stubEnv(name, value);
}

describe('parseModelSpec', () => {
  it('splits provider and model id', () => {
    expect(parseModelSpec('anthropic:claude-opus-5-5')).toEqual({ provider: 'anthropic', modelId: 'claude-opus-5-5' });
    expect(parseModelSpec('openai:ft:gpt-x:org')).toEqual({ provider: 'openai', modelId: 'ft:gpt-x:org' });
  });
  it('rejects a missing provider or unknown provider', () => {
    expect(() => parseModelSpec('claude-opus-5-5')).toThrow(/provider>:<model-id/);
    expect(() => parseModelSpec('mistral:large')).toThrow(/Unknown AI provider "mistral"/);
  });
});

describe('modelSpecFor', () => {
  it('uses the per-job override when set, else AI_MODEL', () => {
    stubEnv({ AI_MODEL: 'openai:a', AI_MODEL_EXTRACT: 'google:b' });
    expect(modelSpecFor('extract')).toBe('google:b');
    expect(modelSpecFor('plan')).toBe('openai:a');
    expect(modelSpecFor()).toBe('openai:a');
  });
  it('throws when AI_MODEL is missing', () => {
    stubEnv({});
    expect(() => modelSpecFor()).toThrow(/AI_MODEL is not set/);
  });
});

describe('checkAiConfig', () => {
  it('passes when every configured provider has a key', () => {
    stubEnv({ AI_MODEL: 'openai:a', AI_MODEL_EXTRACT: 'anthropic:b', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' });
    expect(checkAiConfig()).toEqual(['openai:a', 'anthropic:b']);
  });
  it('names the missing key', () => {
    stubEnv({ AI_MODEL: 'openai:a', AI_MODEL_PLAN: 'google:c', OPENAI_API_KEY: 'x' });
    expect(() => checkAiConfig()).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY is not set/);
  });
});
