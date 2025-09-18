// src/sse.ts
import { normalizeCompatMode } from "./reasoning";
interface SseEvent {
	type: string;
	response?: {
		id?: string;
		// Optional usage payload (Responses API)
		usage?: Record<string, unknown>;
		error?: {
			message: string;
		};
	};
	// Some implementations provide usage at the root level
	usage?: Record<string, unknown>;
	item?: {
		type: string;
		call_id?: string;
		id?: string;
		name?: string;
		arguments?: string;
	};
	delta?: string;
}

export async function sseTranslateChat(
	upstreamResponse: Response,
	model: string,
	created: number,
	verbose: boolean = false,
	reasoningCompat: string = "openai"
): Promise<ReadableStream> {
	// Normalize compatibility mode once for the whole stream
	reasoningCompat = normalizeCompatMode(reasoningCompat);

	const upstreamBody = upstreamResponse.body;
	const reader = upstreamBody?.getReader();
	let canceled = false;
	if (!reader) {
		throw new Error("Upstream response body is not readable.");
	}

	let responseId = "chatcmpl-stream";
	let thinkOpen = false;
	let thinkClosed = false;
	let sawAnySummary = false;
	let pendingSummaryParagraph = false;

	// Implement a custom ReadableStream that properly propagates downstream
	// cancellation to the upstream source to avoid leaking resources.
	// Notes (English):
	// - When the client disconnects, the platform will call `cancel()` on this
	//   stream. Without a `cancel` handler, the loop below would continue to
	//   `read()` from the upstream and repeatedly throw on `enqueue`, wasting
	//   compute and holding the upstream network connection open.
	// - We therefore cancel the `reader` and, if available, cancel the
	//   upstream body stream as well. This is the best-effort way to signal the
	//   origin (e.g., OpenAI) to stop sending bytes.
	return new ReadableStream({
		async start(controller) {
			const decoder = new TextDecoder();
			let buffer = "";
			let sentRole = false; // Emit an initial role chunk to align with OpenAI stream shape

			const ensureRole = () => {
				if (sentRole) return;
				const roleChunk = {
					id: responseId,
					object: "chat.completion.chunk",
					created: created,
					model: model,
					choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
				};
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(roleChunk)}\n\n`));
				sentRole = true;
			};

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					buffer += decoder.decode(value, { stream: true });

					// Process lines from the buffer
					const lines = buffer.split("\n");
					buffer = lines.pop() || ""; // Keep the last (possibly incomplete) line in buffer

					for (const line of lines) {
						if (verbose) {
							console.log(line);
						}
						if (!line.startsWith("data: ")) {
							continue;
						}
						const data = line.substring("data: ".length).trim();
						if (!data) {
							continue;
						}
						if (data === "[DONE]") {
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
							break;
						}

						let evt: SseEvent;
						try {
							evt = JSON.parse(data);
						} catch (e) {
							console.error("Failed to parse SSE data:", e);
							continue;
						}

						const kind = evt.type;
						if (evt.response && typeof evt.response.id === "string") {
							responseId = evt.response.id || responseId;
						}

						if (kind === "response.output_text.delta") {
							ensureRole();
							const delta = evt.delta || "";
							if (reasoningCompat === "tagged" && thinkOpen && !thinkClosed) {
								const closeChunk = {
									id: responseId,
									object: "chat.completion.chunk",
									created: created,
									model: model,
									choices: [{ index: 0, delta: { content: "</think>" }, finish_reason: null }]
								};
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(closeChunk)}\n\n`));
								thinkOpen = false;
								thinkClosed = true;
							}
							const chunk = {
								id: responseId,
								object: "chat.completion.chunk",
								created: created,
								model: model,
								choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
							};
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
						} else if (kind === "response.output_item.done") {
							ensureRole();
							const item = evt.item;
							if (item && item.type === "function_call") {
								const callId = item.call_id || item.id || "";
								const name = item.name || "";
								const args = item.arguments || "";
								if (typeof callId === "string" && typeof name === "string" && typeof args === "string") {
									const deltaChunk = {
										id: responseId,
										object: "chat.completion.chunk",
										created: created,
										model: model,
										choices: [
											{
												index: 0,
												delta: {
													tool_calls: [
														{
															index: 0,
															id: callId,
															type: "function",
															function: { name: name, arguments: args }
														}
													]
												},
												finish_reason: null
											}
										]
									};
									controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(deltaChunk)}\n\n`));

									const finishChunk = {
										id: responseId,
										object: "chat.completion.chunk",
										created: created,
										model: model,
										choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
									};
									controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
								}
							}
						} else if (kind === "response.reasoning_summary_part.added") {
							if (reasoningCompat === "tagged" || reasoningCompat === "o3" || reasoningCompat === "openai") {
								if (sawAnySummary) {
									pendingSummaryParagraph = true;
								} else {
									sawAnySummary = true;
								}
							}
						} else if (
							kind === "response.reasoning_summary_text.delta" ||
							kind === "response.reasoning_text.delta" ||
							kind === "response.reasoning_summary.delta" ||
							kind === "response.reasoning.delta"
						) {
							ensureRole();
							const deltaTxt = evt.delta || "";
							// Hide mode: swallow all reasoning deltas
							if (reasoningCompat === "hidden") {
								// Do nothing; skip streaming any reasoning content
							} else if (reasoningCompat === "r1") {
								const chunk = {
									id: responseId,
									object: "chat.completion.chunk",
									created: created,
									model: model,
									choices: [
										{
											index: 0,
											delta: { reasoning_content: deltaTxt },
											finish_reason: null
										}
									]
								};
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
							} else if (reasoningCompat === "o3") {
								if (
									(kind === "response.reasoning_summary_text.delta" || kind === "response.reasoning_summary.delta") &&
									pendingSummaryParagraph
								) {
									const nlChunk = {
										id: responseId,
										object: "chat.completion.chunk",
										created: created,
										model: model,
										choices: [
											{
												index: 0,
												delta: { reasoning: { content: [{ type: "text", text: "\n" }] } },
												finish_reason: null
											}
										]
									};
									controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(nlChunk)}\n\n`));
									pendingSummaryParagraph = false;
								}
								const chunk = {
									id: responseId,
									object: "chat.completion.chunk",
									created: created,
									model: model,
									choices: [
										{
											index: 0,
											delta: { reasoning: { content: [{ type: "text", text: deltaTxt }] } },
											finish_reason: null
										}
									]
								};
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
							} else if (reasoningCompat === "openai") {
								// Compatible: stream reasoning as plain `reasoning_content`
								if (
									(kind === "response.reasoning_summary_text.delta" || kind === "response.reasoning_summary.delta") &&
									pendingSummaryParagraph
								) {
									const nlChunk = {
										id: responseId,
										object: "chat.completion.chunk",
										created: created,
										model: model,
										choices: [
											{
												index: 0,
												delta: { reasoning_content: "\n" },
												finish_reason: null
											}
										]
									};
									controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(nlChunk)}\n\n`));
									pendingSummaryParagraph = false;
								}
								const chunk = {
									id: responseId,
									object: "chat.completion.chunk",
									created: created,
									model: model,
									choices: [
										{
											index: 0,
											delta: { reasoning_content: deltaTxt },
											finish_reason: null
										}
									]
								};
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
							} else if (reasoningCompat === "tagged") {
								if (!thinkOpen && !thinkClosed) {
									const openChunk = {
										id: responseId,
										object: "chat.completion.chunk",
										created: created,
										model: model,
										choices: [{ index: 0, delta: { content: "<think>" }, finish_reason: null }]
									};
									controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openChunk)}\n\n`));
									thinkOpen = true;
								}
								if (thinkOpen && !thinkClosed) {
									if (
										(kind === "response.reasoning_summary_text.delta" || kind === "response.reasoning_summary.delta") &&
										pendingSummaryParagraph
									) {
										const nlChunk = {
											id: responseId,
											object: "chat.completion.chunk",
											created: created,
											model: model,
											choices: [{ index: 0, delta: { content: "\n" }, finish_reason: null }]
										};
										controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(nlChunk)}\n\n`));
										pendingSummaryParagraph = false;
									}
									const contentChunk = {
										id: responseId,
										object: "chat.completion.chunk",
										created: created,
										model: model,
										choices: [{ index: 0, delta: { content: deltaTxt }, finish_reason: null }]
									};
									controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
								}
							} else {
								// Default behavior for other compat modes
								if (kind === "response.reasoning_summary_text.delta") {
									const chunk = {
										id: responseId,
										object: "chat.completion.chunk",
										created: created,
										model: model,
										choices: [
											{
												index: 0,
												delta: { reasoning_summary: deltaTxt },
												finish_reason: null
											}
										]
									};
									controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
								} else {
									const chunk = {
										id: responseId,
										object: "chat.completion.chunk",
										created: created,
										model: model,
										choices: [{ index: 0, delta: { reasoning: deltaTxt }, finish_reason: null }]
									};
									controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
								}
							}
						} else if (typeof kind === "string" && kind.endsWith(".done")) {
							// Pass
						} else if (kind === "response.output_text.done") {
							const chunk = {
								id: responseId,
								object: "chat.completion.chunk",
								created: created,
								model: model,
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
							};
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
						} else if (kind === "response.failed") {
							const err = (evt.response && evt.response.error && evt.response.error.message) || "response.failed";
							const chunk = { error: { message: err } };
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
						} else if (kind === "response.completed") {
							if (reasoningCompat === "tagged" && thinkOpen && !thinkClosed) {
								const closeChunk = {
									id: responseId,
									object: "chat.completion.chunk",
									created: created,
									model: model,
									choices: [{ index: 0, delta: { content: "</think>" }, finish_reason: null }]
								};
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(closeChunk)}\n\n`));
								thinkOpen = false;
								thinkClosed = true;
							}
							// Emit OpenAI-compatible usage chunk if upstream provided usage
							try {
								const rawUsage = (evt.response && (evt.response as any).usage) || (evt as any).usage;
								if (rawUsage && typeof rawUsage === "object") {
									const prompt_tokens = (rawUsage as any).prompt_tokens ?? (rawUsage as any).input_tokens ?? 0;
									const completion_tokens = (rawUsage as any).completion_tokens ?? (rawUsage as any).output_tokens ?? 0;
									const total_tokens = (rawUsage as any).total_tokens ?? prompt_tokens + completion_tokens;
									const cache_creation_input_tokens = (rawUsage as any).cache_creation_input_tokens;
									const cache_read_input_tokens = (rawUsage as any).cache_read_input_tokens;

									const usageChunk: any = {
										id: responseId,
										object: "chat.completion.chunk",
										created: created,
										model: model,
										choices: [{ index: 0, delta: {}, finish_reason: null }],
										usage: {
											prompt_tokens,
											completion_tokens,
											total_tokens,
											...(typeof cache_creation_input_tokens === "number" ? { cache_creation_input_tokens } : {}),
											...(typeof cache_read_input_tokens === "number" ? { cache_read_input_tokens } : {})
										}
									};
									controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
								}
							} catch {}
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
							break;
						}
					}
				}
			} catch (error) {
				if (!canceled) {
					console.error("SSE stream error:", error);
					try {
						controller.error(error as any);
					} catch {}
				}
			} finally {
				try {
					reader.releaseLock();
				} catch {}
				try {
					controller.close();
				} catch {}
			}
		},
		async cancel(reason?: unknown) {
			canceled = true;
			try {
				await reader.cancel(reason as any);
			} catch {}
			try {
				await upstreamBody?.cancel?.(reason as any);
			} catch {}
		}
	});
}

export async function sseTranslateText(
	upstreamResponse: Response,
	model: string,
	created: number,
	verbose: boolean = false
): Promise<ReadableStream> {
	const upstreamBody = upstreamResponse.body;
	const reader = upstreamBody?.getReader();
	let canceled = false;
	if (!reader) {
		throw new Error("Upstream response body is not readable.");
	}

	let responseId = "cmpl-stream";

	// Same cancellation semantics as sseTranslateChat; see notes above.
	return new ReadableStream({
		async start(controller) {
			const decoder = new TextDecoder();
			let buffer = "";

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					buffer += decoder.decode(value, { stream: true });

					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						if (verbose) {
							console.log(line);
						}
						if (!line.startsWith("data: ")) {
							continue;
						}
						const data = line.substring("data: ".length).trim();
						if (!data || data === "[DONE]") {
							if (data === "[DONE]") {
								const chunk = {
									id: responseId,
									object: "text_completion.chunk",
									created: created,
									model: model,
									choices: [{ index: 0, text: "", finish_reason: "stop" }]
								};
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
							}
							continue;
						}

						let evt: SseEvent;
						try {
							evt = JSON.parse(data);
						} catch (e) {
							console.error("Failed to parse SSE data:", e);
							continue;
						}

						const kind = evt.type;
						if (evt.response && typeof evt.response.id === "string") {
							responseId = evt.response.id || responseId;
						}
						if (kind === "response.output_text.delta") {
							const deltaText = evt.delta || "";
							const chunk = {
								id: responseId,
								object: "text_completion.chunk",
								created: created,
								model: model,
								choices: [{ index: 0, text: deltaText, finish_reason: null }]
							};
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
						} else if (kind === "response.output_text.done") {
							const chunk = {
								id: responseId,
								object: "text_completion.chunk",
								created: created,
								model: model,
								choices: [{ index: 0, text: "", finish_reason: "stop" }]
							};
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
						} else if (kind === "response.completed") {
							// Emit usage for text completions if provided by upstream
							try {
								const rawUsage = (evt.response && (evt.response as any).usage) || (evt as any).usage;
								if (rawUsage && typeof rawUsage === "object") {
									const prompt_tokens = (rawUsage as any).prompt_tokens ?? (rawUsage as any).input_tokens ?? 0;
									const completion_tokens = (rawUsage as any).completion_tokens ?? (rawUsage as any).output_tokens ?? 0;
									const total_tokens = (rawUsage as any).total_tokens ?? prompt_tokens + completion_tokens;
									const cache_creation_input_tokens = (rawUsage as any).cache_creation_input_tokens;
									const cache_read_input_tokens = (rawUsage as any).cache_read_input_tokens;

									const usageChunk: any = {
										id: responseId,
										object: "text_completion.chunk",
										created: created,
										model: model,
										choices: [{ index: 0, text: "", finish_reason: null }],
										usage: {
											prompt_tokens,
											completion_tokens,
											total_tokens,
											...(typeof cache_creation_input_tokens === "number" ? { cache_creation_input_tokens } : {}),
											...(typeof cache_read_input_tokens === "number" ? { cache_read_input_tokens } : {})
										}
									};
									controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
								}
							} catch {}
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
							break;
						}
					}
				}
			} catch (error) {
				if (!canceled) {
					console.error("SSE stream error:", error);
					try {
						controller.error(error as any);
					} catch {}
				}
			} finally {
				try {
					reader.releaseLock();
				} catch {}
				try {
					controller.close();
				} catch {}
			}
		},
		async cancel(reason?: unknown) {
			canceled = true;
			try {
				await reader.cancel(reason as any);
			} catch {}
			try {
				await upstreamBody?.cancel?.(reason as any);
			} catch {}
		}
	});
}
