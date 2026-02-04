#!/bin/bash
# Run desktop app with PRODUCTION UI + PRODUCTION API
# UI: lite.accomplish.ai | API: lite.accomplish.ai
# This builds an unpacked app and runs it (no hot reload)

set -e

echo "Building unpacked app for production..."
pnpm -F @accomplish/desktop build:unpack

echo "Launching app with production configuration..."
ACCOMPLISH_UI_URL=https://lite.accomplish.ai \
ACCOMPLISH_API_URL=https://lite.accomplish.ai \
open apps/desktop/release/mac-arm64/Accomplish.app
