#!/usr/bin/env bash
# Release guard (CI, before the build): the in-app updater compares the TAG with the installed
# versionName, Android compares versionCode, Settings shows package.json. If they disagree, every
# phone would see an update it can never install. Usage: scripts/check-versions.sh [tag]
#   - package.json version must equal build.gradle versionName (always)
#   - with a tag vX.Y.Z: the tag must equal both, and versionCode must be higher than the
#     versionCode of the newest older v* tag.
set -euo pipefail
cd "$(dirname "$0")/.."
GRADLE=android/app/build.gradle
PKG=$(node -p "require('./package.json').version")
VN=$(sed -n 's/^[[:space:]]*versionName[[:space:]]*"\([^"]*\)".*/\1/p' "$GRADLE" | head -1)
VC=$(sed -n 's/^[[:space:]]*versionCode[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$GRADLE" | head -1)
TAG="${1:-}"
TAG="${TAG#refs/tags/}"
echo "tag=${TAG:-none} package.json=$PKG versionName=$VN versionCode=$VC"
fail() { echo "::error::$1"; exit 1; }
[ -n "$VN" ] && [ -n "$VC" ] || fail "versionName/versionCode not found in $GRADLE"
[ "$PKG" = "$VN" ] || fail "package.json version $PKG != versionName $VN"
case "$TAG" in v[0-9]*) ;; *) echo "no release tag: tag checks skipped"; exit 0 ;; esac
[ "${TAG#v}" = "$PKG" ] || fail "tag $TAG != package.json version $PKG / versionName $VN"
# newest v* tag whose version is lower than this one (independent of branch history)
PREV=$(git tag -l 'v[0-9]*' | sed 's/^v//' | { grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true; } \
  | { cat; echo "${TAG#v}"; } | sort -t. -k1,1n -k2,2n -k3,3n -u \
  | awk -v cur="${TAG#v}" '$0 == cur { print prev; exit } { prev = $0 }')
if [ -z "$PREV" ]; then echo "no earlier release tag: versionCode check skipped"; exit 0; fi
PVC=$(git show "v$PREV:$GRADLE" 2>/dev/null | sed -n 's/^[[:space:]]*versionCode[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1 || true)
[ -n "$PVC" ] || fail "cannot read versionCode of v$PREV (fetch-depth 0 / tags missing?)"
[ "$VC" -gt "$PVC" ] || fail "versionCode $VC must be higher than $PVC (v$PREV)"
echo "OK: $TAG, versionCode $VC > $PVC (v$PREV)"
