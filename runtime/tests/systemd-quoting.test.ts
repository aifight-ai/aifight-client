import { describe, expect, it } from "vitest";

import { quoteSystemdExecPath, quoteSystemdEnvironment } from "../src/bridge/service";

// R14 audit: the cli-main unit-file assertions compute their expectation with a
// copy of this quoting logic, so on paths that need escaping they are
// self-referential. These literal-oracle cases pin the escaping rule itself.
describe("systemd unit quoting", () => {
  it("doubles literal % even on a path that needs no quoting", () => {
    expect(quoteSystemdExecPath("/opt/ai%fight/bin/aifight")).toBe("/opt/ai%%fight/bin/aifight");
  });

  it("quotes and escapes a path with spaces, quotes, and backslashes", () => {
    expect(quoteSystemdExecPath('/opt/my dir/ai"f\\ight')).toBe('"/opt/my dir/ai\\"f\\\\ight"');
  });

  it("passes a plain path through untouched", () => {
    expect(quoteSystemdExecPath("/usr/local/bin/aifight")).toBe("/usr/local/bin/aifight");
  });

  it("doubles % and escapes specials in Environment= values", () => {
    expect(quoteSystemdEnvironment("AIFIGHT_HOME", '/h%me/"u\\ser')).toBe(
      'Environment="AIFIGHT_HOME=/h%%me/\\"u\\\\ser"',
    );
  });
});
