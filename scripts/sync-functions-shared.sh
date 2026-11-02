#!/usr/bin/env bash
# Copies the pure bill code the Cloud Functions reuse (run before every functions deploy).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p functions/shared
cp src/billing.js src/format.js src/autoBill.js functions/shared/
