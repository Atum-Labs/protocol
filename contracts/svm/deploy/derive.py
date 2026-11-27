#!/usr/bin/env python3
"""BIP39 + SLIP-0010(ed25519) -> Solana keypair. Python stdlib only.

Exists because `solana-keygen recover` needs a real TTY for its seed-phrase prompt
("Device not configured" on a pipe), so it cannot be looped over candidate derivation paths
without one prompt per path.

Self-tests (--self-test) cover the three layers independently:
  1. BIP39   : the canonical spec vector (abandon x11 about + "TREZOR" -> known 64-byte seed)
  2. SLIP-0010: the spec's official ed25519 test vector 1
  3. ed25519 : round-tripped against a throwaway `solana-keygen new` keypair, so the public-key
               maths is checked against the authoritative implementation rather than asserted
"""
import hashlib
import hmac
import json
import os
import sys
import unicodedata

B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

# ---------------------------------------------------------------- ed25519
p = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_d = (-121665 * pow(121666, p - 2, p)) % p


def _inv(x):
    return pow(x, p - 2, p)


def _add(P, Q):
    x1, y1 = P
    x2, y2 = Q
    k = _d * x1 * x2 * y1 * y2 % p
    x3 = (x1 * y2 + x2 * y1) * _inv(1 + k) % p
    y3 = (y1 * y2 + x1 * x2) * _inv(1 - k) % p
    return (x3, y3)


_By = 4 * _inv(5) % p
_Bx = pow((_By * _By - 1) * _inv(_d * _By * _By + 1), (p + 3) // 8, p)
if (_Bx * _Bx - ((_By * _By - 1) * _inv(_d * _By * _By + 1))) % p != 0:
    _Bx = _Bx * pow(2, (p - 1) // 4, p) % p
if _Bx % 2 != 0:
    _Bx = p - _Bx
_B = (_Bx, _By)


def _mul(P, e):
    if e == 0:
        return (0, 1)
    Q = _mul(P, e // 2)
    Q = _add(Q, Q)
    return _add(Q, P) if e & 1 else Q


def ed25519_pubkey(seed32: bytes) -> bytes:
    """The 32-byte ed25519 public key for a 32-byte private seed (RFC 8032)."""
    h = bytearray(hashlib.sha512(seed32).digest()[:32])
    h[0] &= 248
    h[31] &= 127
    h[31] |= 64
    a = int.from_bytes(h, 'little')
    x, y = _mul(_B, a)
    out = bytearray(y.to_bytes(32, 'little'))
    out[31] |= (x & 1) << 7
    return bytes(out)


# ---------------------------------------------------------------- BIP39 / SLIP-0010
def bip39_seed(mnemonic: str, passphrase: str = '') -> bytes:
    m = unicodedata.normalize('NFKD', ' '.join(mnemonic.split()))
    s = unicodedata.normalize('NFKD', 'mnemonic' + passphrase)
    return hashlib.pbkdf2_hmac('sha512', m.encode(), s.encode(), 2048, 64)


def slip10_master(seed: bytes):
    I = hmac.new(b'ed25519 seed', seed, hashlib.sha512).digest()
    return I[:32], I[32:]


def slip10_child(k: bytes, c: bytes, index: int):
    # ed25519 supports HARDENED derivation only
    data = b'\x00' + k + (index | 0x80000000).to_bytes(4, 'big')
    I = hmac.new(c, data, hashlib.sha512).digest()
    return I[:32], I[32:]


def derive(seed: bytes, path: str) -> bytes:
    """path like "m/44'/501'/0'/0'"; returns the 32-byte private seed. '' or 'm' = master."""
    k, c = slip10_master(seed)
    if path.strip() in ('', 'm'):
        return k
    for part in path.split('/'):
        if part in ('m', ''):
            continue
        if not part.endswith("'"):
            raise ValueError(f"ed25519/SLIP-0010 requires hardened components; got {part!r}")
        k, c = slip10_child(k, c, int(part[:-1]))
    return k


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, 'big')
    out = ''
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    for byte in b:
        if byte:
            break
        out = '1' + out
    return out


def b58decode(t: str) -> bytes:
    """Inverse of b58encode. Leading '1's are leading zero BYTES, not digits."""
    alpha = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    n = 0
    for ch in t.strip():
        i = alpha.find(ch)
        if i < 0:
            raise ValueError(f'not base58: {ch!r}')
        n = n * 58 + i
    body = n.to_bytes((n.bit_length() + 7) // 8, 'big') if n else b''
    pad = len(t.strip()) - len(t.strip().lstrip('1'))
    return b'\x00' * pad + body


def solana_keypair(seed32: bytes):
    """(base58 address, 64-byte keypair bytes as Solana's JSON array)."""
    pub = ed25519_pubkey(seed32)
    return b58encode(pub), list(seed32 + pub)


# ---------------------------------------------------------------- self-test
def self_test() -> int:
    import subprocess
    import tempfile
    import os
    rc = 0

    # 1. BIP39 canonical vector (BIP-0039 spec, English, passphrase "TREZOR")
    want = ('c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553'
            '1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04')
    got = bip39_seed('abandon ' * 11 + 'about', 'TREZOR').hex()
    ok = got == want
    rc |= 0 if ok else 1
    print(f"  {'ok  ' if ok else 'FAIL'} BIP39 seed vector")
    if not ok:
        print(f"       got  {got}\n       want {want}")

    # 2. SLIP-0010 official ed25519 test vector 1, seed 000102...0f
    seed = bytes.fromhex('000102030405060708090a0b0c0d0e0f')
    for path, want_k in [
        ('m', '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7'),
        ("m/0'", '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3'),
        ("m/0'/1'", 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2'),
    ]:
        got_k = derive(seed, path).hex()
        ok = got_k == want_k
        rc |= 0 if ok else 1
        print(f"  {'ok  ' if ok else 'FAIL'} SLIP-0010 ed25519 {path}")
        if not ok:
            print(f"       got  {got_k}\n       want {want_k}")

    # 3. Published Solana vectors for the public test mnemonic, cross-checked against
    #    solana-keygen 2.3.0 behaviour (agave source + pty-driven runs).
    tseed = bip39_seed('abandon ' * 11 + 'about', '')
    for label, path, want_a in [
        ('bare seed  (solana-keygen new / ASK)', BARE, 'EHqmfkN89RJ7Y33CXM6uCzhVeuywHoJXZZLszBHHZy7o'),
        ("m/44'/501'  (bare `prompt:`)", "m/44'/501'", 'D2PPQSYFe83nDzk96FqGumVU8JA7J8vj2Rhjc2oXzEi5'),
        ("m/44'/501'/0'  (?key=0)", "m/44'/501'/0'", 'GjJyeC1r2RgkuoCWMyPYkCWSGSGLcz266EaAkLA27AhL'),
        ("m/44'/501'/0'/0'  (?key=0/0)", "m/44'/501'/0'/0'", 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'),
    ]:
        got_a, _ = solana_keypair(seed_for(tseed, path))
        ok = got_a == want_a
        rc |= 0 if ok else 1
        print(f"  {'ok  ' if ok else 'FAIL'} {label}")
        if not ok:
            print(f"       got  {got_a}\n       want {want_a}")

    # 4. force-hardening: a tickless path must equal its hardened form
    a1, _ = solana_keypair(seed_for(tseed, 'm/44/501/0/0'))
    a2, _ = solana_keypair(seed_for(tseed, "m/44'/501'/0'/0'"))
    ok = a1 == a2
    rc |= 0 if ok else 1
    print(f"  {'ok  ' if ok else 'FAIL'} m/44/501/0/0 == m/44'/501'/0'/0' (force-hardened)")

    # 5. ed25519 public-key maths, checked against solana-keygen's own output.
    #    A throwaway keypair: its JSON is [32-byte seed || 32-byte pubkey], so recomputing the
    #    pubkey from the seed and comparing validates our curve code against the real tool.
    with tempfile.TemporaryDirectory() as td:
        kp = os.path.join(td, 'k.json')
        r = subprocess.run(['solana-keygen', 'new', '--silent', '--no-bip39-passphrase', '-o', kp],
                           capture_output=True)
        if r.returncode != 0:
            print('  --   ed25519 vs solana-keygen  SKIPPED (solana-keygen unavailable)')
        else:
            raw = bytes(json.load(open(kp)))
            ours = b58encode(ed25519_pubkey(raw[:32]))
            theirs = subprocess.run(['solana-keygen', 'pubkey', kp],
                                    capture_output=True, text=True).stdout.strip()
            ok = ours == theirs and b58encode(raw[32:]) == theirs
            rc |= 0 if ok else 1
            print(f"  {'ok  ' if ok else 'FAIL'} ed25519 pubkey == solana-keygen")
            if not ok:
                print(f"       ours {ours}\n       tool {theirs}")

    # 6. secp256k1-private-key-as-ed25519-seed, the --from-secp256k1 path. Two assertions,
    #    because either alone is weak: the pin catches a regression in our encoding, and the
    #    solana-keygen check catches curve maths that is wrong in a SELF-CONSISTENT way, which
    #    a pin computed by the same code could never detect.
    WC_KEY = '46' * 32          # trustwallet/wallet-core CoinAddressDerivationTests
    WC_SOL = 'H4JcMPicKkHcxxDjkyyrLoQj7Kcibd9t815ak4UvTr9M'
    got, arr6 = solana_keypair(bytes.fromhex(WC_KEY))
    ok6 = got == WC_SOL
    rc |= 0 if ok6 else 1
    print(f"  {'ok  ' if ok6 else 'FAIL'} secp256k1 key as ed25519 seed  {got}")
    if not ok6:
        print(f"       expected {WC_SOL}")
    with tempfile.TemporaryDirectory() as td6:
        kp6 = os.path.join(td6, 'sk.json')
        fd6 = os.open(kp6, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(fd6, 'w') as f:
            json.dump(arr6, f)
        r6 = subprocess.run(['solana-keygen', 'verify', WC_SOL, kp6], capture_output=True)
        if r6.returncode != 0 and b'not found' in (r6.stderr or b'').lower():
            print('  --   secp256k1-seed keypair vs solana-keygen  SKIPPED (unavailable)')
        else:
            ok7 = r6.returncode == 0
            rc |= 0 if ok7 else 1
            print(f"  {'ok  ' if ok7 else 'FAIL'} solana-keygen verifies that keypair")
    return rc


# ---------------------------------------------------------------- paths
BARE = 'bare-seed'   # pseudo-path: seed[:32] used directly, NO HD derivation


def candidate_paths(scan: int):
    """Solana path families, genuinely most likely first.

    Coin type 501 (SLIP-0044). SLIP-0010 ed25519 supports HARDENED derivation only, because the
    ed25519 private key is not the scalar multiplier (its SHA-512 clamp is), so the additive-tweak
    trick that makes non-hardened derivation work on secp256k1 has no analogue. Both agave and
    ed25519-hd-key therefore FORCE-harden every component -- m/44/501/0/0 and m/44'/501'/0'/0' are
    the same key -- which is why `normalize_path` hardens rather than rejecting.

      bare-seed         seed[:32], no derivation. What `solana-keygen new` produces with NO
                       --derivation-path, and `solana-keygen recover ASK`. HIGHEST PRIOR for a
                       deployer key, because that is how deployer keys are usually made.
      m/44'/501'/i'/0'  Phantom / Solflare / Backpack / Ledger; solana-keygen `?key=i/0`.
                       Also agave's DEFAULT_DERIVATION_PATH at i=0.
      m/44'/501'/i'     3-level; solana-keygen `?key=i`. Phantom bip44, Ledger Live, Trust Wallet.
      m/44'/501'        2-level BIP-44 base. What bare `prompt:` resolves to -- NOT a bare seed.
      m/44'/501'/0'/i'  change-level sweep; solana-keygen `?key=0/i`.
      m/44'/501'/0'/0'/i'   depth-5, Backpack "Legacy".
      m/44'/501'/i'/0'/0'   depth-5, Backpack "Ledger Live".
      m                 SLIP-0010 master. No Solana tool produces this by default; kept last as a
                       long shot only.

    Not covered, and not coverable here: Sollet's deprecated m/501'/i'/0/0 needs a
    BIP-32/secp256k1 engine whose output is then reinterpreted as an ed25519 seed. It is not
    expressible in SLIP-0010 ed25519 at all.
    """
    out = [BARE]
    out += [f"m/44'/501'/{i}'/0'" for i in range(scan)]
    out += [f"m/44'/501'/{i}'" for i in range(scan)]
    out += ["m/44'/501'"]
    out += [f"m/44'/501'/0'/{i}'" for i in range(1, scan)]
    out += [f"m/44'/501'/0'/0'/{i}'" for i in range(min(scan, 5))]
    out += [f"m/44'/501'/{i}'/0'/0'" for i in range(min(scan, 5))]
    out += ['m']
    return out


def normalize_path(path: str) -> str:
    """Harden every component. agave and ed25519-hd-key both do this, so a path written without
    ticks is the SAME key -- treating them as different would silently miss a match."""
    if path.strip() in (BARE, 'bare', 'seed'):
        return BARE
    parts = []
    for c in path.split('/'):
        c = c.strip()
        if c in ('m', ''):
            continue
        parts.append(c if c.endswith("'") else c + "'")
    return 'm' + (''.join('/' + c for c in parts) if parts else '')


def seed_for(seed: bytes, path: str) -> bytes:
    """32-byte ed25519 seed for a candidate path, including the bare-seed pseudo-path."""
    p = normalize_path(path)
    if p == BARE:
        return seed[:32]
    return derive(seed, p)


def _read_secrets(path):
    """line 1 = mnemonic, line 2 (optional) = BIP39 passphrase. Never argv, never env."""
    with open(path) as f:
        lines = f.read().split('\n')
    return lines[0], (lines[1] if len(lines) > 1 else '')


def cmd_scan(secret_file, scan, expect):
    mn, pw = _read_secrets(secret_file)
    seed = bip39_seed(mn, pw)
    paths = candidate_paths(scan)
    print(f"Scanning {len(paths)} derivation paths" + (f" for {expect}" if expect else ''))
    for path in paths:
        addr, _ = solana_keypair(seed_for(seed, path))
        mark = '   <== MATCH' if expect and addr == expect else ''
        print(f"  {path:22} {addr}{mark}")
    return 0


def cmd_write(secret_file, path, outfile):
    mn, pw = _read_secrets(secret_file)
    addr, arr = solana_keypair(seed_for(bip39_seed(mn, pw), path))
    import os
    fd = os.open(outfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(arr, f)
    print(addr)
    return 0


def cmd_import_secret(secret_file, outfile=None):
    """Import an existing Solana secret key, rather than deriving one from a mnemonic.

    Accepts the four shapes an operator actually has on hand:
      * base58, 64 bytes  -- what `solana-keygen`/wallets export as the "private key"
      * base58, 32 bytes  -- a bare seed
      * JSON array of 64  -- an id.json / keypair file
      * JSON array of 32  -- a bare seed as an array

    With no outfile this is a DRY RUN: it validates, prints the pubkey, and writes nothing.

    For the 64-byte forms the trailing 32 bytes are a CLAIMED public key. We re-derive it from
    the seed and refuse on mismatch: a keypair file whose two halves disagree is accepted by
    some tools and then produces signatures that verify against an address nobody expects.
    """
    raw_text = open(secret_file).read().strip()
    if not raw_text:
        print('empty input', file=sys.stderr)
        return 1
    if raw_text.lstrip().startswith('['):
        try:
            arr = json.loads(raw_text)
        except Exception as e:
            print(f'looks like JSON but will not parse: {e}', file=sys.stderr)
            return 1
        if not all(isinstance(v, int) and 0 <= v <= 255 for v in arr):
            print('JSON array must be bytes in 0..255', file=sys.stderr)
            return 1
        raw = bytes(arr)
    else:
        try:
            raw = b58decode(raw_text)
        except ValueError as e:
            print(f'not a JSON array and not base58: {e}', file=sys.stderr)
            return 1

    if len(raw) == 32:
        seed = raw
        claimed = None
    elif len(raw) == 64:
        seed, claimed = raw[:32], raw[32:]
    else:
        print(f'secret is {len(raw)} bytes; expected 32 (seed) or 64 (seed+pubkey)', file=sys.stderr)
        return 1

    addr, arr = solana_keypair(seed)
    if claimed is not None and claimed != b58decode(addr):
        print('REFUSING: the public key embedded in this secret does not match the one its seed '
              'derives.', file=sys.stderr)
        print(f'  embedded : {b58encode(claimed)}', file=sys.stderr)
        print(f'  derived  : {addr}', file=sys.stderr)
        print('  A keypair whose halves disagree signs as the derived key while tools display the '
              'embedded one.', file=sys.stderr)
        return 1

    if outfile is None:
        print(addr)
        return 0

    fd = os.open(outfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(arr, f)
    print(addr)
    return 0


def cmd_from_secp256k1(secret_file, outfile=None):
    """Use a secp256k1 PRIVATE KEY as the ed25519 seed, so one 32-byte secret serves EVM/TVM
    and Solana.

    Legitimate but non-standard, and the distinctions matter:
      * A secp256k1 private key is a 32-byte scalar; an ed25519 keypair is generated from a
        32-byte SEED. Nothing stops the same bytes being both, and whoever holds the key holds
        the resulting Solana keypair. Confirmed with `solana-keygen verify`.
      * It is NOT a derivation between the curves. The Solana address bears no visible relation
        to the EVM one, and neither can be computed from the other.
      * No wallet reproduces it. Phantom, Ledger and `solana-keygen recover` all expect a BIP44
        path, so recovery depends on still holding the raw 32 bytes; a seed phrase will not bring
        this address back.
      * It reuses one secret across two signature algorithms. No known attack crosses between
        them, but it sits outside what either curve's security analysis covers.

    Prefer the mnemonic path (m/44'/501'/0'/0') unless one-secret-for-everything is deliberate.
    With no outfile this is a dry run: it validates, prints the pubkey, writes nothing.
    """
    txt = open(secret_file).read().strip()
    if not txt:
        print('empty input', file=sys.stderr)
        return 1
    h = txt.lower()
    if h.startswith('0x'):
        h = h[2:]
    if len(h) != 64 or any(c not in '0123456789abcdef' for c in h):
        print(f'expected 64 hex characters (a 32-byte secp256k1 private key), got {len(h)}',
              file=sys.stderr)
        return 1
    raw = bytes.fromhex(h)
    if raw == b'\x00' * 32:
        print('refusing an all-zero key', file=sys.stderr)
        return 1

    addr, arr = solana_keypair(raw)
    if outfile is None:
        print(addr)
        return 0
    fd = os.open(outfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(arr, f)
    print(addr)
    return 0


def cmd_show_base58(keypair_file):
    """The DEPLOYER_PRIVATE_KEY form. Deliberately a separate, explicit command."""
    raw = bytes(json.load(open(keypair_file)))
    print(b58encode(raw))
    return 0


def cmd_sync_id_bytes(src_dir, check_only=False):
    """Regenerate PROGRAM_ID_BYTES in signatures.rs to match declare_id! in lib.rs.

    The array is deliberately spelled as raw bytes so no base58 decoder sits in the derivation
    path, which also means no textual substitution can reach it. This derives the bytes FROM the
    declare_id! that is actually in the file, so the two cannot disagree and there is no hex to
    transcribe by hand.
    """
    import os
    import re
    lib = os.path.join(src_dir, 'programs/escrow/src/lib.rs')
    sig = os.path.join(src_dir, 'programs/escrow/src/utils/signatures.rs')
    for f in (lib, sig):
        if not os.path.isfile(f):
            print(f"FATAL: {f} not found", file=sys.stderr)
            return 1

    m = re.search(r'declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)', open(lib).read())
    if not m:
        print(f"FATAL: no declare_id! in {lib}", file=sys.stderr)
        return 1
    b58 = m.group(1)

    n = 0
    for ch in b58:
        n = n * 58 + B58.index(ch)
    raw = n.to_bytes(32, 'big')
    if b58encode(raw) != b58:
        print(f"FATAL: {b58} does not round-trip as 32 bytes", file=sys.stderr)
        return 1

    body = open(sig).read()
    pat = re.compile(
        r'(?P<head>const PROGRAM_ID_BYTES: \[u8; 32\] = \[\n)(?P<body>.*?)(?P<tail>[ \t]*\];)',
        re.S)
    mm = pat.search(body)
    if not mm:
        print(f"FATAL: PROGRAM_ID_BYTES block not found in {sig}", file=sys.stderr)
        return 1

    # keep the file's own indentation and 15/15/2 line shape
    indent = re.match(r'[ \t]*', mm.group('body')).group(0) or '        '
    hexes = [f'0x{b:02x}' for b in raw]
    rows = [hexes[0:15], hexes[15:30], hexes[30:32]]
    block = ''.join(indent + ', '.join(r) + ',\n' for r in rows)

    current = mm.group('body')
    cur_bytes = [int(x, 16) for x in re.findall(r'0x([0-9a-fA-F]{2})', current)]
    cur_b58 = b58encode(bytes(cur_bytes)) if len(cur_bytes) == 32 else '(unparseable)'

    print(f"declare_id!      : {b58}")
    print(f"PROGRAM_ID_BYTES : {cur_b58}")
    if cur_b58 == b58:
        print("already in sync — nothing to do")
        return 0
    if check_only:
        print("OUT OF SYNC (--check: nothing written)", file=sys.stderr)
        return 1

    import shutil
    shutil.copy2(sig, sig + '.bak')
    open(sig, 'w').write(body[:mm.start('body')] + block + body[mm.end('body'):])

    # re-read and prove it
    again = pat.search(open(sig).read())
    got = [int(x, 16) for x in re.findall(r'0x([0-9a-fA-F]{2})', again.group('body'))]
    ok = len(got) == 32 and b58encode(bytes(got)) == b58
    print(f"rewrote {sig} (backup .bak) -> {b58encode(bytes(got)) if len(got)==32 else 'BAD'}")
    if not ok:
        print("FATAL: post-write verification failed", file=sys.stderr)
        return 1
    print("verified: the bytes now decode to declare_id!")
    return 0


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a or a[0] == '--help':
        print(__doc__)
        sys.exit(2)
    if a[0] == '--self-test':
        code = self_test()
        print()
        print('PASS — derivation matches the published vectors and solana-keygen.' if code == 0
              else 'FAIL — do NOT trust this to find your key.')
        sys.exit(code)
    if a[0] == '--scan':
        import os
        sys.exit(cmd_scan(a[1], int(os.environ.get('SVM_SCAN', '10')),
                          os.environ.get('SVM_EXPECT', '')))
    if a[0] == '--write':
        sys.exit(cmd_write(a[1], a[2], a[3]))
    if a[0] == '--sync-id-bytes':
        sys.exit(cmd_sync_id_bytes(a[1], check_only=('--check' in a)))
    if a[0] == '--from-secp256k1':
        sys.exit(cmd_from_secp256k1(a[1], a[2] if len(a) > 2 else None))
    if a[0] == '--import-secret':
        sys.exit(cmd_import_secret(a[1], a[2] if len(a) > 2 else None))
    if a[0] == '--show-base58':
        sys.exit(cmd_show_base58(a[1]))
    print(f"unknown arg: {a[0]}", file=sys.stderr)
    sys.exit(2)
