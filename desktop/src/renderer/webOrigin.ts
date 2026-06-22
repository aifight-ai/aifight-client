// ws(s):// bridge base URL → http(s):// web origin, for building deep-links to
// the website (agent profiles, event pages). Shared so every view derives the
// same origin from the configured bridge base URL.

export function webOrigin(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return "https://aifight.ai";
  try {
    const u = new URL(baseUrl);
    const proto = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol;
    return `${proto}//${u.host}`;
  } catch {
    return "https://aifight.ai";
  }
}
