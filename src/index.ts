import { Hono } from "hono";
import { cors } from "hono/cors";
import openai from "./routes/openai"; // Import the openai router
import ollama from "./routes/ollama"; // Import the ollama router
import type { ReasoningCompat } from "./types";

const app = new Hono();

app.use(
	"*",
	cors({
		origin: "*", // Or specify allowed origins
		allowHeaders: ["Content-Type", "Authorization", "OpenAI-Beta", "chatgpt-account-id"],
		allowMethods: ["POST", "GET", "OPTIONS"],
		exposeHeaders: ["Content-Length", "X-Kuma-Revision"],
		maxAge: 600,
		credentials: true
	})
);

app.get("/", (c) => c.json({ status: "ok" }));

app.get("/health", (c) => c.json({ status: "ok" }));

// Base mounts
app.route("/", openai); // Default: /v1/*
app.route("/api", ollama); // Mount the Ollama routes under /api

// Helper: per-prefix compat override middleware (only active when REASONING_OUTPUT_MODE=all)
const withCompat = (mode: ReasoningCompat | string) =>
  async (c: any, next: () => Promise<void>) => {
    const compatAll = (c.env && ((c.env as any).REASONING_OUTPUT_MODE === "all"));
    if (!compatAll) {
      // If ALL mode is not enabled, pretend route does not exist
      return c.notFound();
    }
    c.set("REASONING_OUTPUT_MODE_OVERRIDE", String(mode));
    await next();
  };

// Static prefixed mounts for explicit modes when ALL-mode is enabled
// e.g. /tagged/v1/chat/completions -> tagged; /r1/v1/chat/completions -> r1; etc.
app.use("/tagged/*", withCompat("tagged"));
app.route("/tagged", openai);

app.use("/r1/*", withCompat("r1"));
app.route("/r1", openai);

app.use("/o3/*", withCompat("o3"));
app.route("/o3", openai);

app.use("/openai/*", withCompat("openai"));
app.route("/openai", openai);



app.use("/hidden/*", withCompat("hidden"));
app.route("/hidden", openai);

// Note: To avoid conflicts with other root-level routes (like /api), the wildcard form `/:compat/v1/*` is not currently enabled.

export default app;
