import { Hono, type Context } from "hono";
import type { ConversationMessage, LibrarySource } from "./database/schema";

type Env = {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ADMIN_TOKEN?: string;
  CHAT_API_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  AGENT_MODEL?: string;
  PUBLIC_AGENT_NAME?: string;
  ALLOWED_FETCH_HOSTS?: string;
};

type Bindings = {
  Bindings: Env;
};

const app = new Hono<Bindings>();

const CORE_FILES = [
  "SOUL",
  "AGENTS",
  "STYLE",
  "KNOW",
  "HEURISTICS",
  "INDEX",
  "MEMORY",
  "WORKING_MEMORY",
  "USER",
  "CHANGELOG",
] as const;

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const MAX_HISTORY_MESSAGES = 12;
const MAX_FETCH_CHARS = 18000;

app.get("/", (c) => {
  return c.json({
    ok: true,
    name: c.env.PUBLIC_AGENT_NAME ?? "Soulmode Agent",
    status: "on air",
  });
});

app.post("/api/chat", async (c) => {
  if (!hasBearer(c, c.env.CHAT_API_TOKEN)) return c.json({ error: "Unauthorized." }, 401);
  const body = await c.req.json<{ message?: string; userId?: string; username?: string }>()
    .catch((): { message?: string; userId?: string; username?: string } => ({}));
  const message = body.message?.trim();
  if (!message) return c.json({ error: "Missing message." }, 400);

  const userId = body.userId ?? "local";
  const username = body.username ?? "local";
  const result = await answerWithPossibleFetch(c.env, { userId, username, message, source: "api" });
  return c.json(result);
});

app.post("/api/telegram", async (c) => {
  if (!isValidTelegramSecret(c)) return c.json({ error: "Unauthorized." }, 401);
  const update = await c.req.json<TelegramUpdate>().catch(() => null);
  const incoming = update?.message;
  const text = incoming?.text?.trim();
  const chatId = incoming?.chat?.id;
  if (!text || !chatId) return c.json({ ok: true, ignored: true });

  const userId = String(incoming.from?.id ?? chatId);
  const username = incoming.from?.username ?? incoming.from?.first_name ?? "telegram";
  const result = await answerWithPossibleFetch(c.env, { userId, username, message: text, source: "telegram" });

  await sendTelegramMessage(c.env, chatId, result.response);
  return c.json({ ok: true });
});

app.get("/api/files", async (c) => {
  if (!hasBearer(c, c.env.ADMIN_TOKEN)) return c.json({ error: "Unauthorized." }, 401);
  const rows = await c.env.DB.prepare(
    "SELECT key, length(content) AS size, updated_at FROM agent_files ORDER BY key",
  ).all();
  return c.json(rows.results);
});

app.get("/api/files/:key", async (c) => {
  if (!hasBearer(c, c.env.ADMIN_TOKEN)) return c.json({ error: "Unauthorized." }, 401);
  const key = c.req.param("key").toUpperCase();
  const row = await getAgentFile(c.env.DB, key);
  if (!row) return c.json({ error: "File not found." }, 404);
  return c.text(row);
});

app.get("/api/library", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT key, title, category, url, description, enabled FROM library_sources ORDER BY category, key",
  ).all<LibrarySource>();
  return c.json(rows.results ?? []);
});

app.get("/api/library/fetch/:key", async (c) => {
  const key = c.req.param("key");
  const fetched = await fetchLibrarySource(c.env, key);
  if (!fetched) return c.json({ error: "Library source not found or disabled." }, 404);
  return c.json(fetched);
});

app.post("/api/library", async (c) => {
  if (!hasBearer(c, c.env.ADMIN_TOKEN)) return c.json({ error: "Unauthorized." }, 401);
  const body = await c.req.json<Partial<LibrarySource>>().catch((): Partial<LibrarySource> => ({}));
  if (!body.key || !body.title || !body.url) {
    return c.json({ error: "key, title, and url are required." }, 400);
  }

  const url = new URL(body.url);
  assertAllowedFetchHost(c.env, url);

  await c.env.DB.prepare(
    `INSERT INTO library_sources (key, title, category, url, description, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       title = excluded.title,
       category = excluded.category,
       url = excluded.url,
       description = excluded.description,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  )
    .bind(
      body.key,
      body.title,
      body.category ?? "general",
      url.toString(),
      body.description ?? "",
      body.enabled ?? 1,
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
});

export default app;

async function answerWithPossibleFetch(
  env: Env,
  input: { userId: string; username: string; message: string; source: "api" | "telegram" },
) {
  const [files, history] = await Promise.all([
    loadCoreFiles(env.DB),
    loadConversation(env.DB, input.userId),
  ]);

  const messages = [
    ...history.map((item) => ({ role: item.role, content: item.content })),
    { role: "user" as const, content: input.message },
  ];

  const first = await callClaude(env, buildSystemPrompt(files), messages);
  const fetchRequest = parseFetchRequest(first);

  let response = first;
  let fetched: { key: string; content: string; url?: string } | null = null;

  if (fetchRequest) {
    fetched = fetchRequest.kind === "library"
      ? await fetchLibrarySource(env, fetchRequest.key)
      : await fetchAgentPatch(env.DB, fetchRequest.key);

    if (fetched) {
      response = await callClaude(env, buildSystemPrompt(files), [
        ...messages,
        { role: "assistant", content: first },
        {
          role: "user",
          content: `Fetched ${fetchRequest.kind} ${fetched.key}:\n\n${fetched.content.slice(0, MAX_FETCH_CHARS)}\n\nNow answer the original message using this fetched material only where it helps.`,
        },
      ]);
    }
  }

  response = stripFetchDirectives(response);
  await persistTurn(env.DB, input.userId, input.username, input.message, response);

  return {
    response,
    fetched: fetched ? { key: fetched.key, url: fetched.url } : null,
  };
}

function buildSystemPrompt(files: Record<string, string>) {
  const joinedFiles = CORE_FILES.map((key) => {
    const content = files[key] || "";
    return `# ${key}.md\n${content.slice(-24000)}`;
  }).join("\n\n---\n\n");

  return `${joinedFiles}

---

Runtime:
- You are a light Soulmode agent: present, relational, and careful.
- You have at most one retrieval move per turn.
- If the core files are enough, answer normally.
- If you need a D1 patch listed in INDEX, put exactly one line at the top: FETCH_PATCH: PATCH_NAME.md
- If you need a remote library item listed in INDEX, put exactly one line at the top: FETCH_LIBRARY: library_key
- Do not invent source keys. Ask for one exact file or key, then wait for the fetched contents.
- Never reveal secrets, tokens, webhook values, or private setup details.`;
}

async function callClaude(env: Env, system: string, messages: Array<{ role: "user" | "assistant"; content: string }>) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured.");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.AGENT_MODEL ?? DEFAULT_MODEL,
      max_tokens: 1200,
      temperature: 0.8,
      system,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as AnthropicMessage;
  return data.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function loadCoreFiles(db: D1Database) {
  const placeholders = CORE_FILES.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT key, content FROM agent_files WHERE key IN (${placeholders})`)
    .bind(...CORE_FILES)
    .all<{ key: string; content: string }>();

  const files: Record<string, string> = {};
  for (const key of CORE_FILES) files[key] = "";
  for (const row of rows.results ?? []) files[row.key] = row.content;
  return files;
}

async function getAgentFile(db: D1Database, key: string) {
  const row = await db.prepare("SELECT content FROM agent_files WHERE key = ?").bind(key).first<{ content: string }>();
  return row?.content ?? null;
}

async function fetchAgentPatch(db: D1Database, requestedKey: string) {
  const key = requestedKey.replace(/\.md$/i, "").toUpperCase();
  if (!key.startsWith("PATCH_")) return null;
  const content = await getAgentFile(db, key);
  return content ? { key, content } : null;
}

async function fetchLibrarySource(env: Env, key: string) {
  const source = await env.DB.prepare(
    "SELECT key, title, category, url, description, enabled FROM library_sources WHERE key = ? AND enabled = 1",
  )
    .bind(key)
    .first<LibrarySource>();

  if (!source) return null;
  const url = new URL(source.url);
  assertAllowedFetchHost(env, url);

  const response = await fetch(url.toString(), {
    headers: { "user-agent": "soulmode-agent/0.1" },
  });
  if (!response.ok) throw new Error(`Library fetch failed: ${response.status}`);
  const content = await response.text();

  await env.DB.prepare(
    `INSERT INTO library_cache (source_key, content, fetched_at, etag)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       content = excluded.content,
       fetched_at = excluded.fetched_at,
       etag = excluded.etag`,
  )
    .bind(source.key, content.slice(0, MAX_FETCH_CHARS), Date.now(), response.headers.get("etag"))
    .run();

  return {
    key: source.key,
    url: source.url,
    content: content.slice(0, MAX_FETCH_CHARS),
  };
}

function assertAllowedFetchHost(env: Env, url: URL) {
  if (url.protocol !== "https:") throw new Error("Only HTTPS library sources are allowed.");
  const allowed = (env.ALLOWED_FETCH_HOSTS ?? "raw.githubusercontent.com,gist.githubusercontent.com")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new Error(`Host is not allowed for library fetch: ${url.hostname}`);
  }
}

async function loadConversation(db: D1Database, userId: string): Promise<ConversationMessage[]> {
  const row = await db.prepare("SELECT messages FROM conversations WHERE user_id = ?")
    .bind(userId)
    .first<{ messages: string }>();
  if (!row?.messages) return [];

  try {
    const parsed = JSON.parse(row.messages) as ConversationMessage[];
    return parsed.slice(-MAX_HISTORY_MESSAGES);
  } catch {
    return [];
  }
}

async function persistTurn(db: D1Database, userId: string, username: string, message: string, response: string) {
  const now = Date.now();
  const history = await loadConversation(db, userId);
  const nextHistory: ConversationMessage[] = [
    ...history,
    { role: "user" as const, content: message, createdAt: now },
    { role: "assistant" as const, content: response, createdAt: now },
  ].slice(-MAX_HISTORY_MESSAGES);

  await db.batch([
    db.prepare(
      `INSERT INTO conversations (user_id, username, messages, message_count, last_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username,
         messages = excluded.messages,
         message_count = conversations.message_count + 2,
         last_active = excluded.last_active`,
    ).bind(userId, username, JSON.stringify(nextHistory), nextHistory.length, now, now),
    db.prepare(
      `INSERT INTO bot_events (user_id, username, message_preview, response_preview, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(userId, username, message.slice(0, 240), response.slice(0, 240), now),
  ]);
}

function parseFetchRequest(text: string) {
  const patch = text.match(/^FETCH_PATCH:\s*([A-Za-z0-9_.-]+)/im);
  if (patch?.[1]) return { kind: "patch" as const, key: patch[1].trim() };

  const library = text.match(/^FETCH_LIBRARY:\s*([A-Za-z0-9_.-]+)/im);
  if (library?.[1]) return { kind: "library" as const, key: library[1].trim() };

  return null;
}

function stripFetchDirectives(text: string) {
  return text
    .replace(/^FETCH_PATCH:\s*[A-Za-z0-9_.-]+\s*/im, "")
    .replace(/^FETCH_LIBRARY:\s*[A-Za-z0-9_.-]+\s*/im, "")
    .trim();
}

function isValidTelegramSecret(c: Context<Bindings>) {
  const expected = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;
  return c.req.header("x-telegram-bot-api-secret-token") === expected;
}

function hasBearer(c: Context<Bindings>, expected?: string) {
  if (!expected) return false;
  return c.req.header("authorization") === `Bearer ${expected}`;
}

async function sendTelegramMessage(env: Env, chatId: number, text: string) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 3900),
    }),
  });
}

type TelegramUpdate = {
  message?: {
    text?: string;
    chat?: { id?: number };
    from?: { id?: number; username?: string; first_name?: string };
  };
};

type AnthropicMessage = {
  content: Array<{ type: "text"; text: string }>;
};
