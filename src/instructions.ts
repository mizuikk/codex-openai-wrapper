// ChatMock-compatible instructions selection (English comments)
// We load prompts from the ChatMock repository to ensure identical behavior.
// - Base: prompt.md
// - GPT-5 Codex: prompt_gpt5_codex.md
// We cache results in-module to avoid repeated fetches, and fall back to
// embedded copies if network fetch fails.

import { normalizeModelName } from "./utils";
import type { Env } from "./types";
import { CHATMOCK_PROMPT_BASE_B64, CHATMOCK_PROMPT_CODEX_B64 } from "./prompts";

// Default online sources: OpenAI official codex repo
const DEFAULT_BASE_URL = "https://raw.githubusercontent.com/RayBytes/ChatMock/main/prompt.md";
const DEFAULT_CODEX_URL = "https://raw.githubusercontent.com/RayBytes/ChatMock/main/prompt_gpt5_codex.md";

let BASE_CACHE: string | null = null;
let CODEX_CACHE: string | null = null;
let BASE_CACHE_KEY: string | null = null;
let CODEX_CACHE_KEY: string | null = null;

function b64ToUtf8(b64: string): string {
	try {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		// As a last resort, return minimal text
		return "You are Codex in the CLI.";
	}
}

const FALLBACK_BASE = b64ToUtf8(CHATMOCK_PROMPT_BASE_B64);
const FALLBACK_CODEX = b64ToUtf8(CHATMOCK_PROMPT_CODEX_B64);

async function fetchText(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, { method: "GET" });
		if (!res.ok) return null;
		return await res.text();
	} catch (e) {
		console.warn("[instructions] fetch failed:", url, e);
		return null;
	}
}

export async function getBaseInstructions(env?: Env): Promise<string> {
	const url = (env?.INSTRUCTIONS_BASE_URL && env.INSTRUCTIONS_BASE_URL.trim()) || DEFAULT_BASE_URL;
	const key = url;
	if (BASE_CACHE && BASE_CACHE_KEY === key) return BASE_CACHE;
	const txt = await fetchText(url);
	BASE_CACHE = typeof txt === "string" && txt.trim() ? txt : FALLBACK_BASE;
	BASE_CACHE_KEY = key;
	return BASE_CACHE;
}

export async function getGpt5CodexInstructions(env?: Env): Promise<string> {
	const url = (env?.INSTRUCTIONS_CODEX_URL && env.INSTRUCTIONS_CODEX_URL.trim()) || DEFAULT_CODEX_URL;
	const key = url;
	if (CODEX_CACHE && CODEX_CACHE_KEY === key) return CODEX_CACHE;
	const txt = await fetchText(url);
	CODEX_CACHE = typeof txt === "string" && txt.trim() ? txt : FALLBACK_CODEX;
	CODEX_CACHE_KEY = key;
	return CODEX_CACHE;
}

export async function getInstructionsForModel(env: Env, model: string | null | undefined): Promise<string> {
	const m = normalizeModelName(model || "", env?.DEBUG_MODEL);
	if (m === "gpt-5-codex") return await getGpt5CodexInstructions(env);
	return await getBaseInstructions(env);
}
