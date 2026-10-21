"use strict";

/* Rate limiting on POST /api/email-draft, end to end against a fake Upstash REST endpoint (no network, model stubbed). */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

/* A minimal stand-in for the Upstash Redis REST API: POST [command, ...args] -> { result },
 * and POST /pipeline [[command, ...args], ...] -> [{ result }, ...] (the client auto-pipelines). */
const store = new Map();
function run([cmd, ...args]) {
  const name = String(cmd).toLowerCase();
  if (name === "mget") return args.map((k) => (store.has(k) ? String(store.get(k)) : null));
  if (name === "incr") { const v = Number(store.get(args[0]) || 0) + 1; store.set(args[0], v); return v; }
  if (name === "expire") return 1;
  return null;
}
const upstash = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const out = req.url.startsWith("/pipeline") ? parsed.map((command) => ({ result: run(command) })) : { result: run(parsed) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  });
});

const GOOD = {
  subject: "Would love to connect over coffee",
  body: "Hi Jane,\n\nI hope your week is going well. I work in private banking at Harbor & Pine Private Bank with people in the tech industry, and I would enjoy hearing about your work as a research scientist. It sounds like a fascinating area to be in right now.\n\nWould you be open to a relaxed coffee or a short call sometime in the next few weeks? I'd enjoy getting to know you and hearing about your work, and I'm glad to share how I work with people in tech if that is ever useful. You are welcome to choose whatever time and format suit you.\n\nIf the timing is not right, no worries at all.\n\nWarm regards,",
  referenced: []
};

test("email drafts are limited per IP (429 with detail.queries_used) and the kill switch returns 503", async (t) => {
  await new Promise((resolve) => upstash.listen(0, "127.0.0.1", resolve));
  t.after(() => upstash.close());
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${upstash.address().port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "FAKE_TOKEN_FOR_TESTS_ONLY";
  process.env.RATE_LIMIT_EMAIL_MAX = "2";
  process.env.OPENROUTER_API_KEY = "FAKE_OPENROUTER_KEY_FOR_TESTS_ONLY";
  delete process.env.OUTREACH_MOCK;

  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes("openrouter.ai")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }) };
    }
    return realFetch(url, init); // the Upstash client talks to the fake server above
  };
  t.after(() => { global.fetch = realFetch; });

  const { server } = require("../server/server");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const post = (body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: "/api/email-draft", method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "origin-app", "X-Forwarded-For": "203.0.113.7" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text || "{}") }));
    });
    req.on("error", reject);
    req.end(data);
  });
  const payload = { dossier: { subject: { name: "Jane Roe", company: "Testco", title: "Research Scientist" }, complianceRisk: "clear" }, employer: "Harbor & Pine Private Bank" };

  assert.equal((await post(payload)).status, 200);
  assert.equal((await post(payload)).status, 200);
  const limited = await post(payload);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.detail.queries_used, 2);
  assert.ok([...store.keys()].some((k) => k === "ratelimit::ail-ay2627-s1-tzerey-origin:email:203.0.113.7"), "counted per project, bucket and client IP");

  /* validation failures never reach the limiter */
  assert.equal((await post({ ...payload, employer: "" })).status, 422);

  /* kill switch: the engine caches config for 90 s, so load a fresh copy of the server to pick it up */
  store.set("config:ail-ay2627-s1-tzerey-origin:enabled", "0");
  for (const key of Object.keys(require.cache)) if (key.includes(`${require("node:path").sep}server${require("node:path").sep}`)) delete require.cache[key];
  const fresh = require("../server/server").server;
  await new Promise((resolve) => fresh.listen(0, "127.0.0.1", resolve));
  t.after(() => fresh.close());
  const paused = await new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: "127.0.0.1", port: fresh.address().port, path: "/api/email-draft", method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "origin-app" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text || "{}") }));
    });
    req.on("error", reject);
    req.end(data);
  });
  assert.equal(paused.status, 503);
  assert.match(paused.json.detail.message, /paused/);
});
