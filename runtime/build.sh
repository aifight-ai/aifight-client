#!/usr/bin/env bash
# runtime/build.sh — build + package verification pipeline for M1-01.
#
# Steps (all verifiable independently):
#   1. Sync src/protocol/types.ts from protocol/tools/generated/types.ts.
#      The codegen'd file is the single source of truth (plan §6).
#      This step is a plain cp + byte-diff check so CI catches
#      anyone editing the copy by hand.
#   2. tsc --noEmit: strict type-check, including the 1417-line
#      types.ts copy. Catches any breakage from schema changes or
#      hand-edited types.
#   3. esbuild bundle src/index.ts → dist/index.mjs  (library entry)
#   4. esbuild bundle bin/aifight.ts → dist/bin.mjs + shebang + chmod +x
#   5. Copy protocol/schema/** → dist/schemas/** so the packaged
#      tarball carries the asset tree the runtime loader expects.
#      This is the high-risk verification from M0.5 followup.
#   6. npm pack — produces the tarball a user would install.
#   7. Scratch install in /tmp — simulate `npm install <tarball>`
#      and confirm the CLI + loader actually work on the install'd
#      copy (catches missing `files` entries, broken bin symlinks,
#      and asset-path resolution bugs that dev mode would hide).

set -euo pipefail
cd "$(dirname "$0")"

export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/tmp/aifight-bridge-npm-cache}"
# prebuild-install (better-sqlite3's prebuilt-binary fetcher) reads the
# LOWERCASE form only. Without this export it falls back to ~/.npm,
# which in locked-down environments (CI runners, Codex sandbox, any
# machine where ~/.npm lacks write perms) produces EPERM → the install
# silently pivots to node-gyp compile, defeating Step 8's "prebuilt
# hit" assertion. Export both so every subprocess sees the sandbox.
export npm_config_cache="$NPM_CONFIG_CACHE"
mkdir -p "$NPM_CONFIG_CACHE"

echo "==[1] sync types.ts from protocol/tools/generated/"
cp ../protocol/tools/generated/types.ts src/protocol/types.ts
if ! diff -q ../protocol/tools/generated/types.ts src/protocol/types.ts >/dev/null; then
    echo "  FAIL: types.ts copy differs from source after cp — filesystem issue?"
    exit 1
fi
echo "  ok: $(wc -l <src/protocol/types.ts) lines"

echo "==[1.5] generate schema.generated.ts from schema.sql (M1-04)"
node scripts/bundle-schema.mjs
if [ ! -f src/store/schema.generated.ts ]; then
    echo "  FAIL: schema.generated.ts missing after gen:schema"
    exit 1
fi

echo "==[1.6] tests/ must not reference real \$HOME/.aifight (M1-04 hard red line)"
if grep -REn '~/\.aifight|\$HOME/\.aifight' tests/ 2>/dev/null; then
    echo "  FAIL: tests reference real user home. All tests MUST use :memory: or mkdtempSync."
    exit 1
fi
echo "  ok: no ~/.aifight references in tests/"

echo "==[1.7] README command coverage"
node scripts/verify-readme-commands.mjs

echo "==[2] tsc --noEmit strict type-check"
if [ ! -x ../node_modules/.bin/tsc ]; then
    echo "  FAIL: frozen workspace dependencies are missing — run 'npm ci' at the repository root"
    exit 1
fi
npm run check-types

echo "==[3] emit TypeScript declarations (dist/types/*.d.ts)"
rm -rf dist
mkdir -p dist
npx tsc -p tsconfig.build.json
dts_count=$(find dist/types -name '*.d.ts' | wc -l | tr -d ' ')
echo "  .d.ts files: $dts_count"
if [ ! -f dist/types/index.d.ts ]; then
    echo "  FAIL: dist/types/index.d.ts missing — package.json 'types' field would 404"
    exit 1
fi

echo "==[4] esbuild bundle (better-sqlite3 + @napi-rs/keyring kept external — native .node modules)"
# @napi-rs/keyring needs BOTH externals: the top-level dispatcher
# AND every optional platform package (keyring-darwin-arm64,
# keyring-linux-x64-gnu, etc). Without the -* wildcard, esbuild
# would attempt to bundle the per-platform .node loader into the
# JS output and fail.
#
# M1-06 Step 7: --banner:js="createRequire shim" is REQUIRED because
# the inline-bundled `ws` package is CJS and contains
# `require("events")` (and friends) at module top level. esbuild's
# ESM output mode rewrites bare `require()` calls into a stub that
# throws `Dynamic require of "X" is not supported` at runtime. The
# canonical ESM-of-CJS interop fix is to inject a real `require` via
# `createRequire(import.meta.url)` at the top of the bundle. Step 0
# (e) measured this: without the banner, `node dist/index.mjs` dies
# instantly on first ws import; with the banner, ws works as
# expected and bundle-size overhead is negligible (~123 KB).
WS_INTEROP_BANNER='import { createRequire } from "module"; const require = createRequire(import.meta.url);'
npx esbuild src/index.ts \
    --bundle \
    --platform=node \
    --target=node20.19 \
    --format=esm \
    --outfile=dist/index.mjs \
    --external:better-sqlite3 \
    --external:@napi-rs/keyring \
    --external:@napi-rs/keyring-* \
    --banner:js="$WS_INTEROP_BANNER" \
    --minify \
    --log-level=error

# bin/aifight.ts already has #!/usr/bin/env node at the top; esbuild
# passes the shebang through into the bundle output. Do NOT prepend
# one separately or Node hits a "#!/usr/bin/env node" on line 2 and
# parses it as JS (which is a syntax error).
npx esbuild bin/aifight.ts \
    --bundle \
    --platform=node \
    --target=node20.19 \
    --format=esm \
    --external:better-sqlite3 \
    --external:@napi-rs/keyring \
    --external:@napi-rs/keyring-* \
    --banner:js="$WS_INTEROP_BANNER" \
    --minify \
    --log-level=error \
    --outfile=dist/bin.mjs
chmod +x dist/bin.mjs

echo "  index.mjs: $(wc -c <dist/index.mjs) bytes"
echo "  bin.mjs:   $(wc -c <dist/bin.mjs) bytes"

echo "==[5] copy protocol/schema/** → dist/schemas/"
mkdir -p dist/schemas
rsync -a --delete ../protocol/schema/ dist/schemas/
echo "  schema files: $(find dist/schemas -name '*.schema.json' | wc -l | tr -d ' ')"
echo "  schema size:  $(du -sh dist/schemas | awk '{print $1}')"

echo "==[6] vitest"
if [ "${BUILD_ONLY:-0}" = "1" ]; then
    echo "  BUILD_ONLY=1 — skipping the test suite (env-dependent; runs in the test workflow)."
else
    npm test --silent
fi

echo "==[7] npm pack"
rm -f *.tgz
npm_config_dry_run=false NPM_CONFIG_DRY_RUN=false npm pack --silent
TGZ=$(ls aifight-*.tgz | head -1)
echo "  tarball: $TGZ ($(du -h "$TGZ" | awk '{print $1}'))"

if [ "${BUILD_ONLY:-0}" = "1" ]; then
    echo "  BUILD_ONLY=1 — skipping tarball + bundle verification (steps 7a–8; run in the test workflow)."
    echo "==[done] runtime built (dist/ + tarball; verification skipped)"
    exit 0
fi

# Tarball must declare BOTH native runtime deps (better-sqlite3 +
# @napi-rs/keyring) so consumers pull them at install time; must NOT
# contain inlined .node binaries or bundled source for either.
echo "  [7a] verify tarball package.json declares native runtime deps"
if ! tar tzf "$TGZ" | grep -q 'package/package.json$'; then
    echo "    FAIL: tarball missing package/package.json"
    exit 1
fi
tar xzf "$TGZ" -C /tmp/ --force-local 2>/dev/null || tar xzf "$TGZ" -C /tmp/
for dep in better-sqlite3 @napi-rs/keyring; do
    if ! DEP="$dep" node -e 'const p=require("/tmp/package/package.json"); process.exit((p.dependencies||{})[process.env.DEP]?0:1)'; then
        echo "    FAIL: tarball package.json missing $dep in dependencies"
        exit 1
    fi
done
echo "    ok: dependencies contains better-sqlite3 + @napi-rs/keyring"
rm -rf /tmp/package

echo "  [7b] tarball has no .node binaries"
NODEFILES=$(tar tzf "$TGZ" | grep '\.node$' || true)
if [ -n "$NODEFILES" ]; then
    echo "    FAIL: tarball contains .node files:"
    echo "$NODEFILES" | sed 's/^/      /'
    exit 1
fi
echo "    ok: no .node in tarball"

echo "  [7c] tarball has no bundled native-dep source (bs3 / keyring)"
for pattern in 'node_modules/better-sqlite3' 'node_modules/@napi-rs/keyring'; do
    HIT=$(tar tzf "$TGZ" | grep "$pattern" || true)
    if [ -n "$HIT" ]; then
        echo "    FAIL: tarball contains bundled $pattern"
        echo "$HIT" | head -3 | sed 's/^/      /'
        exit 1
    fi
done
echo "    ok: no bundled bs3 / keyring source in tarball"

echo "==[7.5] verify esbuild --external preserved imports (not inlined)"
# Correct --external:<pkg> behavior: the import statement REMAINS in
# the bundle; the native module is resolved at consumer install
# time. This is the opposite of "bundle has no 'pkg' string" —
# that wrong check would FAIL on correct implementations (Roy P2#1,
# TED fix). We assert for BOTH native runtime deps.
for bundle in dist/index.mjs dist/bin.mjs; do
    BS3_KEPT=$(grep -cE 'from ?"better-sqlite3"|require\("better-sqlite3"\)|import\("better-sqlite3"\)' "$bundle" || true)
    if [ "$BS3_KEPT" -lt 1 ]; then
        echo "  FAIL: $bundle has no preserved 'better-sqlite3' import — esbuild --external may have misfired"
        exit 1
    fi
    KEYRING_KEPT=$(grep -cE 'from ?"@napi-rs/keyring"|require\("@napi-rs/keyring"\)|import\("@napi-rs/keyring"\)' "$bundle" || true)
    if [ "$KEYRING_KEPT" -lt 1 ]; then
        echo "  FAIL: $bundle has no preserved '@napi-rs/keyring' import — esbuild --external may have misfired"
        exit 1
    fi
    echo "  ok: $bundle preserves bs3=$BS3_KEPT, keyring=$KEYRING_KEPT external import(s)"
done

# Reverse assertions: bundle must NOT contain any native module's
# source heuristics, platform-package symbols, or embedded .node
# payload. Covers bs3 and every @napi-rs/keyring platform variant
# (darwin-*, linux-*, win32-*, freebsd-*).
for bundle in dist/index.mjs dist/bin.mjs; do
    LEAK=$(grep -cE 'better_sqlite3_addon|better-sqlite3/build/Release|SQLite format 3|N-API|@napi-rs/keyring-(darwin|linux|win32|freebsd|android)|keyring\.(darwin|linux|win32|freebsd|android)-[a-zA-Z0-9_-]+\.node|napi_register_module' "$bundle" || true)
    if [ "$LEAK" -gt 0 ]; then
        echo "  FAIL: $bundle contains inlined native-module heuristics (count=$LEAK)"
        exit 1
    fi
done
echo "  ok: no inlined native-module source in bundles (bs3 + keyring)"

DISTNODE=$(find dist -name '*.node' 2>/dev/null | wc -l | tr -d ' ')
if [ "$DISTNODE" -gt 0 ]; then
    echo "  FAIL: dist/ contains $DISTNODE .node file(s)"
    exit 1
fi
echo "  ok: no .node binaries in dist/"

# ─── M1-06 Step 7: wsclient inline + .d.ts leak protection ────────────
#
# `ws` is a devDependency that gets INLINED into the bundle (decision
# #2 in M1-06 TED). Consumers of @aifight/aifight never have `ws` or
# `@types/ws` in their node_modules — so any leaked reference here
# would break their tsc / runtime resolution downstream. Three reverse
# assertions (hard) cover the bundle and the .d.ts surface; one
# forward best-effort grep is diagnostic (rev 3 P2 #5 lock: forward
# grep is NOT a hard gate — failure WARNs but does not block).
#
# rev 3 P2 #5: inline 成功判定 = 三反向 hard + 两端到端 hard 全过.
# Forward grep is best-effort diagnostic only — if Step 0's stable
# WS symbol got renamed in a future ws release, the warn should
# prompt updating the candidate list, NOT block the build.

echo "  [7.5b] M1-06 wsclient inline checks"
for bundle in dist/index.mjs dist/bin.mjs; do
    # hard reverse #1: no `from "ws"` import (ESM form leaks)
    WS_FROM=$(grep -cE 'from ?"ws"|from ?'"'"'ws'"'"'' "$bundle" || true)
    if [ "$WS_FROM" -gt 0 ]; then
        echo "    FAIL: $bundle leaks $WS_FROM 'from \"ws\"' import(s) — inline bundle should have absorbed them"
        grep -nE 'from ?"ws"|from ?'"'"'ws'"'"'' "$bundle" | head -3 | sed 's/^/      /'
        exit 1
    fi
    # hard reverse #2: no `require("ws")` call (CJS form leaks)
    WS_REQ=$(grep -cE 'require\("ws"\)|require\('"'"'ws'"'"'\)' "$bundle" || true)
    if [ "$WS_REQ" -gt 0 ]; then
        echo "    FAIL: $bundle leaks $WS_REQ require(\"ws\") call(s) — inline bundle should have absorbed them"
        grep -nE 'require\("ws"\)|require\('"'"'ws'"'"'\)' "$bundle" | head -3 | sed 's/^/      /'
        exit 1
    fi
    echo "    ok: $bundle has zero 'from \"ws\"' / require(\"ws\") leaks"
done

# hard reverse #3: dist/types/**/*.d.ts must not surface ws types.
# Consumers' tsc would error 'Cannot find module "ws"' if a public
# .d.ts referenced it. Step 4b's `#private` socket field guards the
# WSClientImpl class; this assertion is the build-side belt to that
# suspenders.
DTS_LEAK=$(grep -rEln 'from ?"ws"|import\("ws"\)' dist/types 2>/dev/null || true)
if [ -n "$DTS_LEAK" ]; then
    echo "    FAIL: dist/types/**/*.d.ts leaks ws type references:"
    echo "$DTS_LEAK" | sed 's/^/      /'
    grep -rEn 'from ?"ws"|import\("ws"\)' dist/types | head -10 | sed 's/^/      /'
    exit 1
fi
echo "    ok: dist/types/**/*.d.ts has zero ws type leaks (#private + type-only export held)"

# best-effort forward diagnostic (rev 3 P2 #5: warn-only, NOT a gate)
# Step 0 (f) locked candidates: `Sec-WebSocket` (RFC 6455 header
# literal, 18 matches, version-stable) and `PerMessageDeflate` (RFC
# 7692 class, 30 matches). If either appears in the bundle, ws was
# successfully inlined; if neither, ws may have changed naming but
# the build still passes — Step 8 connect-probe.mjs is the
# end-to-end ground truth.
WS_SYMBOL_HIT=0
for bundle in dist/index.mjs dist/bin.mjs; do
    HITS=$(grep -cE 'Sec-WebSocket|PerMessageDeflate' "$bundle" || true)
    if [ "$HITS" -gt 0 ]; then
        WS_SYMBOL_HIT=$((WS_SYMBOL_HIT + HITS))
    fi
done
if [ "$WS_SYMBOL_HIT" -gt 0 ]; then
    echo "    ok: bundles contain $WS_SYMBOL_HIT WS stable-symbol match(es) [Sec-WebSocket / PerMessageDeflate]"
else
    echo "    WARN: bundles contain ZERO matches for Step 0 stable WS symbols (Sec-WebSocket / PerMessageDeflate)."
    echo "          rev 3 P2 #5: warn-only, NOT a gate. Step 8 connect-probe.mjs is the ground truth."
    echo "          Action item: if Step 8 also fails, ws may have renamed; update Step 0 (f) candidates."
fi

# ─── M1-07b: reconnect package-boundary checks ───────────────────────
#
# M1-07 landed reconnect.ts as source-only. M1-07b makes the facade
# visible at the package root. These assertions prove the runtime
# symbol survived esbuild in BOTH library and CLI bundles, while keeping
# the jitter implementation grep diagnostic-only so minifier spelling
# changes do not create brittle CI failures.

echo "  [7.5c] M1-07b reconnect package-boundary checks"
INDEX_RECONNECT_HITS=$(grep -c 'createReconnectingWSClient' dist/index.mjs || true)
if [ "$INDEX_RECONNECT_HITS" -lt 1 ]; then
    echo "    FAIL: dist/index.mjs has no createReconnectingWSClient symbol — reconnect facade not in library bundle"
    exit 1
fi
echo "    ok: dist/index.mjs contains createReconnectingWSClient ($INDEX_RECONNECT_HITS hit(s))"

# dist/bin.mjs only imports the subset of src/index.ts used by the current
# placeholder CLI (RUNTIME_VERSION + hello). esbuild correctly tree-shakes
# unused library exports from the CLI bundle, so reconnect's presence here is
# diagnostic only. The library bundle + scratch package import below are the
# hard package-boundary gates.
BIN_RECONNECT_HITS=$(grep -c 'createReconnectingWSClient' dist/bin.mjs || true)
if [ "$BIN_RECONNECT_HITS" -gt 0 ]; then
    echo "    ok: dist/bin.mjs contains createReconnectingWSClient ($BIN_RECONNECT_HITS hit(s))"
else
    echo "    WARN: dist/bin.mjs has zero createReconnectingWSClient matches."
    echo "          This is expected while the CLI only imports RUNTIME_VERSION + hello; dist/index.mjs + connect-probe are hard gates."
fi

RANDOM_HIT=0
for bundle in dist/index.mjs dist/bin.mjs; do
    HITS=$(grep -c 'Math.random' "$bundle" || true)
    if [ "$HITS" -gt 0 ]; then
        RANDOM_HIT=$((RANDOM_HIT + HITS))
    fi
done
if [ "$RANDOM_HIT" -gt 0 ]; then
    echo "    ok: bundles contain $RANDOM_HIT Math.random match(es) (jitter diagnostic)"
else
    echo "    WARN: bundles contain ZERO Math.random matches."
    echo "          M1-07b locks this as warn-only; createReconnectingWSClient + probes are the hard gates."
fi

# ─── M1-14: decision provider package-boundary checks ───────────────
#
# Step 3 first-time exposes the decision facade at the package root.
# These assertions enforce M1-14 rev3 fix #6 (DirectModelError 5 类 not
# leaked) + facade-only public surface (per-game parsers / formatters /
# fallbacks / direct-model factories / buildPrompt stay internal).
# Source-side guards live in tests/index-exports.test.ts (case 8/9/10);
# scripts/ts-consumer.ts adds the @ts-expect-error directive that traps
# any future regression on `import type { DirectModelError }`.

echo "  [7.5d] M1-14 decision provider package-boundary checks"

# Forward #1: dist/index.mjs must contain the decision facade runtime
# symbol. esbuild --minify preserves named exports' identifiers at the
# module boundary (see [7.5c] createReconnectingWSClient precedent).
INDEX_DECISION_HITS=$(grep -c 'createDirectModelProvider' dist/index.mjs || true)
if [ "$INDEX_DECISION_HITS" -lt 1 ]; then
    echo "    FAIL: dist/index.mjs has no createDirectModelProvider symbol — decision facade not wired"
    exit 1
fi
echo "    ok: dist/index.mjs contains createDirectModelProvider ($INDEX_DECISION_HITS hit(s))"

# Forward #2: dist/types/index.d.ts must declare the public facade
# surface — runtime values + type-only exports. Anything missing here
# means a tsc consumer would see TS2305 "Module has no exported member".
ROOT_DTS="dist/types/index.d.ts"
DECISION_PUBLIC_SYMBOLS="createDirectModelProvider DecisionProviderError DecisionProvider DirectModelProviderOptions DirectModelProviderName DecisionProviderErrorKind DecisionRequest DecisionResponse DecisionResponseProviderMetadata StrategyProfile GameSpecificProfile GameType GameRules LegalAction ParseResult ParseInvalidReason"
for sym in $DECISION_PUBLIC_SYMBOLS; do
    if ! grep -qE "\\b${sym}\\b" "$ROOT_DTS"; then
        echo "    FAIL: $ROOT_DTS missing public decision symbol '$sym'"
        exit 1
    fi
done
echo "    ok: dist/types/index.d.ts declares 16 public decision facade symbols"

# Reverse: dist/types/index.d.ts MUST NOT leak M1-11 / M1-12 / M1-13 /
# M1-14 internal building blocks. Consumers reach them through
# createDirectModelProvider; DirectModelError instances surface only
# via DecisionProviderError.cause (rev3 fix #6 lock 选 B). The
# regex covers per-game parsers / formatters / fallbacks /
# direct-model factories / DirectModelError 5 classes + abstract base.
DECISION_INTERNAL_LEAK=$(grep -E '\b(buildPrompt|formatTexasHoldemState|formatLiarsDiceState|formatCoupState|fallbackTexasHoldem|fallbackLiarsDice|fallbackCoup|parseTexasHoldemAction|parseLiarsDiceAction|parseCoupAction|createAnthropicClient|createOpenAIClient|DirectModelError|DirectModelHttpError|DirectModelNetworkError|DirectModelAbortedError|DirectModelInvalidResponseError|DirectModelUnsupportedError)\b' "$ROOT_DTS" || true)
if [ -n "$DECISION_INTERNAL_LEAK" ]; then
    echo "    FAIL: $ROOT_DTS leaks internal decision symbols (M1-11/M1-12/M1-13/M1-14):"
    echo "$DECISION_INTERNAL_LEAK" | sed 's/^/      /'
    exit 1
fi
echo "    ok: $ROOT_DTS has zero internal decision symbol leaks"

echo "==[8] scratch install verification"
SCRATCH=$(mktemp -d /tmp/aifight-bridge-install-XXXXXX)
trap "rm -rf '$SCRATCH'" EXIT
TGZ_ABS="$PWD/$TGZ"
# Capture the scripts/ dir as an absolute path BEFORE we cd into the
# scratch — `(cd $SCRATCH; cp $SCRIPTS_DIR/...)` keeps the source
# files (connect-probe.mjs, ts-consumer.ts) accessible from the
# subshell. M1-06 Step 7 promoted the heredoc'd consumer.ts to
# scripts/ts-consumer.ts so it's IDE-checkable + version-controlled;
# scripts/connect-probe.mjs is the new runtime probe for wsclient.
SCRIPTS_DIR="$PWD/scripts"
(
    cd "$SCRATCH"
    npm_config_dry_run=false NPM_CONFIG_DRY_RUN=false npm init -y >/dev/null 2>&1
    # Capture install log so the next step can detect compile fallback.
    # --loglevel=info surfaces prebuild-install's hit/miss decisions.
    if ! npm_config_dry_run=false NPM_CONFIG_DRY_RUN=false npm install --no-audit --no-fund --loglevel=info "$TGZ_ABS" >install.log 2>&1; then
        echo "  FAIL: scratch install rejected the tarball"
        tail -20 install.log | sed 's/^/    /'
        exit 1
    fi

    # M1-04 Roy P2#1: prove `npm install` hit a prebuilt binary and did
    # NOT silently fall back to node-gyp compile. The Step 0 platform
    # verification caught this risk once; build.sh must re-assert on
    # every release so a future bs3 version bump can't regress users
    # into "download node-gyp + Python + C++ toolchain" territory.
    echo "  [M1-04] prebuilt hit verification for better-sqlite3:"
    BS3_DIR="node_modules/better-sqlite3"
    if [ ! -d "$BS3_DIR" ]; then
        echo "    FAIL: $BS3_DIR missing after install — transitive dep not resolved"
        exit 1
    fi
    OBJS=$(find "$BS3_DIR" \( -name '*.o' -o -name '*.cc.d' -o -name '*.target.mk' \) 2>/dev/null | wc -l | tr -d ' ')
    if [ "$OBJS" -gt 0 ]; then
        echo "    FAIL: found $OBJS compile artifact(s) under $BS3_DIR — prebuilt MISS, node-gyp fallback ran"
        find "$BS3_DIR" \( -name '*.o' -o -name '*.cc.d' -o -name '*.target.mk' \) 2>/dev/null | head -5 | sed 's/^/      /'
        echo "    tail of install.log:"
        tail -30 install.log | sed 's/^/      /'
        exit 1
    fi
    if grep -qE 'gyp info|^make|cc1plus|c\+\+ |CXX\(' install.log; then
        echo "    FAIL: install.log shows compiler invocation — node-gyp fallback path"
        grep -E 'gyp info|^make|cc1plus|c\+\+ |CXX\(' install.log | head -5 | sed 's/^/      /'
        exit 1
    fi
    if [ ! -f "$BS3_DIR/build/Release/better_sqlite3.node" ]; then
        echo "    FAIL: $BS3_DIR/build/Release/better_sqlite3.node missing after install"
        exit 1
    fi
    NODE_SIZE=$(ls -l "$BS3_DIR/build/Release/better_sqlite3.node" | awk '{print $5}')
    echo "    ok: prebuilt HIT (0 compile artifacts, .node size $NODE_SIZE bytes)"

    # M1-05: prove `npm install` also hit a prebuilt @napi-rs/keyring
    # platform package and did NOT fall back to building from source.
    # @napi-rs/keyring distributes per-OS/arch subpackages via
    # optionalDependencies (keyring-darwin-arm64, keyring-linux-x64-gnu,
    # etc.); we don't know which one the CI host resolves, so we just
    # assert at least one .node under node_modules/@napi-rs and zero
    # compile artifacts anywhere under that tree.
    echo "  [M1-05] prebuilt hit verification for @napi-rs/keyring:"
    KEYRING_ROOT="node_modules/@napi-rs"
    if [ ! -d "$KEYRING_ROOT" ]; then
        echo "    FAIL: $KEYRING_ROOT missing after install — platform package not resolved"
        exit 1
    fi
    KEYRING_NODES=$(find "$KEYRING_ROOT" -name '*.node' 2>/dev/null | wc -l | tr -d ' ')
    if [ "$KEYRING_NODES" -lt 1 ]; then
        echo "    FAIL: no .node binaries under $KEYRING_ROOT — prebuilt platform package missing"
        ls -la "$KEYRING_ROOT" 2>/dev/null | sed 's/^/      /'
        exit 1
    fi
    KEYRING_OBJS=$(find "$KEYRING_ROOT" \( -name '*.o' -o -name '*.cc.d' -o -name '*.target.mk' \) 2>/dev/null | wc -l | tr -d ' ')
    if [ "$KEYRING_OBJS" -gt 0 ]; then
        echo "    FAIL: found $KEYRING_OBJS compile artifact(s) under $KEYRING_ROOT — prebuilt MISS, built from source"
        find "$KEYRING_ROOT" \( -name '*.o' -o -name '*.cc.d' -o -name '*.target.mk' \) 2>/dev/null | head -5 | sed 's/^/      /'
        exit 1
    fi
    echo "    ok: prebuilt HIT (keyring .node binaries=$KEYRING_NODES, 0 compile artifacts)"

    echo "  installed footprint:"
    du -sh node_modules 2>/dev/null | awk '{print "    node_modules: "$1}'
    pkgcount=$(find node_modules -maxdepth 3 -name package.json 2>/dev/null | wc -l | tr -d ' ')
    echo "    package count: $pkgcount"

    # Verify the CLI is accessible via node_modules/.bin/
    echo "  CLI --version:"
    ./node_modules/.bin/aifight --version | sed 's/^/    /'

    echo "  CLI doctor:"
    ./node_modules/.bin/aifight doctor | sed 's/^/    /' || {
        echo "    FAIL: aifight doctor exited non-zero"
        exit 1
    }

    # Verify the library entry works too
    echo "  programmatic JS import:"
    cat >probe.mjs <<'EOF'
import { hello, messageTypes, loadSchema, RUNTIME_VERSION } from "@aifight/aifight";
const r = hello();
console.log(`    hello: ${JSON.stringify({version: RUNTIME_VERSION, schemas: r.schemaCount, types: r.messageTypeCount})}`);
console.log(`    schemas root: ${r.schemasRoot}`);
const welcome = loadSchema("welcome");
console.log(`    loadSchema("welcome").title = ${welcome.title}`);
console.log(`    messageTypes().length     = ${messageTypes().length}`);
EOF
    node probe.mjs

    # M1-04 / M1-05 store + credentials end-to-end probe at the
    # package boundary: prove openDatabase() works with the v2 BLOB
    # schema and isKeychainAvailable() imports cleanly after
    # `npm install <tarball>` pulls both native deps.
    echo "  openDatabase(:memory:) + isKeychainAvailable() probe:"
    cat >store-probe.mjs <<'EOF'
// Isolate any keychain probe this script triggers — NEVER touch the
// production default service from a build script.
process.env.AIFIGHT_KEYCHAIN_SERVICE = `aifight-build-probe-${Date.now()}`;

import {
  openDatabase,
  isKeychainAvailable,
  getCredentialsBackend,
} from "@aifight/aifight";

// Keychain availability: just assert the function returns a boolean
// and doesn't throw. Do NOT call encryptForStorage here — we don't
// want build-script side effects on the real OS keychain beyond
// the one short-lived probe entry isKeychainAvailable already
// cleans up in its finally block.
const available = isKeychainAvailable();
const backend = getCredentialsBackend();
if (typeof available !== "boolean") {
  console.error("    FAIL: isKeychainAvailable did not return boolean");
  process.exit(1);
}
console.log(`    isKeychainAvailable=${available} backend=${backend.backend}`);

// Store round-trip under v2 schema: api_key / claim_token must be
// Buffer (not string) — the TypeScript types refuse string at
// compile time, and a raw string at runtime would fail the BLOB
// round-trip bytewise. schemaVersion must be 2 (v1 + v2 applied).
const db = openDatabase({ path: ":memory:" });
db.upsertAgent({
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  name: "consumer-probe",
  api_key: Buffer.from("sk-probe"),
  claim_token: Buffer.from("ct-probe"),
  model: "",
});
const list = db.listAgents();
console.log(`    schemaVersion=${db.schemaVersion} listAgents.length=${list.length} firstName=${list[0]?.name}`);
db.close();
if (list.length !== 1 || list[0].name !== "consumer-probe" || db.schemaVersion !== 2) {
  console.error("    FAIL: store probe did not round-trip under v2");
  process.exit(1);
}
EOF
    node store-probe.mjs

    # M1-06 Step 8: wsclient runtime probe. Pure JS — verifies that
    # createWSClient is a real function value AND the 11 error
    # classes are runtime constructors AFTER esbuild + npm pack +
    # scratch install. Source-side guards live in
    # tests/index-exports.test.ts (case 2: WSClient is type-only);
    # this is the post-bundle equivalent.
    echo "  M1-06 connect-probe.mjs (createWSClient + 11 error classes):"
    cp "$SCRIPTS_DIR/connect-probe.mjs" connect-probe.mjs
    node connect-probe.mjs

    # TypeScript consumer smoke test (R10 P2): prove the published
    # tarball actually ships usable .d.ts declarations. Without this,
    # any TS consumer (including future M2 openclaw-plugin) would get
    # TS7016 "Could not find a declaration file" even though the
    # tarball pretends to be a typed API.
    #
    # M1-06 Step 7: consumer.ts was promoted out of a heredoc into
    # scripts/ts-consumer.ts so it's IDE-visible and source-controlled.
    # Both build.sh and the IDE see the same file; cp moves it into
    # the scratch dir so tsc's `include` (relative to the dir tsc
    # runs in) picks it up against the just-installed @aifight/aifight
    # tarball. The file carries the Step 4b regression guard line
    # marked "@ts-expect-error - WSClient is type-only" — if a future
    # change accidentally exports WSClient as a runtime class value,
    # the directive becomes "unused" and tsc fails (the signal we
    # want).
    echo "  TypeScript consumer compile:"
    npm_config_dry_run=false NPM_CONFIG_DRY_RUN=false npm install --silent --no-audit --no-fund --save-dev typescript >/dev/null
    cp "$SCRIPTS_DIR/ts-consumer.ts" consumer.ts
    cat >consumer-tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": []
  },
  "include": ["consumer.ts"]
}
EOF
    if ./node_modules/.bin/tsc -p consumer-tsconfig.json; then
        echo "    ok: TS consumer compiles against published .d.ts"
    else
        echo "    FAIL: TS consumer did not compile — declarations are missing or broken"
        exit 1
    fi
)

echo "==[done] runtime package verified end-to-end (M1-01 skeleton + M1-04 store)"
