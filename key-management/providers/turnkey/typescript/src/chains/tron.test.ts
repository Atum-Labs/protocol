import { describe, expect, it } from 'vitest';

import { extractTronSignatureFromTransactionProtobuf } from './tron';

describe('extractTronSignatureFromTransactionProtobuf', () => {
  // Real response captured from Turnkey on 2026-05-12 via scripts/probe-turnkey-tx-shapes.ts
  // running TRANSACTION_TYPE_TRON on Shasta with a TronWeb-built triggerSmartContract.
  // Contains:
  //   field 1 (raw_data, tag 0x0a, varint length 0xd301 = 211 bytes)
  //   field 2 (signature, tag 0x12, varint length 0x41 = 65 bytes)
  const REAL_RESPONSE =
    '0ad3010a02f49622081cff434e56cfab4a40e0e9d3e0e1335aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a1541e671290dd56a7efdd3024cb84cf312a81f5b4fd212154142a1e39aefa49290f2b3f9ed688d7cecf86cd6e02244a9059cbb000000000000000000000000e671290dd56a7efdd3024cb84cf312a81f5b4fd2000000000000000000000000000000000000000000000000000000000000000070e19ad0e0e133900180c2d72f124121491d5b75aa15ec9e341a6a3b58f44cfad71eed2d4e52e87f8f077b3c5f986c08402b6daa8a1c7b218f6318d5b620854e236f280914bbbbe8006e61943f703901';

  it('extracts the 65-byte signature from a real Turnkey Tron Transaction protobuf', () => {
    const sig = extractTronSignatureFromTransactionProtobuf(REAL_RESPONSE);
    expect(sig.length).toBe(130); // 65 bytes hex-encoded
    expect(sig).toBe(
      '21491d5b75aa15ec9e341a6a3b58f44cfad71eed2d4e52e87f8f077b3c5f986c08402b6daa8a1c7b218f6318d5b620854e236f280914bbbbe8006e61943f703901',
    );
  });

  it('throws on truncated input', () => {
    expect(() => extractTronSignatureFromTransactionProtobuf('0ad301')).toThrow(
      /TURNKEY_BAD_RESPONSE/,
    );
  });

  it('throws on a protobuf without a signature field', () => {
    // Just raw_data field 1, no field 2.
    const onlyRawData = '0a050102030405';
    expect(() => extractTronSignatureFromTransactionProtobuf(onlyRawData)).toThrow(/no signature/);
  });

  it('handles a synthetic Transaction with raw_data + signature in different orders', () => {
    // Field 2 (signature) appearing BEFORE field 1 (raw_data) is unusual but legal in
    // protobuf — the extractor must find it regardless of order.
    const sig65 = 'aa'.repeat(65);
    // tag=0x12 (field 2, wire 2), length=0x41 (65), payload=65 bytes; then field 1 raw_data
    const sigField = '1241' + sig65;
    const rawDataField = '0a05' + '0102030405';
    expect(extractTronSignatureFromTransactionProtobuf(sigField + rawDataField)).toBe(sig65);
  });
});
