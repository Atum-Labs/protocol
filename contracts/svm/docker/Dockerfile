# Local Solana validator image for Atum e2e tests.
#
# A builder stage compiles the on-chain artifacts, a runtime stage serves a local chain with
# them deployed. Here the builder compiles the escrow programs with the SAME
# toolchain the source pins (Anchor 0.32.1 / Solana 2.3.0, per Anchor.toml), runs
# `anchor keys sync` against our committed THROWAWAY localnet program keypairs so
# the .so binaries carry LOCAL declare_id!s, then `anchor build`.
#
# Two escrows are deployed: v4 (raw hash signing) from the protocol commit ESCROW_V4_REF, at the
# same local ids as always, and v5 (readable text signing) from the current source, escrow only,
# at its own local id beside the v4 fulfillment proxy.
#
# ESCROW_V4_REF is fetched from ESCROW_V4_REPO. While that repository is private, pass a token
# (`--secret id=GIT_AUTH_TOKEN,env=GIT_AUTH_TOKEN`), or replace the stage with a local checkout of
# that commit (`--build-context escrow-v4-source=<dir holding contracts/svm/source>`).
#
# platform: linux/amd64 — cargo-build-sbf / the Solana toolchain target x86_64;
# on Apple Silicon this builds under emulation.

# =====================================================================
# Stage 0: the v4 escrow source, pinned. The build checks that the v4 IDL it
# compiles equals the frozen v4 IDL (idl-history/v4/escrow.json).
# This ref is the frozen v4 IDL's source, which carries #271 and #272. The v4 programs served on
# devnet and mainnet predate both (idl-history/v4/README.md), so localnet v4 is stricter than
# deployed v4: it refuses a mismatched depositor token account and permanent delegate mints, and
# takes memo_program on release and refund. A localnet run says nothing about those paths on
# deployed v4.
# =====================================================================
FROM scratch AS escrow-v4-source
ARG ESCROW_V4_REPO=https://github.com/Atum-Labs/protocol.git
ARG ESCROW_V4_REF=56e374a0bbbb224cf440dab0f3744bc66dcadcee
ADD ${ESCROW_V4_REPO}#${ESCROW_V4_REF} /

# =====================================================================
# Stage 1: builder — Rust + Solana 2.3.0 + Anchor 0.32.1 + Node/pnpm
# =====================================================================
FROM --platform=linux/amd64 rust:1.86.0-bookworm AS builder

ARG SOLANA_VERSION=2.3.0
ARG ANCHOR_VERSION=0.32.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    clang \
    cmake \
    libssl-dev \
    libudev-dev \
    pkg-config \
    protobuf-compiler \
    bzip2 \
  && rm -rf /var/lib/apt/lists/*

# Node 20 + pnpm (Anchor's TS toolchain + the escrow's deploy script deps).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && npm install -g pnpm@10.14.0 \
  && rm -rf /var/lib/apt/lists/*

# Solana / Agave CLI (provides `solana`, `cargo-build-sbf`, the SBF toolchain).
RUN sh -c "$(curl -sSfL https://release.anza.xyz/v${SOLANA_VERSION}/install)"
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

# Anchor CLI, built FROM SOURCE at the pinned v0.32.1 tag. We deliberately do
# NOT use `avm install`, which downloads a prebuilt release binary linked against
# a newer glibc (2.39) that fails on Debian bookworm (2.36):
RUN cargo install --git https://github.com/coral-xyz/anchor --tag v${ANCHOR_VERSION} anchor-cli --locked --force

WORKDIR /build

# Bring in the v4 escrow source (pinned), the v5 source (this checkout) and our docker assets.
COPY --from=escrow-v4-source /contracts/svm/source /build/source
COPY contracts/svm/source /build/source-v5
COPY contracts/svm/accounts /build/accounts
COPY contracts/svm/docker/deploy-local-mint-keypair.patch /build/docker/deploy-local-mint-keypair.patch

WORKDIR /build/source

# Install the escrow's JS deps (Anchor uses them during build/IDL gen).
RUN pnpm install --frozen-lockfile

# Apply the env-gated mint-keypair tweak to deploy-local.ts (keeps the
# committed submodule clean). `patch -p1`
# tolerates the comment header in the .patch file and strips the a/ b/ prefix.
RUN patch -p1 < /build/docker/deploy-local-mint-keypair.patch

# Place our committed throwaway program keypairs where deploy-local.ts and
# `anchor keys sync` look for them. .keys/ is the script's KEYPAIR_DIRECTORY;
# target/deploy/ is where `anchor keys sync` reads the program-id keypairs.
RUN mkdir -p /build/source/.keys /build/source/target/deploy \
  && cp /build/accounts/escrow.json              /build/source/.keys/escrow-keypair.json \
  && cp /build/accounts/fulfillment_proxy.json   /build/source/.keys/fulfillment_proxy-keypair.json \
  && cp /build/accounts/mock_transfer_hook.json  /build/source/.keys/mock_transfer_hook-keypair.json \
  && cp /build/accounts/escrow.json              /build/source/target/deploy/escrow-keypair.json \
  && cp /build/accounts/fulfillment_proxy.json   /build/source/target/deploy/fulfillment_proxy-keypair.json \
  && cp /build/accounts/mock_transfer_hook.json  /build/source/target/deploy/mock_transfer_hook-keypair.json

# Rewrite declare_id! + Anchor.toml [programs.*] to OUR local program IDs (from
# the keypairs above), then build the SBF binaries + IDL carrying those IDs.
RUN anchor keys sync \
  && anchor build

# The v4 build must be the frozen v4 IDL, byte for byte once the frozen program id is
# swapped for the local one.
COPY contracts/svm/bindings/typescript/escrow-encoding/idl-history/v4/escrow.json /build/idl-history-v4.json
RUN node -e ' \
  const fs = require("fs"); \
  const frozen = fs.readFileSync("/build/idl-history-v4.json", "utf8"); \
  const built = fs.readFileSync("target/idl/escrow.json", "utf8"); \
  const want = frozen.split(JSON.parse(frozen).address).join(JSON.parse(built).address); \
  if (built !== want) { console.error("v4 IDL differs from idl-history/v4/escrow.json"); process.exit(1); }'

# v5: the current source, escrow only, at the v5 local id.
WORKDIR /build/source-v5
RUN mkdir -p target/deploy \
  && cp /build/accounts/escrow_v5.json target/deploy/escrow-keypair.json \
  && anchor keys sync --program-name escrow \
  && anchor build --program-name escrow

# =====================================================================
# Stage 2: runtime — solana-test-validator + spl-token + Node/ts-node
# =====================================================================
FROM --platform=linux/amd64 debian:bookworm-slim

ARG SOLANA_VERSION=2.3.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    bzip2 \
    busybox \
    jq \
  && rm -rf /var/lib/apt/lists/*

# Node 20 (deploy-local.ts runs at container startup).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && npm install -g pnpm@10.14.0 \
  && rm -rf /var/lib/apt/lists/*

# Solana toolchain (provides solana-test-validator, solana, spl-token).
RUN sh -c "$(curl -sSfL https://release.anza.xyz/v${SOLANA_VERSION}/install)"
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

# deploy-local.ts shells out to `anchor build`, but this runtime image ships the
# PREBUILT programs (target/ copied from the builder) and carries no Anchor/Rust
# toolchain. Provide a shim that no-ops `anchor build` so the prebuilt artifacts
# are deployed as-is; any other anchor subcommand fails loudly (none are used —
# `build` is the only anchor CLI call in deploy-local.ts).
RUN printf '#!/usr/bin/env bash\nif [ "$1" = "build" ]; then echo "[anchor-shim] runtime uses prebuilt artifacts; skipping anchor build"; exit 0; fi\necho "anchor: subcommand \\"$1\\" unavailable in runtime image" >&2; exit 127\n' > /usr/local/bin/anchor \
  && chmod +x /usr/local/bin/anchor

RUN npm install -g tsx@4

WORKDIR /contracts/svm

# v4 escrow source + the built artifacts (target/{deploy,idl,types}) from the builder.
COPY --from=escrow-v4-source /contracts/svm/source /contracts/svm/source
COPY --from=builder /build/source/target /contracts/svm/source/target
COPY --from=builder /build/source/Anchor.toml /contracts/svm/source/Anchor.toml
COPY --from=builder /build/source/node_modules /contracts/svm/source/node_modules
# .keys/ comes from the builder: without it deploy-local.ts takes its fresh deploy path and runs
# `anchor keys sync`, which the runtime anchor shim refuses, so the container never comes up.
COPY --from=builder /build/source/.keys /contracts/svm/source/.keys

# v5 escrow binary + IDL, and its deploy step (placed in the v4 scripts/ so its imports resolve).
COPY --from=builder /build/source-v5/target/deploy/escrow.so /contracts/svm/escrow-v5/escrow.so
COPY --from=builder /build/source-v5/target/idl/escrow.json /contracts/svm/escrow-v5/escrow.json
COPY contracts/svm/docker/deploy-escrow-v5.ts /contracts/svm/source/scripts/deploy-escrow-v5.ts

# Re-apply the patch so the runtime deploy-local.ts honors the mint-keypair
# env. The submodule source copied above is unpatched; apply it here too.
# `patch` is not in debian:bookworm-slim; install it in its own layer (placed
# after the cached Solana install so that expensive layer stays cached).
COPY contracts/svm/docker/deploy-local-mint-keypair.patch /contracts/svm/docker/deploy-local-mint-keypair.patch
RUN apt-get update && apt-get install -y --no-install-recommends patch \
  && rm -rf /var/lib/apt/lists/* \
  && cd /contracts/svm/source \
  && patch -p1 < /contracts/svm/docker/deploy-local-mint-keypair.patch

# Docker assets (keypairs + scripts).
COPY contracts/svm/accounts    /contracts/svm/accounts
COPY contracts/svm/docker/accounts.sh /contracts/svm/docker/accounts.sh
COPY contracts/svm/docker/entrypoint.sh /contracts/svm/docker/entrypoint.sh
COPY contracts/svm/docker/healthcheck.sh /contracts/svm/docker/healthcheck.sh
RUN chmod +x /contracts/svm/docker/*.sh

EXPOSE 8899 8900 80
HEALTHCHECK --interval=20s --timeout=15s --start-period=180s --retries=20 \
  CMD /contracts/svm/docker/healthcheck.sh

ENTRYPOINT ["/contracts/svm/docker/entrypoint.sh"]
