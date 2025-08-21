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
