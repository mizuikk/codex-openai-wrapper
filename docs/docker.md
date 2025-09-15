# Docker Deployment Guide

This guide provides comprehensive instructions for running the OpenAI Codex CLI wrapper using Docker, offering an alternative to Cloudflare Workers deployment.

## 📋 Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20.10 or later)
- [Docker Compose](https://docs.docker.com/compose/install/) (v2.0 or later)
- Git (for cloning the repository)

## 🚀 Quick Start

### 1. Choose Your Method

**Option A: Use Pre-built Image (Recommended)**
```bash
# Pull the latest pre-built image
docker pull ghcr.io/gewoonjaap/codex-openai-wrapper:latest
```

**Option B: Build from Source**
```bash
git clone https://github.com/GewoonJaap/codex-openai-wrapper.git
cd codex-openai-wrapper
```

### 2. Configure Environment

Create your environment file:

```bash
cp .dev.vars.example .dev.vars
```

Edit [`.dev.vars`](./.dev.vars) with your configuration:

```bash
# OpenAI API Configuration
OPENAI_API_KEY=your_api_key_here
CHATGPT_RESPONSES_URL=https://api.openai.com/v1/chat/completions

# Authentication
OPENAI_CODEX_AUTH={"tokens":{"access_token":"your_token","account_id":"your_account"}}

# Optional: Reasoning Configuration
REASONING_EFFORT=medium
REASONING_SUMMARY=auto
REASONING_COMPAT=think-tags

# Optional: Debugging
VERBOSE=false
DEBUG_MODEL=gpt-4
```

### 3. Start the Service

**Option A: Using Pre-built Image**
```bash
# Create environment file
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your configuration

# Run with pre-built image
docker run -d \
  --name codex-openai-wrapper \
  -p 8787:8787 \
  --env-file .dev.vars \
  ghcr.io/gewoonjaap/codex-openai-wrapper:latest
```

**Option B: Using Docker Compose**
```bash
docker-compose up -d
```

The service will be available at `http://localhost:8787`

## 🔧 Configuration Options

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `OPENAI_API_KEY` | Your OpenAI API key for authentication | ✅ | - |
| `CHATGPT_RESPONSES_URL` | OpenAI API endpoint URL | ✅ | - |
| `OPENAI_CODEX_AUTH` | JSON string with access tokens | ✅ | - |
| `REASONING_EFFORT` | AI reasoning depth: `minimal`, `low`, `medium`, `high` | ❌ | `minimal` |
| `REASONING_SUMMARY` | Summary mode: `auto`, `concise`, `detailed`, `none` (aliases: `on`=concise, `off`=none) | ❌ | `auto` |
| `REASONING_COMPAT` | Compatibility mode: `think-tags`, `standard`, `o3`, `r1`, `legacy`, `current`, `hide` | ❌ | `think-tags` |
| `VERBOSE` | Enable detailed logging: `true`, `false` | ❌ | `false` |
| `DEBUG_MODEL` | Override model for debugging | ❌ | - |

### Docker Compose Configuration

The [`docker-compose.yml`](../docker-compose.yml) includes:

- **Port Mapping**: `8787:8787` for API access
- **Volume Mounts**: 
  - Source code for development hot-reloading
  - Persistent storage for KV data
- **Health Checks**: Automatic service monitoring
- **Restart Policy**: Automatic restart on failure

## 🛠️ Development Setup

### Hot Reloading

For development with automatic code reloading:

```bash
# Start in development mode (default)
docker-compose up

# View logs
docker-compose logs -f codex-openai-wrapper
```

### Using Pre-built Images

The project provides pre-built Docker images via GitHub Container Registry:

```bash
# Pull the latest stable release
docker pull ghcr.io/gewoonjaap/codex-openai-wrapper:latest

# Pull a specific version
docker pull ghcr.io/gewoonjaap/codex-openai-wrapper:v1.0.0

# Run with custom configuration
docker run -d \
  --name codex-wrapper \
  -p 8787:8787 \
  --env-file .dev.vars \
  ghcr.io/gewoonjaap/codex-openai-wrapper:latest
```

### Building from Source

If you need to customize the image or build from source:

```bash
# Build the Docker image
docker build -t codex-openai-wrapper .

# Run with custom configuration
docker run -d \
  --name codex-wrapper \
  -p 8787:8787 \
  --env-file .dev.vars \
  codex-openai-wrapper
```

## 📊 Production Deployment

### 1. Production Environment File

Create `.env.production`:

```bash
NODE_ENV=production
OPENAI_API_KEY=your_production_key
CHATGPT_RESPONSES_URL=https://api.openai.com/v1/chat/completions
OPENAI_CODEX_AUTH={"tokens":{"access_token":"prod_token","account_id":"prod_account"}}
REASONING_EFFORT=medium
VERBOSE=false
```

### 2. Production Docker Compose

**Option A: Using Pre-built Image (Recommended)**

Create `docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  codex-openai-wrapper:
    image: ghcr.io/gewoonjaap/codex-openai-wrapper:latest
    container_name: codex-openai-wrapper-prod
    ports:
      - "8787:8787"
    volumes:
      - codex_storage_prod:/app/.mf
    env_file:
      - .env.production
    restart: always
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8787/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s

volumes:
  codex_storage_prod:
    driver: local
```

**Option B: Building from Source**

```yaml
version: '3.8'

services:
  codex-openai-wrapper:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        NODE_ENV: production
    container_name: codex-openai-wrapper-prod
    ports:
      - "8787:8787"
    volumes:
      - codex_storage_prod:/app/.mf
    env_file:
      - .env.production
    restart: always
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8787/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s

volumes:
  codex_storage_prod:
    driver: local
```

### 3. Deploy Production

```bash
docker-compose -f docker-compose.prod.yml up -d
```

## 🔍 Monitoring and Troubleshooting

### Health Checks

The service includes built-in health monitoring:

```bash
# Check service health
curl http://localhost:8787/health

# Expected response
{"status":"ok","timestamp":"2024-01-01T00:00:00.000Z"}
```

### Viewing Logs

```bash
# View real-time logs
docker-compose logs -f codex-openai-wrapper

# View last 100 lines
docker-compose logs --tail=100 codex-openai-wrapper

# Filter error logs
docker-compose logs codex-openai-wrapper | grep ERROR
```

### Container Management

```bash
# Stop the service
docker-compose down

# Restart the service
docker-compose restart codex-openai-wrapper

# Update and restart
git pull
docker-compose down
docker-compose up -d --build
```

### Data Persistence

The Docker setup includes persistent storage for:

- **KV Store Data**: Authentication tokens and cache
- **Configuration**: Environment-specific settings
- **Logs**: Application and error logs

```bash
# Backup persistent data
docker run --rm -v codex_openai_wrapper_storage:/data -v $(pwd):/backup ubuntu tar czf /backup/codex-backup.tar.gz /data

# Restore persistent data
docker run --rm -v codex_openai_wrapper_storage:/data -v $(pwd):/backup ubuntu tar xzf /backup/codex-backup.tar.gz -C /
```

## 🔐 Security Considerations

### Network Security

```bash
# Run on custom network
docker network create codex-network
docker-compose up -d
```

### Secrets Management

For production deployments, consider using Docker secrets:

```yaml
# In docker-compose.prod.yml
services:
  codex-openai-wrapper:
    secrets:
      - openai_api_key
      - codex_auth_token

secrets:
  openai_api_key:
    file: ./secrets/openai_api_key.txt
  codex_auth_token:
    file: ./secrets/codex_auth.json
```

### Container Security

- Uses non-root user (`worker:nodejs`)
- Minimal base image (`node:20-slim`)
- Security updates applied during build
- Read-only root filesystem option available

## 🔗 API Usage

Once deployed, the service provides the same API endpoints as the Cloudflare Workers version:

### OpenAI-Compatible Endpoints

```bash
# Chat completions
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello!"}]}'

# Text completions
curl -X POST http://localhost:8787/v1/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","prompt":"Complete this sentence:"}'

# List models
curl http://localhost:8787/v1/models
```

### Ollama-Compatible Endpoints

```bash
# Chat with Ollama format
curl -X POST http://localhost:8787/api/chat \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama2","messages":[{"role":"user","content":"Hello!"}]}'

# Show model details
curl -X POST http://localhost:8787/api/show \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"name":"llama2"}'

# List available models
curl http://localhost:8787/api/tags
```

## 🆚 Docker vs Cloudflare Workers

| Feature | Docker | Cloudflare Workers |
|---------|--------|-------------------|
| **Deployment** | Self-hosted | Serverless |
| **Scaling** | Manual/Orchestrator | Automatic |
| **Cold Starts** | None (always warm) | ~10-50ms |
| **Cost** | Infrastructure costs | Pay-per-request |
| **Customization** | Full control | Limited runtime |
| **Maintenance** | Manual updates | Automatic platform updates |
| **Geographic Distribution** | Single region | Global edge network |

Choose Docker when you need:
- Full control over the runtime environment
- No cold start delays
- Custom dependencies or system-level access
- On-premises or private cloud deployment

Choose Cloudflare Workers when you need:
- Zero infrastructure management
- Global edge deployment
- Automatic scaling
- Pay-per-use pricing model

## 📚 Additional Resources

- [Main Documentation](../README.md)
- [Authentication Guide](./authentication.md)
- [Docker Documentation](https://docs.docker.com/)
- [Docker Compose Reference](https://docs.docker.com/compose/compose-file/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)

## 🐛 Common Issues

### Port Already in Use

```bash
# Check what's using port 8787
lsof -i :8787

# Use different port
docker-compose up -d -p 8788:8787
```

### Permission Errors

```bash
# Fix ownership issues
sudo chown -R $USER:$USER .
chmod -R 755 .
```

### Memory Issues

```bash
# Increase Docker memory limit
# Docker Desktop: Settings → Resources → Memory → Increase limit
# Linux: Edit /etc/docker/daemon.json
```

### Build Failures

```bash
# Clean build (remove cache)
docker-compose down
docker system prune -f
docker-compose up -d --build --force-recreate
```

For additional support, please check the [main documentation](../README.md) or open an issue on GitHub.
