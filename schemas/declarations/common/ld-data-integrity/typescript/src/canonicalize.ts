// URDNA2015 canonicalization. jsonld.js's canonize, run as its two halves
// (jsonld.toRDF, then rdf-canonize) with admission checks before and
// between them, pinning the algorithm and routing resolution through a
// strict-no-network DocumentLoader. Mirror of the Go lib's
// canonicalize.go (which uses piprate/json-gold's Normalize). Both
// halves MUST produce byte-identical n-quads on the same input or
// the cross-language signing round trip silently breaks.

import jsonld from "jsonld";
import type { Options } from "jsonld";
import rdfCanonize from "rdf-canonize";
import type { Quad } from "rdf-canonize";

import { checkCanonicalizable } from "./admission.js";
import { checkDataset } from "./datasetAdmission.js";
import type { DocumentLoader } from "./documentLoader.js";
import { UnknownContextError } from "./errors.js";

// jsonld.canonize passes a null base when its input is not a string, which
// the published types do not allow for. The null matters: resolving against
// an empty base would remove dot segments, so that a relative reference such
// as "./_:x" became a blank node label the document chose itself.
type ToRdfOptions = Omit<Options.ToRdf, "base"> & {
  base: string | null;
  safe?: boolean;
  algorithm?: string;
  produceGeneralizedRdf?: boolean;
};

// canonicalize runs URDNA2015 canonicalization on a JSON-LD document
// and returns the canonical N-Quads form. The output is the input to
// the digest computation in hash.ts.
//
// `loader` must be a strict-no-network DocumentLoader (see
// documentLoader.ts). Passing null/undefined would fall back to
// jsonld.js's default loader which DOES make network calls — refused
// by this lib's contract.
//
// A document is refused with an AdmissionError before canonicalization,
// because URDNA2015 offers no bound on the work a small, adversarially
// shaped document can demand of it: checkCanonicalizable bounds the
// document's size and refuses self-defined terms and self-named blank
// nodes, and the expanded dataset is then refused if it holds too many
// blank nodes, or two blank nodes canonicalization could tell apart only
// by searching permutations.
export async function canonicalize(
  doc: object,
  loader: DocumentLoader
): Promise<string> {
  checkCanonicalizable(doc);

  // This is jsonld.canonize split where it converts the document to a
  // dataset and before it canonicalizes that dataset, so that the dataset
  // can be checked in between without changing the output. The first half
  // gets the options jsonld.canonize gives toRDF; the second gets only the
  // options rdf-canonize reads, of which jsonld.canonize sets none beyond
  // the algorithm.
  const toRdfOptions: ToRdfOptions = {
    base: null,
    algorithm: "URDNA2015",
    skipExpansion: false,
    safe: false,
    documentLoader: loader.toJsonldLoader(),
    produceGeneralizedRdf: false,
  };
  let dataset: Quad[];
  try {
    dataset = (await jsonld.toRDF(
      doc as Parameters<typeof jsonld.toRDF>[0],
      toRdfOptions as unknown as Options.ToRdf
    )) as unknown as Quad[];
  } catch (err) {
    // An unregistered context is refused as the UnknownContextError this
    // function promises (errors.ts), not as jsonld.js's error, which only
    // carries the loader's rejection inside it. jsonld.js's error is kept
    // as the cause.
    const unknown = loaderRejection(err);
    throw unknown ? new UnknownContextError(unknown.url, err) : err;
  }
  checkDataset(dataset);

  // Admitted datasets never reach the permutation search, so the limit
  // only matters if the check above were to admit one that does. It is a
  // backstop, not a detector: rdf-canonize compares a blank node's count of
  // deep iterations with the limit before incrementing it, so a limit of 1
  // lets each node run the search twice and throws on the third.
  return rdfCanonize.canonize(dataset, {
    algorithm: "URDNA2015",
    maxDeepIterations: 1,
  });
}

// loaderRejection finds the UnknownContextError the loader threw inside a
// jsonld.js error. jsonld.js keeps the loader's rejection as details.cause,
// so the chain is walked through cause and details.cause, to a small bound.
function loaderRejection(err: unknown): UnknownContextError | undefined {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    if (e instanceof UnknownContextError) {
      return e;
    }
    const wrapped = e as { cause?: unknown; details?: { cause?: unknown } };
    e = wrapped.cause ?? wrapped.details?.cause;
  }
  return undefined;
}
