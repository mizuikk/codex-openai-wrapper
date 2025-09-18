// Strict type definitions for environment variables
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none"; // aliases: on=concise, off=none
// Compatibility modes for how upstream reasoning content is surfaced back to clients
// - "tagged": prepend `<think>...</think>` to assistant content
// - "openai": Compatible – `message.reasoning_content` (stream: `delta.reasoning_content`)
// - "o3": expose structured `reasoning: { content: [{ type: 'text', text: ... }] }`
// - "r1": DeepSeek API shape — `message.reasoning_content` (streaming: `delta.reasoning_content`)
// - "hidden": suppress reasoning output entirely
export type ReasoningCompat = "tagged" | "openai" | "o3" | "r1" | "hidden" | "all";
export type VerboseMode = "true" | "false";

// Strict types for API and message handling
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type ToolType = "function";
export type ToolChoiceType = "auto" | "none" | { type: "function"; function: { name: string } };
export type InputItemType = "message" | "function_call" | "function_call_output";

export interface Env {
	KV?: KVNamespace; // Optional KV namespace for token storage
	OPENAI_API_KEY: string;
	CHATGPT_LOCAL_CLIENT_ID: string;
	CHATGPT_RESPONSES_URL: string;
	OPENAI_CODEX_AUTH: string;
	// Optional: comma-separated or JSON array of model IDs to expose via /v1/models
	// Examples:
	//   EXPOSE_MODELS="gpt-5,gpt-5-codex,codex-mini-latest"
	//   EXPOSE_MODELS='["gpt-5","gpt-5-codex","codex-mini-latest"]'
	EXPOSE_MODELS?: string;
	OLLAMA_API_URL?: string;
	DEBUG_MODEL?: string;
    REASONING_EFFORT?: ReasoningEffort;
    REASONING_SUMMARY?: ReasoningSummary;
    REASONING_OUTPUT_MODE?: ReasoningCompat; // unified config name
	VERBOSE?: VerboseMode;

	// --- Upstream provider overrides ---
	// If set, overrides CHATGPT_RESPONSES_URL entirely
	UPSTREAM_RESPONSES_URL?: string;
	// If set (and UPSTREAM_RESPONSES_URL not set), request URL becomes `${UPSTREAM_BASE_URL}/responses`
	UPSTREAM_BASE_URL?: string;
	// Optional override for the path appended to UPSTREAM_BASE_URL (default: "/responses")
	UPSTREAM_WIRE_API_PATH?: string;

	// How to authenticate to the upstream provider
	//   - "chatgpt_token" (default): Use OAuth access_token from OPENAI_CODEX_AUTH
	//   - "apikey_auth_json": Use OPENAI_CODEX_AUTH[UPSTREAM_AUTH_ENV_KEY] (default key: "OPENAI_API_KEY")
	//   - "apikey_env": Use UPSTREAM_API_KEY env var
	UPSTREAM_AUTH_MODE?: "chatgpt_token" | "apikey_auth_json" | "apikey_env";
	// The key name within OPENAI_CODEX_AUTH JSON to read when using apikey_auth_json (default: OPENAI_API_KEY)
	UPSTREAM_AUTH_ENV_KEY?: string;
	// API key to send upstream when using apikey_env
	UPSTREAM_API_KEY?: string;
	// Header name and scheme used for upstream auth (defaults: Authorization / Bearer)
	UPSTREAM_AUTH_HEADER?: string;
	UPSTREAM_AUTH_SCHEME?: string;

	// Optional: wire schema variant for tools/tool_choice
	//   - "nested" (default): tools[].function.name (OpenAI Responses style)
	//   - "flat": tools[].name (some third-party providers)
	UPSTREAM_TOOLS_FORMAT?: "nested" | "flat";

	// --- Client header forwarding controls ---
	// Controls how incoming client headers are forwarded to the upstream service.
	//   - "off" (default): do not forward any client headers
	//   - "safe": forward a security-allowlist of headers (User-Agent, Accept-Language, sec-ch-*, X-Forwarded-*, etc.)
	//   - "list": forward only headers explicitly listed in FORWARD_CLIENT_HEADERS_LIST environment variable
	//   - "override": after building default headers, override final headers using explicit key-value mapping
	//   - "override-codex" | "override_codex": dynamically build Codex CLI style headers (User-Agent and originator)
	FORWARD_CLIENT_HEADERS_MODE?: "off" | "safe" | "list" | "override" | "override-codex" | "override_codex";
	// When mode = "override": JSON string mapping header names to values for explicit override
	// Example: '{"User-Agent":"MyApp/1.0","Accept":"text/event-stream"}'
	FORWARD_CLIENT_HEADERS_OVERRIDE?: string;
	// When mode = "override-codex": optional JSON string for overriding Codex-generated header values
	// If absent, safe built-in defaults derived from the openai/codex project will be used
	FORWARD_CLIENT_HEADERS_OVERRIDE_CODEX?: string;
	// Comma-separated header names (case-insensitive) used when mode = "list" environment variable
	FORWARD_CLIENT_HEADERS_LIST?: string;

	// --- Codex UA/Originator derivation controls (override-codex mode) ---
	// Optional explicit version to use instead of auto-discovering from GitHub releases
	FORWARD_CLIENT_HEADERS_CODEX_VERSION?: string; // e.g. "0.36.0"

	// Preferred: explicit originator override, aligned with codex-rs project
	CODEX_INTERNAL_ORIGINATOR_OVERRIDE?: string; // e.g. "codex_cli_rs"
	// Legacy/fallback originator override (defaults to "codex_cli_rs" if not set)
	FORWARD_CLIENT_HEADERS_CODEX_ORIGINATOR?: string;

	// Optional explicit OS/architecture information for User-Agent formatting
	// If absent, these are derived from sec-ch-ua-* client hints when available
	FORWARD_CLIENT_HEADERS_CODEX_OS_TYPE?: string; // e.g. "Windows"
	FORWARD_CLIENT_HEADERS_CODEX_OS_VERSION?: string; // e.g. "10.0.26100"
	FORWARD_CLIENT_HEADERS_CODEX_ARCH?: string; // e.g. "x86_64"
	// Optional explicit editor information, used if not detected from client's User-Agent
	FORWARD_CLIENT_HEADERS_CODEX_EDITOR?: string; // e.g. "vscode/1.104.0"
	// Terminal detection environment variables for User-Agent construction
	TERM_PROGRAM?: string;
	TERM_PROGRAM_VERSION?: string;
	WEZTERM_VERSION?: string;
	KONSOLE_VERSION?: string;
	VTE_VERSION?: string;
	WT_SESSION?: string;
	KITTY_WINDOW_ID?: string;
	ALACRITTY_SOCKET?: string;
	TERM?: string;

	// --- Instructions source overrides ---
	INSTRUCTIONS_BASE_URL?: string; // URL to a base prompt markdown
	INSTRUCTIONS_CODEX_URL?: string; // URL to a codex-specific prompt markdown
	INSTRUCTIONS_SANITIZE_PATCH?: "true" | "false"; // default true: sanitize patch markers (*** -> **_)
	INSTRUCTIONS_SANITIZE_LEVEL?: "auto" | "basic" | "strict" | "off"; // default auto
}

export type AuthTokens = {
	OPENAI_API_KEY: string;
	tokens: {
		id_token: string;
		access_token: string;
		refresh_token: string;
		account_id: string;
	};
	last_refresh: string;
};

export type InputItem = {
	type: InputItemType;
	role?: MessageRole;
	content?: string | Array<{ type?: string; text?: string; content?: string; image_url?: { url: string } | string }>;
	call_id?: string;
	output?: string;
	name?: string;
	arguments?: string;
};

export type ChatMessage = {
	role: MessageRole;
	content?: string | Array<{ type?: string; text?: string; content?: string; image_url?: { url: string } | string }>;
	tool_call_id?: string;
	id?: string;
	tool_calls?: Array<{
		type?: ToolType;
		id?: string;
		call_id?: string;
		function?: {
			name?: string;
			arguments?: string;
		};
	}>;
};

export type Tool = {
	type: ToolType;
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
};

export type ToolDefinition = {
	type: ToolType;
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
};

export type ToolChoice = ToolChoiceType;

export interface TokenData {
	id_token: string;
	access_token: string;
	refresh_token: string;
	account_id?: string;
}

export interface AuthDotJson {
	OPENAI_API_KEY?: string;
	tokens?: TokenData;
	last_refresh?: string; // ISO 8601 timestamp
}

export interface RefreshRequest {
	client_id: string;
	grant_type: string;
	refresh_token: string;
	scope: string;
}

export interface RefreshResponse {
	id_token: string;
	access_token?: string;
	refresh_token?: string;
}
