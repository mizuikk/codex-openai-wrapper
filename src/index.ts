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

// Helper: per-prefix compat override middleware (only active when REASONING_COMPAT=all)
const withCompat = (mode: ReasoningCompat | string) =>
  async (c: any, next: () => Promise<void>) => {
    const compatAll = (c.env && (c.env.REASONING_COMPAT === "all" || (c.env as any).REASONING_OUTPUT_MODE === "all"));
    if (!compatAll) {
      // If ALL mode is not enabled, pretend route does not exist
      return c.notFound();
    }
    c.set("REASONING_COMPAT_OVERRIDE", String(mode));
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

app.use("/standard/*", withCompat("standard"));
app.route("/standard", openai);

app.use("/legacy/*", withCompat("legacy"));
app.route("/legacy", openai);

app.use("/current/*", withCompat("current"));
app.route("/current", openai);

app.use("/hidden/*", withCompat("hidden"));
app.route("/hidden", openai);

// Note: 为避免与其他根级路由（如 /api）冲突，暂未开放通配形式 `/:compat/v1/*`。

export default app;
