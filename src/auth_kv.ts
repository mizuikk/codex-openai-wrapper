import { AuthTokens, Env } from "./types";

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
		const auth: AuthTokens = JSON.parse(env.OPENAI_CODEX_AUTH);
		const tokens = auth.tokens;
		let accountId: string | null = tokens.account_id;

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
