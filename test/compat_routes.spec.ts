import { describe, it, expect } from 'vitest';
import { env as baseEnv, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import app from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('compat route mounting', () => {
  it('serves /tagged/v1/models when REASONING_OUTPUT_MODE=all', async () => {
    const env = { ...baseEnv, REASONING_OUTPUT_MODE: 'all' } as any;
    const ctx = createExecutionContext();
    const req = new IncomingRequest('http://example.com/tagged/v1/models');
    const res = await app.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('object', 'list');
  });

  it('404 for /tagged/v1/models when REASONING_OUTPUT_MODE!=all', async () => {
    const env = { ...baseEnv, REASONING_OUTPUT_MODE: 'tagged' } as any;
    const ctx = createExecutionContext();
    const req = new IncomingRequest('http://example.com/tagged/v1/models');
    const res = await app.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });
});
