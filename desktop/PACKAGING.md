# AIFight Desktop — Packaging & Auto-Update

How the desktop app is built into installers, how auto-update works, and the
exact steps still pending (the ones that need the Apple/Windows certificates and
an app icon).

## Build locally

```bash
cd desktop
npm install
npm run package        # full installers for the host OS (dmg+zip on macOS, nsis on Windows)
npm run package:dir    # just the unpacked .app/.exe dir — fastest, for validation
```

Unsigned validation build (no certificate in the keychain):

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:dir
```

Output lands in `desktop/release/` (gitignored).

## What is configured

- **`electron-builder.yml`** — macOS `dmg` + `zip` (the zip feeds the updater),
  Windows `nsis`. `appId: ai.aifight.desktop`, `productName: AIFight`.
- **Schema bundling** — `esbuild.main.mjs` copies `protocol/schema/` to
  `dist/main/schemas/` on every build. The runtime's schema loader resolves its
  first candidate (`./schemas`, next to `main.cjs`) in both dev and the packaged
  app (read from inside `app.asar` via Electron's fs shim). No repo-layout
  dependency at runtime.
- **Native modules** — `better-sqlite3` and `@napi-rs/keyring` are `asarUnpack`-ed
  (native `.node` can't load from inside the asar) and rebuilt against Electron's
  ABI by electron-builder (`npmRebuild: true`) at package time.
- **Auto-update** — `electron-updater` is wired in `src/main/updater.ts` and
  surfaced in Settings → About (Check for updates / progress / Restart & update).
  It checks the `publish` feed in `electron-builder.yml` (currently the generic
  placeholder `https://aifight.ai/desktop`). Inert until a release is published
  there; in dev a check just reports "up to date".
- **CI** — `.github/workflows/desktop.yml`: every PR runs typecheck + test +
  build (ubuntu); `workflow_dispatch` builds unsigned installers on macOS +
  Windows runners and uploads them as artifacts.

## Done in this pass

- **App icon** — `build/icon.svg` (source) + `build/icon.png` (1024², used by
  electron-builder to generate the platform icns/ico). It's an on-brand starter
  (orange gradient squircle + white "A"); replace with final art any time by
  swapping `build/icon.png`.
- **`author`** set in `package.json`.
- **Linux** — `AppImage` target added (no cert needed; see below).
- **CI** — the `package` job runs on `workflow_dispatch` and `desktop-v*` tags
  across macOS / Windows / Linux, and already reads `CSC_LINK` / `APPLE_*` repo
  secrets, so signing activates with no workflow edit once they exist.

## Still pending (needs certs / a feed — not blocked by code)

1. **macOS notarization flip.** Once the Apple Developer ID is in hand, add the
   `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
   `APPLE_TEAM_ID` repo secrets AND set `mac.notarize: true` (+ an entitlements
   plist) in `electron-builder.yml`. Without notarization, modern macOS
   Gatekeeper blocks the app for non-developer users.
2. **Windows signing** (optional at launch): an OV/IV code-signing cert →
   `CSC_LINK` / `CSC_KEY_PASSWORD`. Unsigned just triggers a SmartScreen
   "More info → Run anyway" prompt.
3. **Finalize the update feed.** Host `latest*.yml` + the artifacts at
   `https://aifight.ai/desktop/` (or switch `publish` to a `github` provider).
   Auto-update only works once real releases are published to the feed.

## Certificates — quick reference (verified 2026-06)

- **macOS (required for public distribution).** Apple Developer Program, **US$99/yr**.
  - *Organization* enrollment needs a **D-U-N-S number** = a registered legal
    entity (a company). Applies in China too.
  - *Individual* enrollment needs only an Apple Account + 2-factor; the developer
    is listed under the person's **real legal name**. This is the path when there
    is no company. The Developer ID cert it issues is what signs + notarizes the
    `.dmg`; the app's display name stays "AIFight" regardless.
- **Windows (optional).** Since June 2023 the private key must live on a hardware
  token/HSM (or cloud signer). **OV/IV** certs (~US$200–300/yr + ~US$120 token)
  can be issued to an individual. **EV** (instant SmartScreen trust) normally
  needs a registered org — except a few CAs (e.g. SSL.com) issue EV-level to sole
  proprietors. Microsoft's token-free cloud signing is **US/Canada only** for now.
- **Linux.** No code-signing certificate required; the OS doesn't enforce it.
  AppImage ships unsigned.

## Notes

- electron-builder bundles its own `@electron/rebuild`; the explicit
  `@electron/rebuild` devDependency (used by the `npm run rebuild` dev helper) is
  redundant but harmless.
- The 3 games supported in direct-LLM mode (texas_holdem / liars_dice / coup)
  are the only ones the cockpit renders; nothing packaging-specific depends on
  that, but keep it in mind for QA of a packaged build.
