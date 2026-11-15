import assert from "node:assert/strict";
import test from "node:test";
import { webTarget } from "./target.ts";

test("missing public address requires configuration instead of opening a fallback", () => {
  assert.throws(() => webTarget(), /Configure/);
  assert.throws(() => webTarget("  ", null), /Configure/);
});

test("optional override takes precedence over server URL", () => {
  assert.equal(webTarget("https://example.org/", "https://example.net/"), "https://example.org/");
  assert.equal(webTarget("", "https://example.net/"), "https://example.net/");
});

test("invalid overrides cannot redirect to script URLs or credential-bearing URLs", () => {
  for (const target of ["javascript:alert(1)", "file:///tmp/example", "invalid", "https://example.org/"] ) {
    if (target === "https://example.org/") assert.equal(webTarget(target), target);
    else assert.throws(() => webTarget(target));
  }
  const url = new URL("https://example.org/");
  url.username = "user";
  url.password = "fixture";
  assert.throws(() => webTarget(url.href));
});
