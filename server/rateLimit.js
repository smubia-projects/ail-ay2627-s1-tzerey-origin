"use strict";

/*
 * Rate-limit adapter for Origin.
 *
 * Wraps the shared AI Lodge engine (rate-limit/rateLimitEngine.js, copied unmodified; it is an ES module, hence the
 * {"type":"module"} package.json in that folder) with this project's slug and its one bucket, "email", for the only
 * route that calls a language model: POST /api/email-draft.
 *
 * The engine is written as Express middleware, (req, res, next). This server uses plain node:http, so checkRateLimit()
 * hands it the small surface it touches: req.headers / req.socket (for the client IP, X-Forwarded-For first),
 * res.status(code).json(body), and next(). The engine handles central config, event mode, the kill switch (503),
 * caching and fail-open; without UPSTASH_* credentials it allows every request (local development).
 */
const PROJECT = "ail-ay2627-s1-tzerey-origin";
const BUCKETS = { email: Number(process.env.RATE_LIMIT_EMAIL_MAX || 5) };

let limiterPromise = null;
function limiter() {
  limiterPromise ??= import("./rate-limit/rateLimitEngine.js").then(({ createRateLimiter }) =>
    createRateLimiter({
      project: PROJECT,
      buckets: BUCKETS,
      redisUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL,
      redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN,
      defaultWindow: Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 432000)
    })
  );
  return limiterPromise;
}

/* Resolves to null when the request may proceed, or { status, body } when the engine rejected it (429 or 503).
 * The engine's body ({ message, queries_used? }) is returned under `detail`, which is where the frontend reads it. */
async function checkRateLimit(req, bucket) {
  const middleware = (await limiter())(bucket);
  return new Promise((resolve) => {
    const res = { status: (status) => ({ json: (body) => resolve({ status, body: { error: body.message, detail: body } }) }) };
    Promise.resolve(middleware(req, res, () => resolve(null))).catch(() => resolve(null)); // unexpected engine error: fail open
  });
}

module.exports = { checkRateLimit, PROJECT, BUCKETS };
