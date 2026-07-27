// Links that go into the user's own chat have to point at AIFight.
//
// A replay URL and a challenge join_url both arrive from the server, and both
// end up as a tappable button (or a picture Telegram fetches) inside a private
// bot the user trusts completely. `new URL(path, base)` resolves a relative
// path against the base — but an ABSOLUTE value overrides the base entirely, so
// a server that was lying (or compromised) could put any origin in front of the
// user with AIFight's credibility behind it.
//
// The bridge already refuses to take the server's word on this class of thing
// elsewhere: config.ts rejects a wsUrl whose host is not the base host. This is
// the same rule, applied where the link is about to leave the machine.

/**
 * Resolve `raw` against `baseUrl` and return it only when the result is on the
 * same origin. Anything else — a different host, a `javascript:` scheme, an
 * unparseable string — comes back undefined, and the caller simply leaves the
 * link out.
 */
export function sameOriginUrl(baseUrl: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
    const resolved = new URL(raw, base);
    return resolved.origin === base.origin ? resolved.toString() : undefined;
  } catch {
    return undefined;
  }
}
