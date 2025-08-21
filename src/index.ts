import { Hono } from "hono";
import { cors } from "hono/cors";
import openai from "./routes/openai"; // Import the openai router
import ollama from "./routes/ollama"; // Import the ollama router

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

app.route("/", openai); // Mount the OpenAI routes under /v1
app.route("/api", ollama); // Mount the Ollama routes under /api

export default app;
