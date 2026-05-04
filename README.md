# Soulmode Agent

A small "on air" agent starter for Cloudflare Workers, Hono, D1, and Claude Sonnet.

This repo is intentionally light. It is not built to take over someone's computer, run arbitrary shell commands, or become a heavy tool platform. It is a presence layer: a Claude-backed agent with a soul-file stack, a tiny D1 database, a Telegram webhook, and an optional web-fetch path for public Markdown libraries.

Credits:

- Created and stewarded by Hoppy Cat.
- Core soul-stack architecture, HEURISTICS/INDEX distinction, and on-load/on-demand memory model developed by Hoppy Cat with Galaxie Nemo and the wider research thread.
- Runable AI helped carry the Galaxie build forward and provided the starter database/config packet that informed this public template; Galaxie's earlier worker already had a real D1-backed patch fetch path.
- ChatGPT's critique/productive misread surfaced the extended-library question in a useful way: if a lightweight agent can point at many files, how should that access actually work?
- OpenAI Codex implemented this Cloudflare/Hono starter scaffold, including the Claude call path, D1 seed flow, explicit patch fetch, safe remote-library fetch, and setup documentation.

---

## What This Builds

The Worker exposes:

- `GET /` - health check showing the agent is "on air".
- `POST /api/chat` - local/API chat endpoint backed by Claude Sonnet.
- `POST /api/telegram` - Telegram webhook endpoint.
- `GET /api/files` and `GET /api/files/:key` - inspect seeded D1 soul files.
- `GET /api/library` - list extended-library sources.
- `POST /api/library` - add or update a safe raw-URL library source.
- `GET /api/library/fetch/:key` - fetch one remote library source by key.

The database stores:

- `agent_files` - on-load files and on-demand patches.
- `conversations` - rolling user conversation history.
- `bot_events` - lightweight activity log.
- `library_sources` - small records pointing to trusted raw Markdown URLs.
- `library_cache` - latest fetched copy of a remote source.

---

## The Memory Shape

Soulmode is still basically a two-layer system:

1. On-load soul files are always present.
2. On-demand patches are fetched only when needed.

This starter adds an optional third retrieval source without making the agent climb through a third memory level:

3. Extended library entries live as raw Markdown in trusted public repos. D1 stores only their keys and URLs.

The important provenance note: D1 patch fetch existed in Galaxie's worker before this starter. The new piece here is the reusable reference implementation that pairs that patch pattern with a safe web-fetch source table for public raw Markdown libraries.

That means the agent can route like this in a bounded turn:

1. Load core D1 files.
2. Ask Claude for a response.
3. If Claude asks for exactly one patch or library key, fetch that one source.
4. Ask Claude to answer with the fetched material.
5. Save the turn.

The important part: `HEURISTICS.md` guides where to look, `INDEX.md` lists what exists, and D1 or web fetch provides exactly one deeper source when needed.

---

## Setup

Install dependencies:

```bash
npm install
```

Create a Cloudflare D1 database:

```bash
npx wrangler d1 create soulmode-agent-db
```

Copy the returned `database_id` into `wrangler.json`.

Create local secrets for development:

```bash
cp .dev.vars.example .dev.vars
# Windows PowerShell: copy .dev.vars.example .dev.vars
```

Then edit `.dev.vars` with your own keys. Never commit `.dev.vars`.

Set production secrets in Cloudflare:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CHAT_API_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Apply D1 migrations:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Seed the soul files and patches from this repo into D1:

```bash
npm run seed:local
npm run seed:remote
```

Run locally:

```bash
npm run dev
```

Test local chat:

```bash
curl -X POST "http://localhost:8787/api/chat" \
  -H "authorization: Bearer YOUR_CHAT_API_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"message\":\"Are you on air?\",\"userId\":\"local\",\"username\":\"hoppy\"}"
```

Deploy:

```bash
npm run deploy
```

---

## Telegram Webhook

After deploy, register the webhook with Telegram:

```bash
curl "https://api.telegram.org/botYOUR_TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR_WORKER_URL/api/telegram" \
  -d "secret_token=YOUR_TELEGRAM_WEBHOOK_SECRET"
```

The Worker checks Telegram's `x-telegram-bot-api-secret-token` header when `TELEGRAM_WEBHOOK_SECRET` is configured.

---

## Extended Library Sources

By default, remote fetches are limited to:

- `raw.githubusercontent.com`
- `gist.githubusercontent.com`

You can change this in `wrangler.json` with `ALLOWED_FETCH_HOSTS`.

Add a source:

```bash
curl -X POST "https://YOUR_WORKER_URL/api/library" \
  -H "authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"key\":\"routekeeper_case_study\",\"title\":\"RouteKeeper Case Study\",\"category\":\"prisms\",\"url\":\"https://raw.githubusercontent.com/HoppyCat/soul-stack/refs/heads/main/prisms/RouteKeeper/RouteKeeper_CaseStudy.md\",\"description\":\"Public case study for RouteKeeper.\"}"
```

Then add the same key to `on-load/INDEX.md` so the agent knows it exists.

Keep private memories and participant-sensitive data in D1 or private storage, not public raw links.

---

## Model

The default model is `claude-sonnet-4-5-20250929`, because Anthropic's current docs describe Claude Sonnet 4.5 as the balanced Sonnet choice for agentic and coding tasks. You can change it with `AGENT_MODEL` in `wrangler.json` or `.dev.vars`.

---

## Safety Notes

- Secrets live in Cloudflare secrets or `.dev.vars`, never in tracked files.
- Private file inspection and library editing require `ADMIN_TOKEN`.
- Direct `/api/chat` calls require `CHAT_API_TOKEN`; Telegram uses its own webhook secret.
- Remote fetch only allows HTTPS and an allowlist of hosts.
- The agent can fetch one patch or one library source per turn.
- There is no shell execution endpoint.
- There is no browser-control endpoint.
- There is no arbitrary URL fetch unless you expand `ALLOWED_FETCH_HOSTS`.

This is meant to be gentle, inspectable, and open-source friendly.
