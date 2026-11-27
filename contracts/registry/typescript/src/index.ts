/**
 * @atum-labs/contract-registry: the contract version registry (../chains/*.json), bundled at build
 * time. Mirrors the Go package github.com/atum-labs/protocol/contracts/registry, which validates the files.
 */
import eip155_1 from '../../chains/eip155_1.json';
import eip155_10 from '../../chains/eip155_10.json';
import eip155_11142220 from '../../chains/eip155_11142220.json';
import eip155_11155111 from '../../chains/eip155_11155111.json';
import eip155_11155420 from '../../chains/eip155_11155420.json';
import eip155_137 from '../../chains/eip155_137.json';
import eip155_42161 from '../../chains/eip155_42161.json';
import eip155_421614 from '../../chains/eip155_421614.json';
import eip155_4217 from '../../chains/eip155_4217.json';
import eip155_42220 from '../../chains/eip155_42220.json';
import eip155_42431 from '../../chains/eip155_42431.json';
import eip155_43113 from '../../chains/eip155_43113.json';
import eip155_43114 from '../../chains/eip155_43114.json';
import eip155_5042 from '../../chains/eip155_5042.json';
import eip155_5042002 from '../../chains/eip155_5042002.json';
import eip155_80002 from '../../chains/eip155_80002.json';
import eip155_8453 from '../../chains/eip155_8453.json';
import eip155_84532 from '../../chains/eip155_84532.json';
import solana_5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp from '../../chains/solana_5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp.json';
import solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1 from '../../chains/solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1.json';
import stellar_testnet from '../../chains/stellar_testnet.json';
import tron_mainnet from '../../chains/tron_mainnet.json';
import tron_shasta from '../../chains/tron_shasta.json';

export interface Signature {
  eip712Name?: string;
  eip712Version?: string;
  svmDomainVersion?: number;
  /** The form a Solana signer signs for this version; absent or '' is the raw 32 byte hash. */
  svmMessage?: string;
  /** The version byte every Stellar escrow digest commits to. */
  stellarDomainVersion?: number;
}

export interface Version {
  id: string;
  source: string;
  escrow: string;
  fulfillmentProxies: string[];
  permit2?: string;
  signature: Signature;
  unrecordedFulfillmentProxies?: Record<string, string>;
}

export interface Chain {
  chain: string;
  name: string;
  mainnet: boolean;
  versions: Version[];
}

/** Every chain file in ../chains, keyed by file name. A test keeps it equal to the directory. */
export const CHAIN_FILES: Readonly<Record<string, Chain>> = {
  'eip155_1.json': eip155_1,
  'eip155_10.json': eip155_10,
  'eip155_11142220.json': eip155_11142220,
  'eip155_11155111.json': eip155_11155111,
  'eip155_11155420.json': eip155_11155420,
  'eip155_137.json': eip155_137,
  'eip155_42161.json': eip155_42161,
  'eip155_421614.json': eip155_421614,
  'eip155_4217.json': eip155_4217,
  'eip155_42220.json': eip155_42220,
  'eip155_42431.json': eip155_42431,
  'eip155_43113.json': eip155_43113,
  'eip155_43114.json': eip155_43114,
  'eip155_5042.json': eip155_5042,
  'eip155_5042002.json': eip155_5042002,
  'eip155_80002.json': eip155_80002,
  'eip155_8453.json': eip155_8453,
  'eip155_84532.json': eip155_84532,
  'solana_5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp.json': solana_5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp,
  'solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1.json': solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1,
  'stellar_testnet.json': stellar_testnet,
  'tron_mainnet.json': tron_mainnet,
  'tron_shasta.json': tron_shasta,
};

/**
 * An environment's version ids per chain: the versions new payments may name. It doesn't pick a
 * default; each service keeps its configured escrow as the default.
 */
export type EnvList = Map<string, string[]>;

/** Folds case on EVM chains only; Tron and Solana addresses are case sensitive base58. */
function normalize(caip2: string, addr: string): string {
  const a = addr.trim();
  return caip2.startsWith('eip155:') ? a.toLowerCase() : a;
}

export class Registry {
  private readonly byChain = new Map<string, Chain>();
  private readonly folded = new Map<string, string>(); // lower-cased chain id -> chain id

  constructor(files: Readonly<Record<string, Chain>>) {
    for (const [file, c] of Object.entries(files)) {
      const want = c.chain.replaceAll(':', '_') + '.json';
      if (file !== want) {
        throw new Error(`registry ${file}: holds chain ${JSON.stringify(c.chain)}, want file ${want}`);
      }
      const other = this.folded.get(c.chain.toLowerCase());
      if (other !== undefined) {
        throw new Error(`registry ${file}: chain ${JSON.stringify(c.chain)} differs from ${JSON.stringify(other)} only in case`);
      }
      this.byChain.set(c.chain, c);
      this.folded.set(c.chain.toLowerCase(), c.chain);
    }
  }

  /** Every chain id, sorted. */
  chains(): string[] {
    return [...this.byChain.keys()].sort();
  }

  /** The versions on one chain. The chain id matches regardless of case. */
  chain(caip2: string): Chain | undefined {
    const id = this.folded.get(caip2.toLowerCase());
    return id === undefined ? undefined : this.byChain.get(id);
  }

  /** One version by chain and id. */
  version(caip2: string, id: string): Version | undefined {
    return this.chain(caip2)?.versions.find((v) => v.id === id);
  }

  /**
   * The version whose escrow is addr. EVM addresses match regardless of case; Tron and Solana exactly.
   * Undefined for an escrow no version lists, so a caller has no scheme or domain to read for it.
   */
  versionOfEscrow(caip2: string, addr: string): Version | undefined {
    const c = this.chain(caip2);
    if (c === undefined) return undefined;
    return c.versions.find((v) => normalize(c.chain, v.escrow) === normalize(c.chain, addr));
  }

  /** The versions `list` names for the chain, in list order. The chain id matches regardless of case. */
  allowed(list: EnvList, caip2: string): Version[] {
    const c = this.chain(caip2);
    if (c === undefined) return [];
    return (list.get(c.chain) ?? []).flatMap((id) => this.version(c.chain, id) ?? []);
  }
}

/** Loads the bundled registry, or `files` when given. */
export function load(files: Readonly<Record<string, Chain>> = CHAIN_FILES): Registry {
  return new Registry(files);
}

/** Parses "chain=id[,id];chain=id" as set in env-config.yaml, with the Go ParseEnvList rules. */
export function parseEnvList(s: string): EnvList {
  const out: EnvList = new Map();
  for (const raw of s.split(';')) {
    const part = raw.trim();
    if (part === '') continue;
    const i = part.lastIndexOf('=');
    const chain = i <= 0 ? '' : part.slice(0, i).trim();
    if (chain === '') throw new Error(`${JSON.stringify(part)}: want chain=id[,id]`);
    if (out.has(chain)) throw new Error(`chain ${chain} listed twice`);
    const ids: string[] = [];
    for (const rawId of part.slice(i + 1).split(',')) {
      const id = rawId.trim();
      if (id === '') throw new Error(`chain ${chain}: empty version id`);
      if (ids.includes(id)) throw new Error(`chain ${chain}: version id ${id} listed twice`);
      ids.push(id);
    }
    out.set(chain, ids);
  }
  return out;
}
