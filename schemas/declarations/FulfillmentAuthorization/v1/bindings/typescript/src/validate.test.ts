import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Signature, TypedDataEncoder, Wallet, getAddress, recoverAddress } from "ethers";
import { describe, expect, it } from "vitest";
import {
  ContractSignatureRejectedError,
  FulfillmentAuthorizationError,
  SchemeNotImplementedError,
  SignatureUnverifiableError,
  validateFulfillmentAuthorization,
  validateFulfillmentAuthorizationJSON,
  type ContractSignatureAnswer,
  type SettlerSignatureChecker,
} from "./validate.js";

const conformance = resolve(dirname(fileURLToPath(import.meta.url)), "../../../conformance/fixtures");

// Hardhat account #0, the settler in the conformance vectors.
const SETTLER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

type Json = Record<string, any>;

interface ConformanceVector {
  file: string;
  valid: boolean;
  description: string;
  error_contains?: string;
  contract_signatures_allowed?: { valid: boolean; error_contains?: string };
}

/** Asserts one verdict, so the default and the opt-in are checked the same way. */
async function expectVerdict(
  result: Promise<void>,
  expected: { valid: boolean; error_contains?: string },
  description: string,
): Promise<void> {
  if (expected.valid) {
    await expect(result, description).resolves.toBeUndefined();
    return;
  }
  // Case-insensitive, for the same reason the Go harness is: the two schema validators
  // spell the same refusal differently, and one manifest phrase has to hold for both.
  await expect(result, description).rejects.toThrow();
  const message = await result.then(
    () => "",
    (err: Error) => err.message,
  );
  expect(message.toLowerCase(), description).toContain(String(expected.error_contains).toLowerCase());
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(resolve(conformance, path), "utf8"));
}

function readText(path: string): string {
  return readFileSync(resolve(conformance, path), "utf8");
}

describe("FulfillmentAuthorization conformance vectors", () => {
  const vectors = readJson("vectors.json") as ConformanceVector[];

  it("has vectors", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors) {
    it(vector.file, async () => {
      // From the bytes, not a parsed object: a document whose members fold together is only a
      // document while it is still text, and that is what the Go binding reads too.
      await expectVerdict(validateFulfillmentAuthorizationJSON(readText(vector.file)), vector, vector.description);

      // A vector that names a second verdict is run both ways, so the option is covered by the
      // same oracle as the default and cannot quietly stop mattering.
      if (vector.contract_signatures_allowed !== undefined) {
        await expectVerdict(
          validateFulfillmentAuthorizationJSON(readText(vector.file), { allowContractSignature: true }),
          vector.contract_signatures_allowed,
          `${vector.description} (with allowContractSignature)`,
        );
      }
    });
  }

  // Every fixture is listed in the manifest, so neither language can run a vector the other skips.
  // The manifest is the shared oracle: both suites assert each vector's verdict against it, which
  // only holds the two in step for the vectors both actually run. An unlisted file would be
  // skipped silently by both, and a file listed but absent would pass vacuously.
  it("lists every fixture in the manifest", () => {
    // chain-vectors.json is the second manifest: the same documents judged with a chain reader.
    const listed = new Set(["vectors.json", "chain-vectors.json", ...vectors.map((vector) => vector.file)]);
    const unlisted = readdirSync(conformance).filter((name) => !listed.has(name));
    expect(unlisted, "fixtures not in vectors.json are run by at most one language").toEqual([]);
  });
});

// CORE-2955's reproduction: before strict became the default, each of these passed on a document
// whose settler is an EOA, so a pass did not show the settler signed. The option is the only way
// back to that behaviour.
describe("non-EOA signatures are refused by default", () => {
  const cases: Array<[string, string, boolean]> = [
    ["one byte", "0x11", true],
    ["64 bytes", `0x${"ab".repeat(64)}`, true],
    ["100 bytes", `0x${"cd".repeat(100)}`, true],
    ["odd length", `0x${"ab".repeat(32)}a`, true],
    ["not hex at all", "deadbeef", false],
    ["empty but 0x", "0x", false],
  ];

  for (const [name, signature, allowedUnderOption] of cases) {
    it(`refuses ${name}`, async () => {
      const doc = settlerSigned();
      doc.authorization.signature = signature;
      const text = JSON.stringify(doc);
      await expect(validateFulfillmentAuthorizationJSON(text)).rejects.toThrow();

      // The empty and non-hex cases stay refused even when the caller allows a contract
      // signature: there is nothing there to hand the token.
      const withOption = validateFulfillmentAuthorizationJSON(text, { allowContractSignature: true });
      if (allowedUnderOption) {
        await expect(withOption).resolves.toBeUndefined();
      } else {
        await expect(withOption).rejects.toThrow();
      }
    });
  }
});

// SOROBAN-AUTH is a scheme the schema names and the validators do not implement. It has to get past
// the schema, so a Stellar document is refused for the right reason, and it must not fall through
// to the EIP-3009 parser: a settler-signed EIP-3009 document relabelled with it is still refused.
describe("SOROBAN-AUTH scheme is named but not implemented", () => {
  it("refuses it as not implemented, past the schema", async () => {
    const doc = { ...readJson("settler-signed-declaration-only.json"), scheme: "SOROBAN-AUTH" };
    const err = await validateFulfillmentAuthorization(doc).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SchemeNotImplementedError);
    expect(err).toBeInstanceOf(FulfillmentAuthorizationError);
    expect((err as SchemeNotImplementedError).scheme).toBe("SOROBAN-AUTH");
    expect((err as Error).message).toBe("scheme SOROBAN-AUTH is not implemented");
  });

  it("leaves the schema refusing an unnamed scheme", async () => {
    const doc = { ...readJson("settler-signed-declaration-only.json"), scheme: "SOROBAN-AUTH-TYPO" };
    const message = await validateFulfillmentAuthorization(doc).then(
      () => "",
      (err: Error) => err.message,
    );
    expect(message).not.toBe("");
    expect(message).not.toContain("is not implemented");
  });
});

// A document of an implemented scheme that passes the schema and fails a binding rule is a refusal,
// and it is not SchemeNotImplementedError: a caller that defers to a scheme-specific verifier on that
// class must never be sent there by a rule failure. The document is re-signed after the edit, so the
// rule, not the digest or the signature, is what refuses it. (Deleting a required member would not
// do: the schema refuses that before the scheme lookup, and never reaches the rules.)
describe("a rule failure of an implemented scheme is not SchemeNotImplementedError", () => {
  it("refuses a re-signed amount mismatch as a plain FulfillmentAuthorizationError", async () => {
    const doc = settlerSigned();
    const typed = typedData(doc);
    typed.message.value = "99999";
    resign(doc, typed);
    const err = await validateFulfillmentAuthorization(doc).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FulfillmentAuthorizationError);
    expect((err as Error).message).toContain("does not equal fulfillment_amount");
    expect(err).not.toBeInstanceOf(SchemeNotImplementedError);
  });
});

// Rules the vectors do not cover, each on a settler-signed document re-signed after the edit
// so that the rule under test, not the digest or signature check, is what rejects it.
describe("validateFulfillmentAuthorization EIP-3009 rules", () => {
  const cases: Array<[string, (doc: Json, typed: Json) => void, string]> = [
    ["amount", (_, typed) => (typed.message.value = "99999"), "does not equal fulfillment_amount"],
    [
      "asset",
      (_, typed) => (typed.domain.verifyingContract = "0x0000000000000000000000000000000000000009"),
      "domain.verifyingContract 0x0000000000000000000000000000000000000009 is not the quote destination's token",
    ],
    ["chain", (_, typed) => (typed.domain.chainId = 8453), "domain.chainId 8453 is not the quote destination's chain eip155:84532"],
    // The domain binds to the token by address; the asset namespace is the shared asset rule's.
    [
      "destination asset namespace",
      (doc) => {
        const quote = JSON.parse(doc.fulfillment_quote_json);
        quote.destination.id = String(quote.destination.id).replace("/erc20:", "/erc721:");
        doc.fulfillment_quote_json = JSON.stringify(quote);
      },
      "does not equal quote destination",
    ],
    // Neither U+FEFF nor U+0085 is ASCII whitespace, so a destination led by one is refused in both
    // languages; strings.TrimSpace and JavaScript's trim() each strip only one of them.
    ["destination led by U+FEFF", (doc) => padDestination(doc, "\ufeff", ""), "domain.chainId 84532 is not the quote destination's chain"],
    ["destination led by U+0085", (doc) => padDestination(doc, "\u0085", ""), "domain.chainId 84532 is not the quote destination's chain"],
    ["recipient", (_, typed) => (typed.message.to = "0x0000000000000000000000000000000000000009"), "does not equal a payment request destination"],
    ["valid after equals valid before", (_, typed) => (typed.message.validAfter = typed.message.validBefore), "validAfter must be 0"],
    ["non-canonical value", (_, typed) => (typed.message.value = "0100000"), "uint256 decimal strings"],
    ["extra domain field", (_, typed) => (typed.domain.salt = `0x${"00".repeat(32)}`), "not EIP-3009 typed data"],
    ["other primary type", (_, typed) => (typed.primaryType = "ReceiveWithAuthorization"), "primaryType"],
    ["payload beside message_prehash", (doc) => (doc.authorization.payload = {}), "must not carry payload"],
  ];

  for (const [name, edit, wantErr] of cases) {
    it(`rejects ${name}`, async () => {
      const doc = settlerSigned();
      const typed = typedData(doc);
      edit(doc, typed);
      resign(doc, typed);
      await expect(validateFulfillmentAuthorization(doc)).rejects.toThrow(wantErr);
      await expect(validateFulfillmentAuthorization(doc)).rejects.not.toBeInstanceOf(SchemeNotImplementedError);
    });
  }

  // A destination id padded with spaces is the same asset and chain, as it is for the shared asset
  // rule, in both languages. (Tab, CR and LF padding never gets this far: the quote's
  // canonicalizer refuses them first.)
  it.each([" ", "   "])("accepts a destination padded with %j", async (pad) => {
    const doc = settlerSigned();
    padDestination(doc, pad, pad);
    resign(doc, typedData(doc));
    await expect(validateFulfillmentAuthorization(doc)).resolves.toBeUndefined();
  });

  it("rejects a high-s signature", async () => {
    const doc = settlerSigned();
    const sig = Signature.from(doc.authorization.signature);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = (n - BigInt(sig.s)).toString(16).padStart(64, "0");
    const v = sig.v === 27 ? "1c" : "1b";
    doc.authorization.signature = `${sig.r}${highS}${v}`;
    await expect(validateFulfillmentAuthorization(doc)).rejects.toThrow("not a canonical secp256k1 signature");
  });

  it("accepts the unchanged typed data re-signed", async () => {
    const doc = settlerSigned();
    resign(doc, typedData(doc));
    await expect(validateFulfillmentAuthorization(doc)).resolves.toBeUndefined();
  });
});

interface ChainVector {
  name: string;
  file: string;
  has_code: boolean | { error: string };
  wallet?: { kind: string; owner?: string; trusted_caller?: string; signature?: string; return_data?: string; message?: string };
  expect: { valid: boolean; kind?: "rejected" | "unverifiable" | "offline"; error_contains?: string };
  calls: { has_code: number; is_valid_signature: number };
}

const SETTLER_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const MAGIC = `0x1626ba7e${"00".repeat(28)}`;
const INVALID_VALUE = `0xffffffff${"00".repeat(28)}`;

/**
 * A chain reader for a vector. The wallet is a model of what an ERC-1271 wallet answers, never a
 * deployed one: that the real answer comes from a deployed wallet is the one thing no offline test
 * can show.
 */
function fakeChain(vector: ChainVector) {
  const calls = {
    hasCode: [] as string[],
    isValid: [] as Array<{ network: string; account: string; digest: string; signature: string; caller: string }>,
  };
  const wallet = vector.wallet;
  const answer = (digest: string, signature: string, caller: string): ContractSignatureAnswer => {
    if (wallet === undefined) throw new Error(`${vector.name}: the wallet was called, and the vector describes none`);
    switch (wallet.kind) {
      case "owner": {
        if (caller !== wallet.trusted_caller || signature.length !== 132) return { reverted: true };
        let owner: string;
        try {
          owner = recoverAddress(digest, Signature.from(signature));
        } catch {
          return { reverted: true };
        }
        return { reverted: false, returnData: owner.toLowerCase() === wallet.owner ? MAGIC : INVALID_VALUE };
      }
      case "approves":
        return { reverted: false, returnData: signature === wallet.signature ? MAGIC : INVALID_VALUE };
      case "reverts":
        return { reverted: true };
      case "returns":
        return { reverted: false, returnData: wallet.return_data };
    }
    throw new Error(`${vector.name}: unknown wallet kind ${wallet.kind}`);
  };
  const checker: SettlerSignatureChecker = {
    async hasCode(network, account) {
      calls.hasCode.push(`${network}/${account}`);
      if (typeof vector.has_code === "object") throw new Error(vector.has_code.error);
      return vector.has_code && account === SETTLER_ADDRESS;
    },
    async isValidSignatureFrom(network, account, digest, signature, caller) {
      calls.isValid.push({ network, account, digest, signature, caller });
      if (wallet?.kind === "errors") throw new Error(String(wallet.message));
      return answer(digest, signature, caller);
    },
  };
  return { checker, calls };
}

// The same cases the Go suite runs from the same manifest: a fixture, what the chain says about its
// settler, and the verdict and number of chain reads both languages must reach.
describe("FulfillmentAuthorization chain conformance vectors", () => {
  const vectors = readJson("chain-vectors.json") as ChainVector[];

  it("has vectors", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors) {
    it(vector.name, async () => {
      const { checker, calls } = fakeChain(vector);
      const result = validateFulfillmentAuthorizationJSON(readText(vector.file), { signatureChecker: checker });
      if (vector.expect.valid) {
        await expect(result, vector.name).resolves.toBeUndefined();
      } else {
        const error = await result.then(
          () => undefined,
          (err: Error) => err,
        );
        expect(error, `${vector.name}: want a refusal`).toBeDefined();
        expect(error!.message.toLowerCase()).toContain(String(vector.expect.error_contains).toLowerCase());
        const kind = error instanceof ContractSignatureRejectedError ? "rejected" : error instanceof SignatureUnverifiableError ? "unverifiable" : "offline";
        expect(kind, `${vector.name}: ${error!.message}`).toBe(vector.expect.kind);
      }
      expect(calls.hasCode.length, `${vector.name}: code reads`).toBe(vector.calls.has_code);
      expect(calls.isValid.length, `${vector.name}: isValidSignature calls`).toBe(vector.calls.is_valid_signature);
    });
  }
});

describe("signatureChecker", () => {
  const owner = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const contractWallet = (answerFor: (digest: string, signature: string, caller: string) => ContractSignatureAnswer) => {
    const isValid: Array<{ network: string; account: string; digest: string; signature: string; caller: string; block?: bigint }> = [];
    const hasCode: string[] = [];
    const hasCodeBlocks: Array<bigint | undefined> = [];
    const checker: SettlerSignatureChecker = {
      async hasCode(network, account, block) {
        hasCode.push(`${network}/${account}`);
        hasCodeBlocks.push(block);
        return account === SETTLER_ADDRESS;
      },
      async isValidSignatureFrom(network, account, digest, signature, caller, block) {
        isValid.push({ network, account, digest, signature, caller, block });
        return answerFor(digest, signature, caller);
      },
    };
    return { checker, isValid, hasCode, hasCodeBlocks };
  };

  it("asks the wallet what the token would: the document's digest and signature, the token as msg.sender", async () => {
    const doc = readJson("signature-not-from.json");
    const { checker, isValid } = contractWallet((digest, signature, caller) => {
      const recovered = recoverAddress(digest, Signature.from(signature));
      return { reverted: caller !== "0x036cbd53842c5426634e7929541ec2318f3dcf7e", returnData: recovered === owner.address ? MAGIC : INVALID_VALUE };
    });
    await expect(validateFulfillmentAuthorizationJSON(JSON.stringify(doc), { signatureChecker: checker })).resolves.toBeUndefined();
    expect(isValid).toEqual([
      {
        network: "eip155:84532",
        account: SETTLER_ADDRESS,
        digest: doc.authorization.message,
        signature: doc.authorization.signature,
        caller: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        block: undefined,
      },
    ]);
    // The control: without a checker the same document is refused, because the signature recovers
    // to the owner and not to message.from. A contract signature is proved only by the chain.
    await expect(validateFulfillmentAuthorizationJSON(JSON.stringify(doc))).rejects.toThrow("not message.from");
    expect(getAddress(SETTLER_ADDRESS)).toBe(JSON.parse(doc.authorization.message_prehash).message.from);
  });

  // The permissive option admits each of these on an EOA settler's document without asking anyone;
  // a checker must refuse every one the signer's contract does not vouch for.
  it.each([
    ["one byte", "0x11"],
    ["64 bytes", `0x${"ab".repeat(64)}`],
    ["100 bytes", `0x${"cd".repeat(100)}`],
  ])("refuses %s that the wallet rejects, though allowContractSignature admits it", async (_name, signature) => {
    const doc = settlerSigned();
    doc.authorization.signature = signature;
    const text = JSON.stringify(doc);
    await expect(validateFulfillmentAuthorizationJSON(text, { allowContractSignature: true })).resolves.toBeUndefined();
    const { checker } = contractWallet(() => ({ reverted: false, returnData: INVALID_VALUE }));
    const error = await validateFulfillmentAuthorizationJSON(text, { signatureChecker: checker, allowContractSignature: true }).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(ContractSignatureRejectedError);
    expect(error).not.toBeInstanceOf(SignatureUnverifiableError);
  });

  it("keeps the reader's error for the logs", async () => {
    const checker: SettlerSignatureChecker = {
      hasCode: async () => {
        throw new Error("rpc: connection refused");
      },
      isValidSignatureFrom: async () => ({ reverted: true }),
    };
    const error = await validateFulfillmentAuthorizationJSON(readText("settler-signed.json"), { signatureChecker: checker }).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(SignatureUnverifiableError);
    expect(error).not.toBeInstanceOf(ContractSignatureRejectedError);
    expect(error!.message).toContain("rpc: connection refused");
  });

  it.each([
    ["not hex", "deadbeef"],
    ["odd length", `0x${"ab".repeat(32)}a`],
    ["too long", `0x${"ab".repeat(32768)}`],
  ])("refuses a signature that is %s before reading the chain", async (_name, signature) => {
    const doc = settlerSigned();
    doc.authorization.signature = signature;
    const { checker, hasCode } = contractWallet(() => ({ reverted: false, returnData: MAGIC }));
    await expect(validateFulfillmentAuthorizationJSON(JSON.stringify(doc), { signatureChecker: checker })).rejects.toThrow();
    expect(hasCode).toEqual([]);
  });

  // Every failure of the reader is a refusal. Nothing a reader can fail with passes, and a failure
  // the settler can steer a wallet into (out of gas, an invalid opcode) is one of them, so a caller
  // that gates on the pass is shut by it.
  it.each(["signature-not-from.json", "settler-signed.json"])("never passes an unverifiable document (%s)", async (file) => {
    const boom = new Error("evm: invalid opcode: opcode 0xfe not defined");
    const readers: Record<string, SettlerSignatureChecker> = {
      "code read fails": {
        hasCode: async () => {
          throw boom;
        },
        isValidSignatureFrom: async () => ({ reverted: false, returnData: MAGIC }),
      },
      "the call fails (invalid opcode)": {
        hasCode: async () => true,
        isValidSignatureFrom: async () => {
          throw boom;
        },
      },
      "the reader does not serve the network": {
        hasCode: async (network) => {
          if (network !== "eip155:1") throw new Error(`network ${network} is not served`);
          return true;
        },
        isValidSignatureFrom: async () => ({ reverted: false, returnData: MAGIC }),
      },
    };
    for (const [name, checker] of Object.entries(readers)) {
      const error = await validateFulfillmentAuthorizationJSON(readText(file), { signatureChecker: checker }).then(
        () => undefined,
        (err: Error) => err,
      );
      expect(error, `${name}: an unreadable chain passed`).toBeInstanceOf(SignatureUnverifiableError);
      expect(error, name).not.toBeInstanceOf(ContractSignatureRejectedError);
    }
  });

  it("asks the document's network", async () => {
    const { checker, hasCode } = contractWallet(() => ({ reverted: false, returnData: MAGIC }));
    await validateFulfillmentAuthorizationJSON(readText("settler-signed.json"), { signatureChecker: checker });
    expect(hasCode).toEqual([`eip155:84532/${SETTLER_ADDRESS}`]);
  });

  describe("block", () => {
    const answers = () => ({ reverted: false, returnData: MAGIC });
    it("is undefined for both reads by default", async () => {
      const { checker, isValid, hasCodeBlocks } = contractWallet(answers);
      await validateFulfillmentAuthorizationJSON(readText("signature-not-from.json"), { signatureChecker: checker });
      expect(hasCodeBlocks).toEqual([undefined]);
      expect(isValid.map((call) => call.block)).toEqual([undefined]);
    });
    it("puts both reads at the block it names", async () => {
      const { checker, isValid, hasCodeBlocks } = contractWallet(answers);
      await validateFulfillmentAuthorizationJSON(readText("signature-not-from.json"), { signatureChecker: checker, block: 12345n });
      expect(hasCodeBlocks).toEqual([12345n]);
      expect(isValid.map((call) => call.block)).toEqual([12345n]);
    });
  });

  it("without a checker, gives the strict offline verdict", async () => {
    await expect(validateFulfillmentAuthorizationJSON(readText("contract-signature.json"))).rejects.toThrow("must be 65 bytes");
    await expect(validateFulfillmentAuthorizationJSON(readText("contract-signature.json"), {})).rejects.toThrow("must be 65 bytes");
  });

  it("reads the chain last: an edited amount is refused without a read", async () => {
    const doc = settlerSigned();
    const typed = typedData(doc);
    typed.message.value = "99999";
    resign(doc, typed);
    const { checker, hasCode } = contractWallet(() => ({ reverted: false, returnData: MAGIC }));
    await expect(validateFulfillmentAuthorizationJSON(JSON.stringify(doc), { signatureChecker: checker })).rejects.toThrow("does not equal fulfillment_amount");
    expect(hasCode).toEqual([]);
  });
});

function settlerSigned(): Json {
  return readJson("settler-signed.json");
}

// Wraps the quote's destination id in the given prefix and suffix.
function padDestination(doc: Json, prefix: string, suffix: string): void {
  const quote = JSON.parse(doc.fulfillment_quote_json);
  quote.destination.id = `${prefix}${quote.destination.id}${suffix}`;
  doc.fulfillment_quote_json = JSON.stringify(quote);
}

function typedData(doc: Json): Json {
  return JSON.parse(doc.authorization.message_prehash);
}

// Writes typed back as message_prehash and signs it with the settler's key. When the edited
// typed data no longer hashes, the digest and signature are left as they were, so the decode
// error is what the validator reports.
function resign(doc: Json, typed: Json): void {
  doc.authorization.message_prehash = JSON.stringify(typed);
  let digest: string;
  try {
    digest = TypedDataEncoder.hash(typed.domain, typed.types, typed.message);
  } catch {
    return;
  }
  doc.authorization.message = digest;
  doc.authorization.signature = new Wallet(SETTLER_KEY).signingKey.sign(digest).serialized;
}
