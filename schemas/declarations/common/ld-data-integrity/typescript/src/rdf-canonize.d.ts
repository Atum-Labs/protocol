// Ambient types for the parts of rdf-canonize this package uses; the package
// ships no declarations of its own.
declare module "rdf-canonize" {
  export interface Term {
    termType: string;
    value: string;
    datatype?: { termType: string; value: string };
    language?: string;
  }
  export interface Quad {
    subject: Term;
    predicate: Term;
    object: Term;
    graph: Term;
  }
  export const NQuads: {
    serializeQuad(quad: Quad): string;
  };
  export function canonize(
    dataset: Quad[],
    options: { algorithm: "URDNA2015"; maxDeepIterations?: number }
  ): Promise<string>;
  const _default: {
    NQuads: typeof NQuads;
    canonize: typeof canonize;
  };
  export default _default;
}
