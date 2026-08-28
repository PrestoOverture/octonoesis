#!/usr/bin/env bash
# Fails if a full `bun test` run mutates the repo's own .octonoesis/ ledger.
set -u
cd "$(dirname "$0")/.."
snapshot() {
  { shasum .octonoesis/journal.jsonl .octonoesis/stats.jsonl 2>/dev/null
    find .octonoesis/tasks -type f 2>/dev/null | sort
  } | shasum | awk '{print $1}'
}
BEFORE="$(snapshot)"
bun test >/dev/null 2>&1
AFTER="$(snapshot)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "PASS: .octonoesis/ unchanged by bun test"
  exit 0
fi
echo "FAIL: bun test mutated .octonoesis/ ($BEFORE -> $AFTER)"
exit 1
