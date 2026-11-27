#!/usr/bin/env node
/**
 * Parser and helpers for schemas/apis/hosts.yaml — the writable SSOT for
 * public API base URLs. OpenAPI `servers`, the npm client default, and
 * atum-docs variables are generated from that file.
 *
 * The YAML shape is constrained on purpose so this module has no third-party
 * dependency. A looser document fails here rather than being half-applied.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SCHEMAS_DIR = resolve(__dirname, "..");
export const HOSTS_YAML = resolve(SCHEMAS_DIR, "apis/hosts.yaml");
export const ENV_ORDER = ["mainnet", "testnet", "local"];
export const ENV_DESCRIPTIONS = {
  mainnet: "Mainnet",
  testnet: "Testnet",
  local: "Local development server",
};
export const API_ORDER = ["payment-gateway", "veri-fill", "auth"];

const SCALAR_KEYS = new Set(["x402_base_path"]);
const API_SCALAR_KEYS = new Set(["spec", ...ENV_ORDER]);
const PAYMENT_GATEWAY_ONLY_KEYS = new Set(["default_env"]);
const API_LIST_KEYS = new Set(["embed"]);

/** Read and parse the committed SSOT. */
export function loadHosts(path = HOSTS_YAML) {
  return parseHostsYaml(readFileSync(path, "utf8"));
}

/**
 * Parse the constrained hosts.yaml. Comments and blank lines are ignored.
 * Unknown keys, missing required fields, and a malformed list fail loudly.
 */
export function parseHostsYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = { x402BasePath: "", apis: {} };
  const seenTop = new Set();
  let currentApi = null;
  let currentList = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;

    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    const nested = raw.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/);
    const item = raw.match(/^    - (.+)$/);

    if (item && currentList) {
      currentList.push(item[1].trim());
      continue;
    }
    currentList = null;

    if (top && !raw.startsWith(" ")) {
      const [, key, value] = top;
      if (seenTop.has(key)) {
        throw new Error(`hosts.yaml: duplicate key '${key}' (line ${i + 1})`);
      }
      seenTop.add(key);
      if (SCALAR_KEYS.has(key)) {
        if (!value) throw new Error(`hosts.yaml: '${key}' needs a value (line ${i + 1})`);
        if (key === "x402_base_path") root.x402BasePath = unquote(value.trim());
        continue;
      }
      if (!API_ORDER.includes(key)) {
        throw new Error(`hosts.yaml: unknown top-level key '${key}' (line ${i + 1})`);
      }
      currentApi = {
        name: key,
        spec: "",
        embed: [],
        defaultEnv: "",
        envs: {},
        seen: new Set(),
      };
      root.apis[key] = currentApi;
      continue;
    }

    if (nested && currentApi) {
      const [, key, value] = nested;
      if (API_LIST_KEYS.has(key)) {
        if (currentApi.seen.has(key)) {
          throw new Error(`hosts.yaml: duplicate key '${currentApi.name}.${key}' (line ${i + 1})`);
        }
        currentApi.seen.add(key);
        currentList = currentApi.embed;
        continue;
      }
      if (PAYMENT_GATEWAY_ONLY_KEYS.has(key) && currentApi.name !== "payment-gateway") {
        throw new Error(
          `hosts.yaml: '${key}' is only valid under payment-gateway (line ${i + 1}); ${currentApi.name} does not use it`,
        );
      }
      if (!API_SCALAR_KEYS.has(key) && !PAYMENT_GATEWAY_ONLY_KEYS.has(key)) {
        throw new Error(`hosts.yaml: unknown key '${key}' under ${currentApi.name} (line ${i + 1})`);
      }
      if (currentApi.seen.has(key)) {
        throw new Error(`hosts.yaml: duplicate key '${currentApi.name}.${key}' (line ${i + 1})`);
      }
      currentApi.seen.add(key);
      if (!value) throw new Error(`hosts.yaml: '${currentApi.name}.${key}' needs a value (line ${i + 1})`);
      const trimmed = unquote(value.trim());
      if (key === "spec") currentApi.spec = trimmed;
      else if (key === "default_env") currentApi.defaultEnv = trimmed;
      else currentApi.envs[key] = { url: trimmed, description: ENV_DESCRIPTIONS[key] };
      continue;
    }

    throw new Error(`hosts.yaml: cannot parse line ${i + 1}: ${raw}`);
  }

  if (!root.x402BasePath.startsWith("/")) {
    throw new Error("hosts.yaml: x402_base_path must be a path prefix starting with /");
  }
  for (const name of API_ORDER) {
    const api = root.apis[name];
    if (!api) throw new Error(`hosts.yaml: missing '${name}'`);
    delete api.seen;
    if (!api.spec) throw new Error(`hosts.yaml: '${name}.spec' is required`);
    if (name === "payment-gateway") {
      if (api.defaultEnv !== "testnet") {
        throw new Error(
          "hosts.yaml: payment-gateway.default_env must be testnet (the published client must not default to mainnet)",
        );
      }
    } else if (api.defaultEnv) {
      throw new Error(`hosts.yaml: '${name}' must not set default_env`);
    }
    for (const env of ENV_ORDER) {
      if (!api.envs[env]?.url) throw new Error(`hosts.yaml: '${name}.${env}' is required`);
      assertHostUrl(`${name}.${env}`, api.envs[env].url, env);
    }
  }
  return root;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Public hosts: https, no trailing slash, no query. local may be http. */
export function assertHostUrl(label, url, env) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`hosts.yaml: '${label}' is not a URL: ${url}`);
  }
  const allowHttp = env === "local";
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new Error(
      `hosts.yaml: '${label}' must be ${allowHttp ? "http or https" : "https"}: ${url}`,
    );
  }
  if (url.endsWith("/")) {
    throw new Error(`hosts.yaml: '${label}' must not end with /: ${url}`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`hosts.yaml: '${label}' must not include a query or fragment: ${url}`);
  }
}

export function camelApiName(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Every public URL this file authorizes, including x402 prefixes on the gateway. */
export function ssotUrls(hosts) {
  const urls = new Set();
  for (const api of Object.values(hosts.apis)) {
    for (const env of Object.values(api.envs)) urls.add(env.url);
  }
  const gw = hosts.apis["payment-gateway"];
  for (const env of Object.values(gw.envs)) {
    if (env.url.startsWith("http")) urls.add(env.url.replace(/\/$/, "") + hosts.x402BasePath);
  }
  return urls;
}

export function serversBlock(api) {
  const lines = ["servers:"];
  for (const env of ENV_ORDER) {
    const { url, description } = api.envs[env];
    lines.push(`  - url: ${url}`);
    lines.push(`    description: ${description}`);
  }
  return lines.join("\n") + "\n";
}

const SERVERS_RE = /^servers:\n(?:[ \t].*\n)+/m;

/** Replace the OpenAPI `servers:` stanza. Fails if the block is missing. */
export function replaceServers(text, api) {
  if (!SERVERS_RE.test(text)) {
    throw new Error(`no servers: block to replace in ${api.name} spec`);
  }
  return text.replace(SERVERS_RE, serversBlock(api));
}

function generatedHeader() {
  return [
    "// GENERATED FILE — DO NOT EDIT.",
    "//",
    "// Written by schemas/scripts/gen-hosts.mjs from schemas/apis/hosts.yaml.",
    "// Run `make -C schemas generate-hosts` to regenerate; `make -C schemas check-hosts`",
    "// fails if it has drifted.",
    "",
  ];
}

/** Client surface: payment-gateway only. defaultGateway is always testnet. */
export function renderClientHosts(hosts) {
  const gw = hosts.apis["payment-gateway"];
  return [
    ...generatedHeader(),
    "export const hosts = {",
    "  paymentGateway: {",
    `    mainnet: ${JSON.stringify(gw.envs.mainnet.url)},`,
    `    testnet: ${JSON.stringify(gw.envs.testnet.url)},`,
    `    local: ${JSON.stringify(gw.envs.local.url)},`,
    "  },",
    "} as const;",
    "",
    `export const x402BasePath = ${JSON.stringify(hosts.x402BasePath)};`,
    "",
    "/** Zero-config client default: testnet, never mainnet. */",
    "export const defaultGateway = hosts.paymentGateway.testnet;",
    "",
  ].join("\n");
}

/** Payer trust list: production mainnet and testnet payment-gateway URLs. */
export function renderTrustHosts(hosts) {
  const gw = hosts.apis["payment-gateway"];
  return [
    ...generatedHeader(),
    `export const paymentGatewayMainnet = ${JSON.stringify(gw.envs.mainnet.url)};`,
    `export const paymentGatewayTestnet = ${JSON.stringify(gw.envs.testnet.url)};`,
    "",
    "export const ATUM_DEFAULT_TRUST_GATEWAYS: readonly string[] = Object.freeze([",
    "  paymentGatewayMainnet,",
    "  paymentGatewayTestnet,",
    "]);",
    "",
  ].join("\n");
}

export const CLIENT_HOSTS_TS = resolve(
  SCHEMAS_DIR,
  "apis/payment-gateway/v1/bindings/typescript/client/src/hosts.generated.ts",
);

export const TRUST_HOSTS_TS = [
  resolve(
    SCHEMAS_DIR,
    "apis/payment-gateway/v1/bindings/typescript/mppx-atum-escrow/src/hosts.generated.ts",
  ),
  resolve(SCHEMAS_DIR, "apis/x402/v1/bindings/x402-atum-escrow/src/hosts.generated.ts"),
];
