"use strict";

/* The hosted frontend (Vercel) setup: static build, headers and ignore files. The API runs on Cloud Run (server/server.js). */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const { PUBLIC_FILES, SECURITY_HEADERS, readBody } = require("../server/server");

/* ------------------------------------------------------------------ configuration files */
test("vercel.json: builds the static site, has no serverless functions, and carries the security headers", () => {
  const config = JSON.parse(read("vercel.json"));
  assert.equal(config.buildCommand, "node tools/build-demo.js");
  assert.equal(config.outputDirectory, "public");
  assert.equal(config.functions, undefined, "the API runs on Cloud Run, not as Vercel functions");
  const headers = Object.fromEntries(config.headers.find((h) => h.source === "/(.*)").headers.map((h) => [h.key, h.value]));
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) assert.equal(headers[key], value, `${key} matches the local server`);
  assert.match(headers["Content-Security-Policy"], /script-src 'self'/);
});

test("ignore files keep private data, keys, logs and tests out of the upload and the repository", () => {
  const lines = (file) => read(file).split(/\r?\n/);
  const vercelIgnore = lines(".vercelignore");
  for (const entry of ["private/", ".env", "logs/", "tests/", "public/"]) assert.ok(vercelIgnore.includes(entry), `.vercelignore lists ${entry}`);
  assert.ok(!vercelIgnore.includes("tools/") && !vercelIgnore.includes("tools"), "tools/ stays: the build script needs it");
  const gitIgnore = lines(".gitignore");
  for (const entry of ["private/", ".env", "logs/", "public/"]) assert.ok(gitIgnore.includes(entry), `.gitignore lists ${entry}`);
});

/* ------------------------------------------------------------------ the static build */
test("the build publishes exactly the whitelisted files and nothing else", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "origin-site-"));
  const run = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-demo.js"), out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const published = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else published.push(path.relative(out, full).split(path.sep).join("/"));
    }
  })(out);
  assert.deepEqual(published.sort(), Object.keys(PUBLIC_FILES).sort());
  for (const name of published) assert.equal(sha(path.join(out, name)), sha(path.join(ROOT, name)), `${name} is an exact copy`);
  for (const secret of ["server", "tests", "tools", "private", ".env", "README.md", "logs", "package.json", "vercel.json"]) {
    assert.ok(!published.some((f) => f === secret || f.startsWith(`${secret}/`)), `${secret} is not published`);
  }
  assert.ok(published.includes("templates/sample-data-pack.js") && published.includes("app.html") && published.includes("index.html"));
});

test("the build refuses to delete the project or anything above it", () => {
  for (const target of [ROOT, path.dirname(ROOT)]) {
    const run = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-demo.js"), target], { encoding: "utf8" });
    assert.notEqual(run.status, 0, target);
    assert.match(run.stderr, /Refusing/);
  }
  assert.ok(fs.existsSync(path.join(ROOT, "app.html")), "nothing was deleted");
  assert.ok(fs.existsSync(path.join(ROOT, "server", "server.js")));
});

/* ------------------------------------------------------------------ request bodies */
test("readBody reads the request stream and enforces the size limit", async () => {
  assert.equal(await readBody(Readable.from([Buffer.from('{"a":1}')])), '{"a":1}');
  await assert.rejects(() => readBody(Readable.from([Buffer.alloc(500)]), 100), (e) => e.status === 413);
});

/* ------------------------------------------------------------------ the page */
test("the page tells visitors when it is in demo mode, using the health endpoint", () => {
  const html = read("app.html");
  assert.match(html, /id="demoBanner"[^>]*\shidden/);
  assert.match(html, /synthetic placeholders and no live lookups are made/);
  assert.match(read("app.js"), /health\?\.mock/);
});
