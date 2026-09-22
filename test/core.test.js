// Dependency-free tests for core.js.  Run with:  node --test test/core.test.js
// Uses a mock ArcGIS backend (test/mock-arcgis.js) so no network is needed.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const mock = require("./mock-arcgis");

globalThis.Terraformer = require(path.join(__dirname, "../vendor/t-arcgis.umd.js"));
globalThis.fetch = async (url, opts = {}) => {
  let base = url;
  let params;
  if (opts.method === "POST") {
    params = Object.fromEntries(opts.body);
  } else {
    const [b, qs] = url.split("?");
    base = b;
    params = Object.fromEntries(qs.split("&").map((kv) => kv.split("=").map(decodeURIComponent)));
  }
  const body = mock.handle(base, params);
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
};
const core = require("../core.js");

test("autocomplete: distinct, sorted, prefix OR suffix; ignores 1-char input", async () => {
  assert.deepStrictEqual(await core.suggestWsids("VT0005"), ["VT0005001", "VT0005002"]);
  assert.deepStrictEqual(await core.suggestWsids("5001"), ["VT0005001"]); // suffix match
  assert.deepStrictEqual(await core.suggestWsids("V"), []);
});

test("search: exact match wins, ambiguous input asks the user, unknown throws", async () => {
  assert.strictEqual((await core.searchWsid("vt0005001")).wsid, "VT0005001");
  const amb = await core.searchWsid("1234");
  assert.strictEqual(amb.ambiguous, true);
  assert.deepStrictEqual(amb.candidates, ["VT0011234", "VT0021234"]);
  await assert.rejects(core.searchWsid("nope"), core.WsidNotFoundError);
});

test("search: multi-zone SPA gives 2 polygons but 1 summary row; shared parcels de-duplicated", async () => {
  const r = await core.searchWsid("VT0005001");
  assert.strictEqual(r.spas.length, 2);
  assert.strictEqual(r.spaSummary.length, 1);
  assert.deepStrictEqual(r.parcels.map((p) => p.OBJECTID), [1, 2, 3, 4]);
});

test("search: follows exceededTransferLimit pagination", async () => {
  assert.strictEqual((await core.searchWsid("VT0005002")).parcels.length, 5);
});

test("search: WSID with no SPA returns no parcels", async () => {
  const r = await core.searchWsid("VT0009999");
  assert.strictEqual(r.spas.length, 0);
  assert.strictEqual(r.count, 0);
});

test("service errors surface as ServiceError with a readable message", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(core.searchWsid("VT0005001"), (e) => e instanceof core.ServiceError && /Could not reach/.test(e.message));
  globalThis.fetch = real;
});

test("invalid wildcard input is rejected before querying services", async () => {
  await assert.rejects(core.searchWsid("%"), core.WsidNotFoundError);
  assert.deepStrictEqual(await core.suggestWsids("%"), []);
});

test("search continues when one optional service is unavailable", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("MapServer/4/query")) {
      throw new TypeError("water source service unavailable");
    }
    return real(url, opts);
  };
  const result = await core.searchWsid("VT0005001");
  assert.strictEqual(result.parcels.length, 4);
  assert.deepStrictEqual(result.waterSources, []);
  assert.deepStrictEqual(result.serviceWarnings, ["Public water source locations were unavailable."]);
  globalThis.fetch = real;
});

test("oversized SPA geometry gets a readable processing-limit error", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("FeatureServer/0/query")) {
      const params = Object.fromEntries(opts.body);
      if (params.returnIdsOnly === "true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ error: { code: 400, message: "Unable to perform query" } }),
        };
      }
    }
    return real(url, opts);
  };
  await assert.rejects(
    core.searchWsid("VT0005001"),
    (error) => /SPA's geometry exceeds the app's processing limits/.test(error.message)
  );
  globalThis.fetch = real;
});

test("SPA complexity limit detects very large polygon rings", () => {
  const small = { rings: [Array.from({ length: 10 }, () => [0, 0])] };
  const large = { rings: [Array.from({ length: 50001 }, () => [0, 0])] };
  assert.strictEqual(core._internals.isSpaGeometryTooComplex(small), false);
  assert.strictEqual(core._internals.isSpaGeometryTooComplex(large), true);
});

test("CSV quoting: commas, quotes and null values", async () => {
  const r = await core.searchWsid("VT0005001");
  const lines = core.toCsv(r.parcels.map(core.toRow)).split("\n");
  assert.strictEqual(lines.length, 5);
  assert.ok(lines[2].includes('"Smith, John & ""Jane"" O\'Brien"'));
  assert.ok(lines[4].endsWith(",VT,,,HOUSE & LAND")); // null ZIPGL / PROPTYPE -> empty
});

test("export filename is filesystem-safe", () => {
  assert.strictEqual(core.exportFilenameBase("VT 000/5001"), "WSID_VT_000_5001_parcels");
});
