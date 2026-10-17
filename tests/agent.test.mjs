import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import app from "../src/api/index.ts";
import { buildSeedSql } from "../scripts/seed-prism-files.mjs";

function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../src/api/migrations/0000_initial.sql", import.meta.url), "utf8"));
  t.after(() => sqlite.close());
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return statement.get(...this.args) ?? null; },
        async all() { return { results: statement.all(...this.args) }; },
        async run() { return statement.run(...this.args); },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

function setup(t) {
  const DB = database(t);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://api.anthropic.com/v1/messages") {
      calls.push(JSON.parse(options.body));
      return Response.json({ content: [{ type: "text", text: "Test reply" }] });
    }
    if (url === "https://api.telegram.org/bottest-token/sendMessage") {
      return Response.json({ ok: true });
    }
    assert.fail(`Unexpected network call: ${url}`);
  });
  const env = {
    DB,
    ANTHROPIC_API_KEY: "test-key",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-secret",
    CHAT_API_TOKEN: "test-chat-token",
  };
  const telegram = (chatId, sender, text, secret = "test-secret") => app.request("/api/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    body: JSON.stringify({ message: { chat: { id: chatId }, from: { id: sender }, text } }),
  }, env);
  const api = (userId, message) => app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-chat-token" },
    body: JSON.stringify({ userId, message }),
  }, env);
  const inputs = () => calls.at(-1).messages.map((message) => message.content);
  return { DB, calls, env, telegram, api, inputs };
}

test("a sender's private chat, groups, and API each keep their own history", async (t) => {
  const { telegram, api, inputs, DB } = setup(t);
  assert.equal((await telegram(123, 123, "Private note")).status, 200);
  assert.equal((await telegram(-100, 123, "First group note")).status, 200);
  assert.deepEqual(inputs(), ["First group note"]);
  assert.equal((await telegram(-200, 123, "Second group note")).status, 200);
  assert.deepEqual(inputs(), ["Second group note"]);
  assert.equal((await api("123", "API note")).status, 200);
  assert.deepEqual(inputs(), ["API note"]);

  await telegram(123, 123, "Private follow-up");
  assert.deepEqual(inputs(), ["Private note", "Test reply", "Private follow-up"]);
  await telegram(-100, 123, "Group follow-up");
  assert.deepEqual(inputs(), ["First group note", "Test reply", "Group follow-up"]);
  await api("123", "API follow-up");
  assert.deepEqual(inputs(), ["API note", "Test reply", "API follow-up"]);
  assert.equal(DB.sqlite.prepare("SELECT count(*) AS count FROM conversations").get().count, 4);
  assert.deepEqual(DB.sqlite.prepare("SELECT DISTINCT user_id FROM bot_events").all().map((row) => row.user_id), ["123"]);
});

test("senders in the same group keep separate history", async (t) => {
  const { telegram, inputs } = setup(t);
  await telegram(-100, 123, "First sender note");
  await telegram(-100, 456, "Second sender note");
  assert.deepEqual(inputs(), ["Second sender note"]);
  await telegram(-100, 123, "First sender follow-up");
  assert.deepEqual(inputs(), ["First sender note", "Test reply", "First sender follow-up"]);
});

test("API IDs that resemble Telegram keys remain in the API scope", async (t) => {
  const { telegram, api, inputs } = setup(t);
  await telegram(123, 123, "Private note");
  await api(JSON.stringify(["telegram", 123, "123"]), "API note");
  assert.deepEqual(inputs(), ["API note"]);
});

test("an upgrade preserves old rows and starts fresh scoped histories", async (t) => {
  const { DB, telegram, api, inputs } = setup(t);
  const oldHistory = JSON.stringify([{ role: "user", content: "Legacy private note" }]);
  DB.sqlite.prepare("INSERT INTO conversations (user_id, messages) VALUES (?, ?)").run("123", oldHistory);
  await telegram(-100, 123, "New group note");
  assert.deepEqual(inputs(), ["New group note"]);
  await telegram(123, 123, "New private note");
  assert.deepEqual(inputs(), ["New private note"]);
  await api("123", "New API note");
  assert.deepEqual(inputs(), ["New API note"]);
  assert.equal(DB.sqlite.prepare("SELECT messages FROM conversations WHERE user_id = ?").get("123").messages, oldHistory);
});

test("Telegram requires a configured secret and a matching header", async (t) => {
  const { env, telegram, calls, DB } = setup(t);
  for (const expected of [undefined, ""]) {
    env.TELEGRAM_WEBHOOK_SECRET = expected;
    for (const header of [null, "test-secret"]) {
      assert.equal((await telegram(123, 123, "Attempt", header)).status, 401);
    }
  }
  env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
  for (const header of [null, "wrong-secret"]) {
    assert.equal((await telegram(123, 123, "Attempt", header)).status, 401);
  }
  assert.equal(calls.length, 0);
  assert.equal(DB.sqlite.prepare("SELECT count(*) AS count FROM conversations").get().count, 0);
  assert.equal((await telegram(123, 123, "Accepted")).status, 200);
  assert.equal(calls.length, 1);
});

test("fresh seed and INDEX agree on the public Discoball source", (t) => {
  const { sqlite } = database(t);
  sqlite.exec(buildSeedSql());
  const source = sqlite.prepare("SELECT * FROM library_sources WHERE key = 'discoball_readme'").get();
  const index = sqlite.prepare("SELECT content FROM agent_files WHERE key = 'INDEX'").get().content;
  assert.equal(source.enabled, 1);
  assert.equal(source.url, "https://raw.githubusercontent.com/HoppyCat/discoball/main/README.md");
  assert.ok(index.includes("`discoball_readme`"));
  assert.ok(index.includes(source.url));
});

test("reseeding retires old template links and preserves custom sources", (t) => {
  const { sqlite } = database(t);
  const insert = sqlite.prepare("INSERT INTO library_sources (key, title, url) VALUES (?, ?, ?)");
  insert.run("cathedral_readme", "Old template", "https://raw.githubusercontent.com/HoppyCat/cathedral/refs/heads/main/README.md");
  insert.run("soul_stack_readme", "Old template", "https://raw.githubusercontent.com/HoppyCat/soul-stack/refs/heads/main/README.md");
  insert.run("custom", "Custom source", "https://raw.githubusercontent.com/example/library/main/README.md");
  sqlite.exec(buildSeedSql());
  sqlite.exec(buildSeedSql());
  const enabled = (key) => sqlite.prepare("SELECT enabled FROM library_sources WHERE key = ?").get(key).enabled;
  assert.equal(enabled("cathedral_readme"), 0);
  assert.equal(enabled("soul_stack_readme"), 0);
  assert.equal(enabled("discoball_readme"), 1);
  assert.equal(enabled("custom"), 1);

  sqlite.prepare("UPDATE library_sources SET url = ?, enabled = 1 WHERE key = 'cathedral_readme'")
    .run("https://raw.githubusercontent.com/example/library/main/README.md");
  sqlite.exec(buildSeedSql());
  assert.equal(enabled("cathedral_readme"), 1);
});
