/**
 * A payment gateway stand-in for the command-line tests, defined by the OpenAPI contract rather
 * than by hand.
 *
 * The point is not to avoid the network — it is to make the contract enforceable from inside this
 * package. Every request the tools send is validated against the spec's schema for that operation,
 * and every response this serves is validated before it goes out. So a command that starts sending
 * a body the contract no longer allows, or that is fed a response shape the contract no longer
 * describes, fails here.
 *
 * The schemas come from `../generated/schemas.gen`, which is regenerated from
 * `schemas/apis/payment-gateway/v1/openapi.yaml` and diff-guarded in CI. That is what keeps this
 * honest: there is no second copy of the contract to keep in step, so it cannot quietly go stale.
 * Change the spec, regenerate, and the tools' tests answer whether anything needs updating.
 *
 * Test-only. It is not in the tsup entry list, so it never reaches `dist`.
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import * as generatedSchemas from '../generated/schemas.gen';

/**
 * The generated module exports one `$Name` constant per schema. Stripping the prefix gives the
 * names the spec uses, which is what `$ref`s inside them point at.
 */
const SCHEMAS: Record<string, unknown> = Object.fromEntries(
  Object.entries(generatedSchemas).map(([exported, schema]) => [
    exported.replace(/^\$/, ''),
    schema,
  ]),
);

/** The names of every schema the contract publishes, in spec spelling. */
export const CONTRACT_SCHEMA_NAMES = Object.keys(SCHEMAS);

const ROOT_ID = 'https://atum.test/payment-gateway/v1.json';

// `strict: false` because these are OpenAPI Schema Objects, which carry keywords JSON Schema does
// not define (`example`, most visibly). ajv-formats supplies date-time, uri and int64, all of which
// the contract uses.
//
// `allErrors` stays off. Reporting the first violation is enough for what this is for -- the message
// names the offending field, which is what a failing test needs -- and collecting every violation
// makes validation cost grow with how deeply nested the input is, which static analysis flags
// wherever a validator is reachable from input the program did not produce. Nothing hostile reaches
// this one: it listens on loopback and is fed only by the commands under test.
const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
// Added as one document so the internal `#/components/schemas/...` references resolve as written,
// exactly as they do in the spec.
ajv.addSchema({ $id: ROOT_ID, components: { schemas: SCHEMAS } });

/**
 * Compile the contract's schema for one named type.
 *
 * @param name - the schema name as the spec spells it, e.g. `PaymentRequest`
 * @returns a validator, or throws when the contract has no such schema — which is itself the signal
 *          that this file is referring to something the spec has dropped or renamed
 */
export function contractValidator(name: string): ValidateFunction {
  const validate = ajv.getSchema(`${ROOT_ID}#/components/schemas/${name}`);
  if (!validate) {
    throw new Error(
      `fake-gateway: the contract has no schema named "${name}". It was renamed or removed in ` +
        'schemas/apis/payment-gateway/v1/openapi.yaml; update the route table in this file.',
    );
  }
  return validate;
}

/** Render ajv's errors as one line a failing test can actually read. */
export function describeViolations(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
    .join('; ');
}

/** One route the fake serves, named the way the contract names it. */
interface Route {
  method: string;
  /** The spec's path template, e.g. `/v1/payments/{paymentId}/status`. */
  path: string;
  /** Contract schema for the request body, when the operation takes one. */
  requestSchema?: string;
  /** Contract schema for the response body. */
  responseSchema: string;
}

/**
 * The operations the command-line tools use. Cross-checked against the generated client in
 * `fake-gateway.test.ts`, so a path that moves in the spec fails there rather than silently
 * leaving a route unserved.
 */
export const ROUTES: Route[] = [
  { method: 'GET', path: '/v1/defaults', responseSchema: 'GetDefaultsResult' },
  {
    method: 'POST',
    path: '/v1/payments',
    requestSchema: 'PaymentRequest',
    responseSchema: 'PaymentResponse',
  },
  {
    method: 'GET',
    path: '/v1/payments/{paymentId}/status',
    responseSchema: 'GetPaymentStatusResponse',
  },
  {
    method: 'POST',
    path: '/v1/payments/quote-requests',
    requestSchema: 'CreateQuoteRequest',
    responseSchema: 'QuoteRequestResponse',
  },
  {
    method: 'GET',
    path: '/v1/payments/quote-requests/{quoteRequestId}',
    responseSchema: 'QuoteRequestStatusResponse',
  },
  {
    method: 'POST',
    path: '/v1/payments/awards',
    requestSchema: 'AwardRequest',
    responseSchema: 'PaymentResponse',
  },
];

/** What the fake saw, for a test to assert on — including what it refused and why. */
export interface RecordedRequest {
  method: string;
  /** Path with the query string stripped. */
  path: string;
  query: Record<string, string>;
  body?: unknown;
  /** The matched route's spec path template, or undefined for an unrouted request. */
  route?: string;
  /** Set when the body did not satisfy the contract; the request was answered 400. */
  violation?: string;
}

/** How the fake should answer one route. */
export type Responder = (req: RecordedRequest) => { status?: number; body: unknown };

export interface FakeGatewayOptions {
  /** Per-route overrides, keyed by `"<METHOD> <spec path>"`, e.g. `"POST /v1/payments"`. */
  responders?: Record<string, Responder>;
  /**
   * Skip validating what this serves. Only for the cases that deliberately serve an off-contract
   * response to prove the client rejects it.
   */
  allowInvalidResponses?: boolean;
}

export interface FakeGateway {
  /** Base URL to hand the tools as `--gateway`. */
  url: string;
  /** Every request received, in order. */
  requests: RecordedRequest[];
  /** The requests matching a method and spec path — the usual way to assert what was and was not called. */
  received(method: string, path: string): RecordedRequest[];
  close(): Promise<void>;
}

/** Defaults that satisfy the contract, shaped after a live devnet response. */
function defaultResponders(): Record<string, Responder> {
  return {
    'GET /v1/defaults': (req) => ({
      body: {
        chain_id: req.query.chain_id ?? 'eip155:42161',
        quote_selector: '0xd0f080E23F95571D26eEb1FAD24a5F3d66835195',
        escrow_contract: '0xa61a0C025943Aa79B73D8D07E3aDbEe1873738b4',
        fulfillment_proxy: '0x09A5a0d6955E5394A661Cd9E7007076fa63B4158',
        fulfillment_verifier: {
          account: '0x27050EE47befC43F4dF7807a7AA8073039e5fa89',
          endpoint: 'https://veri-fill.test',
        },
      },
    }),
    'POST /v1/payments': () => ({
      body: { payment_id: '0xpayment', status: 'pending', idempotent_replay: false },
    }),
    'GET /v1/payments/{paymentId}/status': () => ({
      body: { payment_id: '0xpayment', status: 'completed' },
    }),
    'POST /v1/payments/quote-requests': () => ({
      body: { quote_request_id: 'qr_test', status: 'ready', idempotent_replay: false, quotes: [] },
    }),
    'GET /v1/payments/quote-requests/{quoteRequestId}': () => ({
      body: { quote_request_id: 'qr_test', status: 'ready', quotes: [] },
    }),
    'POST /v1/payments/awards': () => ({
      body: { payment_id: '0xpayment', status: 'pending', idempotent_replay: false },
    }),
  };
}

/** Turn a spec path template into a matcher, so `{paymentId}` matches one segment. */
function toPattern(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith('{') && segment.endsWith('}') ? '[^/]+' : escapeSegment(segment),
    )
    .join('/');
  return new RegExp(`^${source}$`);
}

function escapeSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Start the fake on a loopback port.
 *
 * @param options - per-route responses, and whether to police what is served
 * @returns the running gateway; `close()` it in an `afterEach`/`afterAll`
 */
export async function startFakeGateway(options: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const responders = { ...defaultResponders(), ...(options.responders ?? {}) };
  const requests: RecordedRequest[] = [];
  const compiled = ROUTES.map((route) => ({ route, pattern: toPattern(route.path) }));

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      };
      requests.push(recorded);

      const match = compiled.find(
        ({ route, pattern }) => route.method === recorded.method && pattern.test(url.pathname),
      );
      if (!match) {
        // Not a contract operation the tools are supposed to reach. Answering 404 with a
        // contract-shaped error keeps the client on its normal error path.
        return send(res, 404, {
          code: 'NOT_FOUND',
          message: `fake-gateway serves no ${recorded.method} ${url.pathname}`,
        });
      }
      recorded.route = match.route.path;

      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw !== '') {
        try {
          recorded.body = JSON.parse(raw);
        } catch {
          recorded.violation = 'body is not valid JSON';
          return send(res, 400, { code: 'VALIDATION_ERROR', message: recorded.violation });
        }
      }

      // The contract check on the way in. This is what fails when a command drifts from the spec.
      if (match.route.requestSchema) {
        const validate = contractValidator(match.route.requestSchema);
        if (!validate(recorded.body)) {
          recorded.violation = `${match.route.requestSchema}: ${describeViolations(validate)}`;
          return send(res, 400, {
            code: 'VALIDATION_ERROR',
            message: `fake-gateway refused an off-contract request body — ${recorded.violation}`,
          });
        }
      }

      const { status = 200, body } =
        responders[`${match.route.method} ${match.route.path}`](recorded);

      // And on the way out, so a canned response cannot describe a gateway the contract forbids.
      // Answered rather than thrown: throwing here would leave the client waiting on a connection
      // that never completes, which surfaces as a test timeout instead of a readable failure.
      if (!options.allowInvalidResponses) {
        const validate = contractValidator(match.route.responseSchema);
        if (!validate(body)) {
          recorded.violation =
            `response for ${match.route.method} ${match.route.path} does not satisfy ` +
            `${match.route.responseSchema}: ${describeViolations(validate)}`;
          return send(res, 500, {
            code: 'FAKE_GATEWAY_INVALID_RESPONSE',
            message: `fake-gateway refused to serve an off-contract response — ${recorded.violation}`,
          });
        }
      }
      send(res, status, body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    received: (method, path) =>
      requests.filter((r) => r.method === method && (r.route === path || r.path === path)),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `close` only stops new connections and then waits for the open ones to end. Node's fetch
        // pools keep-alive sockets, so without this the server never finishes closing and jest
        // reports a leaked handle at the end of the run.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function send(res: import('http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
