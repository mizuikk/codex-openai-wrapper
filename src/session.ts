// ChatMock-compatible session id handling (English comments)
// - Accept a client-supplied session id via headers when present
// - Otherwise, derive a stable fingerprint from instructions + first user message
// - Map fingerprint -> random UUID (stable while the process lives), capped to 10k entries

import type { InputItem } from "./types";

type CanonMessage = {
	type: "message";
	role: "user";
	content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }>;
};

// In-memory LRU for fingerprint -> UUID
const FP_TO_UUID = new Map<string, string>();
const FP_ORDER: string[] = [];
const MAX_ENTRIES = 10_000;

function remember(fp: string, sid: string) {
	if (FP_TO_UUID.has(fp)) return;
	FP_TO_UUID.set(fp, sid);
	FP_ORDER.push(fp);
	if (FP_ORDER.length > MAX_ENTRIES) {
		const oldest = FP_ORDER.shift();
		if (oldest) FP_TO_UUID.delete(oldest);
	}
}

function canonicalizeFirstUserMessage(inputItems: InputItem[]): CanonMessage | null {
	for (const item of inputItems) {
		if (!item || item.type !== "message") continue;
		const role = item.role === "assistant" || item.role === "user" ? item.role : "user";
		if (role !== "user") continue;
		const content = Array.isArray(item.content) ? item.content : [];
		const norm: CanonMessage["content"] = [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const ptype = (part as any).type;
			if (ptype === "input_text") {
				const text = typeof (part as any).text === "string" ? (part as any).text : "";
				if (text) norm.push({ type: "input_text", text });
			} else if (ptype === "input_image") {
				// Support either string or { url }
				const img = (part as any).image_url;
				const url = typeof img === "string" ? img : img && typeof img.url === "string" ? img.url : undefined;
				if (url) norm.push({ type: "input_image", image_url: url });
			}
		}
		if (norm.length) return { type: "message", role: "user", content: norm };
	}
	return null;
}

function canonicalizePrefix(instructions: string | undefined, inputItems: InputItem[]): string {
	const prefix: Record<string, unknown> = {};
	const inst = typeof instructions === "string" ? instructions.trim() : "";
	if (inst) prefix.instructions = inst;
	const first = canonicalizeFirstUserMessage(inputItems);
	if (first) prefix.first_user_message = first;
	try {
		return JSON.stringify(prefix, Object.keys(prefix).sort());
	} catch {
		return "{}";
	}
}

export function ensureSessionId(
	instructions: string | undefined,
	inputItems: InputItem[],
	clientSupplied?: string | null
): string {
	const client = (clientSupplied || "").toString().trim();
	if (client) return client;
	const fp = crypto.subtle ? undefined : undefined; // keep typecheck happy; not used directly
	const canon = canonicalizePrefix(instructions, inputItems);
	// Use the canonical JSON string itself as the map key (equivalent to ChatMock's SHA keying)
	const key = canon;
	const existing = FP_TO_UUID.get(key);
	if (existing) return existing;
	const sid =
		typeof (crypto as any).randomUUID === "function"
			? (crypto as any).randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	remember(key, sid);
	return sid;
}
