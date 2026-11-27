#!/usr/bin/env python3
"""Regenerates vectors.json, the one fixture the Rust contract tests, the Go encoder tests and the
TypeScript encoder tests all assert against.

This script is the independent oracle. It transcribes contracts/stellar/source/docs/witness-layouts.md
and shares no code with the contract, the Soroban SDK, the Go encoder or the TypeScript encoder: the
keccak-256 is a from-scratch Keccak-f[1600], the strkeys are encoded here, and signatures come from the
`cryptography` package. Never regenerate by copying a digest out of one of the implementations.

A layout change is a deliberate, reviewed event:

  1. change the contract (escrow/src/signatures.rs); bump SIGNATURE_DOMAIN_VERSION only if the rule
     in docs/witness-layouts.md calls for it,
  2. change docs/witness-layouts.md and the layout functions below in the same commit,
  3. run `python3 regenerate_vectors.py` and review the vectors.json diff line by line,
  4. update the Go and TypeScript encoders until their tests pass again.

  python3 regenerate_vectors.py            # rewrite vectors.json
  python3 regenerate_vectors.py --check    # fail if vectors.json differs from what this would write
  python3 regenerate_vectors.py --cast     # also cross-check every digest with `cast keccak` (foundry)

Needs Python 3.9+ and, for the delegate signatures, `pip install cryptography`.
"""

import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path

SIGNATURE_DOMAIN_VERSION = 2
MAX_I128 = (1 << 127) - 1
MAX_U64 = (1 << 64) - 1
OUT = Path(__file__).resolve().parent / "vectors.json"

# --------------------------------------------------------------------------- keccak-256

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
]
_M64 = (1 << 64) - 1


def _rol(x, n):
    n %= 64
    return ((x << n) | (x >> (64 - n))) & _M64 if n else x


def _f1600(a):
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        a = [[b[x][y] ^ (~b[(x + 1) % 5][y] & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    """Original Keccak padding (0x01), as Ethereum; NOT NIST SHA3-256 (0x06)."""
    rate = 136
    msg = bytearray(data)
    msg.append(0x01)
    while len(msg) % rate:
        msg.append(0x00)
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(msg[off + 8 * i: off + 8 * i + 8], "little")
        a = _f1600(a)
    out = b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


def cast_keccak(data: bytes) -> bytes:
    r = subprocess.run(["cast", "keccak", "0x" + data.hex()], capture_output=True, text=True, check=True)
    return bytes.fromhex(r.stdout.strip()[2:])


# --------------------------------------------------------------------------- strkey

_VER = {"G": 6 << 3, "C": 2 << 3, "M": 12 << 3, "S": 18 << 3, "B": 1 << 3}


def _crc16_xmodem(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def strkey(kind: str, payload: bytes) -> str:
    body = bytes([_VER[kind]]) + payload
    body += _crc16_xmodem(body).to_bytes(2, "little")
    return base64.b32encode(body).decode().rstrip("=")


def account(b: int) -> str:
    return strkey("G", bytes([b]) * 32)


def contract(b: int) -> str:
    return strkey("C", bytes([b]) * 32)


# --------------------------------------------------------------------------- layout

def addr33(s: str) -> bytes:
    """Decodes a G or C strkey into type byte + 32 bytes, verifying version and checksum."""
    raw = base64.b32decode(s + "=" * (-len(s) % 8))
    body, crc = raw[:-2], int.from_bytes(raw[-2:], "little")
    assert _crc16_xmodem(body) == crc, s
    kind = {_VER["G"]: 0, _VER["C"]: 1}[body[0]]
    assert len(body) == 33
    return bytes([kind]) + body[1:]


def amt16(v: int) -> bytes:
    assert 0 <= v <= MAX_I128
    return v.to_bytes(16, "little")


def u64le(v: int) -> bytes:
    assert 0 <= v <= MAX_U64
    return v.to_bytes(8, "little")


def h(x: str) -> bytes:
    b = bytes.fromhex(x)
    assert len(b) == 32
    return b


def rep(byte: int) -> str:
    return f"{byte:02x}" * 32


def destination_hash(destination: str) -> bytes:
    return keccak256(destination.encode("utf-8"))


NETWORKS = {
    "testnet": "Test SDF Network ; September 2015",
    "public": "Public Global Stellar Network ; September 2015",
}


def prefix(network: str, contract_id: str) -> bytes:
    cid = addr33(contract_id)
    assert cid[0] == 1
    return (
        b"escrow" + bytes([SIGNATURE_DOMAIN_VERSION])
        + hashlib.sha256(NETWORKS[network].encode()).digest() + cid[1:]
    )


def deposit(c, i):
    return (
        prefix(c["network"], c["contractId"]) + b"deposit"
        + h(i["depositRequestHash"]) + destination_hash(i["destination"])
        + addr33(i["depositor"]) + addr33(i["token"]) + u64le(int(i["epoch"])) + amt16(int(i["amount"]))
        + h(i["reserver"]) + h(i["releaser"])
        + u64le(int(i["nonce"])) + u64le(int(i["issuedAt"])) + u64le(int(i["deadline"]))
    )


def reserve(c, i):
    return (
        prefix(c["network"], c["contractId"]) + b"reserve"
        + h(i["depositId"]) + h(i["quoteHash"]) + addr33(i["settler"]) + amt16(int(i["sourceAmount"]))
    )


def _settle(tag: bytes):
    def f(c, i):
        return (
            prefix(c["network"], c["contractId"]) + tag
            + h(i["depositId"]) + h(i["quoteHash"]) + h(i["depositRequestHash"]) + h(i["destinationHash"])
            + addr33(i["depositor"]) + addr33(i["token"])
            + amt16(int(i["amount"])) + amt16(int(i["feeAmount"]))
            + h(i["reserver"]) + h(i["releaser"]) + addr33(i["settler"])
        )
    return f


def renounce(c, i):
    return (
        prefix(c["network"], c["contractId"]) + b"renounce"
        + addr33(i["depositor"]) + addr33(i["token"]) + u64le(int(i["epoch"])) + u64le(int(i["nonce"]))
        + u64le(int(i["deadline"]))
    )


def active_deposit(c, i):
    # No prefix and no tag: it never leaves the contract's storage
    return (
        addr33(i["depositor"]) + h(i["quoteHash"]) + h(i["depositRequestHash"]) + h(i["destinationHash"])
        + addr33(i["token"]) + amt16(int(i["amount"])) + amt16(int(i["feeAmount"]))
        + h(i["reserver"]) + h(i["releaser"]) + addr33(i["settler"])
    )


def dest_only(c, i):
    return i["destination"].encode("utf-8")


# Each returns the preimage; the digest is keccak256 of it
KINDS = {
    "destinationHash": dest_only,
    "deposit": deposit,
    "reserve": reserve,
    "release": _settle(b"release"),
    "refund": _settle(b"refund"),
    "renounce": renounce,
    "activeDeposit": active_deposit,
}

# Preimage lengths stated in witness-layouts.md, asserted in add() against what is hashed. The
# active-deposit hash is 291 bytes (also asserted).
LENGTHS = {"deposit": 320, "reserve": 191, "release": 401, "refund": 400, "renounce": 169,
           "activeDeposit": 291}

# --------------------------------------------------------------------------- fixture

DESTINATION = (
    "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    "@0xc0ffee254729296a45a3885639ac7e10f9d54979"
)
CONTRACT_ID = contract(0xC0)
DELEGATE_SEED = bytes([0x77]) * 32

BASE_DEPOSIT = {
    "depositRequestHash": rep(0x44),
    "destination": DESTINATION,
    "depositor": account(0xD1),
    "token": contract(0xE1),
    "epoch": "1",
    "amount": "1250000",
    "reserver": rep(0x55),
    "releaser": rep(0x66),
    "nonce": str(0x0000000100000007),
    "issuedAt": "1700000000",
    "deadline": "1700000128",
}
BASE_RESERVE = {
    "depositId": "d28667e7c40efa69ab7ba45db817a82044cb10840fe95a45425e7b99556f6a65",
    "quoteHash": rep(0x33),
    "settler": account(0xA5),
    "sourceAmount": "1000000",
}
BASE_SETTLE = {
    "depositId": BASE_RESERVE["depositId"],
    "quoteHash": rep(0x33),
    "depositRequestHash": rep(0x44),
    "destinationHash": "7e096a6d1abcfc4daab28cec3f3d3a458c3facbfa0f3493284bb891bdc9807ef",
    "depositor": account(0xD1),
    "token": contract(0xE1),
    "amount": "1000000",
    "feeAmount": "200",
    "reserver": rep(0x55),
    "releaser": rep(0x66),
    "settler": account(0xA5),
}
BASE_RENOUNCE = {
    "depositor": account(0xD1),
    "token": contract(0xE1),
    "epoch": "1",
    "nonce": "900",
    "deadline": "1700000128",
}
BASE_ACTIVE = {k: v for k, v in BASE_SETTLE.items() if k != "depositId"}

# One alternative value per field, so every member of every layout is changed exactly once
ALT = {
    "depositRequestHash": rep(0x98),
    "quoteHash": rep(0x97),
    "destinationHash": rep(0x96),
    "depositId": rep(0x95),
    "reserver": rep(0x94),
    "releaser": rep(0x93),
    "depositor": account(0xD2),
    "token": contract(0xE2),
    "settler": account(0xA6),
    "destination": DESTINATION[:-1] + "8",
    "amount": "1250001",
    "sourceAmount": "999999",
    "feeAmount": "201",
    "nonce": str(0x0000000100000008),
    "issuedAt": "1700000001",
    "deadline": "1700000129",
    "epoch": "2",
}

cases = []


def add(name, kind, inputs, network="testnet", contract_id=CONTRACT_ID, **extra):
    c = {"name": name, "kind": kind, "network": network, "contractId": contract_id, "input": inputs}
    pre = KINDS[kind](c, inputs)
    # The documented total must equal the bytes hashed, not just the hash of something
    assert LENGTHS.get(kind, len(pre)) == len(pre), (name, len(pre))
    c["digest"] = keccak256(pre).hex()
    c.update(extra)
    cases.append(c)


def mutations(prefix_name, kind, base, fields, **kw):
    for f in fields:
        add(f"{prefix_name}/change-{f}", kind, {**base, f: ALT[f]}, mutates=f"{prefix_name}/base", field=f, **kw)


def with_alt_amount(base, fields, value):
    return {**base, **{f: value for f in fields}}


# destination hash
add("destination/canonical-103-bytes", "destinationHash", {"destination": DESTINATION}, network="testnet")
add("destination/one-byte", "destinationHash", {"destination": "a"})
add("destination/max-256-bytes", "destinationHash", {"destination": "x" * 256})
add("destination/multibyte-256-bytes", "destinationHash", {"destination": "é" * 128})
add("destination/stellar-case-significant", "destinationHash",
    {"destination": "stellar:testnet/sep41:" + contract(0xE1) + "@" + account(0xA5)})

# deposit
add("deposit/base", "deposit", BASE_DEPOSIT, signer="delegate")
add("deposit/change-network", "deposit", BASE_DEPOSIT, network="public",
    mutates="deposit/base", field="network")
mutations("deposit", "deposit", BASE_DEPOSIT,
          ["depositRequestHash", "destination", "depositor", "token", "epoch", "amount", "reserver", "releaser",
           "nonce", "issuedAt", "deadline"])
add("deposit/change-contractId", "deposit", BASE_DEPOSIT, contract_id=contract(0xC1),
    mutates="deposit/base", field="contractId")
add("deposit/min-destination", "deposit", {**BASE_DEPOSIT, "destination": "a"})
add("deposit/max-destination-256-bytes", "deposit", {**BASE_DEPOSIT, "destination": "d" * 256})
add("deposit/multibyte-destination-256-bytes", "deposit", {**BASE_DEPOSIT, "destination": "é" * 128})
add("deposit/min-amount", "deposit", {**BASE_DEPOSIT, "amount": "1"})
add("deposit/max-amount-i128", "deposit", {**BASE_DEPOSIT, "amount": str(MAX_I128)})
add("deposit/window-exactly-86400", "deposit",
    {**BASE_DEPOSIT, "deadline": str(1700000000 + 86400)})
add("deposit/issued-equals-deadline", "deposit", {**BASE_DEPOSIT, "deadline": BASE_DEPOSIT["issuedAt"]})
add("deposit/u64-max-times-and-nonce", "deposit",
    {**BASE_DEPOSIT, "nonce": str(MAX_U64), "issuedAt": str(MAX_U64 - 86400), "deadline": str(MAX_U64)})
add("deposit/zero-issued-at", "deposit", {**BASE_DEPOSIT, "nonce": "0", "issuedAt": "0", "deadline": "128"})
add("deposit/depositor-is-contract", "deposit", {**BASE_DEPOSIT, "depositor": contract(0xD1)})
add("deposit/token-is-account-type", "deposit", {**BASE_DEPOSIT, "token": account(0xE1)})

# reserve
add("reserve/base", "reserve", BASE_RESERVE)
add("reserve/change-network", "reserve", BASE_RESERVE, network="public",
    mutates="reserve/base", field="network")
mutations("reserve", "reserve", BASE_RESERVE, ["depositId", "quoteHash", "settler", "sourceAmount"])
add("reserve/change-contractId", "reserve", BASE_RESERVE, contract_id=contract(0xC1),
    mutates="reserve/base", field="contractId")
add("reserve/min-source-amount", "reserve", {**BASE_RESERVE, "sourceAmount": "1"})
add("reserve/max-source-amount-i128", "reserve", {**BASE_RESERVE, "sourceAmount": str(MAX_I128)})
add("reserve/settler-is-contract", "reserve", {**BASE_RESERVE, "settler": contract(0xA5)})

# release and refund share every input; only the tag differs
SETTLE_FIELDS = ["depositId", "quoteHash", "depositRequestHash", "destinationHash", "depositor", "token",
                 "amount", "feeAmount", "reserver", "releaser", "settler"]
for kind in ("release", "refund"):
    add(f"{kind}/base", kind, BASE_SETTLE)
    mutations(kind, kind, BASE_SETTLE, SETTLE_FIELDS)
    add(f"{kind}/change-contractId", kind, BASE_SETTLE, contract_id=contract(0xC1),
        mutates=f"{kind}/base", field="contractId")
    add(f"{kind}/change-network", kind, BASE_SETTLE, network="public",
        mutates=f"{kind}/base", field="network")
    add(f"{kind}/zero-fee", kind, {**BASE_SETTLE, "feeAmount": "0"})
    add(f"{kind}/min-amount", kind, {**BASE_SETTLE, "amount": "1", "feeAmount": "0"})
    add(f"{kind}/max-amount-and-fee-i128", kind,
        with_alt_amount(BASE_SETTLE, ["amount", "feeAmount"], str(MAX_I128)))
    add(f"{kind}/token-is-account-type", kind, {**BASE_SETTLE, "token": account(0xE1)})

# renounce
add("renounce/base", "renounce", BASE_RENOUNCE, signer="delegate")
mutations("renounce", "renounce", BASE_RENOUNCE, ["depositor", "token", "epoch", "nonce", "deadline"])
add("renounce/change-contractId", "renounce", BASE_RENOUNCE, contract_id=contract(0xC1),
    mutates="renounce/base", field="contractId")
add("renounce/change-network", "renounce", BASE_RENOUNCE, network="public",
    mutates="renounce/base", field="network")
add("renounce/u64-max-epoch-and-nonce", "renounce",
    {**BASE_RENOUNCE, "epoch": str(MAX_U64), "nonce": str(MAX_U64)})
add("renounce/zero-nonce", "renounce", {**BASE_RENOUNCE, "nonce": "0"})
add("renounce/zero-deadline", "renounce", {**BASE_RENOUNCE, "deadline": "0"})
add("renounce/u64-max-deadline", "renounce", {**BASE_RENOUNCE, "deadline": str(MAX_U64)})

# active-deposit hash (stored, not signed, no domain)
add("activeDeposit/base", "activeDeposit", BASE_ACTIVE)
mutations("activeDeposit", "activeDeposit", BASE_ACTIVE, [f for f in SETTLE_FIELDS if f != "depositId"])
add("activeDeposit/max-amount-and-fee-i128", "activeDeposit",
    with_alt_amount(BASE_ACTIVE, ["amount", "feeAmount"], str(MAX_I128)))
add("activeDeposit/token-is-account-type", "activeDeposit", {**BASE_ACTIVE, "token": account(0xE1)})

# --------------------------------------------------------------------------- signatures


def sign_cases():
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        sys.exit("regenerate_vectors.py needs `pip install cryptography` for the delegate signatures")
    key = Ed25519PrivateKey.from_private_bytes(DELEGATE_SEED)
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    for c in cases:
        if c.get("signer") == "delegate":
            c["signature"] = key.sign(bytes.fromhex(c["digest"])).hex()
    return pub.hex()


# --------------------------------------------------------------------------- strkey vectors

# Two real-world C addresses (the XLM Stellar Asset Contracts) plus the all-zero account, whose strkey
# is well known, so the table is not only this script agreeing with itself.
ADDRESSES = [
    {"strkey": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"},
    {"strkey": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"},
    {"strkey": "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"},
    {"strkey": account(0xD1)},
    {"strkey": contract(0xE1)},
]
for a in ADDRESSES:
    b = addr33(a["strkey"])
    a["type"] = "account" if b[0] == 0 else "contract"
    a["key"] = b[1:].hex()
    assert strkey("G" if b[0] == 0 else "C", b[1:]) == a["strkey"]

REJECTED_ADDRESSES = {
    "muxed": strkey("M", bytes([0xAB]) * 32 + (7).to_bytes(8, "big")),
    "claimableBalance": strkey("B", bytes([0]) + bytes([0xCD]) * 32),
    "secretSeed": strkey("S", bytes([0x01]) * 32),
}


def build():
    pub = sign_cases()
    doc = {
        "_comment": (
            "Shared conformance vectors for the Stellar escrow digests. One fixture, three readers: the "
            "Rust contract tests (escrow/src/test_conformance.rs), Go (encoding/conformance_test.go) and "
            "TypeScript (src/conformance.test.ts) must each reproduce every `digest` from `input`. "
            "Generated OUT OF BAND by conformance/regenerate_vectors.py from docs/witness-layouts.md "
            "(own keccak-256, own strkey encoder, `cryptography` ed25519); never regenerate from the "
            "output of an implementation under test, and never edit by hand. A layout change is a "
            "reviewed vector bump: see the header of regenerate_vectors.py and contracts/encoding-parity.md. "
            "Amounts, nonces and times are decimal strings so no reader loses precision above 2^53."
        ),
        "signatureDomainVersion": SIGNATURE_DOMAIN_VERSION,
        "networks": {
            n: {"passphrase": p, "networkId": hashlib.sha256(p.encode()).hexdigest()}
            for n, p in NETWORKS.items()
        },
        "delegate": {"seed": DELEGATE_SEED.hex(), "publicKey": pub},
        "addresses": ADDRESSES,
        "rejectedAddresses": REJECTED_ADDRESSES,
        "cases": cases,
    }
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def self_check():
    """Pins the script to the golden values witness-layouts.md states, and to the documented widths."""
    by = {c["name"]: c for c in cases}
    golden = {
        "destination/canonical-103-bytes": "7e096a6d1abcfc4daab28cec3f3d3a458c3facbfa0f3493284bb891bdc9807ef",
        "deposit/base": "d28667e7c40efa69ab7ba45db817a82044cb10840fe95a45425e7b99556f6a65",
        "deposit/change-network": "708f97942322b3d027730af1dc8359655b638e06cf2abbaa35f155189a64a6df",
        "reserve/base": "827560933bcd171fc0ac5eb23d176b7fc5f0b2e5fbb7e84fd1d10acb99fb146f",
        "release/base": "1e047d0a87c1ed7a0d380b2c2d89f9484ccc18b4e2e56651b7c85e21117abaa4",
        "refund/base": "1a4f68fa5ba5f3e57a942fd0b6260e97e64b9e399635e454a144e3cf04b8b43c",
        "activeDeposit/base": "f1c27186532d82e2c3bf509335bcac128d234e8c3537188e9b13681cf8b710e6",
        "renounce/base": "99e54f1290c5bd5d79f2d9c502ea157fbbfa2745776cef4be1f82c4643c43589",
    }
    for name, want in golden.items():
        assert by[name]["digest"] == want, f"{name}: script disagrees with witness-layouts.md"
    assert by["deposit/base"]["signature"] == (
        "ec48e2d9cc0bff07e1d6c5fb9820fd8cc7a269fe3d3cc752afd46809472076d45327cc4482b64e91990cde344c545a667304692261d9fa526eddf8e6cd12fe0b")
    assert by["renounce/base"]["signature"] == (
        "3b49fc8c1bd76acedb29ae5896f01384e364d3cd6d112ac06f431cefe7b66aa04a9def71623f490e8fbc070eff05b79c621254298e561291372b6202e232bf06")
    # The doc's byte totals, from the widths in the tables
    p = 71
    assert p + 7 + 32 + 32 + 33 + 33 + 8 + 16 + 32 + 32 + 8 + 8 + 8 == LENGTHS["deposit"]
    assert p + 7 + 32 + 32 + 33 + 16 == LENGTHS["reserve"]
    settle = 32 * 4 + 33 + 33 + 16 + 16 + 32 + 32 + 33
    assert (p + 7 + settle, p + 6 + settle) == (LENGTHS["release"], LENGTHS["refund"])
    assert p + 8 + 33 + 33 + 8 + 8 + 8 == LENGTHS["renounce"]
    assert 33 + 32 * 3 + 33 + 16 + 16 + 32 + 32 + 33 == LENGTHS["activeDeposit"]
    # Every digest is distinct, and every mutated case differs from its base
    assert len({c["digest"] for c in cases if c["kind"] != "destinationHash"}) == sum(
        1 for c in cases if c["kind"] != "destinationHash"), "two cases share a digest"
    for c in cases:
        if "mutates" in c:
            assert c["digest"] != by[c["mutates"]]["digest"], c["name"]


def main():
    out = build()
    self_check()
    if "--cast" in sys.argv:
        # Rebuild every preimage and hash it (and the nested destination hashes) with foundry's keccak
        global keccak256
        mine = keccak256
        keccak256 = cast_keccak
        try:
            for c in cases:
                pre = KINDS[c["kind"]](c, c["input"])
                assert keccak256(pre).hex() == c["digest"], f"cast disagrees: {c['name']}"
        finally:
            keccak256 = mine
        print(f"cast keccak agrees on all {len(cases)} digests", file=sys.stderr)
    if "--check" in sys.argv:
        if OUT.read_text() != out:
            sys.exit("vectors.json is out of date: run conformance/regenerate_vectors.py and review the diff")
        print(f"vectors.json is current ({len(cases)} cases)")
        return
    OUT.write_text(out)
    print(f"wrote {OUT} ({len(cases)} cases)")


if __name__ == "__main__":
    main()
