#!/bin/bash
# Run desktop app with STAGING UI + STAGING API
# UI: lite-staging.accomplish.ai | API: lite-staging.accomplish.ai
# This builds an unpacked app and runs it (no hot reload)

set -e

echo "Building unpacked app for staging..."
pnpm -F @accomplish/desktop build:unpack

echo "Launching app with staging configuration..."
ACCOMPLISH_UI_URL=https://lite-staging.accomplish.ai \
ACCOMPLISH_API_URL=https://lite-staging.accomplish.ai \
open apps/desktop/release/mac-arm64/Accomplish.app
