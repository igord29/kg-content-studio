#!/usr/bin/env bash
# deploy.sh — run the quality-overhaul deploy in order, under bash/WSL.
#
#   cd /mnt/c/Development_Folder/kg-content-studio
#   ./deploy.sh
#
# Run this in WSL, not PowerShell. package.json's build is `bash create-stubs.sh`,
# and .gitattributes already documents that the shell scripts run under WSL
# locally and Linux on the server.
#
# THERE ARE THREE DEPLOY TARGETS. Missing any one silently drops a whole class
# of fix, and you will not get an error — you will just get an unchanged video:
#
#   1. Remotion SITE bundle  -> entry.tsx, CLCVideo.tsx, TextOverlay.tsx, VideoClip.tsx
#                               = composition duration, freeze frames, overlay timing,
#                                 Montserrat, text safe area
#   2. Preprocessor Lambda   -> the FFmpeg crop + audio mastering
#   3. Railway               -> tagging, selection, validators, music, the publish gate
#
# The site bundle is the one that is easy to miss: REMOTION_SERVE_URL is set in
# your .env, and render.ts uses that pre-built S3 bundle as a fast path without
# ever rebuilding it. Redeploying Railway does NOT update it.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }
green() { printf '  \033[32mOK\033[0m  %s\n' "$*"; }
warn()  { printf '  \033[33m!!\033[0m  %s\n' "$*"; }
die()   { printf '\n\033[31mSTOPPED:\033[0m %s\n' "$*"; exit 1; }
step()  { echo; cyan "=== [$1] $2 ==="; }

echo "KG Content Studio — deploy"
echo "Branch: $(git branch --show-current 2>/dev/null || echo '?')"
grep -qi microsoft /proc/version 2>/dev/null && echo "Environment: WSL" || echo "Environment: $(uname -s)"

# ------------------------------------------------------------------ 0. tooling
step 0 "Tooling"
command -v bun >/dev/null 2>&1 || die $'bun not found in this shell.\n     Install inside WSL (not Windows):  curl -fsSL https://bun.sh/install | bash\n     then reopen the shell.'
green "bun $(bun --version)"
command -v node >/dev/null 2>&1 && green "node $(node --version)" || warn "node not found — needed by fix-registry-paths.js"

# A node_modules installed by WINDOWS bun cannot be used from WSL: the .bin
# shims are .exe/.bunx and the native binaries are win32. Mixing the two is a
# reliable way to get errors that look like the code is broken when it isn't.
if [ -d node_modules/.bin ] && ls node_modules/.bin | grep -q '\.exe$'; then
	warn "node_modules was installed by WINDOWS bun (.exe shims present)."
	warn "Reinstalling from WSL. This is the right move — the build scripts need bash."
	read -r -p "  Delete node_modules and reinstall under WSL? (y/n) " ans
	[[ "$ans" =~ ^[Yy] ]] && rm -rf node_modules || die "Cannot continue with a Windows-installed node_modules under WSL."
fi

# ------------------------------------------------------------------ 1. install
step 1 "Dependencies"
bun install || die "bun install failed"
[ -d node_modules/@fontsource/montserrat ] \
	&& green "@fontsource/montserrat present — the self-hosted font will bundle" \
	|| die "@fontsource/montserrat missing after install — check that package.json applied cleanly"

# ------------------------------------------------------------------ 2. typecheck
step 2 "Typecheck"
bun run typecheck || die "typecheck failed — do NOT deploy. Paste the errors to Claude."
green "0 type errors"

# ------------------------------------------------ 3. Remotion site (MOST MISSED)
step 3 "Remotion composition bundle  [the one that carries the visible fixes]"
echo "  Rebuilds entry.tsx + CLCVideo + TextOverlay + VideoClip and uploads to S3."
echo "  WITHOUT THIS: videos stay truncated, text stays under the TikTok rail,"
echo "  Montserrat never appears, and freeze frames remain. Railway cannot fix that."
read -r -p "  Deploy the composition bundle now? (y/n) " ans
if [[ "$ans" =~ ^[Yy] ]]; then
	bun scripts/setup-remotion-lambda.ts || die "site deploy failed — check REMOTION_AWS_* credentials in .env"
	green "composition bundle deployed"
else
	warn "SKIPPED — none of the render-layer fixes will be active."
	warn "Run later:  bun scripts/setup-remotion-lambda.ts"
fi

# ------------------------------------------------------- 4. preprocessor Lambda
step 4 "Preprocessor Lambda"
echo "  Ships the FFmpeg subject punch-in and audio mastering (-16 LUFS, -1.5 dBTP)."
echo "  WITHOUT THIS: framing and audio are unchanged."
read -r -p "  Deploy the preprocessor Lambda now? (y/n) " ans
if [[ "$ans" =~ ^[Yy] ]]; then
	bun scripts/deploy-preprocessor-lambda.ts || die "Lambda deploy failed — check AWS credentials in .env"
	green "preprocessor Lambda deployed"
else
	warn "SKIPPED — run later:  bun scripts/deploy-preprocessor-lambda.ts"
fi

# ------------------------------------------------------------------ 5. next
step 5 "Next"
cat <<'EOF'
  3 of 3: redeploy Railway (the tagging, selection, validators, music, gate).

  Then render ONE video and save it to:
      C:\Development_Folder\output_kg_content_studio\
  Claude will measure it against the three originals.

  Still uncommitted. Once you have read the diff:
      git add -A
      git commit -m "Quality overhaul: tagging, framing, audio, measured gate"
      git push -u origin quality-overhaul-2026-08
EOF
echo
