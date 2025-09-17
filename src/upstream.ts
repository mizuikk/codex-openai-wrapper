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

	// Optionally forward a subset of client headers to the upstream for
	// fingerprint/feature transparency, without compromising protocol headers.
		(function applyClientHeaderForwarding() {
			const mode = (env.FORWARD_CLIENT_HEADERS_MODE || "off").toLowerCase();
			if (!options?.forwardedClientHeaders || mode === "off") return;

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

    // After setting authentication and protocol headers, optionally override
	// final headers from the client using a configured list. Authorization
	// is never overridden to avoid breaking upstream auth.
function applyOverrideClientHeaders() {
		const mode = (env.FORWARD_CLIENT_HEADERS_MODE || "off").toLowerCase();
		if (mode !== "override") return;
		let map: Record<string, unknown> | null = null;
		try {
			if (env.FORWARD_CLIENT_HEADERS_OVERRIDE && env.FORWARD_CLIENT_HEADERS_OVERRIDE.trim()) {
				map = JSON.parse(env.FORWARD_CLIENT_HEADERS_OVERRIDE) as Record<string, unknown>;
			}
		} catch (e) {
			console.warn("[header-override] Invalid JSON in FORWARD_CLIENT_HEADERS_OVERRIDE:", e);
			map = null;
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
			if (lower(name) === "accept" && val.toLowerCase() !== "text/event-stream") {
				console.warn("[header-override] Accept changed; SSE behavior may differ:", val);
			}
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
							JSON.stringify({ error: { message: `Missing upstream API key in OPENAI_CODEX_AUTH at key '${keyName}'` } }),
							{ status: 401, headers: { "Content-Type": "application/json" } }
						)
					};
				}
			} catch (e) {
				return {
					response: null,
					error: new Response(
						JSON.stringify({ error: { message: "Invalid OPENAI_CODEX_AUTH JSON" } }),
						{ status: 400, headers: { "Content-Type": "application/json" } }
					)
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
	applyOverrideClientHeaders();

	try {
		const upstreamResponse = await fetch(requestUrl, {
			method: "POST",
			headers: headers,
			body: requestBody
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
			if (upstreamResponse.status === 401 && env.OPENAI_CODEX_AUTH && (env.UPSTREAM_AUTH_MODE || "chatgpt_token") === "chatgpt_token") {
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
(function applyOverrideOnRetry() {
						const mode = (env.FORWARD_CLIENT_HEADERS_MODE || "off").toLowerCase();
						if (mode !== "override") return;
						let map: Record<string, unknown> | null = null;
						try {
							if (env.FORWARD_CLIENT_HEADERS_OVERRIDE && env.FORWARD_CLIENT_HEADERS_OVERRIDE.trim()) {
								map = JSON.parse(env.FORWARD_CLIENT_HEADERS_OVERRIDE) as Record<string, unknown>;
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
					})();

					const retryResponse = await fetch(requestUrl, {
						method: "POST",
						headers: headers,
						body: requestBody
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
