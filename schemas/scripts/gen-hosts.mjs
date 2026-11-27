#!/usr/bin/env node
/**
 * Generate OpenAPI `servers:` stanzas and hosts.generated.ts files
 * (client defaultGateway + escrow trust lists) from schemas/apis/hosts.yaml.
 *
 *   node schemas/scripts/gen-hosts.mjs           # write
 *   node schemas/scripts/gen-hosts.mjs --check   # fail on drift
 */

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  API_ORDER,
  CLIENT_HOSTS_TS,
  HOSTS_YAML,
  SCHEMAS_DIR,
  TRUST_HOSTS_TS,
  loadHosts,
  renderClientHosts,
  renderTrustHosts,
  replaceServers,
} from "./hosts.mjs";

const check = process.argv.includes("--check");

function apply(path, next) {
  let current;
  try {
    current = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    if (check) return true;
    writeFileSync(path, next);
    return true;
  }
  if (current === next) return false;
  if (check) return true;
  writeFileSync(path, next);
  return true;
}

function main() {
  const hosts = loadHosts();
  const drifted = [];

  for (const name of API_ORDER) {
    const api = hosts.apis[name];
    const specPath = resolve(SCHEMAS_DIR, "apis", api.spec);
    const next = replaceServers(readFileSync(specPath, "utf8"), api);
    if (apply(specPath, next)) drifted.push(api.spec);
    for (const rel of api.embed) {
      const embedPath = resolve(SCHEMAS_DIR, "apis", rel);
      const embedNext = replaceServers(readFileSync(embedPath, "utf8"), api);
      if (apply(embedPath, embedNext)) drifted.push(rel);
    }
  }

  const generated = renderClientHosts(hosts);
  if (apply(CLIENT_HOSTS_TS, generated)) {
    drifted.push(relative(resolve(SCHEMAS_DIR, "apis"), CLIENT_HOSTS_TS));
  }
  const trust = renderTrustHosts(hosts);
  for (const path of TRUST_HOSTS_TS) {
    if (apply(path, trust)) drifted.push(path);
  }

  if (check && drifted.length) {
    process.stderr.write(
      "hosts.yaml consumers have drifted:\n" +
        drifted.map((p) => `  - ${p}`).join("\n") +
        "\nRun `make -C schemas generate-hosts` and commit.\n",
    );
    process.exit(1);
  }
  if (check) {
    process.stdout.write(`✅ OpenAPI servers and hosts.generated.ts match ${HOSTS_YAML}\n`);
    return;
  }
  process.stdout.write(
    drifted.length
      ? `wrote ${drifted.length} file(s) from hosts.yaml\n`
      : "hosts.yaml consumers already up to date\n",
  );
}

main();
