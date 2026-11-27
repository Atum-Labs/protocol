/**
 * Transaction runner: build, simulate, assemble, then either print (dry-run) or sign and submit.
 *
 * It depends on the narrow {@link SorobanRpc} interface rather than rpc.Server, which is what lets
 * the unit tests run the whole deploy against an in-memory fake chain. `rpc.Server` satisfies the
 * interface structurally.
 */
import type { xdr } from '@stellar/stellar-sdk';
import {
  Address,
  BASE_FEE,
  Contract,
  Operation,
  TransactionBuilder,
  rpc,
  type Account,
  type Keypair,
  type Transaction,
} from '@stellar/stellar-sdk';

export interface SorobanRpc {
  getNetwork(): Promise<{ passphrase: string; protocolVersion?: string }>;
  getAccount(address: string): Promise<Account>;
  getLatestLedger(): Promise<{ sequence: number; closeTime: string }>;
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  pollTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export interface Signer {
  readonly publicKey: string;
  /** Absent in dry-run with --deployer-address: such a runner cannot submit */
  readonly keypair?: Keypair;
}

export interface StepResult {
  readonly label: string;
  readonly status: 'submitted' | 'dry-run';
  readonly txHash?: string;
  readonly returnValue?: xdr.ScVal;
  readonly simulationError?: string;
}

export class TxFailedError extends Error {
  constructor(label: string, detail: string) {
    super(`${label}: ${detail}`);
    this.name = 'TxFailedError';
  }
}

export interface RunnerOptions {
  readonly rpc: SorobanRpc;
  readonly networkPassphrase: string;
  readonly signer: Signer;
  readonly dryRun: boolean;
  readonly log: (line: string) => void;
  readonly baseFee?: string;
  /** Seconds a built transaction stays valid */
  readonly timeoutSecs?: number;
}

export class TxRunner {
  /** Dry-run keeps one account object so each unsent transaction takes the next sequence number */
  private dryAccount: Account | undefined;
  /** True once a mutating step was only planned: later simulations may fail because of it */
  private plannedMutation = false;

  constructor(private readonly opts: RunnerOptions) {
    if (!opts.dryRun && opts.signer.keypair === undefined) {
      throw new Error('a signing key is required unless --dry-run');
    }
  }

  get dryRun(): boolean {
    return this.opts.dryRun;
  }

  get log(): (line: string) => void {
    return this.opts.log;
  }

  get sourceAddress(): string {
    return this.opts.signer.publicKey;
  }

  private async account(): Promise<Account> {
    if (!this.opts.dryRun) return this.opts.rpc.getAccount(this.sourceAddress);
    this.dryAccount ??= await this.opts.rpc.getAccount(this.sourceAddress);
    return this.dryAccount;
  }

  private build(account: Account, op: xdr.Operation, sorobanData?: xdr.SorobanTransactionData) {
    const b = new TransactionBuilder(account, {
      fee: this.opts.baseFee ?? BASE_FEE,
      networkPassphrase: this.opts.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(this.opts.timeoutSecs ?? 300);
    if (sorobanData !== undefined) b.setSorobanData(sorobanData);
    return b.build();
  }

  /**
   * Read-only call: simulate and return the value. Never submitted, in dry-run or not. Returns
   * undefined when the simulation fails and a mutation was planned earlier in a dry-run (the
   * contract may simply not exist yet); otherwise a failed simulation throws.
   */
  async read(
    contractId: string,
    fn: string,
    args: xdr.ScVal[] = [],
  ): Promise<xdr.ScVal | undefined> {
    const account = await this.opts.rpc.getAccount(this.sourceAddress);
    const tx = this.build(account, new Contract(contractId).call(fn, ...args));
    const sim = await this.opts.rpc.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      if (this.opts.dryRun && this.plannedMutation) return undefined;
      throw new TxFailedError(`read ${fn}`, sim.error);
    }
    return sim.result?.retval;
  }

  /** Invoke a contract function as a transaction. */
  invoke(label: string, contractId: string, fn: string, args: xdr.ScVal[]): Promise<StepResult> {
    return this.execute(label, new Contract(contractId).call(fn, ...args));
  }

  /** Run any Soroban operation. `sorobanData` is required for extendFootprintTtl / restoreFootprint. */
  async execute(
    label: string,
    op: xdr.Operation,
    sorobanData?: xdr.SorobanTransactionData,
  ): Promise<StepResult> {
    const { log } = this.opts;
    const account = await this.account();
    const tx = this.build(account, op, sorobanData);
    let sim = await this.opts.rpc.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) {
      if (this.opts.dryRun && this.plannedMutation) {
        log(
          `[dry-run] ${label}: simulation failed (${sim.error}); an earlier step was only planned, so this is expected`,
        );
        log(`[dry-run]   unsigned XDR (no resources): ${tx.toXDR()}`);
        this.plannedMutation = true;
        return { label, status: 'dry-run', simulationError: sim.error };
      }
      throw new TxFailedError(label, `simulation failed: ${sim.error}`);
    }

    if (rpc.Api.isSimulationRestore(sim)) {
      if (this.opts.dryRun) {
        log(
          `[dry-run] ${label}: archived entries need a RestoreFootprint first (min fee ${sim.restorePreamble.minResourceFee})`,
        );
      } else {
        await this.restore(label, sim.restorePreamble.transactionData.build());
        // The restore consumed a sequence number, so rebuild and re-simulate from a fresh account
        const fresh = this.build(await this.account(), op, sorobanData);
        sim = await this.opts.rpc.simulateTransaction(fresh);
        if (!rpc.Api.isSimulationSuccess(sim)) {
          throw new TxFailedError(label, 'simulation after restore did not succeed');
        }
        return this.submit(label, fresh, sim);
      }
    }
    return this.submit(label, tx, sim);
  }

  private async submit(
    label: string,
    tx: Transaction,
    sim: rpc.Api.SimulateTransactionResponse,
  ): Promise<StepResult> {
    const { log } = this.opts;
    const assembled = rpc.assembleTransaction(tx, sim).build();
    const retval = rpc.Api.isSimulationSuccess(sim) ? sim.result?.retval : undefined;

    if (this.opts.dryRun) {
      this.plannedMutation = true;
      log(`[dry-run] ${label}`);
      log(
        `[dry-run]   source ${this.sourceAddress}  fee ${assembled.fee}  minResourceFee ${rpc.Api.isSimulationSuccess(sim) ? sim.minResourceFee : '?'}`,
      );
      if (retval !== undefined) log(`[dry-run]   simulated return: ${retval.toXDR('base64')}`);
      log(`[dry-run]   unsigned XDR: ${assembled.toXDR()}`);
      return { label, status: 'dry-run', returnValue: retval };
    }

    const keypair = this.opts.signer.keypair;
    if (keypair === undefined)
      throw new Error('unreachable: constructor requires a key outside dry-run');
    assembled.sign(keypair);
    const sent = await this.opts.rpc.sendTransaction(assembled);
    if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
      throw new TxFailedError(
        label,
        `send rejected (${sent.status}) ${sent.errorResult ? sent.errorResult.toXDR('base64') : ''}`.trim(),
      );
    }
    const done = await this.opts.rpc.pollTransaction(sent.hash);
    if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new TxFailedError(label, `transaction ${sent.hash} ended ${done.status}`);
    }
    log(`submitted ${label}: ${sent.hash}`);
    return {
      label,
      status: 'submitted',
      txHash: sent.hash,
      returnValue: done.returnValue ?? retval,
    };
  }

  private async restore(label: string, data: xdr.SorobanTransactionData): Promise<void> {
    const tx = this.build(await this.account(), Operation.restoreFootprint({}), data);
    const sim = await this.opts.rpc.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim))
      throw new TxFailedError(`${label} (restore)`, 'simulation failed');
    const assembled = rpc.assembleTransaction(tx, sim).build();
    const keypair = this.opts.signer.keypair;
    if (keypair === undefined) throw new Error('unreachable');
    assembled.sign(keypair);
    const sent = await this.opts.rpc.sendTransaction(assembled);
    if (sent.status === 'ERROR') throw new TxFailedError(`${label} (restore)`, 'send rejected');
    const done = await this.opts.rpc.pollTransaction(sent.hash);
    if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new TxFailedError(`${label} (restore)`, `ended ${done.status}`);
    }
    this.opts.log(`restored archived entries for ${label}: ${sent.hash}`);
  }
}

export function addressOf(strkey: string): xdr.ScAddress {
  return new Address(strkey).toScAddress();
}
