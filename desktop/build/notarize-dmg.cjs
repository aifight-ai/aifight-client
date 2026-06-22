// electron-builder afterAllArtifactBuild hook: notarize + staple the .dmg.
//
// afterSign already notarized + stapled the .app (and therefore the app inside the
// update .zip). This stamps the .dmg *container* too, so a freshly downloaded disk
// image passes Gatekeeper on double-click without an "Apple cannot check it" prompt.
//
// Auth: the "aifight-notary" keychain profile (see build/notarize.cjs).
// Set SKIP_NOTARIZE=1 to bypass.

const { execFileSync } = require("node:child_process");

const KEYCHAIN_PROFILE = "aifight-notary";

exports.default = async function notarizeDmg(buildResult) {
  if (process.env.SKIP_NOTARIZE === "1") {
    console.log("[notarize-dmg] SKIP_NOTARIZE=1 set — skipping dmg notarization.");
    return [];
  }

  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith(".dmg"));
  for (const dmg of dmgs) {
    // The .dmg must be code-signed (not just notarized) for Gatekeeper to accept
    // the downloaded image. "Developer ID Application" uniquely matches the one
    // such identity in the keychain.
    console.log(`[notarize-dmg] code-signing ${dmg} …`);
    execFileSync(
      "codesign",
      ["--sign", "Developer ID Application", "--timestamp", "--force", dmg],
      { stdio: "inherit" },
    );
    console.log(`[notarize-dmg] submitting ${dmg} (profile: ${KEYCHAIN_PROFILE}) …`);
    execFileSync(
      "xcrun",
      ["notarytool", "submit", dmg, "--keychain-profile", KEYCHAIN_PROFILE, "--wait"],
      { stdio: "inherit" },
    );
    console.log(`[notarize-dmg] accepted — stapling ${dmg} …`);
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
    console.log("[notarize-dmg] done.");
  }
  return [];
};
