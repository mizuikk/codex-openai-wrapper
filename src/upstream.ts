import { normalizeModelName } from "./utils";
import { getEffectiveChatgptAuth } from "./auth_kv"; // Corrected import path
import { getBaseInstructions } from "./instructions";
import { Env, InputItem, Tool } from "./types"; // Import types

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

async function generateSessionId(instructions: string | undefined, inputItems: InputItem[]): Promise<string> {
	const content = `${instructions || ""}|${JSON.stringify(inputItems)}`;
	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
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
	}
): Promise<{ response: Response | null; error: Response | null }> {
	const { instructions, tools, toolChoice, parallelToolCalls, reasoningParam } = options || {};

	const { accessToken, accountId } = await getEffectiveChatgptAuth(env);

	if (!accessToken || !accountId) {
		return {
			response: null,
			error: new Response(
				JSON.stringify({
					error: {
						message: "Missing ChatGPT credentials. Run 'python3 chatmock.py login' first (and upload to KV)."
					}
				}),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			)
		};
	}

	const include: string[] = [];
	if (reasoningParam?.effort !== "none") {
		include.push("reasoning.encrypted_content");
	}

	const isOllamaRequest = Boolean(options?.ollamaPath);
	const requestUrl = isOllamaRequest
		? `${env.OLLAMA_API_URL}${options?.ollamaPath}` // Assuming OLLAMA_API_URL is in Env
		: env.CHATGPT_RESPONSES_URL;

	const sessionId = isOllamaRequest ? undefined : await generateSessionId(instructions, inputItems);

	const baseInstructions = await getBaseInstructions();

	const requestBody = isOllamaRequest
		? JSON.stringify(options?.ollamaPayload)
		: JSON.stringify({
				model: normalizeModelName(model, env.DEBUG_MODEL),
				instructions: instructions || baseInstructions, // Use fetched instructions
				input: inputItems,
				tools: tools || [],
				tool_choice:
					(toolChoice && (toolChoice === "auto" || toolChoice === "none" || typeof toolChoice === "object")) ||
					toolChoice === undefined
						? toolChoice || "auto"
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

	if (!isOllamaRequest) {
		headers["Authorization"] = `Bearer ${accessToken}`;
		headers["Accept"] = "text/event-stream";
		headers["chatgpt-account-id"] = accountId;
		headers["OpenAI-Beta"] = "responses=experimental";
		// Add session ID for caching (matching Python implementation)
		if (sessionId) {
			headers["session_id"] = sessionId;
		}
	}

	try {
		// Debug logging
		console.log("=== UPSTREAM REQUEST DEBUG ===");
		console.log("Request URL:", requestUrl);
		console.log("Request headers:", headers);
		console.log("Request body:", requestBody);
		console.log("Is Ollama request:", isOllamaRequest);

		const upstreamResponse = await fetch(requestUrl, {
			method: "POST",
			headers: headers,
			body: requestBody
			// Cloudflare Workers fetch does not have a 'timeout' option like requests.
			// You might need to implement a custom timeout using AbortController if necessary.
		});

		console.log("=== UPSTREAM RESPONSE DEBUG ===");
		console.log("Response status:", upstreamResponse.status);
		console.log("Response statusText:", upstreamResponse.statusText);
		console.log("Response headers:", Object.fromEntries(upstreamResponse.headers.entries()));

		if (!upstreamResponse.ok) {
			// Handle HTTP errors from upstream
			const errorBody = (await upstreamResponse
				.json()
				.catch(() => ({ raw: upstreamResponse.statusText }))) as ErrorBody;
			console.log("=== UPSTREAM ERROR DEBUG ===");
			console.log("Error status:", upstreamResponse.status);
			console.log("Error body:", errorBody);
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
