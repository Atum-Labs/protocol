import axios, { type AxiosRequestConfig } from 'axios';
import type { ApiRequestOptions } from './generated/core/ApiRequestOptions';
import { AxiosHttpRequest } from './generated/core/AxiosHttpRequest';
import { CancelablePromise } from './generated/core/CancelablePromise';
import { Interceptors, type OpenAPIConfig } from './generated/core/OpenAPI';
import { request as generatedRequest } from './generated/core/request';
import {
  type RequestTimeouts,
  applyRequestTimeout,
  dropPartialResponseOnTimeout,
  timeoutForRequest,
  translateTimeout,
} from './request-timeout';

/**
 * Dedicated instance so a timeout interceptor cannot leak onto the default
 * axios singleton. Axios 1.20 attaches a partial `response` when the budget
 * fires after headers; dropping it here is what keeps the generated client
 * from turning that into a completed HTTP error.
 */
const timeoutAxios = axios.create();
timeoutAxios.interceptors.response.use(undefined, (error: unknown) =>
  Promise.reject(dropPartialResponseOnTimeout(error)),
);

/**
 * Install the timeout interceptor on a fresh chain. Fresh because the generated
 * client keeps the `Interceptors` object by reference, so registering on the
 * caller's would mutate a value they own. Theirs are copied over and run first,
 * leaving a timeout of their own in control.
 *
 * `_fns` is a declared public field of the generated `Interceptors`; a rename by
 * the generator breaks the build here, which is the intended tripwire.
 */
export function withRequestTimeout(
  config: Partial<OpenAPIConfig> | undefined,
  timeouts: RequestTimeouts,
): Pick<OpenAPIConfig, 'interceptors'> {
  const request = new Interceptors<AxiosRequestConfig>();
  for (const fn of config?.interceptors?.request?._fns ?? []) request.use(fn);
  request.use(applyRequestTimeout(timeouts));
  return {
    interceptors: { request, response: config?.interceptors?.response ?? new Interceptors() },
  };
}

/**
 * The generated transport, with a timed-out request restated as a
 * `GatewayTimeoutError`. The budget itself is applied by an interceptor, the only
 * hook the generated request layer offers, and axios then rejects with a bare
 * `ECONNABORTED`. Translating here means every service method reports an
 * unresponsive gateway the same way, and subclassing keeps the generated code
 * untouched so `pnpm run generate` stays idempotent.
 */
class TimeoutHttpRequest extends AxiosHttpRequest {
  constructor(
    config: OpenAPIConfig,
    private readonly timeouts: RequestTimeouts = {},
  ) {
    super(config);
  }

  public override request<T>(options: ApiRequestOptions): CancelablePromise<T> {
    return new CancelablePromise<T>((resolve, reject, onCancel) => {
      const pending = generatedRequest<T>(this.config, options, timeoutAxios);
      // Cancelling the wrapper has to reach the real request, or an aborted call
      // would leave its socket open.
      onCancel(() => pending.cancel());
      pending.then(resolve, (error: unknown) => {
        // The query lives beside the path here, not in it, so pass it explicitly.
        const request = { method: options.method, url: options.url, wait: options.query?.wait };
        reject(
          translateTimeout(error, this.config.BASE, timeoutForRequest(request, this.timeouts)),
        );
      });
    });
  }
}

/** Binds the timeouts so the result matches the constructor the generated client calls. */
export function timeoutHttpRequest(
  timeouts: RequestTimeouts,
): new (config: OpenAPIConfig) => TimeoutHttpRequest {
  return class extends TimeoutHttpRequest {
    constructor(config: OpenAPIConfig) {
      super(config, timeouts);
    }
  };
}
