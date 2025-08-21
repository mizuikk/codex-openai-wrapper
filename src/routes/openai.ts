import { Hono } from "hono";
import { Env } from "../types";
import { startUpstreamRequest } from "../upstream";
import { normalizeModelName, convertChatMessagesToResponsesInput, convertToolsChatToResponses } from "../utils";
import { buildReasoningParam, applyReasoningToMessage } from "../reasoning";
import { sseTranslateChat, sseTranslateText } from "../sse";
import { getBaseInstructions } from "../instructions";

const openai = new Hono<{ Bindings: Env }>();

openai.post("/v1/chat/completions", async (c) => {
	const verbose = c.env.VERBOSE === "true"; // Assuming VERBOSE is a string in Env
	const reasoningEffort = c.env.REASONING_EFFORT || "minimal";
	const reasoningSummary = c.env.REASONING_SUMMARY || "auto";
	const reasoningCompat = c.env.REASONING_COMPAT || "think-tags";
	const debugModel = c.env.DEBUG_MODEL;

	// Verbose logging like Python version
	if (verbose) {
		try {
			const bodyPreview = (await c.req.text()).substring(0, 2000);
			console.log("IN POST /v1/chat/completions\n" + bodyPreview);
		} catch (e) {
			// Ignore logging errors
		}
	}

	let payload: any;
	try {
		const raw = await c.req.text();
		if (!raw) {
			payload = {};
		} else {
			payload = JSON.parse(raw);
		}
	} catch (e) {
		try {
			const raw = (await c.req.text()).replace(/\r/g, "").replace(/\n/g, "");
			payload = JSON.parse(raw);
		} catch (e2) {
			return c.json({ error: { message: "Invalid JSON body" } }, 400);
		}
	}

	const model = normalizeModelName(payload.model, debugModel);
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

	const sysIdx = messages.findIndex((m: any) => typeof m === "object" && m !== null && m.role === "system");
	if (sysIdx !== -1) {
		const sysMsg = messages.splice(sysIdx, 1)[0]; // Get the first element of the spliced array
		const content = (typeof sysMsg === "object" && sysMsg !== null && sysMsg.content) || "";
		messages.unshift({ role: "user", content: content });
	}

	const isStream = Boolean(payload.stream);

	const toolsResponses = convertToolsChatToResponses(payload.tools);
	const toolChoice = payload.tool_choice || "auto";
	const parallelToolCalls = Boolean(payload.parallel_tool_calls);

	const inputItems: any[] = convertChatMessagesToResponsesInput(messages) || []; // Initialize as array
	if (typeof payload.prompt === "string" && payload.prompt.trim()) {
		inputItems.push({ type: "message", role: "user", content: [{ type: "input_text", text: payload.prompt }] });
	}

	const reasoningOverrides = typeof payload.reasoning === "object" ? payload.reasoning : undefined;
	const reasoningParam = buildReasoningParam(reasoningEffort, reasoningSummary, reasoningOverrides);

	// Debug authentication
	if (verbose) {
		console.log("=== AUTHENTICATION DEBUG ===");
		const auth = await import("../auth_kv").then((m) => m.getEffectiveChatgptAuth(c.env));
		console.log("Auth result:", auth);
	}

	const instructions = await getBaseInstructions();

	const { response: upstream, error: errorResp } = await startUpstreamRequest(c.env, model, inputItems, {
		instructions: instructions,
		tools: toolsResponses,
		toolChoice: toolChoice,
		parallelToolCalls: parallelToolCalls,
		reasoningParam: reasoningParam
	});

	if (verbose) {
		console.log("=== UPSTREAM REQUEST DEBUG ===");
		console.log("Model:", model);
		console.log("Input items:", JSON.stringify(inputItems, null, 2));
		console.log("Instructions length:", instructions.length);
		console.log("Tools:", toolsResponses);
		console.log("Tool choice:", toolChoice);
		console.log("Parallel tool calls:", parallelToolCalls);
		console.log("Reasoning param:", reasoningParam);
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
		const toolCalls: any[] = [];
		let errorMessage: string | null = null;

		// Non-streaming response handling (simplified, as full SSE parsing is complex)
		// This part would typically involve consuming the stream and aggregating the results
		// For a non-streaming response, the upstream would ideally return a single JSON object
		// For now, we'll simulate by just getting the full text if available.
		try {
			const reader = upstream.body?.getReader();
			if (reader) {
				const decoder = new TextDecoder();
				let buffer = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					// Simple parsing for non-streaming, assuming full JSON per line or similar
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (line.startsWith("data: ")) {
							const data = line.substring("data: ".length).trim();
							if (data === "[DONE]") break;
							try {
								const evt = JSON.parse(data);
								const kind = evt.type;
								if (evt.response && typeof evt.response.id === "string") {
									responseId = evt.response.id || responseId;
								}
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

		if (errorMessage) {
			return c.json({ error: { message: errorMessage } }, 502);
		}

		let message: any = { role: "assistant", content: fullText || null };
		if (toolCalls.length > 0) {
			message.tool_calls = toolCalls;
		}
		message = applyReasoningToMessage(message, reasoningSummaryText, reasoningFullText, reasoningCompat);

		const completion = {
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
		return new Response(JSON.stringify(completion), {
			status: upstream.status,
			headers: {
				"Content-Type": "application/json",
				...c.res.headers
			}
		});
	}
});

openai.post("/v1/completions", async (c) => {
	const verbose = c.env.VERBOSE === "true";
	const debugModel = c.env.DEBUG_MODEL;
	const reasoningEffort = c.env.REASONING_EFFORT || "minimal";
	const reasoningSummary = c.env.REASONING_SUMMARY || "auto";

	// Verbose logging like Python version
	if (verbose) {
		try {
			const bodyPreview = (await c.req.text()).substring(0, 2000);
			console.log("IN POST /v1/completions\n" + bodyPreview);
		} catch (e) {
			// Ignore logging errors
		}
	}

	let payload: any;
	try {
		const raw = await c.req.text();
		if (!raw) {
			payload = {};
		} else {
			payload = JSON.parse(raw);
		}
	} catch (e) {
		return c.json({ error: { message: "Invalid JSON body" } }, 400);
	}

	const model = normalizeModelName(payload.model, debugModel);
	let prompt = payload.prompt;
	if (Array.isArray(prompt)) {
		prompt = prompt.join("");
	}
	if (typeof prompt !== "string") {
		prompt = payload.suffix || "";
	}
	const streamReq = Boolean(payload.stream);

	const messages = [{ role: "user", content: prompt || "" }];
	const inputItems = convertChatMessagesToResponsesInput(messages);

	const reasoningOverrides = typeof payload.reasoning === "object" ? payload.reasoning : undefined;
	const reasoningParam = buildReasoningParam(reasoningEffort, reasoningSummary, reasoningOverrides);

	const instructions = await getBaseInstructions();

	const { response: upstream, error: errorResp } = await startUpstreamRequest(c.env, model, inputItems, {
		instructions: instructions,
		reasoningParam: reasoningParam
	});

	if (errorResp) {
		if (verbose) {
			console.log("=== ERROR RESPONSE DEBUG ===");
			console.log("Error response:", errorResp);
		}
		return errorResp;
	}

	if (!upstream) {
		if (verbose) {
			console.log("=== NO UPSTREAM RESPONSE DEBUG ===");
			console.log("Upstream response is null");
		}
		return c.json({ error: { message: "Upstream request failed unexpectedly." } }, 500);
	}

	if (verbose) {
		console.log("=== UPSTREAM RESPONSE DEBUG ===");
		console.log("Upstream status:", upstream.status);
		console.log("Upstream headers:", Object.fromEntries(upstream.headers.entries()));
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

		try {
			const reader = upstream.body?.getReader();
			if (reader) {
				const decoder = new TextDecoder();
				let buffer = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });

					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (line.startsWith("data: ")) {
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
								if (kind === "response.output_text.delta") {
									fullText += evt.delta || "";
								} else if (kind === "response.completed") {
									break;
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

		const completion = {
			id: responseId || "cmpl",
			object: "text_completion",
			created: created,
			model: model,
			choices: [{ index: 0, text: fullText, finish_reason: "stop", logprobs: null }]
		};
		return new Response(JSON.stringify(completion), {
			status: upstream.status,
			headers: {
				"Content-Type": "application/json",
				...c.res.headers
			}
		});
	}
});

openai.get("/v1/models", (c) => {
	const models = { object: "list", data: [{ id: "gpt-5", object: "model", owned_by: "owner" }] };
	return c.json(models);
});

export default openai;
