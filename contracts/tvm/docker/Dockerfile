FROM herryxcodes/blockchain-nodes-x86:latest

# Install Node.js, npm, git and build tools
RUN yum install -y \
    gcc-c++ \
    make \
    git \
    && yum clean all

# Install busybox manually since CentOS 7 doesn't have it in repos
RUN curl -L https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox -o /usr/bin/busybox && \
    chmod +x /usr/bin/busybox && \
    /usr/bin/busybox --install -s /usr/bin

# Install Node.js 16 (last LTS version compatible with CentOS 7's glibc)
RUN curl -fsSL https://rpm.nodesource.com/setup_16.x | bash - && \
    yum install -y nodejs && \
    yum clean all

# Install pnpm and tronbox globally
RUN npm install -g pnpm@8.15.6 tronbox@4.2.0

# Set working directory for contracts
WORKDIR /contracts/tvm

# Copy package files and install dependencies from repo folder
COPY contracts/tvm/source/package.json contracts/tvm/source/pnpm-lock.yaml ./
# Use --no-frozen-lockfile since the lockfile was created with a newer pnpm version
RUN pnpm install --no-frozen-lockfile

# Install tronweb for the approval script
RUN pnpm add tronweb

# Copy contract files from repo folder
COPY contracts/tvm/source/tronbox-config.js ./
COPY contracts/tvm/source/contracts ./contracts/

# Copy base migrations from submodule
COPY contracts/tvm/source/migrations ./migrations/

# Copy integration migrations (extension migrations with higher numbers)
COPY contracts/tvm/migrations ./migrations/

# Copy the Permit2 approval script from docker folder
COPY contracts/tvm/docker/set_permit2_approvals.js ./docker/

# Copy docker folder which contains scripts
COPY contracts/tvm/docker ./docker/

# Pre-compile contracts during build to save startup time (~30-45 seconds)
RUN tronbox compile

# Copy entrypoint and healthcheck scripts to root where Docker expects them
COPY contracts/tvm/docker/entrypoint.sh /entrypoint.sh
COPY contracts/tvm/docker/healthcheck.sh /healthcheck.sh
RUN chmod +x /entrypoint.sh /healthcheck.sh

# Create directory for serving contract addresses
RUN mkdir -p /var/www/deploymentAddresses

EXPOSE 9090 80

HEALTHCHECK --interval=10s --timeout=10s --retries=30 --start-period=60s CMD /healthcheck.sh

WORKDIR /tron

ENTRYPOINT ["/entrypoint.sh"]
