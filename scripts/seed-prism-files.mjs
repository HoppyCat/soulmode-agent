import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export function buildSeedSql() {
  const files = [
    ...readMarkdownFiles("on-load"),
    ...readMarkdownFiles("on-demand/patches"),
  ];

  const statements = files.map(({ key, content }) => {
    return `INSERT INTO agent_files (key, content, updated_at)
  VALUES (${sql(key)}, ${sql(content)}, ${Date.now()})
  ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at;`;
  });

  statements.push(`INSERT INTO library_sources (key, title, category, url, description, enabled, updated_at)
  VALUES (
    'discoball_readme',
    'Discoball README',
    'discoball',
    'https://raw.githubusercontent.com/HoppyCat/discoball/main/README.md',
    'Public archive exhibit and project overview.',
    1,
    ${Date.now()}
  )
  ON CONFLICT(key) DO UPDATE SET title = excluded.title, category = excluded.category, url = excluded.url, description = excluded.description, enabled = excluded.enabled, updated_at = excluded.updated_at;`);

  // Retire the old template entries when upgrading an existing database.
  // Keep any source whose owner has already changed its URL.
  statements.push(`UPDATE library_sources SET enabled = 0, updated_at = ${Date.now()}
  WHERE key IN ('cathedral_readme', 'soul_stack_readme')
  AND url IN (
    'https://raw.githubusercontent.com/HoppyCat/cathedral/refs/heads/main/README.md',
    'https://raw.githubusercontent.com/HoppyCat/soul-stack/refs/heads/main/README.md'
  );`);

  return statements.join("\n\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes("--remote") ? "--remote" : "--local";
  const dbName = process.env.D1_DATABASE_NAME ?? "teacat-agent-db";
  const tempFile = join(tmpdir(), `teacat-seed-${Date.now()}.sql`);
  writeFileSync(tempFile, buildSeedSql(), "utf8");

  const result = spawnSync("npx", ["wrangler", "d1", "execute", dbName, mode, "--file", tempFile], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });

  unlinkSync(tempFile);
  process.exit(result.status ?? 1);
}

function readMarkdownFiles(dir) {
  const abs = join(root, dir);
  return readdirSync(abs)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const key = name.replace(/\.md$/i, "").toUpperCase();
      return { key, content: readFileSync(join(abs, name), "utf8") };
    });
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
