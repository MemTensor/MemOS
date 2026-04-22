#!/bin/bash
# Run desktop app with LOCAL UI (Vite hot reload) + PRODUCTION API
# UI: localhost:5173 | API: lite.accomplish.ai
ACCOMPLISH_UI_URL=http://localhost:3000 ACCOMPLISH_API_URL=https://lite.accomplish.ai pnpm dev
