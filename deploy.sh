#!/usr/bin/env bash
#
# Deploy every target, in the order that matters.
#
#   ./deploy.sh            # deploy everything that changed
#   ./deploy.sh --check    # report what is stale, change nothing
#
# THERE ARE THREE DEPLOY TARGETS AND THEY ARE INDEPENDENT.
# Missing one produces no error at all -- just a video that does not reflect
# your change. That has burned this project repeatedly, which is why this
# script exists.
#
#   1. Railway          the app: planning pipeline, cataloguing, API, web UI.
#                       Deploys automatically when main is pushed to GitHub.
#
#   2. Remotion site    the composition: clip layout, COMPOSITION DURATION,
#      bundle (S3)      text overlays, fonts, transitions.
#                       Railway does NOT rebuild this. render.ts reads
#                       REMOTION_SERVE_URL and reuses whatever is already in S3,
#                       so composition changes stay dormant until this runs.
#
#   3. Preprocessor     per-clip FFmpeg: smart crop, punch-in (extraZoom),
#      Lambda           audio mastering. Also independent of Railway.
#
# Run from WSL or Linux. package.json's build shells out to bash, and a
# node_modules installed by Windows bun cannot be used from WSL.

set -euo pipefail

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '   \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- Preflight -------------------------------------------------------------

say "Preflight"

[[ -f package.json ]] || die "run this from the repo root"

if [[ -d node_modules ]] && compgen -G "node_modules/.bin/*.exe" > /dev/null 2>&1; then
  die "node_modules was installed by Windows bun (.exe shims present).
     It cannot be used from WSL. Fix with:  rm -rf node_modules && bun install"
fi

command -v bun >/dev/null || die "bun not found on PATH"
ok "bun $(bun --version)"

# Shell scripts must be LF. A CRLF checkout fails with \$'\r': command not found.
if grep -qU $'\r' create-stubs.sh 2>/dev/null; then
  warn "create-stubs.sh has CRLF line endings — fixing"
  sed -i 's/\r$//' ./*.sh
fi

say "Typecheck"
bun run typecheck
ok "0 errors"

say "Production build"
# Run the real build before anything is pushed. Railway runs this same step, and
# it is NOT hermetic: agentuity's bundler writes a throwaway package.json
# containing only {name, version} and then runs `npm install <external>` with no
# version, so build.external packages resolve to whatever is latest on npm at
# that moment. Our pins in package.json are not consulted.
#
# In practice that means a Remotion release breaks the build for as long as it
# takes them to finish publishing every package in the set. Observed 2026-08-12:
# remotion@4.0.509 went up at 14:28 and the build failed on @remotion/studio,
# then on @remotion/studio-shared, as the release rolled out package by package.
#
# Catching it here costs two minutes. Not catching it means pushing to main,
# watching the Railway build fail, and shipping nothing — while the old
# container keeps serving, so the app looks fine and the change silently is not
# live. That is the exact failure mode this script exists to prevent.
if ! bun run build > /tmp/kg-build.log 2>&1; then
  tail -20 /tmp/kg-build.log
  echo
  if grep -q "ETARGET\|No matching version found" /tmp/kg-build.log; then
    die "Build failed resolving an external dependency.
     This is almost certainly an in-progress upstream release, not your code.
     Check the version in the error against the registry:
       npm view @remotion/lambda version
     Wait for the publish to finish and re-run. Do NOT push to main until this
     passes — Railway runs the same step and the deploy will fail."
  fi
  die "Build failed — see /tmp/kg-build.log"
fi
ok "build succeeded"

say "Tests"
for t in test-composition-timing.ts test-preprocessor-crop.ts test-emotion-wiring.ts; do
  if [[ -f "$t" ]]; then
    bun "$t" > /dev/null || die "$t failed — run 'bun $t' to see why"
    ok "$t"
  fi
done

# --- What is stale? --------------------------------------------------------
# Compare each target's inputs against the marker written on its last deploy.

STAMP_DIR=".deploy-stamps"
mkdir -p "$STAMP_DIR"

fingerprint() {  # fingerprint <paths...>
  # Hash of tracked content, so a deploy is only "needed" when inputs changed.
  git ls-files -s -- "$@" 2>/dev/null | sha1sum | cut -d' ' -f1
}

REMOTION_SRC=(src/agent/video-editor/remotion)
LAMBDA_SRC=(scripts/deploy-preprocessor-lambda.ts)

REMOTION_FP=$(fingerprint "${REMOTION_SRC[@]}")
LAMBDA_FP=$(fingerprint "${LAMBDA_SRC[@]}")

REMOTION_STALE=1; [[ -f "$STAMP_DIR/remotion" && "$(cat "$STAMP_DIR/remotion")" == "$REMOTION_FP" ]] && REMOTION_STALE=0
LAMBDA_STALE=1;   [[ -f "$STAMP_DIR/lambda"   && "$(cat "$STAMP_DIR/lambda")"   == "$LAMBDA_FP"   ]] && LAMBDA_STALE=0

say "Status"
[[ $REMOTION_STALE == 1 ]] && warn "Remotion site bundle: STALE (composition changed since last deploy)" || ok "Remotion site bundle: current"
[[ $LAMBDA_STALE   == 1 ]] && warn "Preprocessor Lambda: STALE (handler changed since last deploy)"      || ok "Preprocessor Lambda: current"

UNPUSHED=$(git log --oneline @{u}.. 2>/dev/null | wc -l || echo 0)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  warn "On branch '$BRANCH'. Railway deploys from main — merge and push to ship the app."
elif [[ "$UNPUSHED" -gt 0 ]]; then
  warn "$UNPUSHED commit(s) not pushed. Railway deploys on push to main."
else
  ok "main is pushed — Railway is up to date"
fi

if [[ $CHECK_ONLY == 1 ]]; then
  say "--check only, nothing deployed"
  exit 0
fi

# --- 2. Remotion site bundle ----------------------------------------------

if [[ $REMOTION_STALE == 1 ]]; then
  say "Remotion site bundle"
  # Build and sanity-check before spending an upload: a bundle that fetches
  # fonts at render time is a hard failure on a Lambda with no outbound route.
  bun scripts/verify-remotion-bundle.ts
  bun scripts/setup-remotion-lambda.ts
  echo "$REMOTION_FP" > "$STAMP_DIR/remotion"
  ok "deployed"
  warn "If setup printed a new REMOTION_SERVE_URL, set it on Railway:"
  warn "  railway variables -s kg-content-studio --set REMOTION_SERVE_URL=<url>"
else
  say "Remotion site bundle — unchanged, skipping"
fi

# --- 3. Preprocessor Lambda ------------------------------------------------

if [[ $LAMBDA_STALE == 1 ]]; then
  say "Preprocessor Lambda"
  bun scripts/deploy-preprocessor-lambda.ts
  echo "$LAMBDA_FP" > "$STAMP_DIR/lambda"
  ok "deployed"
else
  say "Preprocessor Lambda — unchanged, skipping"
fi

# --- 1. Railway ------------------------------------------------------------

say "Railway (the app)"
if [[ "$BRANCH" == "main" && "$UNPUSHED" -gt 0 ]]; then
  warn "Pushing main — this triggers a production deploy."
  read -r -p "   Push now? [y/N] " reply
  if [[ "$reply" == "y" || "$reply" == "Y" ]]; then
    git push origin main
    ok "pushed — watch the build in the Railway dashboard"
  else
    warn "skipped; the app is NOT updated"
  fi
elif [[ "$BRANCH" != "main" ]]; then
  warn "Not on main. To ship the app:"
  warn "  git checkout main && git merge $BRANCH && git push origin main"
else
  ok "nothing to push"
fi

say "Done"
