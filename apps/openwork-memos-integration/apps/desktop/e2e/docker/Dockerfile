# Base image with Playwright dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.49.1-noble

# Install Xvfb, build tools (for node-pty), and additional dependencies for Electron
RUN apt-get update && apt-get install -y \
    xvfb \
    build-essential \
    python3 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2t64 \
    libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/desktop/package.json ./apps/desktop/

# Copy skills directories (needed by postinstall script)
COPY apps/desktop/skills ./apps/desktop/skills

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the desktop app
RUN pnpm -F @accomplish/desktop build

# Set display for Xvfb
ENV DISPLAY=:99

# Default command: start Xvfb and run tests (using native Playwright, not Docker)
CMD ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 & sleep 1 && pnpm -F @accomplish/desktop test:e2e:native"]
