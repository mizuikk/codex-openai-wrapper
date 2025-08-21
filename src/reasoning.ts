type ReasoningParam = {
	effort: string;
	summary?: string;
};

export function buildReasoningParam(
	baseEffort: string = "medium",
	baseSummary: string = "auto",
	overrides?: { effort?: string; summary?: string }
): ReasoningParam {
	let effort = (baseEffort || "").trim().toLowerCase();
	let summary = (baseSummary || "").trim().toLowerCase();

	const validEfforts = new Set(["low", "medium", "high", "none"]);
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
		effort = "medium";
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

export function applyReasoningToMessage(
	message: any,
	reasoningSummaryText: string,
	reasoningFullText: string,
	compat: string
): any {
	try {
		compat = (compat || "think-tags").trim().toLowerCase();
	} catch (e) {
		compat = "think-tags";
	}

	if (compat === "o3") {
		const rtxtParts: string[] = [];
		if (typeof reasoningSummaryText === "string" && reasoningSummaryText.trim()) {
			rtxtParts.push(reasoningSummaryText);
		}
		if (typeof reasoningFullText === "string" && reasoningFullText.trim()) {
			rtxtParts.push(reasoningFullText);
		}
		const rtxt = rtxtParts.filter((p) => p).join("\n\n");
		if (rtxt) {
			message.reasoning = { content: [{ type: "text", text: rtxt }] };
		}
		return message;
	}

	if (compat === "legacy" || compat === "current") {
		if (reasoningSummaryText) {
			message.reasoning_summary = reasoningSummaryText;
		}
		if (reasoningFullText) {
			message.reasoning = reasoningFullText;
		}
		return message;
	}

	// Default to think-tags compatibility
	const rtxtParts: string[] = [];
	if (typeof reasoningSummaryText === "string" && reasoningSummaryText.trim()) {
		rtxtParts.push(reasoningSummaryText);
	}
	if (typeof reasoningFullText === "string" && reasoningFullText.trim()) {
		rtxtParts.push(reasoningFullText);
	}
	const rtxt = rtxtParts.filter((p) => p).join("\n\n");
	if (rtxt) {
		const thinkBlock = `<think>${rtxt}</think>`;
		const contentText = message.content || "";
		message.content = thinkBlock + (typeof contentText === "string" ? contentText : "");
	}
	return message;
}
