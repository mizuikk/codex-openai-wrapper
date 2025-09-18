import { normalizeModelName } from "./utils";
import { getRefreshedAuth, refreshAccessToken } from "./auth_kv"; // Updated import
import { getInstructionsForModel } from "./instructions";
import { Env, InputItem, Tool } from "./types"; // Import types
import { ensureSessionId } from "./session";

type ReasoningParam = {
	effort?: string;
	summary?: string;
};

type ToolChoice = "auto" | "none" | { type: string; function: { name: string } };

type OllamaPayload = Record<string, unknown>;

type ErrorBody = {
	error?: {
		message: string;
	};
	raw?: string;
	[key: string]: unknown;
};

// ChatMock uses an ensure_session_id() that prefers client-supplied id
// and otherwise maps a fingerprint to a random UUID. We implement the
// compatible behavior in src/session.ts and use it here.

// Helper for override-codex mode: manages only 'user-agent' and 'originator' headers.
// Values are sourced dynamically from incoming client request headers when available,
// otherwise optional environment variables may provide explicit values.
const CODEX_KEYS = new Set(["user-agent", "originator"]);

// Cache computed Codex UA/originator between requests.
let CODExCachedUA: { ua: string; originator: string } | null = null;

function sanitizeHeaderValue(value: string): string {
	try {
		// Allow visible ASCII 0x20..0x7E; replace others with underscore
		let out = "";
		for (const ch of value) {
			const code = ch.charCodeAt(0);
			out += code >= 0x20 && code <= 0x7e ? ch : "_";
		}
		return out;
	} catch {
		return value;
	}
}

function detectTerminalUA(env: Env): string {
	const tp = (env.TERM_PROGRAM || "").trim();
	const tpv = (env.TERM_PROGRAM_VERSION || "").trim();
	if (tp) return sanitizeHeaderValue(tpv ? `${tp}/${tpv}` : tp);
	const wz = (env.WEZTERM_VERSION || "").trim();
	if (wz) return sanitizeHeaderValue(`WezTerm/${wz}`);
	if ((env.KITTY_WINDOW_ID || "").trim() || (env.TERM || "").toLowerCase().includes("kitty")) return "kitty";
	if ((env.ALACRITTY_SOCKET || "").trim() || (env.TERM || "") === "alacritty") return "Alacritty";
	const kv = (env.KONSOLE_VERSION || "").trim();
	if (kv) return sanitizeHeaderValue(`Konsole/${kv}`);
	const vte = (env.VTE_VERSION || "").trim();
	if (vte) return sanitizeHeaderValue(`VTE/${vte}`);
	if ((env.WT_SESSION || "").trim()) return "WindowsTerminal";
	return sanitizeHeaderValue(env.TERM || "unknown");
}

type GitHubRelease = { name?: string; tag_name?: string };
type GitHubTag = { name: string };

async function fetchLatestCodexVersion(): Promise<string | null> {
	try {
		const res = await fetch("https://api.github.com/repos/openai/codex/releases/latest", {
			headers: {
				Accept: "application/vnd.github+json",
				// GitHub API recommends/asks for a User-Agent
				"User-Agent": "codex-openai-wrapper/override-codex"
			}
		});
		if (!res.ok) return null;
		const data = (await res.json()) as GitHubRelease;
		// Prefer the human-readable name; fallback to tag_name like "rust-v0.36.0"
		let v: string | undefined = data?.name;
		if (!v || typeof v !== "string" || !v.trim()) {
			const tag = (data?.tag_name as string) || "";
			v = tag.replace(/^rust-v/i, "").trim();
		}
		if (typeof v === "string" && v.trim()) return v.trim();
		return null;
	} catch {
		return null;
	}
}

function parseRustTagToVersion(name: string): string | null {
	const m = name.match(/^rust-v(\d+)\.(\d+)\.(\d+)$/i);
	if (!m) return null;
	return `${parseInt(m[1], 10)}.${parseInt(m[2], 10)}.${parseInt(m[3], 10)}`;
}

function cmpSemver(a: string, b: string): number {
	const pa = a.split(".").map((x) => parseInt(x, 10));
	const pb = b.split(".").map((x) => parseInt(x, 10));
	for (let i = 0; i < 3; i++) {
		const da = pa[i] || 0;
		const db = pb[i] || 0;
		if (da !== db) return da - db;
	}
	return 0;
}

// Combine two AbortSignals into one. If either aborts, the returned signal
// aborts. When both are undefined, returns undefined.
function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
	if (!a && !b) return undefined;
	if (a && !b) return a;
	if (!a && b) return b;
	const controller = new AbortController();
	const onAbortA = (reason?: any) => {
		try {
			controller.abort((a as any).reason ?? reason);
		} catch {
			controller.abort();
		}
		cleanup();
	};
	const onAbortB = (reason?: any) => {
		try {
			controller.abort((b as any).reason ?? reason);
		} catch {
			controller.abort();
		}
		cleanup();
	};
	const cleanup = () => {
		try {
			a?.removeEventListener("abort", onAbortA as any);
		} catch {}
		try {
			b?.removeEventListener("abort", onAbortB as any);
		} catch {}
	};
	try {
		a?.addEventListener("abort", onAbortA as any, { once: true });
	} catch {}
	try {
		b?.addEventListener("abort", onAbortB as any, { once: true });
	} catch {}
	if (a?.aborted) onAbortA();
	else if (b?.aborted) onAbortB();
	return controller.signal;
}

async function fetchLatestCodexVersionFromTags(): Promise<string | null> {
	try {
		const res = await fetch("https://api.github.com/repos/openai/codex/tags?per_page=100", {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "codex-openai-wrapper/override-codex"
			}
		});
		if (!res.ok) return null;
		const list = (await res.json()) as GitHubTag[];
		let best: string | null = null;
		for (const t of list) {
			const ver = parseRustTagToVersion(t.name);
			if (!ver) continue;
			if (!best || cmpSemver(ver, best) > 0) best = ver;
		}
		return best;
	} catch {
		return null;
	}
}

async function ensureCodexUA(env: Env, forwardedClientHeaders?: Headers): Promise<{ ua: string; originator: string }> {
	if (CODExCachedUA) return CODExCachedUA;

	// Originator: prefer new env var, fallback to old, then default.
	const originator =
		(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || env.FORWARD_CLIENT_HEADERS_CODEX_ORIGINATOR || "codex_cli_rs").trim() ||
		"codex_cli_rs";

	// Version: prefer env var, fallback to dynamic GitHub fetch.
	let version = (env.FORWARD_CLIENT_HEADERS_CODEX_VERSION || "").trim();
	if (!version) {
		version = (await fetchLatestCodexVersion()) || (await fetchLatestCodexVersionFromTags()) || "0.0.0";
	}

	// OS/Arch/Editor: prefer client hints/UA, fallback to env, then 'unknown'.
	const unquote = (s: string | null) => (s ? s.trim().replace(/^"|"$/g, "").trim() : null);

	let osType = unquote(forwardedClientHeaders?.get("sec-ch-ua-platform") || null);
	let osVer = unquote(forwardedClientHeaders?.get("sec-ch-ua-platform-version") || null);
	let arch = unquote(forwardedClientHeaders?.get("sec-ch-ua-arch") || null);
	let editorInfo: string | null = null;

	const clientUA = forwardedClientHeaders?.get("user-agent") || "";
	// Match "Code/1.91.1" or "vscode/1.104.0"
	const editorMatch = clientUA.match(/(vscode|Code)\/([^\s]+)/);
	if (editorMatch) {
		// Normalize to "vscode/version"
		editorInfo = `vscode/${editorMatch[2]}`;
	}
	// Fallback to environment variable if not detected
	if (!editorInfo) {
		editorInfo = (env.FORWARD_CLIENT_HEADERS_CODEX_EDITOR || "").trim() || null;
	}

	osType = osType || (env.FORWARD_CLIENT_HEADERS_CODEX_OS_TYPE || "unknown").trim() || "unknown";
	osVer = osVer || (env.FORWARD_CLIENT_HEADERS_CODEX_OS_VERSION || "unknown").trim() || "unknown";
	arch = arch || (env.FORWARD_CLIENT_HEADERS_CODEX_ARCH || "unknown").trim() || "unknown";

	const term = detectTerminalUA(env);

	// Final UA assembly, mirroring `codex-rs` format.
	let ua = `${originator}/${version} (${osType} ${osVer}; ${arch}) ${term}`;
	if (editorInfo) {
		ua = `${ua} (${editorInfo})`;
	}
	const finalUA = sanitizeHeaderValue(ua);

	// Only cache when version discovery succeeded (avoid pinning 0.0.0)
	if (version !== "0.0.0") {
		CODExCachedUA = { ua: finalUA, originator };
		return CODExCachedUA;
	}
	return { ua: finalUA, originator };
}

function isOverrideCodexMode(mode: string) {
	const m = (mode || "").toLowerCase();
	return m === "override-codex" || m === "override_codex";
}

export async function startUpstreamRequest(
	env: Env, // Pass the environment object
	model: string,
	inputItems: InputItem[],
	options?: {
		instructions?: string;
		tools?: Tool[];
		toolChoice?: ToolChoice;
		parallelToolCalls?: boolean;
		reasoningParam?: ReasoningParam;
		ollamaPath?: string; // Added for Ollama specific paths
		ollamaPayload?: OllamaPayload; // Added for Ollama specific payloads
		forwardedClientHeaders?: Headers; // Optional: original client headers for selective forwarding
		// NEW: Optional abort signal passed from the request lifecycle so we
		// can cancel the upstream fetch when the client disconnects.
		// (English) This ensures resources are released promptly under
		// client aborts and avoids upstream compute leakage.
		signal?: AbortSignal;
		// Optional timeout for upstream request (ms). When provided, a
		// composite signal will be used so either timeout or caller abort
		// cancels the fetch.
		timeoutMs?: number;
	}
): Promise<{ response: Response | null; error: Response | null }> {
	const { instructions, tools, toolChoice, parallelToolCalls, reasoningParam } = options || {};

	// Helper: format tools for upstream wire schema differences
	function formatToolsForUpstream(
		toolsIn: Tool[] | undefined,
		format: string | undefined
	): Array<Record<string, unknown>> {
		const arr = Array.isArray(toolsIn) ? toolsIn : [];
		// ChatMock sends tools in a "flat" schema by default.
		const mode = (format || "flat").toLowerCase();
		if (mode !== "flat") {
			// Default: OpenAI Responses style
			return arr as unknown as Array<Record<string, unknown>>;
		}
		// Flatten: { type: 'function', function: { name, description, parameters } }
		//   -> { type: 'function', name, description, parameters }
		const out: Array<Record<string, unknown>> = [];
		for (const t of arr) {
			try {
				if (!t || t.type !== "function") continue;
				const fn = (t as Tool).function as {
					name?: string;
					description?: string;
					parameters?: Record<string, unknown>;
				};
				if (!fn || typeof fn.name !== "string" || !fn.name) continue;
				out.push({
					type: "function",
					name: fn.name,
					...(fn.description ? { description: fn.description } : {}),
					...(fn.parameters ? { parameters: fn.parameters } : {})
				});
			} catch {}
		}
		return out;
	}

	// Helper: format tool_choice for flat schema if needed
	function formatToolChoiceForUpstream(
		choice: ToolChoice | undefined,
		format: string | undefined
	): ToolChoice | { type: string; name: string } | "auto" | "none" | undefined {
		const mode = (format || "flat").toLowerCase();
		if (!choice || mode !== "flat") return choice;
		if (typeof choice === "object" && (choice as any).type && (choice as any).function?.name) {
			return { type: (choice as any).type, name: (choice as any).function.name } as any;
		}
		return choice;
	}

	const { accessToken, accountId } = await getRefreshedAuth(env);

	// Determine request type and upstream auth mode early
	const isOllamaRequest = Boolean(options?.ollamaPath);
	const authMode = env.UPSTREAM_AUTH_MODE || "chatgpt_token";

	// In chatgpt_token mode, ChatGPT tokens are required (unless Ollama path)
	if (!isOllamaRequest && authMode === "chatgpt_token") {
		if (!accessToken || !accountId) {
			return {
				response: null,
				error: new Response(
					JSON.stringify({
						error: {
							message: "Missing ChatGPT credentials. Run 'codex login' first"
						}
					}),
					{ status: 401, headers: { "Content-Type": "application/json" } }
				)
			};
		}
	}

	const include: string[] = [];
	// ChatMock includes reasoning.encrypted_content whenever a reasoning param is present
	if (reasoningParam) {
		include.push("reasoning.encrypted_content");
	}

	// Resolve upstream URL
	let requestUrl: string;
	if (isOllamaRequest) {
		requestUrl = `${env.OLLAMA_API_URL}${options?.ollamaPath}`;
	} else if (env.UPSTREAM_RESPONSES_URL && env.UPSTREAM_RESPONSES_URL.trim()) {
		requestUrl = env.UPSTREAM_RESPONSES_URL.trim();
	} else if (env.UPSTREAM_BASE_URL && env.UPSTREAM_BASE_URL.trim()) {
		const base = env.UPSTREAM_BASE_URL.replace(/\/$/, "");
		const path = (env.UPSTREAM_WIRE_API_PATH && env.UPSTREAM_WIRE_API_PATH.trim()) || "/responses";
		requestUrl = `${base}${path.startsWith("/") ? path : `/${path}`}`;
	} else {
		requestUrl = env.CHATGPT_RESPONSES_URL;
	}

	// Prefer client-provided session id (X-Session-Id or session_id), else derive+cache
	let clientSessionId: string | undefined = undefined;
	try {
		const src = options?.forwardedClientHeaders;
		if (src) {
			clientSessionId = src.get("X-Session-Id") || src.get("x-session-id") || src.get("session_id") || undefined;
		}
	} catch {}
	const sessionId = isOllamaRequest ? undefined : ensureSessionId(instructions, inputItems, clientSessionId);

	const baseInstructions = await getInstructionsForModel(env, model);

	const requestBody = isOllamaRequest
		? JSON.stringify(options?.ollamaPayload)
		: JSON.stringify({
				model: normalizeModelName(model, env.DEBUG_MODEL),
				instructions: instructions || baseInstructions, // Use fetched instructions
				input: inputItems,
				tools: formatToolsForUpstream(tools, (env as any).UPSTREAM_TOOLS_FORMAT),
				tool_choice:
					(formatToolChoiceForUpstream(toolChoice, (env as any).UPSTREAM_TOOLS_FORMAT) &&
						(toolChoice === "auto" || toolChoice === "none" || typeof toolChoice === "object")) ||
					toolChoice === undefined
						? formatToolChoiceForUpstream(toolChoice, (env as any).UPSTREAM_TOOLS_FORMAT) || "auto"
						: "auto",
				parallel_tool_calls: parallelToolCalls || false,
				store: false,
				stream: true,
				include: include,
				prompt_cache_key: sessionId,
				...(reasoningParam && { reasoning: reasoningParam })
			});

	const headers: HeadersInit = {
		"Content-Type": "application/json"
	};

	// Client header forwarding module: forwards a subset of client headers to upstream
	// for fingerprint/feature transparency while preserving protocol-critical headers.
	(function applyClientHeaderForwarding() {
		const mode = (env.FORWARD_CLIENT_HEADERS_MODE || "off").toLowerCase();
		if (!options?.forwardedClientHeaders || mode === "off") return;

		// Log FORWARD_CLIENT_HEADERS_MODE configuration on first request to show active settings
		if (!(globalThis as any)._forwardClientHeadersModeLogged) {
			(globalThis as any)._forwardClientHeadersModeLogged = true;
			console.log(`[FORWARD_CLIENT_HEADERS_MODE] Mode: ${mode}`);

			if (mode === "safe") {
				console.log(
					"[FORWARD_CLIENT_HEADERS_MODE] Safe mode - forwarding allowlist headers: User-Agent, Accept-Language, sec-ch-*, X-Forwarded-*, CF-Connecting-IP"
				);
			} else if (mode === "list") {
				const headerList = env.FORWARD_CLIENT_HEADERS_LIST || "";
				console.log(`[FORWARD_CLIENT_HEADERS_MODE] List mode - forwarding headers: ${headerList}`);
			}
		}

		// Always treat header names as case-insensitive
		const RESERVED = new Set([
			"authorization",
			"content-type",
			"accept",
			"openai-beta",
			"chatgpt-account-id",
			"session_id"
		]);

		// Safe allowlist based on common client fingerprint headers
		const SAFE_DEFAULT = [
			"user-agent",
			"accept-language",
			"sec-ch-ua",
			"sec-ch-ua-mobile",
			"sec-ch-ua-platform",
			"sec-ch-ua-arch",
			"sec-ch-ua-model",
			"x-forwarded-for",
			"x-forwarded-proto",
			"x-forwarded-host",
			"cf-connecting-ip"
		];

		let passList: string[] = [];
		if (mode === "safe") {
			passList = SAFE_DEFAULT;
		} else if (mode === "list") {
			const raw = env.FORWARD_CLIENT_HEADERS_LIST || "";
			passList = raw
				.split(",")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean);
		}

		if (!passList.length) return;

		const src = options.forwardedClientHeaders;
		for (const name of passList) {
			if (RESERVED.has(name)) continue;
			const val = src.get(name);
			if (typeof val === "string" && val.length > 0) {
				(headers as Record<string, string>)[name] = val;
			}
		}

		// If X-Forwarded-For missing but cf-connecting-ip is present, synthesize it.
		if (!("x-forwarded-for" in (headers as Record<string, string>))) {
			const connectingIp = src.get("cf-connecting-ip") || src.get("x-real-ip");
			if (connectingIp) {
				(headers as Record<string, string>)["x-forwarded-for"] = connectingIp;
			}
		}
	})();

	// Header override module: applies final header overrides after authentication
	// and protocol headers are set. Authorization is never overridden to preserve
	// upstream authentication security.
	async function applyOverrideClientHeaders() {
		const rawMode = env.FORWARD_CLIENT_HEADERS_MODE || "off";
		const mode = rawMode.toLowerCase();

		let map: Record<string, unknown> | null = null;

		if (mode === "override") {
			try {
				if (env.FORWARD_CLIENT_HEADERS_OVERRIDE && env.FORWARD_CLIENT_HEADERS_OVERRIDE.trim()) {
					map = JSON.parse(env.FORWARD_CLIENT_HEADERS_OVERRIDE) as Record<string, unknown>;

					// Log override configuration on first request to display configured header values
					if (!(globalThis as any)._forwardClientHeadersOverrideLogged) {
						(globalThis as any)._forwardClientHeadersOverrideLogged = true;
						console.log("[FORWARD_CLIENT_HEADERS_MODE] Override mode - configured headers:");
						for (const [key, value] of Object.entries(map)) {
							console.log(`  - ${key}: ${value}`);
						}
					}
				}
			} catch (e) {
				console.warn("[header-override] Invalid JSON in FORWARD_CLIENT_HEADERS_OVERRIDE:", e);
				map = null;
			}
		} else if (isOverrideCodexMode(mode)) {
			// Build map only for user-agent and originator, derived from Codex project rules
			// and optionally overridden by FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX.
			const out: Record<string, string> = {};
			try {
				const derived = await ensureCodexUA(env, options?.forwardedClientHeaders);
				out["User-Agent"] = derived.ua;
				out["originator"] = derived.originator;

				// Log override-codex configuration on first request to display generated header values
				if (!(globalThis as any)._forwardClientHeadersCodexLogged) {
					(globalThis as any)._forwardClientHeadersCodexLogged = true;
					console.log("[FORWARD_CLIENT_HEADERS_MODE] Override-Codex mode - generated headers:");
					console.log(`  - User-Agent: ${derived.ua}`);
					console.log(`  - originator: ${derived.originator}`);

					// Log source information for debugging
					const hasEnvOverride =
						env.FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX && env.FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX.trim();
					if (hasEnvOverride) {
						console.log(
							"  - Note: Some values may be overridden by FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX environment variable"
						);
					}
				}
			} catch {}
			try {
				if (env.FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX && env.FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX.trim()) {
					const envMap = JSON.parse(env.FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX) as Record<string, unknown>;
					for (const [k, v] of Object.entries(envMap)) {
						const lk = k.toLowerCase();
						if (!CODEX_KEYS.has(lk)) continue;
						if (v == null) continue;
						const sv = String(v).trim();
						if (!sv) continue;
						if (lk === "user-agent") out["User-Agent"] = sv;
						else if (lk === "originator") out["originator"] = sv;
					}
				}
			} catch (e) {
				console.warn("[header-override] Invalid JSON in FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX:", e);
			}
			map = Object.keys(out).length ? (out as Record<string, unknown>) : null;
		} else {
			return; // not an override mode
		}

		if (!map) return;

		const lower = (s: string) => s.toLowerCase();
		const setCanonical = (name: string, value: string) => {
			const n = lower(name);
			let key = name;
			if (n === "accept") key = "Accept";
			else if (n === "content-type") key = "Content-Type";
			else if (n === "authorization") key = "Authorization";
			else if (n === "openai-beta") key = "OpenAI-Beta";
			else if (n === "chatgpt-account-id") key = "chatgpt-account-id";
			else if (n === "session_id") key = "session_id";
			(headers as Record<string, string>)[key] = value;
		};

		for (const [name, rawVal] of Object.entries(map)) {
			if (lower(name) === "authorization") continue; // hard-reserved
			if (rawVal == null) continue;
			const val = String(rawVal);
			if (val.length === 0) continue;
			setCanonical(name, val);
		}
	}

	if (!isOllamaRequest) {
		// Pre-validate API key in apikey_* modes for clearer errors
		if (authMode === "apikey_env") {
			if (!env.UPSTREAM_API_KEY || !env.UPSTREAM_API_KEY.trim()) {
				return {
					response: null,
					error: new Response(
						JSON.stringify({ error: { message: "Missing upstream API key (set UPSTREAM_API_KEY)" } }),
						{ status: 401, headers: { "Content-Type": "application/json" } }
					)
				};
			}
		}
		if (authMode === "apikey_auth_json") {
			try {
				const keyName = (env.UPSTREAM_AUTH_ENV_KEY || "OPENAI_API_KEY").trim();
				const authObj = env.OPENAI_CODEX_AUTH ? (JSON.parse(env.OPENAI_CODEX_AUTH) as Record<string, unknown>) : {};
				const maybeKey = authObj?.[keyName];
				if (typeof maybeKey !== "string" || !maybeKey.trim()) {
					return {
						response: null,
						error: new Response(
							JSON.stringify({
								error: { message: `Missing upstream API key in OPENAI_CODEX_AUTH at key '${keyName}'` }
							}),
							{ status: 401, headers: { "Content-Type": "application/json" } }
						)
					};
				}
			} catch {
				return {
					response: null,
					error: new Response(JSON.stringify({ error: { message: "Invalid OPENAI_CODEX_AUTH JSON" } }), {
						status: 400,
						headers: { "Content-Type": "application/json" }
					})
				};
			}
		}

		// Build upstream auth header according to mode
		const authHeaderName = (env.UPSTREAM_AUTH_HEADER || "Authorization").trim();
		const authScheme = (env.UPSTREAM_AUTH_SCHEME || "Bearer").trim();

		let sendAuth = "";
		if (authMode === "apikey_auth_json") {
			try {
				if (env.OPENAI_CODEX_AUTH) {
					const authObj = JSON.parse(env.OPENAI_CODEX_AUTH) as Record<string, unknown>;
					const keyName = (env.UPSTREAM_AUTH_ENV_KEY || "OPENAI_API_KEY").trim();
					const maybeKey = authObj?.[keyName];
					if (typeof maybeKey === "string" && maybeKey.trim()) {
						sendAuth = `${authScheme} ${maybeKey.trim()}`;
					}
				}
			} catch (e) {
				console.error("Failed parsing OPENAI_CODEX_AUTH for API key:", e);
			}
		} else if (authMode === "apikey_env") {
			if (typeof env.UPSTREAM_API_KEY === "string" && env.UPSTREAM_API_KEY.trim()) {
				sendAuth = `${authScheme} ${env.UPSTREAM_API_KEY.trim()}`;
			}
		} else {
			// default: chatgpt_token
			if (typeof accessToken === "string" && accessToken.trim()) {
				sendAuth = `${authScheme} ${accessToken.trim()}`;
			}
		}

		if (sendAuth) {
			(headers as Record<string, string>)[authHeaderName] = sendAuth;
		}

		// Keep protocol-critical header to ensure SSE behavior regardless of forwarding
		(headers as Record<string, string>)["Accept"] = "text/event-stream";
		if (accountId) {
			(headers as Record<string, string>)["chatgpt-account-id"] = accountId;
		}
		(headers as Record<string, string>)["OpenAI-Beta"] = "responses=experimental";
		if (sessionId) {
			(headers as Record<string, string>)["session_id"] = sessionId;
		}
	}

	// Apply final override, if configured
	await applyOverrideClientHeaders();

	// Build a composite AbortSignal if caller provided a signal and/or timeout
	let fetchSignal: AbortSignal | undefined = options?.signal;
	let timeoutController: AbortController | null = null;
	try {
		if (typeof options?.timeoutMs === "number" && options.timeoutMs > 0) {
			timeoutController = new AbortController();
			fetchSignal = combineAbortSignals(options?.signal, timeoutController.signal);
			// Fire timeout after the specified duration
			setTimeout(() => {
				try {
					timeoutController?.abort(new DOMException("Upstream timeout", "TimeoutError"));
				} catch {}
			}, options.timeoutMs);
		}
	} catch {}

	try {
		const upstreamResponse = await fetch(requestUrl, {
			method: "POST",
			headers: headers,
			body: requestBody,
			signal: fetchSignal
			// Cloudflare Workers fetch does not have a 'timeout' option like requests.
			// You might need to implement a custom timeout using AbortController if necessary.
		});

		// Response received

		if (!upstreamResponse.ok) {
			// Handle HTTP errors from upstream
			const errorBody = (await upstreamResponse
				.json()
				.catch(() => ({ raw: upstreamResponse.statusText }))) as ErrorBody;

			// Log complete error details for OpenAI failures
			console.error("=== OPENAI API ERROR ===");
			console.error("Status:", upstreamResponse.status, upstreamResponse.statusText);
			console.error("URL:", requestUrl);
			console.error("Headers:", Object.fromEntries(upstreamResponse.headers.entries()));
			console.error("Error Body:", JSON.stringify(errorBody, null, 2));
			console.error("Request Body:", requestBody);
			console.error("========================");

			// Check if it's a 401 Unauthorized and we can refresh the token
			if (
				upstreamResponse.status === 401 &&
				env.OPENAI_CODEX_AUTH &&
				(env.UPSTREAM_AUTH_MODE || "chatgpt_token") === "chatgpt_token"
			) {
				const refreshedTokens = await refreshAccessToken(env);
				if (refreshedTokens) {
					const headers: HeadersInit = {
						"Content-Type": "application/json"
					};

					if (!isOllamaRequest) {
						const authHeaderName = (env.UPSTREAM_AUTH_HEADER || "Authorization").trim();
						const authScheme = (env.UPSTREAM_AUTH_SCHEME || "Bearer").trim();
						headers[authHeaderName] = `${authScheme} ${refreshedTokens.access_token}`;
						headers["Accept"] = "text/event-stream";
						const acc = refreshedTokens.account_id || accountId;
						if (typeof acc === "string" && acc) {
							(headers as Record<string, string>)["chatgpt-account-id"] = acc;
						}
						headers["OpenAI-Beta"] = "responses=experimental";
						if (sessionId) {
							headers["session_id"] = sessionId;
						}
					}

					// Apply final override to retry headers as well (if configured)
					async function applyOverrideOnRetry() {
						const rawMode = env.FORWARD_CLIENT_HEADERS_MODE || "off";
						const mode = rawMode.toLowerCase();
						let map: Record<string, unknown> | null = null;
						try {
							if (mode === "override") {
								if (env.FORWARD_CLIENT_HEADERS_OVERRIDE && env.FORWARD_CLIENT_HEADERS_OVERRIDE.trim()) {
									map = JSON.parse(env.FORWARD_CLIENT_HEADERS_OVERRIDE) as Record<string, unknown>;
								}
							} else if (isOverrideCodexMode(mode)) {
								// Rebuild the same UA/originator map used in the first attempt (derived from Codex)
								const out: Record<string, string> = {};
								try {
									const derived = await ensureCodexUA(env, options?.forwardedClientHeaders);
									out["User-Agent"] = derived.ua;
									out["originator"] = derived.originator;
								} catch {}
								try {
									if (env.FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX && env.FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX.trim()) {
										const envMap = JSON.parse(env.FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX) as Record<string, unknown>;
										for (const [k, v] of Object.entries(envMap)) {
											const lk = k.toLowerCase();
											if (!CODEX_KEYS.has(lk)) continue;
											if (v == null) continue;
											const sv = String(v).trim();
											if (!sv) continue;
											if (lk === "user-agent") out["User-Agent"] = sv;
											else if (lk === "originator") out["originator"] = sv;
										}
									}
								} catch {}
								map = Object.keys(out).length ? (out as Record<string, unknown>) : null;
							} else {
								return;
							}
						} catch {}
						if (!map) return;
						const lower = (s: string) => s.toLowerCase();
						const setCanonical = (name: string, value: string) => {
							const n = lower(name);
							let key = name;
							if (n === "accept") key = "Accept";
							else if (n === "content-type") key = "Content-Type";
							else if (n === "authorization") key = "Authorization";
							else if (n === "openai-beta") key = "OpenAI-Beta";
							else if (n === "chatgpt-account-id") key = "chatgpt-account-id";
							else if (n === "session_id") key = "session_id";
							(headers as Record<string, string>)[key] = value;
						};
						for (const [name, rawVal] of Object.entries(map)) {
							if (lower(name) === "authorization") continue;
							if (rawVal == null) continue;
							const val = String(rawVal);
							if (val.length === 0) continue;
							setCanonical(name, val);
						}
					}

					// Apply final override to retry headers as well (if configured)
					await applyOverrideOnRetry();

					const retryResponse = await fetch(requestUrl, {
						method: "POST",
						headers: headers,
						body: requestBody,
						signal: fetchSignal
					});

					if (retryResponse.ok) {
						return { response: retryResponse, error: null };
					}
				}
			}

			return {
				response: null,
				error: new Response(
					JSON.stringify({
						error: {
							message: (errorBody.error && errorBody.error.message) || "Upstream error"
						}
					}),
					{ status: upstreamResponse.status, headers: { "Content-Type": "application/json" } }
				)
			};
		}

		return { response: upstreamResponse, error: null };
	} catch (e: unknown) {
		try {
			timeoutController?.abort();
		} catch {}
		// Log complete error details for fetch failures
		console.error("=== UPSTREAM REQUEST FAILURE ===");
		console.error("URL:", requestUrl);
		console.error("Request Body:", requestBody);
		console.error("Headers:", headers);
		console.error("Error:", e);
		if (e instanceof Error) {
			console.error("Error Message:", e.message);
			console.error("Error Stack:", e.stack);
		}
		console.error("================================");

		return {
			response: null,
			error: new Response(
				JSON.stringify({
					error: {
						message: `Upstream ChatGPT request failed: ${e instanceof Error ? e.message : String(e)}`
					}
				}),
				{ status: 502, headers: { "Content-Type": "application/json" } }
			)
		};
	}
}
