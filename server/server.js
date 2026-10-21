"use strict";

/*
 * Origin API server (API-only: the static frontend is deployed separately on Vercel).
 *   GET  /api/health         liveness plus which integrations are configured (booleans only, never keys)
 *   POST /api/outreach       streams a SYNTHETIC research dossier as NDJSON (server/mock.js; no live lookups, no AI calls)
 *   POST /api/email-draft    drafts a first-touch email from a dossier (the only live AI call, via OpenRouter, rate-limited)
 * The public demo never researches real people: the live research agent (server/outreach.js, server/tools.js) is kept
 * in the repository for reference but is not wired into this server.
 * API keys are read from the environment / .env on the server and are never sent to the browser.
 * Cross-origin calls are accepted only from the origins listed in CORS_ORIGINS.
 * Run with `npm start`, or `npm run start:mock` for keyless demo email drafts as well.
 */
const http = require("http");
const { llmConfig } = require("./llm");
const { runMock } = require("./mock");
const { draftEmail, mockDraft, assertCanContact, cleanEmployer } = require("./email");

/* Research is always synthetic. This flag only switches email drafting to the keyless demo generator too. */
const EMAIL_MOCK = process.argv.includes("--mock") || process.env.OUTREACH_MOCK === "1";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 8080;
/* Frontend origins allowed to call the API (comma-separated). Defaults to the local static dev server. */
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5500,http://127.0.0.1:5500")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const MAX_RESEARCH_RUNS = 10; // synthetic runs are cheap timers
const MAX_DRAFTS = 2; // live model calls per instance
const RUN_TIMEOUT_MS = 240000;
let active = 0;
let activeDrafts = 0;

/* API responses are JSON or NDJSON only, so the policy forbids loading anything. */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function health() {
  return {
    status: "ok",
    mock: true, // research dossiers are always synthetic
    research: "synthetic",
    email: EMAIL_MOCK ? "demo" : llmConfig() ? "live" : "unconfigured"
  };
}

const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function parseSubject(payload) {
  const subject = {
    name: str(payload.name, 80),
    company: str(payload.company, 60),
    title: str(payload.title, 160),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(str(payload.startDate, 10)) ? payload.startDate : "",
    department: str(payload.department, 80)
  };
  if (subject.name.length < 2 || !subject.company || !subject.title) return null;
  const eq = payload.equity && typeof payload.equity === "object" ? payload.equity : {};
  subject.equity = {
    estimatedNetEquityMedian: Number.isFinite(eq.netP50) ? Math.round(eq.netP50) : undefined,
    rangeP10: Number.isFinite(eq.netP10) ? Math.round(eq.netP10) : undefined,
    rangeP90: Number.isFinite(eq.netP90) ? Math.round(eq.netP90) : undefined,
    structure: str(eq.structure, 120) || undefined,
    liquidityNote: str(eq.liquidity, 400) || undefined,
    confidence: str(eq.confidence, 20) || undefined
  };
  return subject;
}

async function readBody(req, limit = 20000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const allowedOrigin = (origin) => CORS_ORIGINS.includes(String(origin || "").replace(/\/+$/, ""));

/* Lets the configured frontend origins read API responses. Set before any response is written. */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}

/* CORS preflight for the POST APIs (they send Content-Type: application/json and X-Requested-With). */
function handlePreflight(req, res) {
  if (!allowedOrigin(req.headers.origin)) return sendJson(res, 403, { error: "Origin not allowed" });
  res.writeHead(204, {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
    "Access-Control-Max-Age": "600",
    ...SECURITY_HEADERS
  });
  return res.end();
}

/* Shared request guard for the POST APIs: only from an allowed frontend origin, and only from the app's own fetch calls. */
function guardApiRequest(req, res) {
  const origin = req.headers.origin;
  if (origin && !allowedOrigin(origin)) {
    sendJson(res, 403, { error: "Cross-origin requests are not allowed" });
    return false;
  }
  if (req.headers["x-requested-with"] !== "origin-app" || !String(req.headers["content-type"] || "").includes("application/json")) {
    sendJson(res, 400, { error: "Bad request" });
    return false;
  }
  return true;
}

async function handleOutreach(req, res) {
  if (!guardApiRequest(req, res)) return;
  if (active >= MAX_RESEARCH_RUNS) return sendJson(res, 429, { error: "Too many research runs in progress. Try again shortly." });

  let subject;
  try {
    subject = parseSubject(JSON.parse(await readBody(req)));
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Invalid JSON" });
  }
  if (!subject) return sendJson(res, 422, { error: "A name, company and title are required" });

  active += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  res.on("close", () => controller.abort());
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...SECURITY_HEADERS });
  const emit = (event) => { if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };
  try {
    const dossier = await runMock(subject, emit, { signal: controller.signal });
    emit({ type: "result", dossier });
  } catch (error) {
    emit({ type: "error", message: controller.signal.aborted ? "The research run was cancelled or timed out." : error.message });
  } finally {
    clearTimeout(timer);
    active -= 1;
    if (!res.writableEnded) res.end();
  }
}

/* POST /api/email-draft: drafts a first-touch email from a dossier.
 * Receives the dossier and the sender's employer name only; the sender's personal details never reach this endpoint. */
async function handleEmailDraft(req, res) {
  if (!guardApiRequest(req, res)) return;
  if (activeDrafts >= MAX_DRAFTS) return sendJson(res, 429, { error: "Too many drafts in progress. Try again shortly." });

  let payload;
  try {
    payload = JSON.parse(await readBody(req, 600000));
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Invalid JSON" });
  }
  const dossier = payload && typeof payload.dossier === "object" ? payload.dossier : null;
  if (!dossier?.subject?.name) return sendJson(res, 422, { error: "A dossier is required" });
  const variant = Number.isInteger(payload.variant) ? Math.max(0, Math.min(payload.variant, 9)) : 0;
  const acknowledged = payload.acknowledgeCompliance === true;
  const employer = cleanEmployer(payload.employer);
  if (!employer) return sendJson(res, 422, { error: "A valid employer name is required (letters, numbers and basic punctuation, up to 80 characters)." });

  /* 500, not 503: 503 is reserved for the rate-limit kill switch ("demo paused"). */
  if (!EMAIL_MOCK && !llmConfig()) {
    return sendJson(res, 500, { error: "Email drafting is not configured on this server (OPENROUTER_API_KEY is missing)." });
  }
  activeDrafts += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  res.on("close", () => controller.abort());
  try {
    assertCanContact(dossier, acknowledged);
    const draft = EMAIL_MOCK ? mockDraft(dossier, { variant, employer }) : await draftEmail(dossier, { acknowledged, variant, employer, signal: controller.signal });
    return sendJson(res, 200, draft);
  } catch (error) {
    const status = error.status || (controller.signal.aborted ? 504 : 502);
    return sendJson(res, status, { error: controller.signal.aborted ? "The draft timed out. Try again." : error.message, needsAcknowledgement: Boolean(error.needsAcknowledgement) });
  } finally {
    clearTimeout(timer);
    activeDrafts -= 1;
  }
}

/* Routes one request. */
function route(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");
  applyCors(req, res);
  if (!pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
  if (req.method === "OPTIONS") return handlePreflight(req, res);
  if (pathname === "/api/health" && req.method === "GET") return sendJson(res, 200, health());
  if (pathname === "/api/outreach" && req.method === "POST") return handleOutreach(req, res);
  if (pathname === "/api/email-draft" && req.method === "POST") return handleEmailDraft(req, res);
  if (["/api/health", "/api/outreach", "/api/email-draft"].includes(pathname)) return sendJson(res, 405, { error: "Method not allowed" });
  return sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(route);

if (require.main === module) {
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Stop the other server or set PORT to a different number.` : error.message);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Origin API listening on http://${HOST}:${PORT} (research: synthetic, email drafts: ${health().email}). Allowed origins: ${CORS_ORIGINS.join(", ") || "(none)"}`);
  });
}

module.exports = { server, route, health, parseSubject, readBody, SECURITY_HEADERS, CORS_ORIGINS };
