import { describe, it, expect } from 'vitest';
import { applyReasoningToMessage, normalizeCompatMode } from '../src/reasoning';

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

describe('normalizeCompatMode', () => {
  it('normalizes hide to hidden', () => {
    expect(normalizeCompatMode('hide')).toBe('hidden');
    expect(normalizeCompatMode('HIDE')).toBe('hidden');
    expect(normalizeCompatMode('  hide  ')).toBe('hidden');
  });

  it('normalizes legacy to standard', () => {
    expect(normalizeCompatMode('legacy')).toBe('standard');
    expect(normalizeCompatMode('LEGACY')).toBe('standard');
    expect(normalizeCompatMode('  legacy  ')).toBe('standard');
  });

  it('normalizes current to standard', () => {
    expect(normalizeCompatMode('current')).toBe('standard');
    expect(normalizeCompatMode('CURRENT')).toBe('standard');
    expect(normalizeCompatMode('  current  ')).toBe('standard');
  });

  it('passes through known modes unchanged', () => {
    expect(normalizeCompatMode('hidden')).toBe('hidden');
    expect(normalizeCompatMode('standard')).toBe('standard');
    expect(normalizeCompatMode('tagged')).toBe('tagged');
    expect(normalizeCompatMode('r1')).toBe('r1');
    expect(normalizeCompatMode('o3')).toBe('o3');
  });

  it('handles case and whitespace for known modes', () => {
    expect(normalizeCompatMode('  TAGGED  ')).toBe('tagged');
    expect(normalizeCompatMode('Standard')).toBe('standard');
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

