/**
 * Conformance test for the x402-facilitator OpenAPI document. Validating it both
 * resolves every $ref — including the external references to the atum-escrow
 * schema files, which are relative paths and so break silently when a file moves —
 * and checks the result against the OpenAPI schema, so a malformed document fails
 * here rather than at a consumer's codegen. Dereferencing alone would do only the
 * first: it answers whether the pointers resolve, not whether what they resolve to
 * is a legal document. Also asserts the three endpoints exist and that /supported
 * advertises the required `signers` field.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";

const openapiPath = fileURLToPath(
  new URL("../../../facilitator/openapi.yaml", import.meta.url),
);

describe("x402-facilitator OpenAPI", () => {
  it("validates (all $refs, incl. external schemas, resolve; document is legal OpenAPI)", async () => {
    const api = await SwaggerParser.validate(openapiPath);
    expect(api).toBeTruthy();
  });

  it("defines POST /verify, POST /settle, and GET /supported", async () => {
    const api = (await SwaggerParser.dereference(openapiPath)) as any;
    expect(api.paths?.["/verify"]?.post).toBeTruthy();
    expect(api.paths?.["/settle"]?.post).toBeTruthy();
    expect(api.paths?.["/supported"]?.get).toBeTruthy();
  });

  it("/supported response includes the required signers field", async () => {
    const api = (await SwaggerParser.dereference(openapiPath)) as any;
    const schema = api.paths["/supported"].get.responses["200"].content["application/json"].schema;
    expect(Object.keys(schema.properties ?? {})).toContain("signers");
  });
});
