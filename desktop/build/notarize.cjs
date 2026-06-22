// electron-builder afterSign hook: notarize + staple the signed macOS .app.
//
// Auth resolves in this order:
//   1. SKIP_NOTARIZE=1                                   → skip (fast signed-only
//      check; Gatekeeper will reject it — expected without notarization).
//   2. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID present
//                                                        → use those credentials
//      (this is the CI path; the values come from repo secrets).
//   3. otherwise                                         → use the local
//      "aifight-notary" keychain profile, created once with:
//        xcrun notarytool store-credentials "aifight-notary" \
//          --apple-id <id> --team-id <team> --password <app-specific-password>
//
// So the same hook works on a developer machine (keychain profile, no secrets in
// the environment) and in CI (credentials injected as env vars).

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

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  const useEnvCreds = Boolean(APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID);

  // In CI we must have explicit credentials — the keychain profile only exists on
  // the developer machine. Fail loudly instead of producing a non-notarized build.
  if (!useEnvCreds && process.env.CI) {
    throw new Error(
      "[notarize] Apple notary credentials missing in CI. Set repo secrets " +
        "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID, or set " +
        "SKIP_NOTARIZE=1 to build signed-but-unnotarized.",
    );
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const auth = useEnvCreds
    ? { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID }
    : { keychainProfile: KEYCHAIN_PROFILE };

  console.log(
    `[notarize] submitting ${appPath} ` +
      `(${useEnvCreds ? "env credentials" : `keychain profile: ${KEYCHAIN_PROFILE}`}) …`,
  );
  await notarize({ tool: "notarytool", appPath, ...auth });

  console.log("[notarize] accepted by Apple — stapling the ticket …");
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  console.log("[notarize] done.");
};
