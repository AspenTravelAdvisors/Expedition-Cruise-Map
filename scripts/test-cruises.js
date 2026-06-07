// scripts/test-cruises.js — Expedition Cruise Atlas tests
// No framework. Run: node scripts/test-cruises.js
// Cross-checks the in-memory query layer against the raw data, then exercises
// the actual serverless handlers with mock req/res.

const assert = require("node:assert/strict");
const { cruises, filterCruises, clampLimit, query, buildDeepLink, regions, MARQUEE, ATLAS_URL } =
  require("../lib/cruises");
const cruisesApi = require("../api/expedition-cruises");
const regionsApi = require("../api/regions");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok  " + name); }
const ci = (s) => String(s == null ? "" : s).toLowerCase();

// --- dataset sanity --------------------------------------------------------
test("dataset loaded (unique ids, every record has a bookable URL)", () => {
  assert.ok(cruises.length > 1000);
  assert.equal(new Set(cruises.map((c) => c.id)).size, cruises.length);
  assert.ok(cruises.every((c) => c.name && c.bookUrl));
});

// --- filtering -------------------------------------------------------------
test("region filter only accepts marquee keys and matches them", () => {
  const r = filterCruises({ region: "antarctica" });
  assert.ok(r.length > 0);
  assert.ok(r.every((c) => c.region === "antarctica"));
  // a non-marquee value is ignored (no spurious empties)
  assert.equal(filterCruises({ region: "alaska" }).length, cruises.length);
});

test("q drops genre stopwords: 'alaska expedition cruises' matches Alaska", () => {
  const r = filterCruises({ q: "alaska expedition cruises" });
  assert.ok(r.length > 0);
  assert.ok(r.every((c) => ci(c.regionLabel).includes("alaska") || ci(c.name).includes("alaska")));
});

test("keyword override: Kimberley sailings resolve to the kimberley marquee", () => {
  const r = filterCruises({ q: "kimberley" });
  assert.ok(r.length > 0);
  assert.ok(r.some((c) => c.region === "kimberley"));
});

test("month filter (YYYY-MM) narrows by start month", () => {
  const any = cruises.find((c) => c.month);
  const r = filterCruises({ month: any.month });
  assert.ok(r.length > 0);
  assert.ok(r.every((c) => c.month === any.month));
});

// --- pagination + deeplink -------------------------------------------------
test("query paginates with honest total and default limit 6", () => {
  const r = query({ region: "antarctica" });
  assert.ok(r.total >= r.count);
  assert.equal(r.count, Math.min(6, r.total));
  assert.equal(r.count, r.results.length);
  assert.ok(r.deepLink.includes("region=antarctica"));
});
test("clampLimit default 6, capped at 24", () => {
  assert.equal(clampLimit(undefined), 6);
  assert.equal(clampLimit(100), 24);
  assert.equal(clampLimit(3), 3);
});

// --- regions aggregate -----------------------------------------------------
test("regions returns marquee aggregates with centroids", () => {
  const r = regions();
  assert.ok(r.count > 0 && r.total > 0);
  assert.ok(r.regions.every((g) => MARQUEE.has(g.region) && Array.isArray(g.center)));
});

// --- handlers --------------------------------------------------------------
function mockRes() {
  return { _s: 200, _j: null, _h: {}, setHeader(k, v) { this._h[k] = v; },
    status(c) { this._s = c; return this; }, json(o) { this._j = o; return this; } };
}
test("GET /api/expedition-cruises handler returns query payload", () => {
  const res = mockRes();
  cruisesApi({ method: "GET", query: { region: "antarctica", limit: "3" } }, res);
  assert.equal(res._s, 200);
  assert.equal(res._j.count, 3);
  assert.ok(res._j.results[0].name && res._j.results[0].bookUrl);
});
test("GET /api/regions handler returns aggregate", () => {
  const res = mockRes();
  regionsApi({ method: "GET", query: {} }, res);
  assert.equal(res._s, 200);
  assert.ok(res._j.regions.length > 0);
});

console.log(`\n${passed} tests passed`);
