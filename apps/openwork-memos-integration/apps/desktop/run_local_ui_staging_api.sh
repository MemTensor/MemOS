#!/bin/bash
# Run desktop app with LOCAL UI (Vite hot reload) + STAGING API
# UI: localhost:5173 | API: lite-staging.accomplish.ai
ACCOMPLISH_UI_URL=http://localhost:3000 ACCOMPLISH_API_URL=https://lite-staging.accomplish.ai pnpm dev
