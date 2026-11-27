#!/usr/bin/env python3
"""Read one field out of an escrow/proxy ProtocolConfig, with no node_modules.

Written so pre-finalize.sh needs only python3 + curl, matching the rest of the SVM kit.
The escrow's config is 216 bytes (escrow/src/state.rs::ProtocolConfig) and the fulfillment
proxy's is 636 (fulfillment_proxy/src/state.rs::ProtocolConfig). The two layouts differ, so the
script picks one by the account's length and refuses any other length rather than guess.

Escrow field offsets, Anchor/Borsh-packed after the 8-byte account discriminator:

    8   default_admin            Pubkey   32
    40  token_config_authority   Pubkey   32
    72  treasurer                Pubkey   32
    104 pauser                   Pubkey   32
    136 paused                   bool      1
    137 cluster_id               [u8;32]  32
    169 signature_domain_version u8        1
    170 default_admin_delay_secs u32       4

Proxy offsets: default_admin 8, pauser 40, paused 72, default_admin_delay_seconds 73 (u32),
then pending_default_admin (Option<Pubkey>: 1 byte if None, 33 if Some) and
pending_default_admin_accept_after_ts (Option<i64>: 1 or 9), then enforce_settler_allowlist (bool)
and authorized_settlers (u32 length, then that many Pubkeys). Borsh writes a None option as one
byte, so the last two fields move with the options; the script reads them in order.
The proxy has no token_config_authority, treasurer, cluster_id or signature_domain_version.

`signature_domain_version` and `cluster_id` have NO setter instruction: they are written
only by initialize_protocol. That is why this script exists -- they are the two values
that --final makes permanent.
"""
import argparse, base64, hashlib, json, sys, urllib.request

ESCROW_CONFIG_LEN = 216
PROXY_CONFIG_LEN = 636
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return b'\x00' * (len(s) - len(s.lstrip('1'))) + raw


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, 'big')
    out = ''
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return '1' * (len(b) - len(b.lstrip(b'\x00'))) + out


def on_curve(y_bytes: bytes) -> bool:
    """ed25519 point check, so the PDA search skips on-curve candidates as the runtime does."""
    p = 2**255 - 19
    d = -121665 * pow(121666, p - 2, p) % p
    y = int.from_bytes(y_bytes, 'little') & ((1 << 255) - 1)
    if y >= p:
        return False
    u = (y * y - 1) % p
    v = (d * y * y + 1) % p
    xx = u * pow(v, p - 2, p) % p
    x = pow(xx, (p + 3) // 8, p)
    if (x * x - xx) % p != 0:
        x = x * pow(2, (p - 1) // 4, p) % p
    return (x * x - xx) % p == 0


def find_pda(seeds, program: bytes) -> str:
    for bump in range(255, -1, -1):
        h = hashlib.sha256()
        for s in seeds:
            h.update(s)
        h.update(bytes([bump]))
        h.update(program)
        h.update(b'ProgramDerivedAddress')
        cand = h.digest()
        if not on_curve(cand):
            return b58encode(cand)
    raise SystemExit('no off-curve PDA found')


def rpc(url: str, addr: str):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getAccountInfo",
                       "params": [addr, {"encoding": "base64"}]}).encode()
    req = urllib.request.Request(url, data=body, method='POST',
                                 headers={'content-type': 'application/json',
                                          'user-agent': 'atum-pre-finalize'})
    return json.load(urllib.request.urlopen(req, timeout=30))['result']['value']


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--program', required=True)
    ap.add_argument('--url', required=True)
    ap.add_argument('--field', required=True,
                    choices=['size', 'signature_domain_version', 'cluster_id',
                             'default_admin', 'treasurer', 'pauser',
                             'token_config_authority', 'paused',
                             'enforce_settler_allowlist', 'authorized_settlers'])
    a = ap.parse_args()

    pda = find_pda([b'protocol_config'], b58decode(a.program))
    acct = rpc(a.url, pda)
    if acct is None:
        print('none')
        return 1
    d = base64.b64decode(acct['data'][0])

    if a.field == 'size':
        print(len(d))
        return 0
    if len(d) == ESCROW_CONFIG_LEN:
        layout = 'escrow'
    elif len(d) == PROXY_CONFIG_LEN:
        layout = 'proxy'
    else:
        print(f'refusing: config is {len(d)} bytes, expected {ESCROW_CONFIG_LEN} (escrow) '
              f'or {PROXY_CONFIG_LEN} (fulfillment proxy)', file=sys.stderr)
        print('none')
        return 1

    if layout == 'escrow':
        if a.field in ('enforce_settler_allowlist', 'authorized_settlers'):
            print('none')
            return 1
        if a.field == 'signature_domain_version':
            print(d[169])
        elif a.field == 'cluster_id':
            print(d[137:169].rstrip(b'\x00').decode('utf-8', 'replace'))
        elif a.field == 'paused':
            print('true' if d[136] == 1 else 'false')
        else:
            off = {'default_admin': 8, 'token_config_authority': 40,
                   'treasurer': 72, 'pauser': 104}[a.field]
            print(b58encode(d[off:off + 32]))
        return 0

    # Fulfillment proxy.
    if a.field in ('signature_domain_version', 'cluster_id', 'token_config_authority', 'treasurer'):
        print('none')
        return 1
    if a.field == 'default_admin':
        print(b58encode(d[8:40]))
    elif a.field == 'pauser':
        print(b58encode(d[40:72]))
    elif a.field == 'paused':
        print('true' if d[72] == 1 else 'false')
    else:
        off = 77                                   # after default_admin_delay_seconds
        off += 33 if d[off] == 1 else 1            # pending_default_admin
        off += 9 if d[off] == 1 else 1             # pending_default_admin_accept_after_ts
        if a.field == 'enforce_settler_allowlist':
            print('true' if d[off] == 1 else 'false')
        else:
            n = int.from_bytes(d[off + 1:off + 5], 'little')
            if n > 16 or off + 5 + 32 * n > len(d):
                print('refusing: authorized_settlers length is out of range', file=sys.stderr)
                print('none')
                return 1
            print(','.join(b58encode(d[off + 5 + 32 * i:off + 37 + 32 * i]) for i in range(n)) or 'empty')
    return 0


if __name__ == '__main__':
    sys.exit(main())
