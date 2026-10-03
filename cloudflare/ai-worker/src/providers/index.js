import { createZhipuProvider } from './zhipu.js';
import { createGeminiProvider, DEFAULT_GEMINI_MODEL } from './gemini.js';

export const DEFAULT_AI_PROVIDER = 'zhipu';
export const AI_PROVIDERS = new Set(['zhipu', 'gemini']);

export function normalizeProvider(value) {
  return AI_PROVIDERS.has(value) ? value : DEFAULT_AI_PROVIDER;
}

export function providerModel(providerName, env) {
  return normalizeProvider(providerName) === 'gemini'
    ? (env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL)
    : env.AI_MODEL;
}

export function createProvider(providerName, env, fetchImpl) {
  if (normalizeProvider(providerName) === 'gemini') return createGeminiProvider(env, fetchImpl);
  return createZhipuProvider(env, fetchImpl);
}
