import { setTimeout as sleep } from 'node:timers/promises';

import { SignerErrorCode, signerRetryable, signerTerminal } from '@atum-labs/km-core';

import { TURNKEY_RETRY_BACKOFF_MS } from './constants';
import { type Logger, noopLogger } from './logger';
import { type Counter, type Histogram, type Meter, noopMeter } from './meter';
import { createTurnkeyStamper, type TurnkeyStamper } from './stamp';
import type {
  SignRawPayloadInput,
  SignRawPayloadResult,
  SignTransactionInput,
  SignTransactionResult,
  TurnkeyAccount,
  TurnkeyActivity,
  TurnkeyWallet,
} from './types';

/**
 * Single-tenant HTTP wrapper around the Turnkey REST API.
 *
 * - One client per `(organizationId, apiPublicKey)` — instances are shared across chain
 *   signers via `client-registry.ts` so the stamper, connection pool, and concurrency
 *   semaphore all live in one place.
 * - In-flight calls are gated by a per-sub-org concurrency semaphore (Turnkey docs cap the
 *   per-sub-org rate at 10 RPS; we default the semaphore to that ceiling so we never burst
 *   past it). Configurable lower on shared sub-orgs.
 * - HTTP 429 with `Retry-After` is honored; otherwise exponential backoff (500ms, 2s, 8s)
 *   before surfacing as a retryable signer error to the executor.
 * - Activities normally complete synchronously (status `ACTIVITY_STATUS_COMPLETED` in the
 *   POST response); when they don't, we poll `get_activity` with a bounded budget.
 */
export interface TurnkeyClientOpts {
  readonly organizationId: string;
  readonly apiUrl: string;
  readonly apiPublicKey: string;
  readonly apiPrivateKey: string;
  readonly concurrencyLimit: number;
  readonly requestTimeoutMs: number;
  /** Injectable structured logger. Defaults to a no-op logger. */
  readonly log?: Logger;
  /** Injectable metrics meter. Defaults to a no-op meter. */
  readonly meter?: Meter;
  /** Override for tests. */
  readonly fetchImpl?: typeof fetch;
}

// Backoff schedule for activity polling. Last value is reused after the array is exhausted.
const POLL_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const POLL_TIMEOUT_MS = 30_000;

export class TurnkeyClient {
  // `apiPrivateKey` is intentionally omitted — see constructor for why.
  private readonly opts: Omit<TurnkeyClientOpts, 'apiPrivateKey'>;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly retryCounter: Counter;
  private readonly backoffHistogram: Histogram;
  private readonly activityPendingCounter: Counter;
  private readonly signDurationHistogram: Histogram;
  // The private API scalar is held only long enough to construct the stamper. After
  // `getStamper()` runs, this is nulled out so the hex string doesn't survive on the heap
  // for the client's lifetime. Web Crypto holds the imported key as an opaque CryptoKey.
  private apiPrivateKey: string | null;
  private stamper: TurnkeyStamper | null = null;
  private stamperInit: Promise<TurnkeyStamper> | null = null;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: TurnkeyClientOpts) {
    // Destructure `apiPrivateKey` out of the retained `this.opts` so the only reference we
    // hold to the scalar is `this.apiPrivateKey`. Without this, `this.opts.apiPrivateKey`
    // would keep the same V8 string reachable via a second path and the scrub in
    // `getStamper` would have no effect on GC eligibility.
    const { apiPrivateKey, ...optsWithoutKey } = opts;
    this.opts = optsWithoutKey;
    this.apiPrivateKey = apiPrivateKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = (opts.log ?? noopLogger).child({
      component: 'TurnkeyClient',
      orgId: opts.organizationId,
    });
    const meter = opts.meter ?? noopMeter;
    this.retryCounter = meter.createCounter('turnkey.retry_total', {
      description:
        'Turnkey retry attempts, labeled by retry reason (http-429, http-5xx, transport-error) and endpoint path',
    });
    this.backoffHistogram = meter.createHistogram('turnkey.backoff_duration_ms', {
      description: 'Backoff sleep duration per retry attempt',
      unit: 'ms',
    });
    this.activityPendingCounter = meter.createCounter('turnkey.activity_pending_total', {
      description:
        'Activities that entered async polling (did not complete synchronously in the submit response), labeled by activity type',
    });
    this.signDurationHistogram = meter.createHistogram('turnkey.sign_duration_ms', {
      description:
        'Full Turnkey activity round-trip latency (concurrency-semaphore wait + submit + poll), labeled by activity type and outcome (success|error)',
      unit: 'ms',
    });
  }

  private emitRetry(reason: string, path: string): void {
    try {
      this.retryCounter.add(1, { reason, path });
    } catch {
      // Metric emission must never break the hot path.
    }
  }

  private emitBackoff(reason: string, delayMs: number): void {
    try {
      this.backoffHistogram.record(delayMs, { reason });
    } catch {
      // Metric emission must never break the hot path.
    }
  }

  private emitActivityPending(activityType: string): void {
    try {
      this.activityPendingCounter.add(1, { activity_type: activityType });
    } catch {
      // Metric emission must never break the hot path.
    }
  }

  private emitSignDuration(durationMs: number, activityType: string, outcome: string): void {
    try {
      this.signDurationHistogram.record(durationMs, { activity_type: activityType, outcome });
    } catch {
      // Metric emission must never break the hot path.
    }
  }

  // ── public surface ─────────────────────────────────────────────────────────

  /** Boot-time reachability + auth probe. Throws TURNKEY_AUTH on bad credentials. */
  async whoami(): Promise<{ organizationId: string; userId?: string }> {
    return this.queryPost('/public/v1/query/whoami', { organizationId: this.opts.organizationId });
  }

  async listWalletAccounts(walletId: string): Promise<TurnkeyAccount[]> {
    const path = '/public/v1/query/list_wallet_accounts';
    const r = await this.queryPost<{ accounts: TurnkeyAccount[] }>(path, {
      organizationId: this.opts.organizationId,
      walletId: normalizeWalletId(walletId),
    });
    return r.accounts ?? [];
  }

  async listWallets(): Promise<TurnkeyWallet[]> {
    const path = '/public/v1/query/list_wallets';
    const r = await this.queryPost<{ wallets: TurnkeyWallet[] }>(path, {
      organizationId: this.opts.organizationId,
    });
    return r.wallets ?? [];
  }

  async signRawPayload(
    input: SignRawPayloadInput,
  ): Promise<SignRawPayloadResult['signRawPayloadResult']> {
    const out = await this.submitActivity<SignRawPayloadResult>(
      'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2',
      'sign_raw_payload',
      input as unknown as Record<string, unknown>,
    );
    if (!out?.signRawPayloadResult) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `signRawPayload response missing signRawPayloadResult`,
      );
    }
    return out.signRawPayloadResult;
  }

  /**
   * Generic activity submission. Public surface used by admin tooling under
   * `providers/turnkey/admin/` for sub-org lifecycle and policy authoring. Hot-path signers
   * call the typed wrappers (`signRawPayload`, `signTransaction`) above; admin functions
   * use this when the activity type isn't part of the agent's runtime signing surface.
   */
  async executeActivity<T>(
    activityType: string,
    endpoint: string,
    parameters: Record<string, unknown>,
  ): Promise<T> {
    return this.submitActivity<T>(activityType, endpoint, parameters);
  }

  /** Generic query POST. Public surface for admin tooling. */
  async query<T>(pathSuffix: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.queryPost<T>(pathSuffix, body);
  }

  async signTransaction(
    input: SignTransactionInput,
  ): Promise<SignTransactionResult['signTransactionResult']> {
    const out = await this.submitActivity<SignTransactionResult>(
      'ACTIVITY_TYPE_SIGN_TRANSACTION_V2',
      'sign_transaction',
      input as unknown as Record<string, unknown>,
    );
    if (!out?.signTransactionResult) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `signTransaction response missing signTransactionResult`,
      );
    }
    return out.signTransactionResult;
  }

  // ── activity submission ────────────────────────────────────────────────────

  private async submitActivity<T>(
    activityType: string,
    endpoint: string,
    parameters: Record<string, unknown>,
  ): Promise<T> {
    // The histogram covers the whole round trip and must record on the failure path too, so
    // a Turnkey outage shows up as latency rather than as missing data.
    const start = Date.now();
    let outcome = 'error';
    try {
      const body = {
        type: activityType,
        timestampMs: String(Date.now()),
        organizationId: this.opts.organizationId,
        parameters,
      };
      // signWith is the chain-natural address ("0x...", "T...", base58 Solana). When present in
      // the parameters, including it in error context lets operators triage which chain/wallet
      // hit a Turnkey-side failure without grepping log files in tandem with HTTP captures.
      const signWith =
        typeof (parameters as { signWith?: unknown }).signWith === 'string'
          ? (parameters as { signWith: string }).signWith
          : undefined;
      const ctx = `activity=${activityType}${signWith ? ` signWith=${signWith}` : ''}`;

      const resp = await this.queryPost<{ activity: TurnkeyActivity<T> }>(
        `/public/v1/submit/${endpoint}`,
        body,
      );
      let activity = resp.activity;

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let pollAttempt = 0;
      // Count each activity that goes async (the submit response wasn't COMPLETED). One emit
      // per submitActivity call regardless of how many polls follow — the value of this metric
      // is "how often does Turnkey defer," not "how many polls did we send."
      if (activity?.status === 'ACTIVITY_STATUS_PENDING') {
        this.emitActivityPending(activityType);
      }
      while (activity?.status === 'ACTIVITY_STATUS_PENDING') {
        if (Date.now() > deadline) {
          throw signerRetryable(
            SignerErrorCode.TURNKEY_SIGNER_UNAVAILABLE,
            `Turnkey ${ctx} activityId=${activity.id} stayed PENDING past ${POLL_TIMEOUT_MS}ms`,
          );
        }
        const sleepIdx = Math.min(pollAttempt, POLL_BACKOFF_MS.length - 1);
        await sleep(POLL_BACKOFF_MS[sleepIdx]!);
        pollAttempt++;
        const polled = await this.queryPost<{ activity: TurnkeyActivity<T> }>(
          '/public/v1/query/get_activity',
          { organizationId: this.opts.organizationId, activityId: activity.id },
        );
        activity = polled.activity;
      }

      if (activity?.status !== 'ACTIVITY_STATUS_COMPLETED') {
        // Surface the status verbatim — `ACTIVITY_STATUS_REJECTED` / `CONSENSUS_NEEDED` /
        // `PENDING_SIGNERS` are all operator-actionable (sub-org policy denied, quorum approval
        // required, etc.) and the structured `failure` payload from Turnkey carries the human
        // detail. Including the status string keeps log greps cheap.
        const failure = activity?.failure ?? {};
        // The fingerprint is included because CONSENSUS_NEEDED is recoverable and APPROVE_ACTIVITY
        // takes the fingerprint, not the activity id. Without it here, the operator has to re-query.
        const fp = activity?.fingerprint ? ` fingerprint=${activity.fingerprint}` : '';
        throw signerTerminal(
          SignerErrorCode.TURNKEY_ACTIVITY_FAILED,
          `Turnkey ${ctx} activityId=${activity?.id ?? '?'} status=${activity?.status ?? 'unknown'}${fp}; ${JSON.stringify(failure)}`,
        );
      }
      // Defensive: a malformed COMPLETED response without `result` would otherwise return
      // `undefined as T` and surface as a confusing downstream type error.
      if (activity.result == null) {
        throw signerTerminal(
          SignerErrorCode.TURNKEY_BAD_RESPONSE,
          `Turnkey ${ctx} activityId=${activity.id} COMPLETED but result was missing`,
        );
      }
      outcome = 'success';
      return activity.result as T;
    } finally {
      this.emitSignDuration(Date.now() - start, activityType, outcome);
    }
  }

  // ── HTTP layer ────────────────────────────────────────────────────────────

  /**
   * Issue a POST against Turnkey with stamping, concurrency gating, and retry/backoff.
   * Retries on 429 + 5xx network-class failures; surfaces 4xx (other than 429) as terminal.
   */
  private async queryPost<T>(pathSuffix: string, body: Record<string, unknown>): Promise<T> {
    const bodyJson = JSON.stringify(body);
    // Submit endpoints (sign_raw_payload, sign_transaction, create_wallet, …) trigger
    // state-changing activities. Retrying after a transport error or 5xx risks a
    // double-execution because Turnkey may have already committed the activity before the
    // failure was observed locally. We surface those as retryable signer errors and let the
    // caller decide based on chain-level semantics (e.g., re-fetching the on-chain nonce)
    // rather than blindly re-POSTing the same body. Rate-limit 429s remain safe to retry
    // — Turnkey returns 429 BEFORE the activity is created.
    const isStateChanging = pathSuffix.startsWith('/public/v1/submit/');
    let attempt = 0;
    while (true) {
      await this.acquireSlot();
      let res: Response;
      try {
        const stamper = await this.getStamper();
        const stamp = await stamper.stamp(bodyJson);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.opts.requestTimeoutMs);
        try {
          res = await this.fetchImpl(`${this.opts.apiUrl}${pathSuffix}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'X-Stamp': stamp,
            },
            body: bodyJson,
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        this.releaseSlot();
        if (!isStateChanging) {
          const recoverable = await this.maybeBackoff(attempt, {
            reason: 'transport-error',
            path: pathSuffix,
            err,
          });
          if (recoverable) {
            attempt++;
            continue;
          }
        }
        throw signerRetryable(
          SignerErrorCode.TURNKEY_NETWORK,
          `Turnkey ${pathSuffix} transport error: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined,
        );
      }
      this.releaseSlot();

      if (res.ok) {
        const text = await res.text();
        try {
          return JSON.parse(text) as T;
        } catch (err) {
          throw signerTerminal(
            SignerErrorCode.TURNKEY_BAD_RESPONSE,
            `Turnkey ${pathSuffix} returned non-JSON: ${truncate(text, 200)}`,
            err instanceof Error ? err : undefined,
          );
        }
      }

      const bodyText = await res.text();
      // 401/403 = bad stamp / unknown public key — terminal.
      if (res.status === 401 || res.status === 403) {
        throw signerTerminal(
          SignerErrorCode.TURNKEY_AUTH,
          `Turnkey ${pathSuffix} → HTTP ${res.status}: ${truncate(bodyText, 200)}`,
        );
      }
      // 429 = rate limited. Always safe to retry — Turnkey rejects pre-activity-creation.
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const recoverable = await this.maybeBackoff(attempt, {
          reason: 'http-429',
          path: pathSuffix,
          ...(retryAfter != null ? { retryAfterMs: retryAfter } : {}),
        });
        if (recoverable) {
          attempt++;
          continue;
        }
        throw signerRetryable(
          SignerErrorCode.TURNKEY_RATE_LIMITED,
          `Turnkey ${pathSuffix} rate-limited after ${attempt + 1} attempts: ${truncate(bodyText, 200)}`,
        );
      }
      // 5xx on state-changing endpoints is NOT retryable here — Turnkey may have committed
      // the activity before returning 5xx. Surface as a retryable signer error so the
      // executor decides at the chain level (e.g., reconcile nonce, check for in-flight
      // activity by externalId). For idempotent queries, retry locally.
      if (res.status >= 500) {
        if (!isStateChanging) {
          const recoverable = await this.maybeBackoff(attempt, {
            reason: `http-${res.status}`,
            path: pathSuffix,
          });
          if (recoverable) {
            attempt++;
            continue;
          }
        }
        throw signerRetryable(
          SignerErrorCode.TURNKEY_NETWORK,
          `Turnkey ${pathSuffix} → HTTP ${res.status}${isStateChanging ? ' (state-changing endpoint — not retried locally)' : ` after ${attempt + 1} attempts`}: ${truncate(bodyText, 200)}`,
        );
      }
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Turnkey ${pathSuffix} → HTTP ${res.status}: ${truncate(bodyText, 200)}`,
      );
    }
  }

  /**
   * Returns true if we still have backoff budget; sleeps before the next attempt.
   *
   * The `reason` + `path` fields let operators distinguish a Turnkey rate-limit (`http-429`,
   * Retry-After honored) from a server-side failure (`http-5xx`) from a network blip
   * (`transport-error`) at log-grep level — all three currently produce the same backoff
   * behavior but have very different operational interpretations.
   */
  private async maybeBackoff(
    attempt: number,
    ctx: {
      reason: string;
      path: string;
      err?: unknown;
      retryAfterMs?: number;
    },
  ): Promise<boolean> {
    if (attempt >= TURNKEY_RETRY_BACKOFF_MS.length) return false;
    const delay = ctx.retryAfterMs ?? TURNKEY_RETRY_BACKOFF_MS[attempt] ?? 0;
    this.emitRetry(ctx.reason, ctx.path);
    this.emitBackoff(ctx.reason, delay);
    this.log.warn(
      {
        attempt,
        delayMs: delay,
        reason: ctx.reason,
        path: ctx.path,
        ...(ctx.retryAfterMs != null ? { retryAfterMs: ctx.retryAfterMs } : {}),
        ...(ctx.err ? { err: ctx.err instanceof Error ? ctx.err.message : ctx.err } : {}),
      },
      'Turnkey retry backoff',
    );
    await sleep(delay);
    return true;
  }

  // ── concurrency semaphore ──────────────────────────────────────────────────
  // The semaphore must remain ≤ `concurrencyLimit` even under contention. A naïve design
  // (decrement on release, let the waiter resume and re-increment) opens a TOCTOU window:
  // between `inFlight--` and the waiter's `inFlight++`, a fresh caller can race in via the
  // fast path and over-allocate. The fix: when releasing with a waiter queued, transfer the
  // slot directly — neither side touches `inFlight`. New arrivals always see the slot as
  // occupied until the waiter actually consumes it.

  private async acquireSlot(): Promise<void> {
    if (this.inFlight < this.opts.concurrencyLimit) {
      this.inFlight++;
      return;
    }
    // Waiter takes a slot when notified; `releaseSlot` hands the slot directly so we don't
    // increment here.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      // Transfer the slot directly; `inFlight` stays the same so a concurrent fast-path
      // caller still sees the limit hit.
      next();
      return;
    }
    this.inFlight--;
  }

  // ── lazy stamper init ──────────────────────────────────────────────────────

  private async getStamper(): Promise<TurnkeyStamper> {
    if (this.stamper) return this.stamper;
    if (!this.stamperInit) {
      const scalar = this.apiPrivateKey;
      if (!scalar) {
        throw new Error('TurnkeyClient: apiPrivateKey was scrubbed but stamper not initialized');
      }
      this.stamperInit = createTurnkeyStamper(scalar, this.opts.apiPublicKey).then(
        (s) => {
          this.stamper = s;
          // Scrub the hex string after the stamper has imported it. The CryptoKey is opaque
          // inside Web Crypto; the hex doesn't need to live on the heap any longer.
          this.apiPrivateKey = null;
          return s;
        },
        (err: unknown) => {
          // Scrub on failure too — even if we can't sign, the scalar shouldn't outlive its
          // single use. The rejected promise stays cached on `stamperInit` so retrying with
          // a now-null scalar would fail fast at the guard above on the next call.
          this.apiPrivateKey = null;
          throw err;
        },
      );
    }
    return this.stamperInit;
  }
}

function normalizeWalletId(id: string): string {
  // Turnkey returns wallet identifiers as either `wallets/<id>` or bare `<id>` depending on
  // endpoint. The query endpoints prefer bare; normalize to bare here.
  return id.startsWith('wallets/') ? id.slice('wallets/'.length) : id;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
