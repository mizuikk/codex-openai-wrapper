import { Hono } from "hono";
import { Env, ToolDefinition, ToolChoice, ChatMessage } from "../types";
import { startUpstreamRequest } from "../upstream";
import { normalizeModelName, convertChatMessagesToResponsesInput, convertToolsChatToResponses } from "../utils";
import { buildReasoningParam, applyReasoningToMessage, extractReasoningFromModelName } from "../reasoning";
import { sseTranslateChat, sseTranslateText } from "../sse";
import { normalizeUsage } from "../usage";
import { getInstructionsForModel } from "../instructions";
import { openaiAuthMiddleware } from "../middleware/openaiAuthMiddleware";

const openai = new Hono<{ Bindings: Env }>();

openai.post("/v1/chat/completions", openaiAuthMiddleware(), async (c) => {
	const verbose = c.env.VERBOSE === "true";
	const reasoningEffort = c.env.REASONING_EFFORT || "low";
	const reasoningSummary = c.env.REASONING_SUMMARY || "auto";
	// Allow per-route override via context, fall back to env
	let reasoningCompat =
		((c as any).get("REASONING_OUTPUT_MODE_OVERRIDE") as string | undefined) ||
		((c.env as any).REASONING_OUTPUT_MODE as string | undefined) ||
		"openai";
	if (String(reasoningCompat).trim().toLowerCase() === "all") {
		// Default the root /v1 to openai when running in ALL mode
		reasoningCompat = "openai";
	}
	const debugModel = c.env.DEBUG_MODEL;

	// Upstream cancellation wiring: tie client request lifecycle to upstream fetch.
	// Notes (English): We create a dedicated AbortController for the upstream
	// request and abort it when the incoming client request aborts (e.g.,
	// browser tab closed or navigation). This prevents wasting compute on
	// long-running generations after the client has gone away.
	const upstreamAbort = new AbortController();
	try {
		c.req.raw.signal.addEventListener("abort", () => upstreamAbort.abort(), { once: true });
	} catch {}

	// Minimal request logging
	if (verbose) {
		console.log("POST /v1/chat/completions");
	}

	let payload: Record<string, unknown>;
	try {
		const raw = await c.req.text();
		if (!raw) {
			payload = {};
		} else {
			payload = JSON.parse(raw);
		}
	} catch {
		try {
			const raw = (await c.req.text()).replace(/\r/g, "").replace(/\n/g, "");
			payload = JSON.parse(raw);
		} catch {
			return c.json({ error: { message: "Invalid JSON body" } }, 400);
		}
	}

	const model = normalizeModelName(payload.model as string, debugModel);
	let messages = payload.messages;
	if (!messages && typeof payload.prompt === "string") {
		messages = [{ role: "user", content: payload.prompt }];
	}
	if (!messages && typeof payload.input === "string") {
		messages = [{ role: "user", content: payload.input }];
	}
	if (!messages) {
		messages = [];
	}
	if (!Array.isArray(messages)) {
		return c.json({ error: { message: "Request must include messages: []" } }, 400);
	}

	const sysIdx = messages.findIndex((m: unknown) => {
		if (typeof m === "object" && m !== null) {
			const msg = m as { role?: string };
			return msg.role === "system";
		}
		return false;
	});
	if (sysIdx !== -1) {
		const sysMsg = messages.splice(sysIdx, 1)[0]; // Get the first element of the spliced array
		const content = (typeof sysMsg === "object" && sysMsg !== null && sysMsg.content) || "";
		messages.unshift({ role: "user", content: content });
	}

	const isStream = Boolean(payload.stream);

	const toolsResponses = convertToolsChatToResponses(payload.tools as ToolDefinition[]);
	const toolChoice = (payload.tool_choice as ToolChoice) || "auto";
	const parallelToolCalls = Boolean(payload.parallel_tool_calls);

	const inputItems = convertChatMessagesToResponsesInput(messages as ChatMessage[]) || [];
	if (typeof payload.prompt === "string" && payload.prompt.trim()) {
		inputItems.push({ type: "message", role: "user", content: [{ type: "input_text", text: payload.prompt }] });
	}

	const modelReasoning = extractReasoningFromModelName(payload.model);
	const reasoningOverrides: { effort?: string; summary?: string } | undefined =
		(typeof payload.reasoning === "object" && payload.reasoning !== null
			? (payload.reasoning as { effort?: string; summary?: string })
			: undefined) || modelReasoning;
	const reasoningParam = buildReasoningParam(reasoningEffort, reasoningSummary, reasoningOverrides);

	// Auth check (minimal logging)
	if (verbose) {
		console.log("Authentication verified");
	}

	const instructions = await getInstructionsForModel(c.env, model);

	const { response: upstream, error: errorResp } = await startUpstreamRequest(c.env, model, inputItems, {
		instructions: instructions,
		tools: toolsResponses,
		toolChoice: toolChoice,
		parallelToolCalls: parallelToolCalls,
		reasoningParam: reasoningParam,
		forwardedClientHeaders: c.req.raw.headers,
		signal: upstreamAbort.signal
	});

	if (verbose) {
		console.log(
			`Upstream request: model=${model}, messages=${inputItems.length}, tools=${toolsResponses?.length || 0}`
		);
	}

	if (errorResp) {
		return errorResp;
	}

	if (!upstream) {
		return c.json({ error: { message: "Upstream request failed unexpectedly." } }, 500);
	}

	const created = Math.floor(Date.now() / 1000); // Unix timestamp

	if (isStream) {
		return new Response(await sseTranslateChat(upstream, model, created, verbose, reasoningCompat), {
			status: upstream.status,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				...c.res.headers // Include CORS headers from Hono middleware
			}
		});
	} else {
		let fullText = "";
		let reasoningSummaryText = "";
		let reasoningFullText = "";
		let responseId = "chatcmpl";
		let finalUsage: ReturnType<typeof normalizeUsage> | null = null;
		const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
		let errorMessage: string | null = null;

		// Non-streaming response handling (simplified, as full SSE parsing is complex)
		// This part would typically involve consuming the stream and aggregating the results
		// For a non-streaming response, the upstream would ideally return a single JSON object
		// For now, we'll simulate by just getting the full text if available.
		let rawAll = "";
		let sawDataPrefix = false;
		let completedEarly = false;
		try {
			const reader = upstream.body?.getReader();
			if (reader) {
				const decoder = new TextDecoder();
				let buffer = "";
				while (true) {
					// Stop reading if client aborted. Also cancel upstream to release resources.
					if (c.req.raw?.signal?.aborted) {
						try {
							await reader.cancel(new DOMException("Client aborted", "AbortError"));
						} catch {}
						try {
							await upstream.body?.cancel?.(new DOMException("Client aborted", "AbortError"));
						} catch {}
						break;
					}
					const { done, value } = await reader.read();
					if (done || completedEarly) break;
					const chunkStr = decoder.decode(value, { stream: true });
					buffer += chunkStr;
					rawAll += chunkStr;
					// Simple parsing for non-streaming, assuming full JSON per line or similar
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (line.startsWith("data: ")) {
							sawDataPrefix = true;
							const data = line.substring("data: ".length).trim();
							if (data === "[DONE]") break;
							try {
								const evt = JSON.parse(data);
								const kind = evt.type;
								if (evt.response && typeof evt.response.id === "string") {
									responseId = evt.response.id || responseId;
								}
								// Capture usage when available; prefer the one from response.completed
								try {
									const rawUsage = (evt.response && (evt.response as any).usage) || (evt as any).usage;
									const u = normalizeUsage(rawUsage);
									if (u && !finalUsage) finalUsage = u;
									if (u && kind === "response.completed") finalUsage = u;
								} catch {}
								if (kind === "response.output_text.delta") {
									fullText += evt.delta || "";
								} else if (kind === "response.reasoning_summary_text.delta") {
									reasoningSummaryText += evt.delta || "";
								} else if (kind === "response.reasoning_text.delta") {
									reasoningFullText += evt.delta || "";
								} else if (kind === "response.output_item.done") {
									const item = evt.item || {};
									if (item.type === "function_call") {
										const callId = item.call_id || item.id || "";
										const name = item.name || "";
										const args = item.arguments || "";
										if (typeof callId === "string" && typeof name === "string" && typeof args === "string") {
											toolCalls.push({
												id: callId,
												type: "function",
												function: { name: name, arguments: args }
											});
										}
									}
								} else if (kind === "response.failed") {
									errorMessage =
										(evt.response && evt.response.error && evt.response.error.message) || "response.failed";
								} else if (kind === "response.completed") {
									completedEarly = true;
								}
							} catch (parseError) {
								console.error("Error parsing non-streamed SSE data:", parseError);
							}
						}
					}
				}
			}
		} catch (streamError) {
			console.error("Error reading non-streamed upstream response:", streamError);
			errorMessage = `Error reading upstream response: ${streamError}`;
		}

		// Fallback: accept non-SSE single JSON body from upstream
		try {
			if (!sawDataPrefix && rawAll.trim()) {
				const parsed = JSON.parse(rawAll.trim());
				if (parsed && typeof parsed === "object") {
					try {
						if (typeof (parsed as any).id === "string") responseId = (parsed as any).id || responseId;
					} catch {}
					try {
						const u = normalizeUsage((parsed as any).usage || (parsed as any).response?.usage);
						if (u) finalUsage = u;
					} catch {}
					try {
						const maybeText =
							(parsed as any).output_text ??
							(parsed as any).text ??
							(parsed as any).message?.content ??
							(parsed as any).choices?.[0]?.message?.content ??
							(parsed as any).choices?.[0]?.text ??
							"";
						if (typeof maybeText === "string" && maybeText) fullText = fullText || maybeText;
					} catch {}
					try {
						const maybeToolCalls =
							(parsed as any).tool_calls ??
							(parsed as any).choices?.[0]?.message?.tool_calls ??
							[];
						if (Array.isArray(maybeToolCalls) && maybeToolCalls.length) {
							for (const tc of maybeToolCalls) {
								try {
									if (tc && tc.type === "function" && tc.function?.name) {
										toolCalls.push({
											id: String(tc.id || ""),
											type: "function",
											function: { name: String(tc.function.name), arguments: String(tc.function.arguments ?? "") }
										});
									}
								} catch {}
							}
						}
					} catch {}
				}
			}
		} catch {}
		if (errorMessage) {
			return c.json({ error: { message: errorMessage } }, 502);
		}

		let message: {
			role: string;
			content: string | null;
			tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
		} = { role: "assistant", content: fullText || null };
		if (toolCalls.length > 0) {
			message.tool_calls = toolCalls;
		}
		message = applyReasoningToMessage(message, reasoningSummaryText, reasoningFullText, reasoningCompat);

		const completion: any = {
			id: responseId || "chatcmpl",
			object: "chat.completion",
			created: created,
			model: model,
			choices: [
				{
					index: 0,
					message: message,
					finish_reason: "stop"
				}
			]
		};
		if (finalUsage) completion.usage = finalUsage;
		return new Response(JSON.stringify(completion), {
			status: upstream.status,
			headers: {
				"Content-Type": "application/json",
				...c.res.headers
			}
		});
	}
});

openai.post("/v1/completions", openaiAuthMiddleware(), async (c) => {
	const verbose = c.env.VERBOSE === "true";
	const debugModel = c.env.DEBUG_MODEL;
	const reasoningEffort = c.env.REASONING_EFFORT || "low";
	const reasoningSummary = c.env.REASONING_SUMMARY || "auto";

	// No legacy/current/standard handling (removed)

	// Minimal request logging
	if (verbose) {
		console.log("POST /v1/completions");
	}

	let payload: Record<string, unknown>;
	try {
		const raw = await c.req.text();
		if (!raw) {
			payload = {};
		} else {
			payload = JSON.parse(raw);
		}
	} catch {
		return c.json({ error: { message: "Invalid JSON body" } }, 400);
	}

	const model = normalizeModelName(payload.model as string, debugModel);
	let prompt = payload.prompt;
	if (Array.isArray(prompt)) {
		prompt = prompt.join("");
	}
	if (typeof prompt !== "string") {
		prompt = payload.suffix || "";
	}
	const streamReq = Boolean(payload.stream);

	const messages: ChatMessage[] = [{ role: "user", content: String(prompt || "") }];
	const inputItems = convertChatMessagesToResponsesInput(messages);

	const modelReasoning2 = extractReasoningFromModelName(payload.model);
	const reasoningOverrides2 =
		(typeof payload.reasoning === "object" && payload.reasoning !== null
			? (payload.reasoning as { effort?: string; summary?: string })
			: undefined) || modelReasoning2;
	const reasoningParam = buildReasoningParam(reasoningEffort, reasoningSummary, reasoningOverrides2);

	const instructions = await getInstructionsForModel(c.env, model);

	const { response: upstream, error: errorResp } = await startUpstreamRequest(c.env, model, inputItems, {
		instructions: instructions,
		reasoningParam: reasoningParam,
		forwardedClientHeaders: c.req.raw.headers,
		signal: ((): AbortSignal | undefined => {
			try {
				const ac = new AbortController();
				c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });
				return ac.signal;
			} catch {
				return undefined;
			}
		})()
	});

	if (errorResp) {
		if (verbose) {
			console.log("Upstream error response");
		}
		return errorResp;
	}

	if (!upstream) {
		if (verbose) {
			console.log("No upstream response received");
		}
		return c.json({ error: { message: "Upstream request failed unexpectedly." } }, 500);
	}

	if (verbose) {
		console.log(`Upstream response: ${upstream.status}`);
	}

	const created = Math.floor(Date.now() / 1000);

	if (streamReq) {
		return new Response(await sseTranslateText(upstream, model, created, verbose), {
			status: upstream.status,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				...c.res.headers
			}
		});
	} else {
		let fullText = "";
		let responseId = "cmpl";
		let finalUsage2: ReturnType<typeof normalizeUsage> | null = null;

		let rawAll = "";
		let sawDataPrefix = false;
		let completedEarly = false;
		try {
			const reader = upstream.body?.getReader();
			if (reader) {
				const decoder = new TextDecoder();
				let buffer = "";
				while (true) {
					if (c.req.raw?.signal?.aborted) {
						try {
							await reader.cancel(new DOMException("Client aborted", "AbortError"));
						} catch {}
						try {
							await upstream.body?.cancel?.(new DOMException("Client aborted", "AbortError"));
						} catch {}
						break;
					}
					const { done, value } = await reader.read();
					if (done || completedEarly) break;
					const chunkStr = decoder.decode(value, { stream: true });
					buffer += chunkStr;
					rawAll += chunkStr;

					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (line.startsWith("data: ")) {
							sawDataPrefix = true;
							const data = line.substring("data: ".length).trim();
							if (!data || data === "[DONE]") {
								if (data === "[DONE]") {
									// Final chunk for non-streaming completion
								}
								continue;
							}
							try {
								const evt = JSON.parse(data);
								if (evt.response && typeof evt.response.id === "string") {
									responseId = evt.response.id || responseId;
								}
								const kind = evt.type;
								// Capture usage when available; prefer the one from response.completed
								try {
									const rawUsage = (evt.response && (evt.response as any).usage) || (evt as any).usage;
									const u = normalizeUsage(rawUsage);
									if (u && !finalUsage2) finalUsage2 = u;
									if (u && kind === "response.completed") finalUsage2 = u;
								} catch {}
								if (kind === "response.output_text.delta") {
									fullText += evt.delta || "";
								} else if (kind === "response.completed") {
									completedEarly = true;
								}
							} catch (parseError) {
								console.error("Error parsing non-streamed SSE data:", parseError);
							}
						}
					}
				}
			}
		} catch (streamError) {
			console.error("Error reading non-streamed upstream response:", streamError);
			return c.json({ error: { message: `Error reading upstream response: ${streamError}` } }, 502);
		}

		// Fallback: accept non-SSE single JSON body from upstream (text completions)
		try {
			if (!sawDataPrefix && rawAll.trim()) {
				const parsed2 = JSON.parse(rawAll.trim());
				if (parsed2 && typeof parsed2 === "object") {
					try {
						if (typeof (parsed2 as any).id === "string") responseId = (parsed2 as any).id || responseId;
					} catch {}
					try {
						const u2 = normalizeUsage((parsed2 as any).usage || (parsed2 as any).response?.usage);
						if (u2) finalUsage2 = u2;
					} catch {}
					try {
						const maybeText2 =
							(parsed2 as any).output_text ??
							(parsed2 as any).text ??
							(parsed2 as any).choices?.[0]?.text ??
							(parsed2 as any).choices?.[0]?.message?.content ??
							"";
						if (typeof maybeText2 === "string" && maybeText2) fullText = fullText || maybeText2;
					} catch {}
				}
			}
		} catch {}
		const completion: any = {
			id: responseId || "cmpl",
			object: "text_completion",
			created: created,
			model: model,
			choices: [{ index: 0, text: fullText, finish_reason: "stop", logprobs: null }]
		};
		if (finalUsage2) completion.usage = finalUsage2;
		return new Response(JSON.stringify(completion), {
			status: upstream.status,
			headers: {
				"Content-Type": "application/json",
				...c.res.headers
			}
		});
	}
});

// Helper to parse EXPOSE_MODELS from env (CSV or JSON array)
function parseExposeModels(input: string | undefined, fallback: string[]): string[] {
	if (typeof input !== "string" || !input.trim()) return fallback;
	const raw = input.trim();
	try {
		const arr = JSON.parse(raw);
		if (Array.isArray(arr)) {
			return arr.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
		}
	} catch {
		// not JSON, try CSV / whitespace separated
	}
	return raw
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

openai.get("/v1/models", (c) => {
	// Default set mirrors built-in support and aliases
	const defaults = ["gpt-5", "gpt-5-latest", "gpt-5-codex", "gpt-5-codex-latest", "codex-mini-latest"];
	const ids = parseExposeModels(c.env.EXPOSE_MODELS, defaults);
	const data = ids.map((id) => ({ id, object: "model", owned_by: "openai-codex" }));
	return c.json({ object: "list", data });
});

export default openai;
