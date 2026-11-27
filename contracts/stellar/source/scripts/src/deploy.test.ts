import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Address, Keypair, StrKey, scValToNative } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDeploy, runExtendTtl, type DeployInputs } from './deploy-lib.js';
import { main, type MainDeps } from './deploy.js';
import { readDeployments } from './deployments.js';
import { escrowArgs } from './abi.js';
import { deploySalt, deriveContractId, sha256, toHex, tokenBalanceKey } from './ids.js';
import { MAINNET_ALLOWLIST_ENV, NETWORKS } from './networks.js';
import { TxRunner } from './runner.js';
import { FakeChain, WASM_A, WASM_B } from './test-helpers.js';

const net = NETWORKS.testnet;
const deployer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const token = StrKey.encodeContract(Buffer.alloc(32, 9));

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stellar-deploy-'));
  file = join(dir, 'deployments-testnet.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function inputs(over: Partial<DeployInputs> = {}): DeployInputs {
  const d = deployer.publicKey();
  return {
    network: net,
    deployer: d,
    escrowWasm: WASM_A,
    proxyWasm: WASM_B,
    admin: d,
    pauser: d,
    treasurer: d,
    tokenConfig: d,
    proxyAdmin: d,
    proxyPauser: d,
    adminDelaySecs: 1,
    proxyDelaySecs: 1,
    tokens: [{ contract: token, decimals: 7, feePercentage6: 1_000_000, minFee6: 0n, maxFee6: 0n }],
    saltTag: 'v1',
    deploymentsFile: file,
    ...over,
  };
}

/** A runner over `chain`; `keyless` signs with the public address only (dry-run use). */
function makeRunner(chain: FakeChain, dryRun: boolean, log: (l: string) => void, keyless = false) {
  return new TxRunner({
    rpc: chain,
    networkPassphrase: net.passphrase,
    signer: keyless
      ? { publicKey: deployer.publicKey() }
      : { publicKey: deployer.publicKey(), keypair: deployer },
    dryRun,
    log,
  });
}

function setup(dryRun: boolean, opts: { chain?: FakeChain; keyless?: boolean } = {}) {
  const chain = opts.chain ?? new FakeChain(net.passphrase, [deployer.publicKey()]);
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);
  const runner = makeRunner(chain, dryRun, log, opts.keyless);
  return { chain, logs, log, runner };
}

const escrowId = deriveContractId(net.passphrase, deployer.publicKey(), deploySalt('escrow', 'v1'));
const proxyId = deriveContractId(
  net.passphrase,
  deployer.publicKey(),
  deploySalt('fulfillment-proxy', 'v1'),
);

describe('deploy against a fake chain', () => {
  it('uploads, creates with the right constructor args, grants roles, configures the token, extends TTL, writes the file', async () => {
    const { chain, log, runner } = setup(false);
    const out = await runDeploy(inputs(), runner, chain, log);

    expect(chain.sent.map((s) => (s.kind === 'invoke' ? s.fn : s.kind))).toEqual([
      'upload',
      'create',
      'upload',
      'create',
      'grant_role',
      'grant_role',
      'grant_role',
      'allow_token_and_set_fee_config',
      'extend',
    ]);
    const d = deployer.publicKey();
    const creates = chain.sent.filter((s) => s.kind === 'create');
    // constructor args reach the chain in contract order
    expect(creates[0]?.args?.[2]).toEqual([d, 1]);
    expect(creates[1]?.args?.[2]).toEqual([d, d, 1]);
    // roles, in the order Pauser, Treasurer, TokenConfig
    expect(
      chain.sent.filter((s) => s.fn === 'grant_role').map((s) => (s.args?.[0] as string[])[0]),
    ).toEqual(['Pauser', 'Treasurer', 'TokenConfig']);
    expect(chain.sent.find((s) => s.fn === 'allow_token_and_set_fee_config')?.args).toEqual([
      d,
      token,
      7,
      1_000_000,
      0n,
      0n,
    ]);
    // TTL: code + instance of both contracts in the read-only footprint
    expect(chain.sent.at(-1)).toMatchObject({ kind: 'extend', footprintKeys: 4 });
    expect(out.fileWritten).toBe(true);

    const written = readDeployments(file)['stellar:testnet'];
    expect(written?.contracts).toEqual({ Escrow: escrowId, FulfillmentProxy: proxyId });
    expect(written?.wasm.Escrow).toEqual({ hash: toHex(sha256(WASM_A)), sizeBytes: WASM_A.length });
    expect(written?.networkId).toBe(toHex(sha256(Buffer.from(net.passphrase))));
    expect(written?.mainnet).toBe(false);
    expect(written?.ttl?.liveUntilLedgerSeq).toBeGreaterThan(chain.latestLedger);
    expect(written?.pendingAdminSteps).toEqual([]);
    expect(JSON.stringify(readFileSync(file, 'utf8'))).not.toMatch(/\bS[A-Z2-7]{55}\b/);
  });

  it('extends TTL to max-1 by default and honours --extend-to', async () => {
    const a = setup(false);
    await runDeploy(inputs(), a.runner, a.chain, a.log);
    expect(readDeployments(file)['stellar:testnet']?.ttl?.extendTo).toBe(a.chain.maxEntryTtl - 1);

    const b = setup(false);
    await runDeploy(
      inputs({ extendTo: 500_000, deploymentsFile: join(dir, 'b.json') }),
      b.runner,
      b.chain,
      b.log,
    );
    expect(readDeployments(join(dir, 'b.json'))['stellar:testnet']?.ttl?.extendTo).toBe(500_000);
  });

  it('refuses an extend-to at or above the network max', async () => {
    const { chain, log, runner } = setup(false);
    await expect(
      runDeploy(inputs({ extendTo: chain.maxEntryTtl }), runner, chain, log),
    ).rejects.toThrow(/below the network max/);
  });

  it('is idempotent: a second run redeploys nothing and only re-extends TTL', async () => {
    const { chain, log, runner } = setup(false);
    await runDeploy(inputs(), runner, chain, log);
    const firstFile = readFileSync(file, 'utf8');
    chain.sent.length = 0;

    const second = await runDeploy(inputs(), runner, chain, log);
    expect(chain.sent.map((s) => s.kind)).toEqual(['extend']);
    expect(second.skipped).toEqual(
      expect.arrayContaining([
        'upload Escrow wasm',
        'create Escrow instance',
        'upload FulfillmentProxy wasm',
        'create FulfillmentProxy instance',
        expect.stringMatching(/^grant Escrow role Pauser/),
        expect.stringMatching(/^allow token /),
      ]),
    );
    const entry = readDeployments(file)['stellar:testnet'];
    expect(entry?.contracts).toEqual({ Escrow: escrowId, FulfillmentProxy: proxyId });
    // original deploy transaction hashes survive the no-op run
    expect(Object.keys(entry?.transactions ?? {})).toContain('create Escrow instance');
    expect(JSON.parse(firstFile)['stellar:testnet'].contracts).toEqual(entry?.contracts);
  });

  it('re-running after a partial failure resumes instead of redeploying', async () => {
    const { chain, log, runner } = setup(false);
    // The first grant_role lands on chain, then the connection drops before the script sees the result
    const real = chain.sendTransaction.bind(chain);
    let boom = true;
    chain.sendTransaction = async (tx) => {
      const r = await real(tx);
      if (boom && chain.sent.at(-1)?.fn === 'grant_role') {
        boom = false;
        throw new Error('network blip after grant');
      }
      return r;
    };
    await expect(runDeploy(inputs(), runner, chain, log)).rejects.toThrow(/blip/);
    chain.sent.length = 0;
    await runDeploy(inputs(), runner, chain, log);
    const kinds = chain.sent.map((s) => (s.kind === 'invoke' ? s.fn : s.kind));
    expect(kinds).not.toContain('upload');
    expect(kinds).not.toContain('create');
    // the grant that landed before the blip is not repeated
    expect(kinds.filter((k) => k === 'grant_role')).toHaveLength(2);
  });

  it('updates fees on an existing token only when they differ', async () => {
    const { chain, log, runner } = setup(false);
    await runDeploy(inputs(), runner, chain, log);
    chain.sent.length = 0;
    await runDeploy(
      inputs({
        tokens: [
          { contract: token, decimals: 7, feePercentage6: 2_000_000, minFee6: 0n, maxFee6: 0n },
        ],
      }),
      runner,
      chain,
      log,
    );
    expect(chain.sent.map((s) => s.fn ?? s.kind)).toEqual(['set_token_fee_config', 'extend']);
    expect(chain.sent[0]?.args).toEqual([deployer.publicKey(), token, 2_000_000, 0n, 0n]);
  });

  it('refuses to touch an instance at the deterministic address that runs different wasm', async () => {
    const { chain, log, runner } = setup(false);
    chain.seedInstance(escrowId, toHex(sha256(Buffer.from('some other wasm'))));
    await expect(runDeploy(inputs(), runner, chain, log)).rejects.toThrow(
      /refusing to touch it.*--salt-tag/,
    );
    expect(chain.sent.filter((s) => s.kind === 'create')).toHaveLength(0);
  });

  it('a new --salt-tag deploys a second set at new addresses', async () => {
    const { chain, log, runner } = setup(false);
    await runDeploy(inputs(), runner, chain, log);
    chain.sent.length = 0;
    await runDeploy(
      inputs({ saltTag: 'v2', deploymentsFile: join(dir, 'v2.json') }),
      runner,
      chain,
      log,
    );
    expect(chain.sent.filter((s) => s.kind === 'create')).toHaveLength(2);
    expect(readDeployments(join(dir, 'v2.json'))['stellar:testnet']?.contracts.Escrow).not.toBe(
      escrowId,
    );
  });

  it('takes role holders as parameters and records what it could not apply', async () => {
    const { chain, log, runner } = setup(false);
    const holder = other.publicKey();
    const out = await runDeploy(
      inputs({
        admin: holder,
        pauser: holder,
        treasurer: holder,
        tokenConfig: holder,
        proxyAdmin: holder,
        proxyPauser: holder,
      }),
      runner,
      chain,
      log,
    );
    const creates = chain.sent.filter((s) => s.kind === 'create');
    expect(creates[0]?.args?.[2]).toEqual([holder, 1]);
    expect(creates[1]?.args?.[2]).toEqual([holder, holder, 1]);
    // the deployer cannot sign admin or TokenConfig calls, so none were attempted
    expect(
      chain.sent.some((s) => s.fn === 'grant_role' || s.fn === 'allow_token_and_set_fee_config'),
    ).toBe(false);
    expect(out.entry.pendingAdminSteps).toHaveLength(4);
    expect(out.entry.pendingAdminSteps.join('\n')).toMatch(
      /requires default admin|TokenConfig holder/,
    );
    expect(out.entry.roles.Escrow.defaultAdmin).toBe(holder);
  });

  it('rejects a non-wasm file before any transaction', async () => {
    const { chain, log, runner } = setup(false);
    await expect(
      runDeploy(inputs({ escrowWasm: Buffer.from('nope') }), runner, chain, log),
    ).rejects.toThrow(/not a WebAssembly/);
    expect(chain.sent).toHaveLength(0);
  });

  it('surfaces a failed simulation instead of submitting that step', async () => {
    const { chain, log, runner } = setup(false);
    const real = chain.simulateTransaction.bind(chain);
    chain.simulateTransaction = async (tx) => {
      const r = await real(tx);
      return chain.simulated.at(-1) === 'grant_role'
        ? ({
            id: '1',
            latestLedger: 1,
            events: [],
            _parsed: true,
            error: 'HostError: auth',
          } as never)
        : r;
    };
    await expect(runDeploy(inputs(), runner, chain, log)).rejects.toThrow(
      /grant Escrow role Pauser.*simulation failed: HostError: auth/,
    );
    expect(chain.sent.some((s) => s.fn === 'grant_role')).toBe(false);
  });
});

describe('chain state, not flags, decides what is pending', () => {
  const holder = other.publicKey();
  const handedOff = () =>
    inputs({
      admin: holder,
      pauser: holder,
      treasurer: holder,
      tokenConfig: holder,
      proxyAdmin: holder,
      proxyPauser: holder,
    });

  it('pending steps clear once the admin has applied them', async () => {
    const { chain, log, runner } = setup(false);
    const first = await runDeploy(handedOff(), runner, chain, log);
    expect(first.entry.pendingAdminSteps).toHaveLength(4);
    expect(first.entry.roles.Escrow.Pauser).toEqual({ holder, granted: false });

    // the admin applies everything out of band
    for (const r of ['Pauser', 'Treasurer', 'TokenConfig']) chain.forceRole(r, holder);
    chain.forceToken(token, { pct: 1_000_000, decimals: 7 });
    const second = await runDeploy(handedOff(), runner, chain, log);
    expect(second.entry.pendingAdminSteps).toEqual([]);
    expect(second.entry.roles.Escrow.TokenConfig).toEqual({ holder, granted: true });
    expect(second.entry.tokens.map((t) => t.contract)).toEqual([token]);
  });

  it('reads constructor values back from the chain and flags a mismatch instead of recording the flag', async () => {
    const { chain, log, runner } = setup(false);
    await runDeploy(inputs(), runner, chain, log);
    const out = await runDeploy(inputs({ adminDelaySecs: 99, admin: holder }), runner, chain, log);
    expect(out.entry.roles.Escrow.adminDelaySecs).toBe(1);
    expect(out.entry.roles.Escrow.defaultAdmin).toBe(deployer.publicKey());
    expect(out.entry.pendingAdminSteps.join('\n')).toMatch(
      /Escrow admin delay is 1 on chain, requested 99/,
    );
    expect(out.entry.pendingAdminSteps.join('\n')).toMatch(/Escrow default admin is/);
  });

  it('a re-run after an admin handoff, with default flags, still extends TTL and never simulates a grant', async () => {
    const { chain, log, runner } = setup(false);
    await runDeploy(inputs(), runner, chain, log);
    chain.forceAdmin(escrowId, holder);
    chain.forceRole('TokenConfig', deployer.publicKey(), false);
    chain.forceRole('Pauser', deployer.publicKey(), false);
    chain.sent.length = 0;
    chain.simulated.length = 0;

    const out = await runDeploy(
      inputs({
        tokens: [
          { contract: token, decimals: 7, feePercentage6: 2_000_000, minFee6: 0n, maxFee6: 0n },
        ],
      }),
      runner,
      chain,
      log,
    );
    expect(chain.simulated).not.toContain('grant_role');
    expect(chain.simulated).not.toContain('set_token_fee_config');
    expect(chain.sent.map((s) => s.kind)).toEqual(['extend']);
    expect(out.entry.pendingAdminSteps.join('\n')).toMatch(/needs default admin .* to sign/);
    expect(out.entry.pendingAdminSteps.join('\n')).toMatch(/TokenConfig holder/);
    expect(out.entry.roles.Escrow.defaultAdmin).toBe(holder);
  });

  it('refuses to hand a role to a new holder while the recorded holder still has it', async () => {
    const { chain, log, runner } = setup(false);
    await runDeploy(inputs(), runner, chain, log);
    const before = readFileSync(file, 'utf8');
    chain.sent.length = 0;
    chain.simulated.length = 0;

    await expect(
      runDeploy(inputs({ pauser: holder, tokenConfig: holder }), runner, chain, log),
    ).rejects.toThrow(
      /refusing to change Escrow role holders: Pauser: .* still holds it on chain, requested .*; TokenConfig: .* still holds it/,
    );
    // nothing was granted, and the file still says who actually holds the roles
    expect(chain.simulated).not.toContain('grant_role');
    expect(chain.sent).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readDeployments(file)['stellar:testnet']?.roles.Escrow.Treasurer.holder).toBe(
      deployer.publicKey(),
    );
  });

  it('accepts the new holder once the old one has been revoked, and records only it', async () => {
    const { chain, log, runner } = setup(false);
    await runDeploy(inputs(), runner, chain, log);
    chain.forceRole('Pauser', deployer.publicKey(), false); // the admin flow revoked it
    const out = await runDeploy(inputs({ pauser: holder }), runner, chain, log);
    expect(out.entry.roles.Escrow.Pauser).toEqual({ holder, granted: true });
    expect(out.entry.roles.Escrow.Treasurer).toEqual({
      holder: deployer.publicKey(),
      granted: true,
    });
  });

  it('a recorded holder that never received the role does not block a change', async () => {
    const { chain, log, runner } = setup(false);
    await runDeploy(handedOff(), runner, chain, log); // deployer is not the admin: grants stay pending
    const out = await runDeploy(
      inputs({ ...handedOff(), pauser: deployer.publicKey() }),
      runner,
      chain,
      log,
    );
    expect(out.entry.roles.Escrow.Pauser.holder).toBe(deployer.publicKey());
  });

  it('keeps tokens added by earlier runs when a later run names a different one', async () => {
    const { chain, log, runner } = setup(false);
    const tokenB = StrKey.encodeContract(Buffer.alloc(32, 10));
    await runDeploy(inputs(), runner, chain, log);
    const out = await runDeploy(
      inputs({
        tokens: [
          { contract: tokenB, decimals: 6, feePercentage6: 500_000, minFee6: 0n, maxFee6: 0n },
        ],
      }),
      runner,
      chain,
      log,
    );
    expect(out.entry.tokens.map((t) => t.contract).sort()).toEqual([token, tokenB].sort());
    expect(readDeployments(file)['stellar:testnet']?.tokens).toHaveLength(2);
  });

  it('main() reuses the recorded role holders when flags are omitted', async () => {
    const chain = new FakeChain(net.passphrase, [deployer.publicKey()]);
    const d = {
      env: {},
      log: () => undefined,
      makeRpc: () => chain,
      readFile: (p: string) => (p.includes('escrow') ? WASM_A : WASM_B),
      loadKey: () => deployer,
    };
    const base = [
      '--network',
      'testnet',
      '--escrow-wasm',
      'escrow.wasm',
      '--proxy-wasm',
      'proxy.wasm',
      '--deployments-file',
      file,
    ];
    await main([...base, '--admin', deployer.publicKey(), '--pauser', holder], d);
    expect(readDeployments(file)['stellar:testnet']?.roles.Escrow.Pauser.holder).toBe(holder);
    await main(base, d); // no flags: the recorded holder is kept, not reset to the deployer
    expect(readDeployments(file)['stellar:testnet']?.roles.Escrow.Pauser).toEqual({
      holder,
      granted: true,
    });
  });
});

describe('dry-run', () => {
  it('simulates and prints every transaction and submits nothing, writes nothing', async () => {
    const { chain, logs, log, runner } = setup(true);
    const out = await runDeploy(inputs(), runner, chain, log);
    expect(chain.sent).toHaveLength(0);
    expect(out.fileWritten).toBe(false);
    expect(existsSync(file)).toBe(false);
    const text = logs.join('\n');
    expect(text).toMatch(/\[dry-run\] upload Escrow wasm/);
    expect(text).toMatch(/\[dry-run\] create FulfillmentProxy instance/);
    expect(text).toMatch(/unsigned XDR: AAAA/);
    expect(text).toMatch(/would write/);
    // later steps that depend on the planned ones are explained, not fatal
    expect(text).toMatch(/an earlier step was only planned/);
    // simulations were actually run for each planned step
    expect(chain.simulated).toEqual(
      expect.arrayContaining(['upload', 'create', 'grant_role', 'extend']),
    );
  });

  it('works with only a public address (no key)', async () => {
    const { chain, log, runner } = setup(true, { keyless: true });
    await runDeploy(inputs(), runner, chain, log);
    expect(chain.sent).toHaveLength(0);
  });

  it('a real run needs a key', () => {
    const chain = new FakeChain(net.passphrase, [deployer.publicKey()]);
    expect(() => makeRunner(chain, false, () => undefined, true)).toThrow(/signing key/);
  });

  it('on an already-deployed pair it reports the state it found and plans only the TTL extension', async () => {
    const live = setup(false);
    await runDeploy(inputs(), live.runner, live.chain, live.log);
    const { logs, log, runner } = setup(true, { chain: live.chain, keyless: true });
    live.chain.sent.length = 0;
    const out = await runDeploy(inputs(), runner, live.chain, log);
    expect(live.chain.sent).toHaveLength(0);
    expect(out.performed).toEqual(['extend TTL of code and instances']);
    expect(logs.join('\n')).toMatch(/skip: create Escrow instance/);
  });
});

describe('extend-ttl keeper', () => {
  it('extends code and instance of both contracts from the deployments file', async () => {
    const { chain, log, runner } = setup(false);
    await runDeploy(inputs(), runner, chain, log);
    chain.sent.length = 0;
    chain.latestLedger += 500_000;
    const entry = readDeployments(file)['stellar:testnet'];
    if (entry === undefined) throw new Error('no entry');
    const next = await runExtendTtl(entry, runner, chain, undefined);
    expect(chain.sent).toEqual([expect.objectContaining({ kind: 'extend', footprintKeys: 4 })]);
    expect(next.ttl?.observedAtLedger).toBe(chain.latestLedger);
  });
});

describe('extend-ttl keeper, token balances', () => {
  async function deployed() {
    const { chain, log, runner } = setup(false);
    await runDeploy(inputs(), runner, chain, log);
    chain.sent.length = 0;
    chain.latestLedger += 500_000;
    const entry = readDeployments(file)['stellar:testnet'];
    if (entry === undefined) throw new Error('no entry');
    return { chain, runner, entry, log };
  }

  it("extends the escrow's balance entry of every allowlisted token with the code and instances", async () => {
    const { chain, runner, entry } = await deployed();
    chain.seedBalance(token, escrowId);
    const key = tokenBalanceKey(token, escrowId);
    expect(chain.liveUntilOf(key)).toBeLessThan(chain.latestLedger + 1_000);
    await runExtendTtl(entry, runner, chain, undefined);
    // code and instance of both contracts, plus the one balance entry
    expect(chain.sent).toEqual([expect.objectContaining({ kind: 'extend', footprintKeys: 5 })]);
    expect(chain.liveUntilOf(key)).toBe(chain.latestLedger + chain.maxEntryTtl - 1);
  });

  it('skips a token the escrow holds no balance entry for, and says so', async () => {
    const { chain, entry } = await deployed();
    const logs: string[] = [];
    const quiet = makeRunner(chain, false, (l) => logs.push(l));
    await runExtendTtl(entry, quiet, chain, undefined);
    expect(chain.sent).toEqual([expect.objectContaining({ kind: 'extend', footprintKeys: 4 })]);
    expect(logs.join('\n')).toMatch(/no balance entry/);
  });
});

describe('extend-ttl keeper, allowlist read from the escrow at run time', () => {
  const token2 = StrKey.encodeContract(Buffer.alloc(32, 8));

  async function deployed() {
    const { chain, log, runner } = setup(false);
    await runDeploy(inputs(), runner, chain, log);
    chain.sent.length = 0;
    chain.latestLedger += 500_000;
    const entry = readDeployments(file)['stellar:testnet'];
    if (entry === undefined) throw new Error('no entry');
    return { chain, runner, entry, log };
  }

  /** What the TokenConfig holder does between two `deploy` runs, so the deployments file never sees it. */
  async function allowLater(chain: FakeChain, runner: TxRunner, t: string) {
    await runner.invoke(
      'allow later',
      escrowId,
      'allow_token_and_set_fee_config',
      escrowArgs('allow_token_and_set_fee_config', deployer.publicKey(), t, 7, 1_000_000, 0n, 0n),
    );
    chain.sent.length = 0;
  }

  it('extends the balance entry of a token allowed after the last deploy run, absent from the file', async () => {
    const { chain, runner, entry } = await deployed();
    await allowLater(chain, runner, token2);
    expect(entry.tokens.map((t) => t.contract)).toEqual([token]);
    chain.seedBalance(token, escrowId);
    chain.seedBalance(token2, escrowId);
    await runExtendTtl(entry, runner, chain, undefined);
    // code and instance of both contracts, plus both balance entries
    expect(chain.sent).toEqual([expect.objectContaining({ kind: 'extend', footprintKeys: 6 })]);
    const key2 = tokenBalanceKey(token2, escrowId);
    expect(chain.liveUntilOf(key2)).toBe(chain.latestLedger + chain.maxEntryTtl - 1);
  });

  it('extends the on-chain tokens when the file records none, as after a first mainnet run', async () => {
    const { chain, runner, entry } = await deployed();
    chain.seedBalance(token, escrowId);
    await runExtendTtl({ ...entry, tokens: [] }, runner, chain, undefined);
    expect(chain.sent).toEqual([expect.objectContaining({ kind: 'extend', footprintKeys: 5 })]);
    expect(chain.liveUntilOf(tokenBalanceKey(token, escrowId))).toBe(
      chain.latestLedger + chain.maxEntryTtl - 1,
    );
  });

  it('still extends a token recorded in the file that the escrow no longer lists, as a disallowed token can hold deposits in flight', async () => {
    const { chain, runner, entry } = await deployed();
    chain.seedBalance(token2, escrowId);
    const recorded = { ...entry.tokens[0], contract: token2 } as (typeof entry.tokens)[number];
    await runExtendTtl({ ...entry, tokens: [recorded] }, runner, chain, undefined);
    expect(chain.sent).toEqual([expect.objectContaining({ kind: 'extend', footprintKeys: 5 })]);
    expect(chain.liveUntilOf(tokenBalanceKey(token2, escrowId))).toBe(
      chain.latestLedger + chain.maxEntryTtl - 1,
    );
  });

  it('says so, as a warning, when the escrow lists no token and none is recorded', async () => {
    const { entry } = await deployed();
    const fresh = new FakeChain(net.passphrase, [deployer.publicKey()]);
    const logs: string[] = [];
    // an escrow that allowlists nothing: deploy with no tokens
    const none = () => undefined;
    await runDeploy(inputs({ tokens: [] }), makeRunner(fresh, false, none), fresh, none);
    fresh.sent.length = 0;
    const quiet = makeRunner(fresh, false, (l) => logs.push(l));
    await runExtendTtl({ ...entry, tokens: [] }, quiet, fresh, undefined);
    expect(logs.join('\n')).toMatch(/WARNING: the escrow reports no allowlisted token/);
    expect(logs.join('\n')).toMatch(/no token balance entry was extended/);
    expect(fresh.sent).toEqual([expect.objectContaining({ kind: 'extend', footprintKeys: 4 })]);
  });

  it('logs how many tokens and which balance entries it extends', async () => {
    const { chain, entry } = await deployed();
    chain.seedBalance(token, escrowId);
    const logs: string[] = [];
    await runExtendTtl(
      entry,
      makeRunner(chain, false, (l) => logs.push(l)),
      chain,
      undefined,
    );
    const out = logs.join('\n');
    expect(out).toMatch(/1 allowlisted token/);
    expect(out).toContain(token);
    expect(out).toMatch(/extending 1 of 1 token balance entr/);
  });

  it('fails the run, sending nothing, when the allowlist cannot be read', async () => {
    const { entry } = await deployed();
    // a chain on which the escrow does not exist: the read simulation fails
    const empty = new FakeChain(net.passphrase, [deployer.publicKey()]);
    const runner = makeRunner(empty, false, () => undefined);
    await expect(runExtendTtl(entry, runner, empty, undefined)).rejects.toThrow(
      /get_allowed_tokens/,
    );
    expect(empty.sent).toHaveLength(0);
    expect(empty.simulated).not.toContain('extend');
  });
});

describe('main() wiring', () => {
  function deps(
    chain: FakeChain,
    env: Record<string, string | undefined>,
    loadKeyCalls: { n: number },
  ): MainDeps {
    return {
      env,
      log: () => undefined,
      makeRpc: () => chain,
      readFile: (p) => (p.includes('escrow') ? WASM_A : WASM_B),
      loadKey: () => {
        loadKeyCalls.n++;
        return deployer;
      },
    };
  }
  const base = [
    '--network',
    'testnet',
    '--escrow-wasm',
    'escrow.wasm',
    '--proxy-wasm',
    'proxy.wasm',
  ];

  it('refuses mainnet before touching a key or the network', async () => {
    const calls = { n: 0 };
    const chain = new FakeChain(NETWORKS.mainnet.passphrase, [deployer.publicKey()]);
    await expect(
      main(
        [
          '--network',
          'mainnet',
          '--rpc-url',
          'https://rpc.example',
          '--escrow-wasm',
          'e',
          '--proxy-wasm',
          'p',
        ],
        deps(chain, {}, calls),
      ),
    ).rejects.toThrow(/refusing mainnet/);
    expect(calls.n).toBe(0);
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses mainnet with the flag but without the env allowlist, still before any key', async () => {
    const calls = { n: 0 };
    const chain = new FakeChain(NETWORKS.mainnet.passphrase, [deployer.publicKey()]);
    await expect(
      main(
        [
          '--network',
          'mainnet',
          '--rpc-url',
          'https://rpc.example',
          '--escrow-wasm',
          'e',
          '--proxy-wasm',
          'p',
          '--i-know-this-is-mainnet',
          '--environment',
          'production-mainnet',
        ],
        deps(chain, {}, calls),
      ),
    ).rejects.toThrow(/ATUM_STELLAR_MAINNET_ALLOWLIST/);
    expect(calls.n).toBe(0);
  });

  it('proceeds on mainnet only with flag + environment + allowlist, a keychain key and roles elsewhere (dry-run here)', async () => {
    const calls = { n: 0 };
    const chain = new FakeChain(NETWORKS.mainnet.passphrase, [deployer.publicKey()]);
    await main(
      [
        '--network',
        'mainnet',
        '--rpc-url',
        'https://rpc.example',
        '--escrow-wasm',
        'e',
        '--proxy-wasm',
        'p',
        '--i-know-this-is-mainnet',
        '--environment',
        'production-mainnet',
        '--dry-run',
        '--deployments-file',
        file,
        '--keychain-item',
        'k',
        ...[
          '--admin',
          '--pauser',
          '--treasurer',
          '--token-config',
          '--proxy-admin',
          '--proxy-pauser',
        ].flatMap((f) => [f, other.publicKey()]),
        '--admin-delay-secs',
        '172800',
        '--proxy-delay-secs',
        '172800',
      ],
      deps(chain, { [MAINNET_ALLOWLIST_ENV]: 'production-mainnet' }, calls),
    );
    expect(calls.n).toBe(1);
    expect(chain.sent).toHaveLength(0);
  });

  describe('mainnet custody', () => {
    const holders = [
      '--admin',
      other.publicKey(),
      '--pauser',
      other.publicKey(),
      '--treasurer',
      other.publicKey(),
      '--token-config',
      other.publicKey(),
      '--proxy-admin',
      other.publicKey(),
      '--proxy-pauser',
      other.publicKey(),
    ];
    const delays = ['--admin-delay-secs', '172800', '--proxy-delay-secs', '172800'];
    const mainnetArgs = (...extra: string[]) => [
      '--network',
      'mainnet',
      '--rpc-url',
      'https://rpc.example',
      '--escrow-wasm',
      'e',
      '--proxy-wasm',
      'p',
      '--i-know-this-is-mainnet',
      '--environment',
      'production-mainnet',
      '--dry-run',
      '--deployments-file',
      file,
      ...extra,
    ];
    const allowed = { [MAINNET_ALLOWLIST_ENV]: 'production-mainnet' };
    const run = (extra: string[], env: Record<string, string | undefined> = allowed) => {
      const calls = { n: 0 };
      const chain = new FakeChain(NETWORKS.mainnet.passphrase, [deployer.publicKey()]);
      return { calls, chain, p: main(mainnetArgs(...extra), deps(chain, env, calls)) };
    };

    it('refuses the default roles (every role falls back to the deployer)', async () => {
      const { calls, p } = run(['--keychain-item', 'k', ...delays]);
      await expect(p).rejects.toThrow(/refusing mainnet: .*held by the deployer/);
      expect(calls.n).toBe(1); // the deployer address is needed to see the fallback
    });

    it('refuses one role left on the deployer, naming it', async () => {
      const { p } = run([
        '--keychain-item',
        'k',
        ...delays,
        '--admin',
        other.publicKey(),
        '--pauser',
        other.publicKey(),
        '--treasurer',
        other.publicKey(),
        '--token-config',
        other.publicKey(),
        '--proxy-admin',
        other.publicKey(),
      ]);
      await expect(p).rejects.toThrow(/proxyPauser/);
    });

    it('refuses a role passed explicitly as the deployer', async () => {
      const { p } = run([
        '--keychain-item',
        'k',
        ...delays,
        ...holders,
        '--pauser',
        deployer.publicKey(),
      ]);
      await expect(p).rejects.toThrow(/pauser/);
    });

    it('refuses the testnet default admin delay on either contract', async () => {
      await expect(
        run(['--keychain-item', 'k', ...holders, '--proxy-delay-secs', '172800']).p,
      ).rejects.toThrow(/--admin-delay-secs/);
      await expect(
        run(['--keychain-item', 'k', ...holders, '--admin-delay-secs', '172800']).p,
      ).rejects.toThrow(/--proxy-delay-secs/);
    });

    it('refuses a short admin delay on either contract, not only the default', async () => {
      await expect(
        run([
          '--keychain-item',
          'k',
          ...holders,
          '--admin-delay-secs',
          '2',
          '--proxy-delay-secs',
          '172800',
        ]).p,
      ).rejects.toThrow(/--admin-delay-secs is 2, below the mainnet minimum of 86400 seconds/);
      await expect(
        run([
          '--keychain-item',
          'k',
          ...holders,
          '--admin-delay-secs',
          '172800',
          '--proxy-delay-secs',
          '86399',
        ]).p,
      ).rejects.toThrow(/--proxy-delay-secs is 86399, below the mainnet minimum/);
    });

    it('refuses an environment-held secret, default or named, before it is read', async () => {
      for (const extra of [[], ['--secret-env', 'MY_SECRET']]) {
        const { calls, p } = run([...extra, ...holders, ...delays]);
        await expect(p).rejects.toThrow(/environment variable/);
        expect(calls.n).toBe(0);
      }
    });

    it('accepts a keychain key, every role elsewhere and a longer delay', async () => {
      const { calls, chain, p } = run(['--keychain-item', 'k', ...holders, ...delays]);
      await p;
      expect(calls.n).toBe(1);
      expect(chain.sent).toHaveLength(0);
    });

    it('accepts a public-key dry run with no secret at all', async () => {
      const { calls, p } = run(['--deployer-address', deployer.publicKey(), ...holders, ...delays]);
      await p;
      expect(calls.n).toBe(0);
    });

    it('refuses an environment-held secret for extend-ttl too, but needs no roles', async () => {
      await expect(
        main(
          [
            'extend-ttl',
            '--network',
            'mainnet',
            '--rpc-url',
            'https://rpc.example',
            '--i-know-this-is-mainnet',
            '--environment',
            'production-mainnet',
          ],
          deps(new FakeChain(NETWORKS.mainnet.passphrase, [deployer.publicKey()]), allowed, {
            n: 0,
          }),
        ),
      ).rejects.toThrow(/environment variable/);
    });

    it('does not touch testnet: default roles and an env secret still run', async () => {
      const chain = new FakeChain(net.passphrase, [deployer.publicKey()]);
      await main([...base, '--deployments-file', file, '--dry-run'], deps(chain, {}, { n: 0 }));
    });
  });

  it('refuses an RPC that serves a different network than --network', async () => {
    const chain = new FakeChain(NETWORKS.mainnet.passphrase, [deployer.publicKey()]);
    await expect(main(base, deps(chain, {}, { n: 0 }))).rejects.toThrow(/expects/);
    expect(chain.sent).toHaveLength(0);
  });

  it('end to end on testnet writes the deployments file and a re-run changes nothing', async () => {
    const chain = new FakeChain(net.passphrase, [deployer.publicKey()]);
    await main(
      [...base, '--deployments-file', file, '--token', `${token}:7:1000000`],
      deps(chain, {}, { n: 0 }),
    );
    const sentAfterFirst = chain.sent.length;
    const entry = readDeployments(file)['stellar:testnet'];
    expect(entry?.deployer).toBe(deployer.publicKey());
    expect(chain.sent.filter((s) => s.kind === 'create')).toHaveLength(2);

    await main(
      [...base, '--deployments-file', file, '--token', `${token}:7:1000000`],
      deps(chain, {}, { n: 0 }),
    );
    expect(chain.sent.length - sentAfterFirst).toBe(1); // only the TTL extension
    expect(chain.sent.filter((s) => s.kind === 'create')).toHaveLength(2);
  });

  it('extend-ttl command reads the file and extends', async () => {
    const chain = new FakeChain(net.passphrase, [deployer.publicKey()]);
    await main([...base, '--deployments-file', file], deps(chain, {}, { n: 0 }));
    chain.sent.length = 0;
    await main(
      ['extend-ttl', '--network', 'testnet', '--deployments-file', file],
      deps(chain, {}, { n: 0 }),
    );
    expect(chain.sent.map((s) => s.kind)).toEqual(['extend']);
  });

  it('constructs addresses the way the SDK reads them back', () => {
    // guards the helper used above: scValToNative of an Address ScVal is its strkey
    expect(scValToNative(new Address(deployer.publicKey()).toScVal())).toBe(deployer.publicKey());
  });
});
