#!/usr/bin/env bash
#
# build-test-caddy.sh
#
# Builds a Caddy binary with the forwardproxy plugin for use in SSRF e2e tests.
# The output binary is cached at .test-fixtures/caddy-with-forwardproxy.
#
# Usage:
#   ./scripts/build-test-caddy.sh           # build if missing
#   ./scripts/build-test-caddy.sh --force   # force rebuild
#
# Requirements:
#   - Go 1.21+ in PATH
#
# Exit codes:
#   0 - binary is ready (built or already cached)
#   1 - Go not installed
#   2 - build failed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="${REPO_ROOT}/.test-fixtures"
CADDY_BIN="${FIXTURE_DIR}/caddy-with-forwardproxy"
FORCE="${1:-}"
CADDY_VERSION="$(tr -d '[:space:]' < "${REPO_ROOT}/scripts/caddy-ssrf-version.txt")"
XCADDY_VERSION="v0.4.5"
FORWARDPROXY_VERSION="0aab84dad4fc2830789f34e27b4d7bc22a40889e"

# 1. Check Go
if ! command -v go >/dev/null 2>&1; then
  echo "ERROR: Go is required to build test Caddy. Install from https://go.dev/dl/"
  echo "  macOS:   brew install go"
  echo "  Linux:   apt-get install golang-go"
  exit 1
fi

# 2. Skip if cached binary works (unless --force)
if [[ "${FORCE}" != "--force" && -x "${CADDY_BIN}" ]]; then
  if "${CADDY_BIN}" version >/dev/null 2>&1; then
    echo "Test caddy binary already exists at ${CADDY_BIN}"
    "${CADDY_BIN}" version
    exit 0
  fi
fi

# 3. Build
mkdir -p "${FIXTURE_DIR}"
echo "Building Caddy with forwardproxy plugin..."
echo "  Output: ${CADDY_BIN}"

# Use a temporary GOBIN so we don't pollute the user's environment
TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

cd "${TMPDIR}"

# Use go run to invoke xcaddy without requiring it to be globally installed
GOBIN="${TMPDIR}/gobin" go install "github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION}"

if [[ ! -x "${TMPDIR}/gobin/xcaddy" ]]; then
  echo "ERROR: failed to install xcaddy"
  exit 2
fi

# Build caddy with the forwardproxy plugin
"${TMPDIR}/gobin/xcaddy" build "v${CADDY_VERSION}" \
  --with "github.com/caddyserver/forwardproxy@${FORWARDPROXY_VERSION}" \
  --output "${CADDY_BIN}"

if [[ ! -x "${CADDY_BIN}" ]]; then
  echo "ERROR: build did not produce a binary at ${CADDY_BIN}"
  exit 2
fi

# Verify
echo ""
echo "Build complete:"
"${CADDY_BIN}" version
echo ""

# Verify the forward_proxy module is loaded
if ! "${CADDY_BIN}" list-modules 2>&1 | grep -qi "forward_proxy"; then
  echo "ERROR: built binary does not include the forward_proxy module"
  exit 2
fi

echo "✓ forward_proxy module is loaded"
echo "✓ Test caddy ready at: ${CADDY_BIN}"
