# Stage 1: Build Anvil from Foundry
FROM ghcr.io/foundry-rs/foundry:v1.3.6 AS builder

# Stage 2: Runtime
FROM debian:bullseye-slim

# Install ca-certificates, busybox, curl, git, and prerequisites for Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    busybox \
    curl \
    wget \
    gnupg \
    jq \
    xxd \
    gzip \
    git \
    bc \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (LTS) from NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm@10.12.1

# Copy anvil binary
COPY --from=builder /usr/local/bin/anvil  /usr/local/bin/anvil
# Copy the cast binary
COPY --from=builder /usr/local/bin/cast  /usr/local/bin/cast
# Copy the forge binary
COPY --from=builder /usr/local/bin/forge  /usr/local/bin/forge

# Set working directory
WORKDIR /contracts/evm

# Set environment variables that are shared across all chains
ENV PERMIT2_ADDRESS=0x000000000022D473030F116dDEE9F6B43aC78BA3
ENV SALT=0x22b4280b956c7f0613b6313bbd60cf38e78fdbd98dee9876ee5db5fb1e7e4367

COPY contracts/evm/docker/start-fork.sh /start-fork.sh
COPY contracts/evm/docker/stop-fork.sh /stop-fork.sh

ARG RPC_URL
ARG FORK_BLOCK_NUMBER
ARG BUILD_PORT=8545

# Make BUILD_PORT available as environment variable for scripts
ENV BUILD_PORT=${BUILD_PORT}

# establish the fork cache:
RUN /start-fork.sh "${RPC_URL}" "${FORK_BLOCK_NUMBER}" "${BUILD_PORT}" && /stop-fork.sh

COPY contracts/evm/docker/entrypoint.sh /entrypoint.sh
COPY contracts/evm/docker/healthcheck.sh /healthcheck.sh
COPY contracts/evm/source/package.json package.json
COPY contracts/evm/source/pnpm-lock.yaml pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY contracts/evm/source/foundry.toml foundry.toml
COPY contracts/evm/source/remappings.txt remappings.txt
# Copy lib directory with all submodule contents already checked out
COPY contracts/evm/source/lib lib
COPY contracts/evm/docker/deploy-contracts.sh deploy-contracts.sh
COPY contracts/evm/source/script script
COPY contracts/evm/docker/erc20-approve-escrow.sh erc20-approve-escrow.sh
COPY contracts/evm/docker/seed-custom-tokens.sh seed-custom-tokens.sh
COPY contracts/evm/docker/accounts.sh accounts.sh
COPY contracts/evm/tokens.json tokens.json
COPY contracts/evm/source/src src
COPY contracts/evm/source/test test
ENV FORK_BLOCK_NUMBER=${FORK_BLOCK_NUMBER}

# Deploy contracts and dump state in one go
RUN /start-fork.sh "${RPC_URL}" "${FORK_BLOCK_NUMBER}" "${BUILD_PORT}" && \
    ./deploy-contracts.sh && \
    ./seed-custom-tokens.sh && \
    curl -X POST \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"anvil_dumpState","params":[],"id":1}' \
      http://localhost:${BUILD_PORT} \
      | jq -r '.result' \
      | sed 's/^0x//' \
      | xxd -r -p \
      | gzip -d > anvil_state.json && \
    /stop-fork.sh

EXPOSE 8545 80
HEALTHCHECK --interval=20s --timeout=15s --retries=13 CMD /healthcheck.sh

# Create generic wrapper that bakes in the fork block number and state
RUN echo '#!/bin/bash' > /start-fork.sh && \
    echo 'exec /entrypoint.sh --fork-block-number '"${FORK_BLOCK_NUMBER}"' --state /contracts/evm/anvil_state.json "$@"' >> /start-fork.sh && \
    chmod +x /start-fork.sh

ENTRYPOINT ["/start-fork.sh"]
