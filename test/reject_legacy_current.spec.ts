import { describe, it, expect } from 'vitest';
import { env as baseEnv, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import app from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('reject legacy/current compat modes', () => {
  it('400 when REASONING_COMPAT=legacy', async () => {
    // Bypass auth middleware by clearing OPENAI_API_KEY
    const env = { ...baseEnv, REASONING_COMPAT: 'legacy', OPENAI_API_KEY: 'test' } as any;
    const ctx = createExecutionContext();
    const req = new IncomingRequest('http://example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
      body: '{}',
    });
    const res = await app.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(String(json?.error?.message || '')).toContain('Use openai');
  });

  it('400 when REASONING_OUTPUT_MODE=current', async () => {
    // Bypass auth middleware by clearing OPENAI_API_KEY
    const env = { ...baseEnv, REASONING_OUTPUT_MODE: 'current', OPENAI_API_KEY: 'test' } as any;
    const ctx = createExecutionContext();
    const req = new IncomingRequest('http://example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
      body: '{}',
    });
    const res = await app.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(String(json?.error?.message || '')).toContain('Use openai');
  });
});
it('400 when REASONING_COMPAT=legacy on /v1/completions', async () => {
  const env = { ...baseEnv, REASONING_COMPAT: 'legacy', OPENAI_API_KEY: 'test' } as any;
  const ctx = createExecutionContext();
  const req = new IncomingRequest('http://example.com/v1/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
    body: JSON.stringify({ model: 'gpt-3.5-turbo-instruct', prompt: 'Hi' }),
  });
  const res = await app.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(400);
  const json = (await res.json()) as any;
  expect(String(json?.error?.message || '')).toContain('Use openai');
});
