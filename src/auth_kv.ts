import { AuthDotJson, TokenData, RefreshRequest, RefreshResponse, Env } from "./types";

type JwtClaims = {
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
	};
} & Record<string, unknown>;

function urlBase64Decode(input: string): string {
	// Replace non-url-safe chars with url-safe ones
	input = input.replace(/-/g, "+").replace(/_/g, "/");
	// Pad out with = for base64.decode to work
	const pad = input.length % 4;
	if (pad) {
		input += new Array(5 - pad).join("=");
	}
	return atob(input);
}

function parseJwtClaims(token: string): JwtClaims | null {
	if (!token || token.split(".").length !== 3) {
		return null;
	}
	try {
		const payload = token.split(".");
		const decoded = urlBase64Decode(payload[1]);
		return JSON.parse(decoded);
	} catch (e) {
		console.error("Error parsing JWT claims:", e);
		return null;
	}
}

export async function getEffectiveChatgptAuth(
	env: Env
): Promise<{ accessToken: string | null; accountId: string | null }> {
	if (!env.OPENAI_CODEX_AUTH) {
		return { accessToken: null, accountId: null };
	}

	try {
		const auth: AuthDotJson = JSON.parse(env.OPENAI_CODEX_AUTH);
		const tokens = auth.tokens;

		if (!tokens) {
			return { accessToken: null, accountId: null };
		}

		let accountId: string | null = tokens.account_id || null;

		if (!accountId && tokens.id_token) {
			const claims = parseJwtClaims(tokens.id_token);
			if (claims && claims["https://api.openai.com/auth"]) {
				accountId = claims["https://api.openai.com/auth"].chatgpt_account_id || null;
			}
		}

		return { accessToken: tokens.access_token, accountId: accountId };
	} catch (e) {
		console.error("Error parsing OPENAI_CODEX_AUTH:", e);
		return { accessToken: null, accountId: null };
	}
}

// Token refresh functionality
export async function refreshAccessToken(env: Env): Promise<TokenData | null> {
	if (!env.OPENAI_CODEX_AUTH) {
		return null;
	}

	try {
		const auth: AuthDotJson = JSON.parse(env.OPENAI_CODEX_AUTH);
		const tokens = auth.tokens;

		if (!tokens || !tokens.refresh_token) {
			console.error("No refresh token available");
			return null;
		}

		const clientId = env.CHATGPT_LOCAL_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";

		const refreshRequest: RefreshRequest = {
			client_id: clientId,
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			scope: "openid profile email"
		};

		const response = await fetch("https://auth.openai.com/oauth/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(refreshRequest)
		});

		if (!response.ok) {
			console.error("Token refresh failed:", response.status, await response.text());
			return null;
		}

		const refreshResponse: RefreshResponse = await response.json();

		// Update tokens
		const updatedTokens: TokenData = {
			id_token: refreshResponse.id_token,
			access_token: refreshResponse.access_token || tokens.access_token,
			refresh_token: refreshResponse.refresh_token || tokens.refresh_token,
			account_id: tokens.account_id
		};

		// Update the auth in environment (this is a limitation - we can't modify env vars directly)
		// In a real implementation, you'd want to update the stored auth.json
		// const updatedAuth: AuthDotJson = {
		// 	...auth,
		// 	tokens: updatedTokens,
		// 	last_refresh: new Date().toISOString()
		// };

		// Store in KV if available
		if (env.KV) {
			console.log("💾 AUTH DEBUG: Saving refreshed tokens to KV storage");
			await env.KV.put("auth_tokens", JSON.stringify(updatedTokens));
			await env.KV.put("auth_last_refresh", new Date().toISOString());
		} else {
			console.log("💾 AUTH DEBUG: No KV storage available, tokens not persisted");
		}

		console.log("✅ AUTH DEBUG: Token refreshed successfully");
		return updatedTokens;

	} catch (e) {
		console.error("Error refreshing token:", e);
		return null;
	}
}

export async function getRefreshedAuth(env: Env): Promise<{ accessToken: string | null; accountId: string | null }> {
	// First try to get current auth
	const currentAuth = await getEffectiveChatgptAuth(env);

	if (!currentAuth.accessToken) {
		console.log("🔐 AUTH DEBUG: No access token found in environment");
		return currentAuth;
	}

	console.log("🔐 AUTH DEBUG: Found access token in environment");

	// Check if token needs refresh (older than 28 days or if we have KV storage with newer tokens)
	let needsRefresh = false;

	if (env.OPENAI_CODEX_AUTH) {
		try {
			const auth: AuthDotJson = JSON.parse(env.OPENAI_CODEX_AUTH);
			if (auth.last_refresh) {
				const lastRefresh = new Date(auth.last_refresh);
				const daysSinceRefresh = (Date.now() - lastRefresh.getTime()) / (1000 * 60 * 60 * 24);
				if (daysSinceRefresh > 28) {
					needsRefresh = true;
				}
			}
		} catch (e) {
			console.error("Error checking refresh time:", e);
		}
	}

	// Check KV for newer tokens
	if (env.KV && !needsRefresh) {
		try {
			const kvLastRefresh = await env.KV.get("auth_last_refresh");
			if (kvLastRefresh) {
				const kvRefreshTime = new Date(kvLastRefresh);
				if (kvRefreshTime.getTime() > Date.now() - (28 * 24 * 60 * 60 * 1000)) {
					// KV has newer tokens, use those
					const kvTokens = await env.KV.get("auth_tokens", "json");
					if (kvTokens) {
						const tokens = kvTokens as TokenData;
						console.log("🔐 AUTH DEBUG: Using tokens from KV storage");
						return {
							accessToken: tokens.access_token,
							accountId: tokens.account_id || null
						};
					}
				}
			}
		} catch (e) {
			console.error("Error checking KV for tokens:", e);
		}
	}

	// Refresh if needed
	if (needsRefresh) {
		const refreshedTokens = await refreshAccessToken(env);
		if (refreshedTokens) {
			return {
				accessToken: refreshedTokens.access_token,
				accountId: refreshedTokens.account_id || null
			};
		}
	}

	return currentAuth;
}
