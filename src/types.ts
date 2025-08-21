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

export interface Env {
	OPENAI_CODEX_AUTH: string;
	CHATGPT_LOCAL_CLIENT_ID: string;
	CHATGPT_RESPONSES_URL: string;
	DEBUG_MODEL?: string; // Add this line
	VERBOSE?: string;
	REASONING_EFFORT?: string;
	REASONING_SUMMARY?: string;
	REASONING_COMPAT?: string;
	OLLAMA_API_URL: string; // Added for Ollama API URL
	// Add other environment variables as needed
}

export type InputItem = {
	type: string;
	role?: string;
	content?: string | Array<{ type?: string; text?: string; content?: string; image_url?: { url: string } | string }>;
	call_id?: string;
	output?: string;
	name?: string;
	arguments?: string;
};

export type ChatMessage = {
	role: string;
	content?: string | Array<{ type?: string; text?: string; content?: string; image_url?: { url: string } | string }>;
	tool_call_id?: string;
	id?: string;
	tool_calls?: Array<{
		type?: string;
		id?: string;
		call_id?: string;
		function?: {
			name?: string;
			arguments?: string;
		};
	}>;
};

export type Tool = {
	type: string;
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
};

export type ToolDefinition = {
	type: string;
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
};

export type ToolChoice = "auto" | "none" | { type: string; function: { name: string } };
