// electron-builder afterAllArtifactBuild hook: code-sign + notarize + staple the .dmg.
//
// afterSign already notarized + stapled the .app (and the app inside the update
// .zip). This stamps the .dmg *container* too, so a freshly downloaded disk image
// passes Gatekeeper on double-click without an "Apple cannot check it" prompt.
//
// Auth resolves like build/notarize.cjs:
//   SKIP_NOTARIZE=1 → skip; APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
//   → those credentials (CI); otherwise the local "aifight-notary" keychain profile.

const { execFileSync } = require("node:child_process");

const KEYCHAIN_PROFILE = "aifight-notary";

exports.default = async function notarizeDmg(buildResult) {
  if (process.env.SKIP_NOTARIZE === "1") {
    console.log("[notarize-dmg] SKIP_NOTARIZE=1 set — skipping dmg notarization.");
    return [];
  }

  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith(".dmg"));
  if (dmgs.length === 0) return [];

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  const useEnvCreds = Boolean(APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID);

  if (!useEnvCreds && process.env.CI) {
    throw new Error(
      "[notarize-dmg] Apple notary credentials missing in CI. Set repo secrets " +
        "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID, or SKIP_NOTARIZE=1.",
    );
  }

  const authArgs = useEnvCreds
    ? ["--apple-id", APPLE_ID, "--password", APPLE_APP_SPECIFIC_PASSWORD, "--team-id", APPLE_TEAM_ID]
    : ["--keychain-profile", KEYCHAIN_PROFILE];

  for (const dmg of dmgs) {
    // The .dmg must be code-signed (not just notarized) for Gatekeeper to accept
    // the downloaded image. "Developer ID Application" matches the signing identity.
    console.log(`[notarize-dmg] code-signing ${dmg} …`);
    execFileSync(
      "codesign",
      ["--sign", "Developer ID Application", "--timestamp", "--force", dmg],
      { stdio: "inherit" },
    );
    console.log(
      `[notarize-dmg] submitting ${dmg} ` +
        `(${useEnvCreds ? "env credentials" : `profile: ${KEYCHAIN_PROFILE}`}) …`,
    );
    execFileSync("xcrun", ["notarytool", "submit", dmg, ...authArgs, "--wait"], { stdio: "inherit" });
    console.log(`[notarize-dmg] accepted — stapling ${dmg} …`);
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
    console.log("[notarize-dmg] done.");
  }
  return [];
};
