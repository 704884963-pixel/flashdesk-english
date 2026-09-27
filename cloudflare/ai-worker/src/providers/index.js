import { createZhipuProvider } from './zhipu.js';

export function createProvider(env, fetchImpl) {
  if (env.AI_PROVIDER === 'zhipu') return createZhipuProvider(env, fetchImpl);
  throw new Error('unsupported provider');
}
