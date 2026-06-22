// electron-builder afterSign hook: notarize + staple the signed macOS .app.
//
// Auth comes from a keychain-stored notary profile created once with:
//   xcrun notarytool store-credentials "aifight-notary" \
//     --apple-id <id> --team-id <team> --password <app-specific-password>
// so no Apple credentials are ever passed through env vars or the repo.
//
// Set SKIP_NOTARIZE=1 to produce a signed-but-unnotarized build for a fast
// local check (Gatekeeper will reject it — that's expected without notarization).

const { notarize } = require("@electron/notarize");
const { execFileSync } = require("node:child_process");

const KEYCHAIN_PROFILE = "aifight-notary";

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  if (process.env.SKIP_NOTARIZE === "1") {
    console.log("[notarize] SKIP_NOTARIZE=1 set — skipping notarization.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] submitting ${appPath} (profile: ${KEYCHAIN_PROFILE}) …`);
  await notarize({
    tool: "notarytool",
    appPath,
    keychainProfile: KEYCHAIN_PROFILE,
  });

  console.log("[notarize] accepted by Apple — stapling the ticket …");
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  console.log("[notarize] done.");
};
