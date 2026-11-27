#!/usr/bin/env node
/**
 * Unit tests for the hosts.yaml parser, servers rewrite, and host-literal deny-list.
 *
 * The deny-list cases are the proof that a leftover atum.network / unknown
 * *.atum.xyz host fails: they run on inline fixtures so they cannot go green
 * by scanning a clean tree.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HOSTS_YAML,
  parseHostsYaml,
  loadHosts,
  replaceServers,
  renderClientHosts,
  renderTrustHosts,
  serversBlock,
  ssotUrls,
} from "./hosts.mjs";
import { findHostHits } from "./check-host-literals.mjs";

const FIXTURE = `
x402_base_path: /x402/v1

payment-gateway:
  spec: payment-gateway/v1/openapi.yaml
  embed:
    - payment-gateway/v1/embed/go/openapi.yaml
  default_env: testnet
  mainnet: https://payment-gw.production-mainnet.atum.xyz
  testnet: https://payment-gw.production-testnet.atum.xyz
  local: http://localhost:8080

veri-fill:
  spec: veri-fill/v1/openapi.yaml
  mainnet: https://veri-fill.production-mainnet.atum.xyz
  testnet: https://veri-fill.production-testnet.atum.xyz
  local: http://localhost:8088

auth:
  spec: auth/v1/openapi.yaml
  mainnet: https://auth.production-mainnet.atum.xyz
  testnet: https://auth.production-testnet.atum.xyz
  local: http://localhost:8080
`;

test("parseHostsYaml reads the committed SSOT", () => {
  const hosts = loadHosts();
  assert.equal(hosts.x402BasePath, "/x402/v1");
  assert.equal(
    hosts.apis["payment-gateway"].envs.testnet.url,
    "https://payment-gw.production-testnet.atum.xyz",
  );
  assert.equal(hosts.apis["veri-fill"].envs.local.url, "http://localhost:8088");
  assert.equal(hosts.apis["payment-gateway"].defaultEnv, "testnet");
  assert.equal(hosts.apis.auth.defaultEnv, "");
  assert.equal(hosts.apis["veri-fill"].defaultEnv, "");
  assert.deepEqual(hosts.apis["payment-gateway"].embed, [
    "payment-gateway/v1/embed/go/openapi.yaml",
  ]);
});

test("parseHostsYaml rejects an unknown key", () => {
  assert.throws(
    () => parseHostsYaml(FIXTURE + "\nwallet-orch:\n  spec: x\n"),
    /unknown top-level key 'wallet-orch'/,
  );
});

test("parseHostsYaml rejects a missing env", () => {
  const missing = FIXTURE.replace(
    "  local: http://localhost:8088\n",
    "",
  );
  assert.throws(() => parseHostsYaml(missing), /veri-fill.local/);
});

test("replaceServers is a no-op on the committed payment-gateway spec", () => {
  const hosts = loadHosts();
  const spec = readFileSync(
    new URL("../apis/payment-gateway/v1/openapi.yaml", import.meta.url),
    "utf8",
  );
  assert.equal(replaceServers(spec, hosts.apis["payment-gateway"]), spec);
});

test("replaceServers rewrites a drifted servers block", () => {
  const hosts = parseHostsYaml(FIXTURE);
  const drifted = [
    "openapi: 3.0.3",
    "servers:",
    "  - url: https://api.atum.network",
    "    description: Mainnet",
    "paths: {}",
    "",
  ].join("\n");
  const out = replaceServers(drifted, hosts.apis["payment-gateway"]);
  assert.equal(
    out,
    ["openapi: 3.0.3", serversBlock(hosts.apis["payment-gateway"]) + "paths: {}", ""].join(
      "\n",
    ),
  );
});

test("renderClientHosts defaults the client to testnet", () => {
  const ts = renderClientHosts(parseHostsYaml(FIXTURE));
  assert.match(ts, /export const defaultGateway = hosts.paymentGateway.testnet;/);
  assert.match(ts, /https:\/\/payment-gw.production-testnet.atum.xyz/);
  assert.match(ts, /GENERATED FILE/);
  assert.doesNotMatch(ts, /veriFill|auth:/);
});

test("committed hosts.yaml has default_env only on payment-gateway", () => {
  const text = readFileSync(HOSTS_YAML, "utf8");
  const envs = [...text.matchAll(/^  default_env: (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(envs, ["testnet"]);
  const hosts = loadHosts();
  assert.equal(hosts.apis["payment-gateway"].defaultEnv, "testnet");
  assert.equal(hosts.apis["veri-fill"].defaultEnv, "");
  assert.equal(hosts.apis.auth.defaultEnv, "");
});

test("parseHostsYaml rejects default_env on veri-fill or auth", () => {
  for (const [name, needle] of [
    ["veri-fill", "veri-fill:\n  spec: veri-fill/v1/openapi.yaml\n  mainnet:"],
    ["auth", "auth:\n  spec: auth/v1/openapi.yaml\n  mainnet:"],
  ]) {
    const bad = FIXTURE.replace(needle, needle.replace("\n  mainnet:", "\n  default_env: testnet\n  mainnet:"));
    assert.throws(
      () => parseHostsYaml(bad),
      /only valid under payment-gateway/,
      `expected to reject default_env under ${name}`,
    );
  }
});

test("serversBlock is always mainnet, then testnet, then local", () => {
  const hosts = parseHostsYaml(FIXTURE);
  // payment-gateway still has default_env: testnet; that must not reorder servers:
  for (const name of ["payment-gateway", "veri-fill", "auth"]) {
    const api = hosts.apis[name];
    const urls = [...serversBlock(api).matchAll(/url: (\S+)/g)].map((m) => m[1]);
    assert.deepEqual(
      urls,
      [api.envs.mainnet.url, api.envs.testnet.url, api.envs.local.url],
      `${name} servers: must ignore default_env`,
    );
  }
});

test("parseHostsYaml rejects payment-gateway default_env mainnet", () => {
  const bad = FIXTURE.replace(
    "payment-gateway:\n  spec: payment-gateway/v1/openapi.yaml\n  embed:\n    - payment-gateway/v1/embed/go/openapi.yaml\n  default_env: testnet",
    "payment-gateway:\n  spec: payment-gateway/v1/openapi.yaml\n  embed:\n    - payment-gateway/v1/embed/go/openapi.yaml\n  default_env: mainnet",
  );
  assert.throws(() => parseHostsYaml(bad), /must be testnet/);
});

test("parseHostsYaml strips YAML quotes so the URL matches the yaml package", () => {
  const quoted = FIXTURE.replace(
    "  testnet: https://payment-gw.production-testnet.atum.xyz",
    '  testnet: "https://payment-gw.production-testnet.atum.xyz"',
  );
  const hosts = parseHostsYaml(quoted);
  assert.equal(
    hosts.apis["payment-gateway"].envs.testnet.url,
    "https://payment-gw.production-testnet.atum.xyz",
  );
});

test("parseHostsYaml rejects a host without a scheme", () => {
  const bad = FIXTURE.replace(
    "  testnet: https://payment-gw.production-testnet.atum.xyz",
    "  testnet: payment-gw.production-testnet.atum.xyz",
  );
  assert.throws(() => parseHostsYaml(bad), /is not a URL/);
});

test("parseHostsYaml rejects a trailing slash", () => {
  const bad = FIXTURE.replace(
    "  testnet: https://payment-gw.production-testnet.atum.xyz",
    "  testnet: https://payment-gw.production-testnet.atum.xyz/",
  );
  assert.throws(() => parseHostsYaml(bad), /must not end with \//);
});

test("parseHostsYaml rejects a duplicate env key", () => {
  const bad = FIXTURE.replace(
    "  testnet: https://payment-gw.production-testnet.atum.xyz\n",
    "  testnet: https://payment-gw.production-testnet.atum.xyz\n  testnet: https://payment-gw.production-testnet.atum.xyz\n",
  );
  assert.throws(() => parseHostsYaml(bad), /duplicate key 'payment-gateway.testnet'/);
});

test("renderTrustHosts is mainnet then testnet from hosts.yaml", () => {
  const hosts = loadHosts();
  const gw = hosts.apis["payment-gateway"];
  const ts = renderTrustHosts(hosts);
  assert.match(ts, new RegExp(`paymentGatewayMainnet = ${JSON.stringify(gw.envs.mainnet.url)}`));
  assert.match(ts, new RegExp(`paymentGatewayTestnet = ${JSON.stringify(gw.envs.testnet.url)}`));
  assert.match(ts, /ATUM_DEFAULT_TRUST_GATEWAYS/);
  assert.ok(ts.indexOf(gw.envs.mainnet.url) < ts.indexOf(gw.envs.testnet.url));
});

test("deny-list fails on a leftover atum.network service URL", () => {
  const allowed = ssotUrls(parseHostsYaml(FIXTURE));
  const hits = findHostHits(
    'example: "https://verifier.atum.network/api/v1/verify"',
    allowed,
  );
  assert.equal(hits.length, 1);
  assert.match(hits[0].why, /deprecated/);
  assert.match(hits[0].url, /atum.network/);
});

test("deny-list fails on an unknown *.atum.xyz service host", () => {
  const allowed = ssotUrls(parseHostsYaml(FIXTURE));
  const hits = findHostHits("BASE: https://gateway.testnet.atum.xyz", allowed);
  assert.equal(hits.length, 1);
  assert.match(hits[0].why, /not in schemas\/apis\/hosts.yaml/);
});

test("deny-list allows SSOT URLs, docs/schemas hosts, and did:web:atumlabs.xyz", () => {
  const allowed = ssotUrls(parseHostsYaml(FIXTURE));
  const ok = [
    "https://payment-gw.production-testnet.atum.xyz",
    "https://payment-gw.production-testnet.atum.xyz/x402/v1",
    "https://schemas.atum.xyz/declarations/PaymentRequest/v1",
    "https://docs.atum.xyz/errors",
    "issuer: did:web:atumlabs.xyz",
    "https://schemas.atum.network/declarations/PaymentRequest/v1/context.jsonld",
  ].join("\n");
  assert.deepEqual(findHostHits(ok, allowed), []);
});

test("committed hosts.yaml is the file loadHosts reads", () => {
  assert.match(readFileSync(HOSTS_YAML, "utf8"), /x402_base_path: \/x402\/v1/);
});
