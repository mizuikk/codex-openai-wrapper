import { describe, it, expect } from 'vitest';
import { applyReasoningToMessage } from '../src/reasoning';

describe('applyReasoningToMessage', () => {
  const baseMsg = { role: 'assistant', content: 'Hello' } as any;

  it('applies tagged content by default', () => {
    const out = applyReasoningToMessage({ ...baseMsg }, 'S', 'F', 'unknown');
    expect(typeof out.content).toBe('string');
    expect(out.content!.startsWith('<think>S\n\nF</think>')).toBe(true);
  });

  it('applies standard mode (strings)', () => {
    const out = applyReasoningToMessage({ ...baseMsg }, 'S', 'F', 'standard');
    expect(out.reasoning_summary).toBe('S');
    expect(out.reasoning).toBe('F');
    expect(out.content).toBe('Hello');
  });

  it('applies o3 mode (structured content)', () => {
    const out = applyReasoningToMessage({ ...baseMsg }, 'S', 'F', 'o3') as any;
    expect(out.reasoning).toBeTruthy();
    expect(out.reasoning.content[0].type).toBe('text');
    expect(out.reasoning.content[0].text).toBe('S\n\nF');
  });

  it('normalizes case/whitespace for compat', () => {
    const out = applyReasoningToMessage({ ...baseMsg }, 'S', 'F', '  STANDARD  ');
    expect(out.reasoning_summary).toBe('S');
    expect(out.reasoning).toBe('F');
  });
});

