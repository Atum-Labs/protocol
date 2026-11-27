#!/bin/bash

# Runtime entrypoint script that starts anvil and httpd
# The forking and deployment have already been done at build time
# Health checks are now handled by the Docker healthcheck

set -e

# Start anvil in the background with all arguments passed through
anvil --host 0.0.0.0 "$@" &

ANVIL_PID=$!

# Start busybox httpd to serve deployment addresses (already created at build time)
busybox httpd -f -p 80 -h /var/www &
HTTPD_PID=$!

# Wait for anvil process to complete
wait $ANVIL_PID
