import { Context, Next } from "hono";
import { Env } from "../types";

/**
 * OpenAI API Key Authentication Middleware
 * Validates that requests include a valid OpenAI API key in the Authorization header
 */
export function openaiAuthMiddleware() {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		const authHeader = c.req.header("Authorization");

		if (!authHeader) {
			return c.json({ error: { message: "Missing Authorization header" } }, 401);
		}

		if (!authHeader.startsWith("Bearer ")) {
			return c.json({ error: { message: "Invalid Authorization header format. Expected: Bearer <token>" } }, 401);
		}

		const providedKey = authHeader.substring(7); // Remove "Bearer " prefix
		const configuredKey = c.env.OPENAI_API_KEY;

		// If no configured key is set in environment, skip auth enforcement
		if (!configuredKey) {
			return await next();
		}

		if (providedKey !== configuredKey) {
			return c.json({ error: { message: "Invalid API key" } }, 401);
		}
		await next();
	};
}
