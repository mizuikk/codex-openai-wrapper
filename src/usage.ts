// src/usage.ts
// Utility to normalize upstream token usage payloads into OpenAI-compatible shape.
// Notes (English):
// - Maps input_tokens -> prompt_tokens, output_tokens -> completion_tokens
// - Prefers total_tokens when provided; otherwise sums prompt+completion
// - Passes through cache_creation_input_tokens and cache_read_input_tokens when numeric

export type NormalizedUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const prompt_tokens = numberOrZero(r["prompt_tokens"], r["input_tokens"]);
  const completion_tokens = numberOrZero(
    r["completion_tokens"],
    r["output_tokens"]
  );
  const total_tokens =
    typeof r["total_tokens"] === "number"
      ? (r["total_tokens"] as number)
      : prompt_tokens + completion_tokens;

  const cache_creation_input_tokens =
    typeof r["cache_creation_input_tokens"] === "number"
      ? (r["cache_creation_input_tokens"] as number)
      : undefined;
  const cache_read_input_tokens =
    typeof r["cache_read_input_tokens"] === "number"
      ? (r["cache_read_input_tokens"] as number)
      : undefined;

  return {
    prompt_tokens,
    completion_tokens,
    total_tokens,
    ...(cache_creation_input_tokens !== undefined
      ? { cache_creation_input_tokens }
      : {}),
    ...(cache_read_input_tokens !== undefined
      ? { cache_read_input_tokens }
      : {}),
  };
}

function numberOrZero(primary: unknown, fallback?: unknown): number {
  if (typeof primary === "number") return primary;
  if (typeof fallback === "number") return fallback;
  return 0;
}

