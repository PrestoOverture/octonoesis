#!/usr/bin/env bash
# Creates the scratch repos the demo tapes record against, under /tmp/octo-demo.
# Idempotent: wipes and recreates on every run. Never commit /tmp/octo-demo.
#
# Usage:  bash demo/tapes/setup-demo-repos.sh
# Then:   vhs demo/tapes/hero.tape        (from the repo root)
#
# The tapes invoke `octonoesis` via /tmp/octo-demo/bin, which wraps
# `bun <this-repo>/src/cli.tsx`. An ANTHROPIC_API_KEY must be available:
# either exported in the shell that runs vhs, or present in this repo's .env
# (copied into each scratch repo below, where Bun auto-loads it).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEMO_ROOT="/tmp/octo-demo"

rm -rf "$DEMO_ROOT"
mkdir -p "$DEMO_ROOT/bin"

cat > "$DEMO_ROOT/bin/octonoesis" <<EOF
#!/usr/bin/env bash
exec bun "$REPO_ROOT/src/cli.tsx" "\$@"
EOF
chmod +x "$DEMO_ROOT/bin/octonoesis"

# --- hero-repo: the golden-path fixture (null-pointer bug + failing tests) ---
HERO="$DEMO_ROOT/hero-repo"
mkdir -p "$HERO"
cp -R "$REPO_ROOT/test/fixtures/buggy-repo/." "$HERO/"
if [ -f "$REPO_ROOT/.env" ]; then cp "$REPO_ROOT/.env" "$HERO/.env"; fi
git -C "$HERO" init -q
git -C "$HERO" add -A
git -C "$HERO" -c user.email=demo@octo -c user.name=demo commit -qm init

# --- learning-repo: two same-class TypeError bugs in different files ---
LEARN="$DEMO_ROOT/learning-repo"
mkdir -p "$LEARN/src"

cat > "$LEARN/src/user.ts" <<'EOF'
export interface User {
  name?: string
}

export function greetUser(user?: User | null): string {
  // @ts-ignore - intentionally buggy
  return `Hello, ${user.name.toUpperCase()}!`
}
EOF

cat > "$LEARN/src/user.test.ts" <<'EOF'
import { expect, test } from 'bun:test'
import { greetUser } from './user'

test('greets a valid user', () => {
  expect(greetUser({ name: 'alice' })).toBe('Hello, ALICE!')
})

test('greets a missing user as Guest', () => {
  expect(greetUser(null)).toBe('Hello, Guest!')
})

test('greets a user without a name as Guest', () => {
  expect(greetUser({})).toBe('Hello, Guest!')
})
EOF

cat > "$LEARN/src/order.ts" <<'EOF'
export interface Order {
  customer?: { name?: string } | null
}

export function orderLabel(order?: Order | null): string {
  // @ts-ignore - intentionally buggy
  return `Order for ${order.customer.name.trim()}`
}
EOF

cat > "$LEARN/src/order.test.ts" <<'EOF'
import { expect, test } from 'bun:test'
import { orderLabel } from './order'

test('labels a valid order', () => {
  expect(orderLabel({ customer: { name: ' Bob ' } })).toBe('Order for Bob')
})

test('labels a missing order as Guest', () => {
  expect(orderLabel(null)).toBe('Order for Guest')
})

test('labels an order without a customer as Guest', () => {
  expect(orderLabel({})).toBe('Order for Guest')
})
EOF

cat > "$LEARN/package.json" <<'EOF'
{
  "name": "demo-app",
  "private": true,
  "type": "module"
}
EOF
if [ -f "$REPO_ROOT/.env" ]; then cp "$REPO_ROOT/.env" "$LEARN/.env"; fi
git -C "$LEARN" init -q
git -C "$LEARN" add -A
git -C "$LEARN" -c user.email=demo@octo -c user.name=demo commit -qm init

# Written AFTER the commit so it stays untracked (untracked config = trusted,
# so the permission allowPatterns actually apply). Keeps each demo session at
# exactly one permission prompt (the Edit), regardless of how many test runs
# the model decides to do.
mkdir -p "$LEARN/.octonoesis"
cat > "$LEARN/.octonoesis/config.json" <<'EOF'
{
  "permissions": {
    "allowPatterns": ["Bash(bun test*)", "Bash(cd *)"]
  }
}
EOF

echo "demo repos ready under $DEMO_ROOT"
