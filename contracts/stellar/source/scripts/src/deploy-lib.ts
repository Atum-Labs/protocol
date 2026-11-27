/**
 * Deploy orchestration. Every step first asks the chain whether it is already done, so running the
 * script twice does not deploy twice: a wasm hash that is already uploaded is not re-uploaded, an
 * instance at the deterministic address is not re-created, a role or token config already in place
 * is not re-written. TTL extension is the one step that runs every time, on purpose.
 */
import { Address, Operation, scValToNative, type xdr } from '@stellar/stellar-sdk';
import { networkIdFromPassphrase } from '@atum-labs/stellar-escrow-encoding';
import { escrowArgs, proxyArgs, type RoleName } from './abi.js';
import type { TokenSpec } from './args.js';
import {
  upsertDeployment,
  readDeployments,
  type DeploymentEntry,
  type TokenRecord,
} from './deployments.js';
import {
  assertWasm,
  contractCodeKey,
  contractInstanceKey,
  deploySalt,
  deriveContractId,
  sha256,
  toHex,
  type ContractKind,
} from './ids.js';
import type { NetworkConfig } from './networks.js';
import type { SorobanRpc, TxRunner } from './runner.js';
import { extendCodeAndInstances } from './ttl.js';

/** `get_token_config` as decoded by scValToNative; null when the token is not allowed. */
type TokenConfigRead = Record<string, number | bigint>;

export interface DeployInputs {
  readonly network: NetworkConfig;
  readonly deployer: string;
  readonly escrowWasm: Uint8Array;
  readonly proxyWasm: Uint8Array;
  /** Role holders, already defaulted to the deployer by the caller */
  readonly admin: string;
  readonly pauser: string;
  readonly treasurer: string;
  readonly tokenConfig: string;
  readonly proxyAdmin: string;
  readonly proxyPauser: string;
  readonly adminDelaySecs: number;
  readonly proxyDelaySecs: number;
  readonly tokens: readonly TokenSpec[];
  readonly saltTag: string;
  readonly extendTo?: number;
  readonly deploymentsFile: string;
}

export interface DeployOutcome {
  readonly entry: DeploymentEntry;
  /** Steps found already done on chain */
  readonly skipped: readonly string[];
  /** Steps this run submitted or (dry-run) planned */
  readonly performed: readonly string[];
  readonly fileWritten: boolean;
}

interface ContractPlan {
  readonly kind: ContractKind;
  readonly label: string;
  readonly wasm: Uint8Array;
  readonly wasmHash: Buffer;
  readonly contractId: string;
  readonly salt: Buffer;
  readonly ctorArgs: xdr.ScVal[];
}

async function exists(
  rpc: SorobanRpc,
  key: xdr.LedgerKey,
): Promise<xdr.LedgerEntryData | undefined> {
  const res = await rpc.getLedgerEntries(key);
  return res.entries[0]?.val;
}

/** Hash of the wasm an instance executes, or undefined if the instance is absent. */
async function instanceWasmHash(rpc: SorobanRpc, contractId: string): Promise<string | undefined> {
  const data = await exists(rpc, contractInstanceKey(contractId));
  if (data === undefined) return undefined;
  if (data.type !== 'contractData' || data.contractData.val.type !== 'scvContractInstance') {
    throw new Error(`ledger entry at ${contractId} is not a contract instance`);
  }
  const exec = data.contractData.val.instance.executable;
  if (exec.type !== 'contractExecutableWasm') {
    throw new Error(`${contractId} is not a wasm contract (executable ${exec.type})`);
  }
  return toHex(exec.wasmHash.value);
}

function plan(i: DeployInputs): ContractPlan[] {
  const mk = (
    kind: ContractKind,
    label: string,
    wasm: Uint8Array,
    ctorArgs: xdr.ScVal[],
  ): ContractPlan => {
    assertWasm(wasm, `${label} wasm`);
    const salt = deploySalt(kind, i.saltTag);
    return {
      kind,
      label,
      wasm,
      wasmHash: sha256(wasm),
      salt,
      contractId: deriveContractId(i.network.passphrase, i.deployer, salt),
      ctorArgs,
    };
  };
  return [
    mk('escrow', 'Escrow', i.escrowWasm, escrowArgs('__constructor', i.admin, i.adminDelaySecs)),
    mk(
      'fulfillment-proxy',
      'FulfillmentProxy',
      i.proxyWasm,
      proxyArgs('__constructor', i.proxyAdmin, i.proxyPauser, i.proxyDelaySecs),
    ),
  ];
}

export async function runDeploy(
  i: DeployInputs,
  runner: TxRunner,
  rpc: SorobanRpc,
  log: (line: string) => void,
): Promise<DeployOutcome> {
  const skipped: string[] = [];
  const performed: string[] = [];
  const pending: string[] = [];
  const transactions: Record<string, string> = {};
  const record = (r: { status: string; txHash?: string }, step: string) => {
    performed.push(step);
    if (r.txHash !== undefined) transactions[step] = r.txHash;
  };

  const [escrow, proxy] = plan(i) as [ContractPlan, ContractPlan];
  const live = new Map<string, boolean>();
  /** Instances that were already on chain when this run started */
  const existed = new Set<string>();

  for (const c of [escrow, proxy]) {
    // 1. upload (content-addressed: the hash is the identity, so "exists" means done)
    const uploadStep = `upload ${c.label} wasm`;
    if ((await exists(rpc, contractCodeKey(c.wasmHash))) !== undefined) {
      skipped.push(uploadStep);
      log(`skip: ${uploadStep} (hash ${toHex(c.wasmHash)} already on chain)`);
    } else {
      record(
        await runner.execute(uploadStep, Operation.uploadContractWasm({ wasm: c.wasm })),
        uploadStep,
      );
    }

    // 2. create the instance at the deterministic address, constructor runs atomically
    const createStep = `create ${c.label} instance`;
    const onChain = await instanceWasmHash(rpc, c.contractId);
    if (onChain !== undefined) {
      if (onChain !== toHex(c.wasmHash)) {
        throw new Error(
          `${c.label} at ${c.contractId} runs wasm ${onChain}, not the supplied ${toHex(c.wasmHash)}; ` +
            'refusing to touch it. Use a new --salt-tag for a new version.',
        );
      }
      skipped.push(createStep);
      live.set(c.kind, true);
      existed.add(c.kind);
      log(`skip: ${createStep} (${c.contractId} already deployed with this wasm)`);
    } else {
      const res = await runner.execute(
        createStep,
        Operation.createCustomContract({
          address: new Address(i.deployer),
          wasmHash: c.wasmHash,
          salt: c.salt,
          constructorArgs: c.ctorArgs,
        }),
      );
      record(res, createStep);
      live.set(c.kind, !runner.dryRun);
      if (res.status === 'submitted' && res.returnValue !== undefined) {
        const got = Address.fromScVal(res.returnValue).toString();
        if (got !== c.contractId)
          throw new Error(`${c.label}: created ${got}, expected ${c.contractId}`);
      }
    }
  }

  const escrowLive = live.get('escrow') === true;
  const proxyLive = live.get('fulfillment-proxy') === true;

  const readAddr = async (cid: string, fn: string): Promise<string | undefined> => {
    const v = await runner.read(cid, fn);
    return v === undefined ? undefined : Address.fromScVal(v).toString();
  };
  const hasRole = async (role: RoleName, account: string): Promise<boolean> => {
    const v = await runner.read(
      escrow.contractId,
      'has_role',
      escrowArgs('has_role', role, account),
    );
    return v !== undefined && scValToNative(v) === true;
  };
  const readTokenConfig = async (token: string): Promise<TokenConfigRead | null> => {
    const v = await runner.read(
      escrow.contractId,
      'get_token_config',
      escrowArgs('get_token_config', token),
    );
    return v === undefined ? null : (scValToNative(v) as TokenConfigRead | null);
  };
  const readNum = async (cid: string, fn: string): Promise<number | undefined> => {
    const v = await runner.read(cid, fn);
    return v === undefined ? undefined : Number(scValToNative(v));
  };

  // Chain state is the truth for constructor-set values; flags only say what we wanted.
  let escrowAdmin = i.admin;
  let escrowDelay = i.adminDelaySecs;
  if (escrowLive) {
    escrowAdmin = (await readAddr(escrow.contractId, 'default_admin')) ?? i.admin;
    escrowDelay = (await readNum(escrow.contractId, 'default_admin_delay')) ?? i.adminDelaySecs;
    mismatch('Escrow default admin', escrowAdmin, i.admin, 'escrow');
    mismatch('Escrow admin delay', escrowDelay, i.adminDelaySecs, 'escrow');
  }
  let proxyAdmin = i.proxyAdmin;
  let proxyPauser = i.proxyPauser;
  let proxyDelay = i.proxyDelaySecs;
  if (proxyLive) {
    proxyAdmin = (await readAddr(proxy.contractId, 'default_admin')) ?? i.proxyAdmin;
    proxyPauser = (await readAddr(proxy.contractId, 'pauser')) ?? i.proxyPauser;
    proxyDelay = (await readNum(proxy.contractId, 'default_admin_delay')) ?? i.proxyDelaySecs;
    mismatch('Proxy default admin', proxyAdmin, i.proxyAdmin, 'fulfillment-proxy');
    mismatch('Proxy pauser', proxyPauser, i.proxyPauser, 'fulfillment-proxy');
    mismatch('Proxy admin delay', proxyDelay, i.proxyDelaySecs, 'fulfillment-proxy');
  }

  function mismatch(
    what: string,
    onChain: string | number,
    wanted: string | number,
    kind: ContractKind,
  ) {
    if (onChain === wanted) return;
    if (!existed.has(kind)) {
      throw new Error(`${what} is ${onChain} after deploy, expected ${wanted}`);
    }
    // Constructor arguments are immutable; changing them later is the admin's rotation flow
    pending.push(
      `${what} is ${onChain} on chain, requested ${wanted}; change it through the admin`,
    );
  }

  // 3. escrow roles. The constructor only sets the default admin; the three operational roles are
  // granted. Whether each is held is read from the chain, so nothing here depends on the flags alone.
  const roleHolders: [RoleName, string][] = [
    ['Pauser', i.pauser],
    ['Treasurer', i.treasurer],
    ['TokenConfig', i.tokenConfig],
  ];
  //
  // Rotation is refused, not performed: granting NEW while OLD still holds the role would leave two
  // holders on chain while the deployments file records one. The previous holder comes from the
  // file (the contract has no member enumeration), and has_role confirms it still holds the role.
  const recorded = readDeployments(i.deploymentsFile)[i.network.caip2];
  if (
    escrowLive &&
    recorded?.deployed === true &&
    recorded.contracts.Escrow === escrow.contractId
  ) {
    const stale: string[] = [];
    for (const [role, holder] of roleHolders) {
      const old = recorded.roles.Escrow[role].holder;
      if (old === holder) continue;
      if (await hasRole(role, old)) {
        stale.push(`${role}: ${old} still holds it on chain, requested ${holder}`);
      }
    }
    if (stale.length > 0) {
      throw new Error(
        `refusing to change Escrow role holders: ${stale.join('; ')}. ` +
          'Granting the new holder would leave both holding the role while the deployments file ' +
          'records one. Rotating a role (revoke_role on the old holder) belongs to the admin flow; ' +
          'revoke the old holder first, then re-run.',
      );
    }
  }
  const granted: Record<string, boolean> = {};
  for (const [role, holder] of roleHolders) {
    const step = `grant Escrow role ${role} to ${holder}`;
    if (escrowLive && (await hasRole(role, holder))) {
      skipped.push(step);
      granted[role] = true;
      log(`skip: ${step} (already held)`);
      continue;
    }
    if (escrowAdmin !== i.deployer) {
      // Needs a signer we do not have: keep it pending without simulating
      pending.push(`${step} (needs default admin ${escrowAdmin} to sign)`);
      granted[role] = false;
      continue;
    }
    record(
      await runner.invoke(
        step,
        escrow.contractId,
        'grant_role',
        escrowArgs('grant_role', role, holder),
      ),
      step,
    );
    granted[role] = !runner.dryRun;
  }

  // 4. tokens and fees. Satisfied state is skipped before asking who could sign.
  const holdsTokenConfig = async (): Promise<boolean> => {
    if (i.tokenConfig !== i.deployer) return false;
    if (!escrowLive) return escrowAdmin === i.deployer;
    return hasRole('TokenConfig', i.deployer);
  };
  for (const t of i.tokens) {
    const step = `allow token ${t.contract} + fees`;
    const cfg = escrowLive ? await readTokenConfig(t.contract) : null;
    if (cfg != null) {
      if (Number(cfg.token_decimals) !== t.decimals) {
        throw new Error(
          `token ${t.contract} is allowed with ${String(cfg.token_decimals)} decimals, not ${t.decimals}`,
        );
      }
      const same =
        Number(cfg.fee_percentage_6) === t.feePercentage6 &&
        BigInt(cfg.min_fee_6 ?? 0) === t.minFee6 &&
        BigInt(cfg.max_fee_6 ?? 0) === t.maxFee6;
      if (same) {
        skipped.push(step);
        log(`skip: ${step} (already configured identically)`);
        continue;
      }
    }
    if (!(await holdsTokenConfig())) {
      pending.push(
        `${step} (caller must be the TokenConfig holder ${i.tokenConfig}, and hold the role)`,
      );
      continue;
    }
    if (cfg == null) {
      record(
        await runner.invoke(
          step,
          escrow.contractId,
          'allow_token_and_set_fee_config',
          escrowArgs(
            'allow_token_and_set_fee_config',
            i.tokenConfig,
            t.contract,
            t.decimals,
            t.feePercentage6,
            t.minFee6,
            t.maxFee6,
          ),
        ),
        step,
      );
    } else {
      const upd = `update fees for token ${t.contract}`;
      record(
        await runner.invoke(
          upd,
          escrow.contractId,
          'set_token_fee_config',
          escrowArgs(
            'set_token_fee_config',
            i.tokenConfig,
            t.contract,
            t.feePercentage6,
            t.minFee6,
            t.maxFee6,
          ),
        ),
        upd,
      );
    }
  }

  // 5. the tokens record is read back from the contract, so it never loses earlier runs' entries
  let tokens: TokenRecord[] = i.tokens.map((t) => ({
    contract: t.contract,
    decimals: t.decimals,
    feePercentage6: t.feePercentage6,
    minFee6: t.minFee6.toString(),
    maxFee6: t.maxFee6.toString(),
  }));
  if (escrowLive) {
    const list = await runner.read(escrow.contractId, 'get_allowed_tokens');
    if (list !== undefined) {
      const onChain: TokenRecord[] = [];
      for (const addr of scValToNative(list) as string[]) {
        const n = await readTokenConfig(addr);
        if (n == null) continue;
        onChain.push({
          contract: addr,
          decimals: Number(n.token_decimals),
          feePercentage6: Number(n.fee_percentage_6),
          minFee6: BigInt(n.min_fee_6 ?? 0).toString(),
          maxFee6: BigInt(n.max_fee_6 ?? 0).toString(),
        });
      }
      tokens = onChain;
    }
  }

  // 6. TTL of code and instances, every run
  const ttl = await extendCodeAndInstances(
    runner,
    rpc,
    [
      { wasmHash: escrow.wasmHash, contractId: escrow.contractId },
      { wasmHash: proxy.wasmHash, contractId: proxy.contractId },
    ],
    i.extendTo,
  );
  performed.push('extend TTL of code and instances');

  // 7. record
  const key = i.network.caip2;
  const previous = readDeployments(i.deploymentsFile)[key];
  const entry: DeploymentEntry = {
    name: i.network.displayName,
    mainnet: i.network.mainnet,
    deployed: true,
    networkPassphrase: i.network.passphrase,
    networkId: toHex(networkIdFromPassphrase(i.network.passphrase)),
    deployer: i.deployer,
    saltTag: i.saltTag,
    contracts: { Escrow: escrow.contractId, FulfillmentProxy: proxy.contractId },
    wasm: {
      Escrow: { hash: toHex(escrow.wasmHash), sizeBytes: escrow.wasm.length },
      FulfillmentProxy: { hash: toHex(proxy.wasmHash), sizeBytes: proxy.wasm.length },
    },
    roles: {
      Escrow: {
        defaultAdmin: escrowAdmin,
        adminDelaySecs: escrowDelay,
        Pauser: { holder: i.pauser, granted: granted.Pauser === true },
        Treasurer: { holder: i.treasurer, granted: granted.Treasurer === true },
        TokenConfig: { holder: i.tokenConfig, granted: granted.TokenConfig === true },
      },
      FulfillmentProxy: {
        defaultAdmin: proxyAdmin,
        pauser: proxyPauser,
        adminDelaySecs: proxyDelay,
      },
    },
    tokens,
    pendingAdminSteps: pending,
    ...(ttl.liveUntilLedgerSeq !== undefined
      ? {
          ttl: {
            extendTo: ttl.extendTo,
            liveUntilLedgerSeq: ttl.liveUntilLedgerSeq,
            observedAtLedger: ttl.observedAtLedger,
          },
        }
      : {}),
    // Keep hashes from earlier runs; a re-run that submits nothing must not erase the record
    transactions: {
      ...(previous?.deployed === true && previous.contracts.Escrow === escrow.contractId
        ? previous.transactions
        : {}),
      ...transactions,
    },
  };

  let fileWritten = false;
  if (runner.dryRun) {
    log(`[dry-run] would write ${i.deploymentsFile}:`);
    log(JSON.stringify({ [key]: entry }, null, 2));
  } else {
    fileWritten = upsertDeployment(i.deploymentsFile, key, entry);
    log(fileWritten ? `wrote ${i.deploymentsFile}` : `${i.deploymentsFile} already up to date`);
  }
  return { entry, skipped, performed, fileWritten };
}

/**
 * `extend-ttl` subcommand: the keeper for code, instances and the escrow's token balances.
 *
 * The allowlist is read from the escrow itself (`get_allowed_tokens`, a simulated read, nothing is
 * submitted), so a token allowed since the last `deploy` run is covered without refreshing the
 * deployments file. The read is mandatory: if it fails the run fails, because falling back to the file
 * would silently extend a stale list. Tokens recorded in the file are added to the on-chain list, because
 * `disallow_token` leaves deposits in flight releasable and their balance entry still has to live; the
 * escrow no longer lists such a token, but an earlier `deploy` run may have recorded it.
 */
export async function runExtendTtl(
  entry: DeploymentEntry,
  runner: TxRunner,
  rpc: SorobanRpc,
  extendTo: number | undefined,
): Promise<DeploymentEntry> {
  const escrow = entry.contracts.Escrow;
  const list = await runner.read(escrow, 'get_allowed_tokens');
  if (list === undefined) {
    throw new Error(
      `get_allowed_tokens on ${escrow} returned no value; refusing to extend from a possibly stale list`,
    );
  }
  const onChain = scValToNative(list) as string[];
  const recordedOnly = entry.tokens.map((t) => t.contract).filter((t) => !onChain.includes(t));
  const tokens = [...new Set([...onChain, ...recordedOnly])];
  runner.log(
    `escrow ${escrow} lists ${onChain.length} allowlisted token(s)` +
      (recordedOnly.length > 0
        ? `; ${recordedOnly.length} more recorded in the deployments file but no longer listed: ${recordedOnly.join(', ')}`
        : ''),
  );
  if (tokens.length === 0) {
    runner.log(
      'WARNING: the escrow reports no allowlisted token and none is recorded, so no token balance entry was extended',
    );
  }
  const ttl = await extendCodeAndInstances(
    runner,
    rpc,
    [
      { wasmHash: Buffer.from(entry.wasm.Escrow.hash, 'hex'), contractId: entry.contracts.Escrow },
      {
        wasmHash: Buffer.from(entry.wasm.FulfillmentProxy.hash, 'hex'),
        contractId: entry.contracts.FulfillmentProxy,
      },
    ],
    extendTo,
    // The escrow's balance in every allowlisted token: the token extends it only when the escrow's own
    // balance is touched, and `extend_deposit_ttl` does not
    tokens.map((t) => ({ token: t, holder: escrow })),
  );
  return ttl.liveUntilLedgerSeq === undefined
    ? entry
    : {
        ...entry,
        ttl: {
          extendTo: ttl.extendTo,
          liveUntilLedgerSeq: ttl.liveUntilLedgerSeq,
          observedAtLedger: ttl.observedAtLedger,
        },
      };
}
