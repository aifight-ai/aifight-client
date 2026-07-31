// Types for scripts/postinstall.mjs so the vitest suite (TypeScript, strict)
// can import the pure renderer without allowJs. Kept next to the script it
// describes; not shipped (package.json "files" ships only the .mjs).

export function renderPostinstallBox(
  isTTY: boolean,
  env?: Record<string, string | undefined>,
): string | null;
