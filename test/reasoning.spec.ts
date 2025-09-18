import { describe, it, expect } from 'vitest';
import { applyReasoningToMessage, normalizeCompatMode } from '../src/reasoning';

describe('applyReasoningToMessage', () => {
  const baseMsg = { role: 'assistant', content: 'Hello' } as any;

  it('applies tagged content by default', () => {
    const out = applyReasoningToMessage({ ...baseMsg }, 'S', 'F', 'unknown');
    expect(typeof out.content).toBe('string');
    expect(out.content!.startsWith('<think>S\n\nF</think>')).toBe(true);
  });

  it('applies openai mode (reasoning_content)', () => {
    const out = applyReasoningToMessage({ ...baseMsg }, 'S', 'F', 'openai') as any;
    expect(out.content).toBe('Hello');
    expect(typeof out.reasoning_content).toBe('string');
    expect(out.reasoning_content).toBe('S\n\nF');
  });

  it('applies o3 mode (structured content)', () => {
    const out = applyReasoningToMessage({ ...baseMsg }, 'S', 'F', 'o3') as any;
    expect(out.reasoning).toBeTruthy();
    expect(out.reasoning.content[0].type).toBe('text');
    expect(out.reasoning.content[0].text).toBe('S\n\nF');
  });

  it('normalizes case/whitespace for compat', () => {
    const out = applyReasoningToMessage({ ...baseMsg }, 'S', 'F', '  OPENAI  ') as any;
    expect(out.reasoning_content).toBe('S\n\nF');
  });
});

describe('normalizeCompatMode', () => {
  it('treats hide as unknown (falls back to tagged)', () => {
    expect(normalizeCompatMode('hide')).toBe('tagged');
    expect(normalizeCompatMode('HIDE')).toBe('tagged');
    expect(normalizeCompatMode('  hide  ')).toBe('tagged');
  });

  
  
  it('passes through known modes unchanged', () => {
    expect(normalizeCompatMode('hidden')).toBe('hidden');
    expect(normalizeCompatMode('openai')).toBe('openai');
    expect(normalizeCompatMode('tagged')).toBe('tagged');
    expect(normalizeCompatMode('r1')).toBe('r1');
    expect(normalizeCompatMode('o3')).toBe('o3');
  });

  it('handles case and whitespace for known modes', () => {
    expect(normalizeCompatMode('  TAGGED  ')).toBe('tagged');
    expect(normalizeCompatMode('OpenAI')).toBe('openai');
    expect(normalizeCompatMode('R1')).toBe('r1');
    expect(normalizeCompatMode('O3')).toBe('o3');
  });

  it('defaults to tagged for unknown modes', () => {
    expect(normalizeCompatMode('unknown')).toBe('tagged');
    expect(normalizeCompatMode('')).toBe('tagged');
    expect(normalizeCompatMode('  ')).toBe('tagged');
  });

  it('handles undefined/null gracefully', () => {
    expect(normalizeCompatMode(undefined as any)).toBe('tagged');
    expect(normalizeCompatMode(null as any)).toBe('tagged');
  });
});

