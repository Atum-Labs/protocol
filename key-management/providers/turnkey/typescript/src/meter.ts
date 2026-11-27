// Minimal metrics interface the Turnkey client needs. Consumers inject a meter backed by their
// telemetry stack (e.g. @opentelemetry/api); when omitted a no-op meter is used.

export interface Counter {
  add(value: number, attributes?: Record<string, unknown>): void;
}

export interface Histogram {
  record(value: number, attributes?: Record<string, unknown>): void;
}

export interface InstrumentOptions {
  description?: string;
  unit?: string;
}

export interface Meter {
  createCounter(name: string, options?: InstrumentOptions): Counter;
  createHistogram(name: string, options?: InstrumentOptions): Histogram;
}

const noopCounter: Counter = { add: () => {} };
const noopHistogram: Histogram = { record: () => {} };

export const noopMeter: Meter = {
  createCounter: () => noopCounter,
  createHistogram: () => noopHistogram,
};
