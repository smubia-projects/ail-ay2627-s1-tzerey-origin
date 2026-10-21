#!/usr/bin/env node
/*
 * Builds the static frontend into public/ (git-ignored). Vercel runs this as its build command.
 *
 *   node tools/build-demo.js [output folder]
 *
 * It copies ONLY the whitelisted frontend files below, so server code, tests, tools, documentation, .env and private
 * data are never published.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/* The only files the frontend publishes. Everything else stays out of the build. */
const PUBLIC_FILES = [
  "index.html",
  "app.html",
  "styles.css",
  "landing.css",
  "app.js",
  "landing.js",
  "equity-model.js",
  "dossier.js",
  "dossier-pdf.js",
  "compose.js",
  "data-loader.js",
  "data-upload.js",
  "templates/prospects-template.js",
  "templates/company-profiles-template.js",
  "templates/sample-data-pack.js",
  "vendor/jspdf.umd.min.js"
];

function build(out) {
  const root = path.resolve(__dirname, "..");
  /* Never delete the project itself or any folder above it. */
  if (out === root || root.startsWith(out + path.sep)) {
    console.error(`Refusing to use ${out} as the output folder: it contains the project.`);
    process.exit(1);
  }

  fs.rmSync(out, { recursive: true, force: true });
  let count = 0;
  for (const name of PUBLIC_FILES) {
    const from = path.join(root, name);
    if (!fs.existsSync(from)) {
      console.error(`Missing file listed in the whitelist: ${name}`);
      process.exit(1);
    }
    const to = path.join(out, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    count += 1;
  }
  console.log(`Built the demo site: ${count} files in ${out}`);
}

if (require.main === module) {
  build(path.resolve(process.argv[2] || path.join(__dirname, "..", "public")));
}

module.exports = { PUBLIC_FILES };
