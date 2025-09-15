// src/sse.ts
interface SseEvent {
	type: string;
	response?: {
		id?: string;
		error?: {
			message: string;
		};
	};
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
    reasoningCompat: string = "think-tags"
): Promise<ReadableStream> {
    // Normalize compatibility mode once for the whole stream
    try {
        reasoningCompat = (reasoningCompat || "think-tags").trim().toLowerCase();
    } catch {
        reasoningCompat = "think-tags";
    }

    const reader = upstreamResponse.body?.getReader();
	if (!reader) {
		throw new Error("Upstream response body is not readable.");
	}

	let responseId = "chatcmpl-stream";
	let thinkOpen = false;
	let thinkClosed = false;
	let sawAnySummary = false;
	let pendingSummaryParagraph = false;

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
							const delta = evt.delta || "";
							if (reasoningCompat === "think-tags" && thinkOpen && !thinkClosed) {
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
							if (reasoningCompat === "think-tags" || reasoningCompat === "o3") {
								if (sawAnySummary) {
									pendingSummaryParagraph = true;
								} else {
									sawAnySummary = true;
								}
							}
                    } else if (kind === "response.reasoning_summary_text.delta" || kind === "response.reasoning_text.delta") {
                        const deltaTxt = evt.delta || "";
                        // Hide mode: swallow all reasoning deltas
                        if (reasoningCompat === "hide") {
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
								if (kind === "response.reasoning_summary_text.delta" && pendingSummaryParagraph) {
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
                        } else if (reasoningCompat === "think-tags") {
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
									if (kind === "response.reasoning_summary_text.delta" && pendingSummaryParagraph) {
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
							if (reasoningCompat === "think-tags" && thinkOpen && !thinkClosed) {
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
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
							break;
						}
					}
				}
			} catch (error) {
				console.error("SSE stream error:", error);
				controller.error(error);
			} finally {
				reader.releaseLock();
				controller.close();
			}
		}
	});
}

export async function sseTranslateText(
	upstreamResponse: Response,
	model: string,
	created: number,
	verbose: boolean = false
): Promise<ReadableStream> {
	const reader = upstreamResponse.body?.getReader();
	if (!reader) {
		throw new Error("Upstream response body is not readable.");
	}

	let responseId = "cmpl-stream";

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
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
							break;
						}
					}
				}
			} catch (error) {
				console.error("SSE stream error:", error);
				controller.error(error);
			} finally {
				reader.releaseLock();
				controller.close();
			}
		}
	});
}
