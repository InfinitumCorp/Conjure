// Guessing lockout: too many wrong credentials from one address lock it out for a while.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GuessGuard, clientIp } from "../src/guard.js";

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("ten wrong guesses lock the address for fifteen minutes", () => {
  const c = clock();
  const g = new GuessGuard({ now: c.now });
  for (let i = 0; i < 9; i++) assert.equal(g.fail("1.2.3.4"), false);
  assert.equal(g.retryAfter("1.2.3.4"), 0);
  assert.equal(g.fail("1.2.3.4"), true);
  assert.equal(g.retryAfter("1.2.3.4"), 900);
  assert.equal(g.retryAfter("5.6.7.8"), 0, "other addresses are unaffected");
  c.t += 900_000;
  assert.equal(g.retryAfter("1.2.3.4"), 0, "the lock expires");
});

test("failures spread beyond the window don't add up", () => {
  const c = clock();
  const g = new GuessGuard({ now: c.now });
  for (let i = 0; i < 9; i++) g.fail("ip");
  c.t += 16 * 60_000;
  assert.equal(g.fail("ip"), false);
  assert.equal(g.retryAfter("ip"), 0);
});

test("a right credential clears earlier mistakes", () => {
  const g = new GuessGuard({ now: clock().now });
  for (let i = 0; i < 9; i++) g.fail("ip");
  g.succeed("ip");
  assert.equal(g.fail("ip"), false);
});

test("memory stays bounded under a flood of addresses", () => {
  const g = new GuessGuard({ now: clock().now, maxEntries: 100 });
  for (let i = 0; i < 1000; i++) g.fail(`10.0.${i >> 8}.${i & 255}`);
  assert.ok(g.entries.size <= 100);
});

test("client address: proxy's X-Forwarded-For only when the socket is local", () => {
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff ? { "x-forwarded-for": xff } : {} });
  assert.equal(clientIp(req("127.0.0.1", "9.9.9.9")), "9.9.9.9");
  assert.equal(clientIp(req("::1", "1.1.1.1, 9.9.9.9")), "9.9.9.9", "the proxy's own entry is last");
  assert.equal(clientIp(req("203.0.113.5", "9.9.9.9")), "203.0.113.5", "a direct client can't spoof the header");
  assert.equal(clientIp(req("127.0.0.1")), "127.0.0.1");
});
