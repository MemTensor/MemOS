#!/bin/bash
# Test script to verify the npm package includes compiled output

set -e

echo "Testing @memtensor/memos-local-openclaw-plugin package..."

cd "$(dirname "$0")/.."

# Run build
echo "1. Running build..."
npm run build

# Check dist/ directory exists
if [ ! -d "dist" ]; then
  echo "✗ FAIL: dist/ directory not found"
  exit 1
fi
echo "✓ dist/ directory exists"

# Check main entry point
if [ ! -f "dist/index.js" ]; then
  echo "✗ FAIL: dist/index.js not found"
  exit 1
fi
echo "✓ dist/index.js exists"

# Check type declarations
if [ ! -f "dist/index.d.ts" ]; then
  echo "✗ FAIL: dist/index.d.ts not found"
  exit 1
fi
echo "✓ dist/index.d.ts exists"

# Check compiled src files
if [ ! -d "dist/src" ]; then
  echo "✗ FAIL: dist/src/ directory not found"
  exit 1
fi
echo "✓ dist/src/ directory exists"

# Verify package.json points to compiled output
MAIN_ENTRY=$(node -p "require('./package.json').main")
if [ "$MAIN_ENTRY" != "dist/index.js" ]; then
  echo "✗ FAIL: package.json main field is '$MAIN_ENTRY', expected 'dist/index.js'"
  exit 1
fi
echo "✓ package.json main points to dist/index.js"

# Verify openclaw.extensions points to compiled output
OPENCLAW_EXT=$(node -p "require('./package.json').openclaw.extensions[0]")
if [ "$OPENCLAW_EXT" != "./dist/index.js" ]; then
  echo "✗ FAIL: openclaw.extensions is '$OPENCLAW_EXT', expected './dist/index.js'"
  exit 1
fi
echo "✓ openclaw.extensions points to ./dist/index.js"

# Simulate npm pack and verify dist is included
echo "2. Simulating npm pack..."
PACK_OUTPUT=$(npm pack --dry-run 2>&1)
if ! echo "$PACK_OUTPUT" | grep -q "dist/index.js"; then
  echo "✗ FAIL: dist/index.js not included in npm package"
  exit 1
fi
echo "✓ dist/index.js will be included in npm package"

if ! echo "$PACK_OUTPUT" | grep -q "dist/src/"; then
  echo "✗ FAIL: dist/src/ not included in npm package"
  exit 1
fi
echo "✓ dist/src/ will be included in npm package"

# Verify TypeScript source is NOT included (but .d.ts type declarations are OK)
if echo "$PACK_OUTPUT" | grep -E "npm notice.*(index\.ts|src/.+\.ts)" | grep -v "\.d\.ts" | grep -q .; then
  echo "✗ FAIL: TypeScript source files should not be included in npm package"
  exit 1
fi
echo "✓ TypeScript source files excluded from npm package (type declarations OK)"

echo ""
echo "✓ All tests passed!"
echo "The package now correctly ships compiled JavaScript output in dist/"
