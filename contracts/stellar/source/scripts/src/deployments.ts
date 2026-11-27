/**
 * deployments-<network>.json, shaped like contracts/svm/deployments-v4.json: a map keyed by network
 * reference whose entry carries name, mainnet, contracts, and chain-specific detail.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WasmRecord {
  /** hex sha256 of the uploaded wasm; this is what the instance's executable points at */
  hash: string;
  sizeBytes: number;
}

export interface RoleRecord {
  holder: string;
  granted: boolean;
}

export interface TokenRecord {
  contract: string;
  decimals: number;
  feePercentage6: number;
  minFee6: string;
  maxFee6: string;
}

export interface DeploymentEntry {
  name: string;
  mainnet: boolean;
  deployed: boolean;
  networkPassphrase: string;
  /** hex sha256(passphrase): the `network_id` every escrow signature commits to */
  networkId: string;
  deployer: string;
  saltTag: string;
  contracts: { Escrow: string; FulfillmentProxy: string };
  wasm: { Escrow: WasmRecord; FulfillmentProxy: WasmRecord };
  /**
   * Constructor-set values are read back from the chain. For each operational escrow role, `holder`
   * is who we asked for and `granted` is what `has_role` said when the file was written.
   */
  roles: {
    Escrow: {
      defaultAdmin: string;
      adminDelaySecs: number;
      Pauser: RoleRecord;
      Treasurer: RoleRecord;
      TokenConfig: RoleRecord;
    };
    FulfillmentProxy: { defaultAdmin: string; pauser: string; adminDelaySecs: number };
  };
  /** Every token allowed on the escrow, read back from the contract */
  tokens: TokenRecord[];
  /** Set only when roles were not all applied by the deployer; the admin flow completes them */
  pendingAdminSteps: string[];
  ttl?: { extendTo: number; liveUntilLedgerSeq: number; observedAtLedger: number };
  /** Transaction hashes by step label, for the steps this run submitted */
  transactions: Record<string, string>;
}

export type DeploymentsFile = Record<string, DeploymentEntry>;

export function readDeployments(path: string): DeploymentsFile {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object keyed by network reference`);
  }
  return parsed as DeploymentsFile;
}

/** Stable key order and a trailing newline, so an unchanged re-run is a byte-identical file. */
export function serialize(file: DeploymentsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Write atomically (temp file then rename) and preserve other networks' entries. */
export function upsertDeployment(path: string, key: string, entry: DeploymentEntry): boolean {
  const current = readDeployments(path);
  const next: DeploymentsFile = { ...current, [key]: entry };
  const text = serialize(next);
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
  return true;
}
