# OpenAI API Key Authentication

The codex-openai-wrapper now includes OpenAI API key authentication middleware to secure access to the proxy endpoints.

## Overview

All API endpoints (`/v1/*` and `/api/*`) now require a valid OpenAI API key to be provided in the Authorization header. This ensures that only authorized clients can use the proxy service.

## Configuration

### Environment Variables

Add the following environment variable to your `.dev.vars` file (for local development) or Cloudflare Workers environment:

```
OPENAI_API_KEY=sk-your-openai-api-key-here
```

This is the API key that clients must provide to access the endpoints.

### Cloudflare Workers Deployment

When deploying to Cloudflare Workers, set the environment variable using:

```bash
wrangler secret put OPENAI_API_KEY
```

Then enter your OpenAI API key when prompted.

## Client Usage

### Authentication Header

All requests to the proxy endpoints must include an Authorization header with the Bearer token format:

```
Authorization: Bearer sk-your-openai-api-key-here
```

### Example Requests

#### OpenAI Chat Completions

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-your-openai-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

#### Ollama Chat

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/api/chat \
  -H "Authorization: Bearer sk-your-openai-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama2",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Error Responses

### Missing Authorization Header

```json
{
  "error": {
    "message": "Missing Authorization header"
  }
}
```
**Status Code:** 401 Unauthorized

### Invalid Authorization Format

```json
{
  "error": {
    "message": "Invalid Authorization header format. Expected: Bearer <token>"
  }
}
```
**Status Code:** 401 Unauthorized

### Invalid API Key

```json
{
  "error": {
    "message": "Invalid API key"
  }
}
```
**Status Code:** 401 Unauthorized

### Server Configuration Error

```json
{
  "error": {
    "message": "Server configuration error"
  }
}
```
**Status Code:** 500 Internal Server Error

This occurs when the `OPENAI_API_KEY` environment variable is not configured on the server.

## Security Notes

1. **Keep API Keys Secure**: Never expose your OpenAI API key in client-side code or public repositories.

2. **Use Environment Variables**: Always store API keys in environment variables, never hardcode them.

3. **Rotate Keys Regularly**: Consider rotating your API keys periodically for enhanced security.

4. **Monitor Usage**: Keep track of API key usage to detect any unauthorized access.

## Public Endpoints

The following endpoints do **NOT** require authentication:

- `GET /` - Root endpoint with service information
- `GET /health` - Health check endpoint

All other endpoints require valid OpenAI API key authentication.