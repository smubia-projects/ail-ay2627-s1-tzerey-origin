"use strict";

/*
 * Language-model client, OpenRouter only (https://openrouter.ai/api/v1). The model comes from OUTREACH_MODEL.
 * The optional `web` argument (OpenRouter's web plugin) is only used by the reference research agent in outreach.js,
 * which the hosted server does not call.
 */
const { fetchJson, truncate, normalizeUrl } = require("./util");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

function llmConfig() {
  if (!process.env.OPENROUTER_API_KEY) return null;
  return {
    provider: "openrouter",
    key: process.env.OPENROUTER_API_KEY,
    model: process.env.OUTREACH_MODEL || DEFAULT_MODEL
  };
}

/* OpenRouter attribution: the public frontend URL (first CORS origin) when set. */
const siteUrl = () => (process.env.CORS_ORIGINS || "").split(",")[0].trim() || "http://localhost";

function dedupeCitations(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = normalizeUrl(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ url: item.url, title: item.title || "", snippet: item.snippet || "" });
  }
  return out;
}

async function viaOpenRouter(cfg, { system, user, web, maxTokens, signal, temperature }) {
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    max_tokens: maxTokens,
    temperature: temperature ?? 0.2
  };
  if (web) body.plugins = [{ id: "web", max_results: web.maxResults || 6 }];
  const json = await fetchJson(
    OPENROUTER_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": siteUrl(),
        "X-Title": "Origin outreach agent"
      },
      body: JSON.stringify(body)
    },
    { timeoutMs: web ? 150000 : 100000, signal, retries: 1 }
  );
  const message = json.choices?.[0]?.message || {};
  const text = typeof message.content === "string"
    ? message.content
    : (message.content || []).map((part) => part.text || "").join("");
  const citations = (message.annotations || [])
    .filter((a) => a.type === "url_citation" && a.url_citation?.url)
    .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title, snippet: truncate(a.url_citation.content || "", 500) }));
  return { text, citations: dedupeCitations(citations), usage: json.usage || null };
}

async function complete({ system, user, web = null, maxTokens = 2500, signal, temperature }) {
  const cfg = llmConfig();
  if (!cfg) throw new Error("No language-model key configured (set OPENROUTER_API_KEY).");
  return viaOpenRouter(cfg, { system, user, web, maxTokens, signal, temperature });
}

module.exports = { llmConfig, complete };
