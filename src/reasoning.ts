type ReasoningParam = {
	effort: string;
	summary?: string;
};

export function buildReasoningParam(
	baseEffort: string = "minimal",
	baseSummary: string = "auto",
	overrides?: { effort?: string; summary?: string }
): ReasoningParam {
	let effort = (baseEffort || "").trim().toLowerCase();
	let summary = (baseSummary || "").trim().toLowerCase();

	const validEfforts = new Set(["low", "medium", "high", "none", "minimal"]);
	const validSummaries = new Set(["auto", "concise", "detailed", "none"]);

	if (overrides) {
		const oEff = (overrides.effort || "").trim().toLowerCase();
		const oSum = (overrides.summary || "").trim().toLowerCase();
		if (validEfforts.has(oEff) && oEff) {
			effort = oEff;
		}
		if (validSummaries.has(oSum) && oSum) {
			summary = oSum;
		}
	}

	if (!validEfforts.has(effort)) {
		effort = "minimal";
	}
	if (!validSummaries.has(summary)) {
		summary = "auto";
	}

	const reasoning: ReasoningParam = { effort: effort };
	if (summary !== "none") {
		reasoning.summary = summary;
	}
	return reasoning;
}

interface ChatMessage {
    role: string;
    content: string | null;
    reasoning?: string | { content: { type: string; text: string }[] };
    reasoning_summary?: string;
    reasoning_content?: string | null;
    [key: string]: unknown;
}

export const REASONING_COMPAT: { [key: string]: string } = {
	legacy: "standard",
	current: "standard",
	hide: "hidden",
};

export function applyReasoningToMessage(
	message: ChatMessage,
	reasoningSummaryText: string,
	reasoningFullText: string,
	compat: string
): ChatMessage {
	let normalizedCompat: string;
	try {
		// Normalize compatibility mode to avoid case/whitespace issues
		normalizedCompat = (compat || "tagged").trim().toLowerCase();
		normalizedCompat = REASONING_COMPAT[normalizedCompat] || normalizedCompat;
	} catch {
		normalizedCompat = "tagged";
	}

	// Hide mode: do not include any reasoning content in the final message.
	if (normalizedCompat === "hidden") {
		return message;
	}

	const rtxtParts: string[] = [];
	if (typeof reasoningSummaryText === "string" && reasoningSummaryText.trim()) {
		rtxtParts.push(reasoningSummaryText);
	}
	if (typeof reasoningFullText === "string" && reasoningFullText.trim()) {
		rtxtParts.push(reasoningFullText);
	}
	const rtxt = rtxtParts.filter((p) => p).join("\n\n");

	if (!rtxt) {
		return message;
	}

	// OpenAI Reasoning API JSON format
	if (normalizedCompat === "o3") {
		message.reasoning = { content: [{ type: "text", text: rtxt }] };
		return message;
	}

	// DeepSeek R1 compatibility
	if (normalizedCompat === "r1") {
		message.reasoning_content = rtxt;
		return message;
	}

	// Standard/legacy OpenAI Chat Completions compatibility
	if (normalizedCompat === "standard") {
		if (reasoningSummaryText) {
			message.reasoning_summary = reasoningSummaryText;
		}
		if (reasoningFullText){
			message.reasoning = reasoningFullText;
		}
		return message;
	}

	// Default to tagged content compatibility
	const thinkBlock = `<think>${rtxt}</think>`;
	const contentText = message.content || "";
	message.content =
		thinkBlock + (typeof contentText === "string" ? contentText : "");
	return message;
}

// Infer reasoning overrides from model suffix, like ChatMock:
// e.g., "gpt-5-medium" => { effort: "medium" }
export function extractReasoningFromModelName(model: unknown): { effort?: string; summary?: string } | undefined {
  try {
    const s = String(model || "").trim().toLowerCase();
    if (!s) return undefined;
    const parts = s.split(":", 1)[0];
    for (const sep of ["-", "_"]) {
      for (const effort of ["minimal", "low", "medium", "high"]) {
        if (parts.endsWith(`${sep}${effort}`)) return { effort };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
