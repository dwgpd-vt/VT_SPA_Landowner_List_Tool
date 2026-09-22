// Test fixture: an in-memory imitation of the three ArcGIS REST services (used by core.test.js).
// Minimal in-memory imitation of the three ArcGIS REST services the app uses.
// handle(url, params) -> JSON body, exactly as ArcGIS would return it (HTTP 200).
const SR = { wkid: 4326, latestWkid: 4326 };
const PAGE_CAP = 2; // tiny maxRecordCount so pagination is exercised

const GW = "MapServer/7/query";
const SW = "MapServer/13/query";
const WS = "MapServer/4/query";
const PARCELS = "FeatureServer/0/query";

// clockwise square = ArcGIS "outer ring"; counter-clockwise = hole
const cw = (x, y, s) => [[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]];
const ccw = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

const spa = (WSID, Facility_ID, SystemName, zone, ring) => ({
  attributes: {
    WSID, SystemName, FacilityName: `${SystemName} Well ${Facility_ID}`, Facility_ID,
    FacilityStatus: "A", ActivityStatus: "Active", SystemType: "CWS", WaterType: "GW", ZONE_ID: zone,
  },
  geometry: { rings: [ring] },
});

// Each SPA polygon is identified by its first vertex so the parcels endpoint
// can tell which one it was asked about.
const Z1 = cw(-72.60, 44.20, 0.02);
const Z2 = cw(-72.56, 44.20, 0.02);
const SW1 = cw(-72.40, 44.10, 0.02);
const GW_1234 = cw(-72.30, 44.00, 0.02);
const SW_1234 = cw(-72.20, 44.00, 0.02);
const GW_7777 = cw(-72.10, 44.00, 0.02);

const LAYERS = {
  [GW]: [
    spa("VT0005001", "WL001", "Alpha Water Co", 1, Z1),
    spa("VT0005001", "WL001", "Alpha Water Co", 2, Z2), // same Facility_ID -> one chip
    spa("VT0011234", "WL010", "Beta Village", 1, GW_1234),
    spa("VT0007777", "WL070", "Gamma Estates", 1, GW_7777), // SPA but no parcels
  ],
  [SW]: [
    spa("VT0005002", "SR001", "Delta Reservoir Co", 1, SW1),
    spa("VT0021234", "SR020", "Epsilon Town", 1, SW_1234),
  ],
};

const src = (WSID, name, status, x, y) => ({
  attributes: {
    WSID, SystemName: name, SystemType: "CWS", SystemStatus: "A", FacilityName: `${name} src`,
    FacilityID: `${WSID}-${x}`, FacilityStatus: status, WaterType: "GW", Availability: "P", WellType: "DW", WellDepth: 200,
  },
  geometry: { x, y },
});
const WATER_SOURCES = [
  src("VT0005001", "Alpha Water Co", "A", -72.59, 44.21),
  src("VT0005001", "Alpha Water Co", "I", -72.55, 44.21),
  src("VT0005002", "Delta Reservoir Co", "A", -72.39, 44.11),
  src("VT0009999", "Zeta Only-Source Co", "A", -72.0, 44.5), // no SPA at all
  src("VT0011234", "Beta Village", "A", -72.29, 44.01),
  src("VT0021234", "Epsilon Town", "P", -72.19, 44.01),
];

const parcel = (OBJECTID, SPAN, extra = {}, geometry) => ({
  attributes: {
    OBJECTID, SPAN, PARCID: `P-${OBJECTID}`, E911ADDR: `${OBJECTID} Main St`, TNAME: "MONTPELIER",
    OWNER1: `Owner ${OBJECTID}`, ADDRGL1: `${OBJECTID} Elm Rd`, ADDRGL2: null, CITYGL: "MONTPELIER",
    STGL: "VT", ZIPGL: "05602", PROPTYPE: "Residential", DESCPROP: "HOUSE & LAND", ...extra,
  },
  geometry,
});
const sq = (x, y) => ({ rings: [cw(x, y, 0.001)] });

const P = {
  1: parcel(1, "001-001-00001", {}, sq(-72.599, 44.201)),
  // owner name with commas, quotes, apostrophe, accents, ampersand -> CSV/XLSX/HTML escaping
  2: parcel(2, "001-001-00002", { OWNER1: 'Smith, John & "Jane" O\'Brien', ADDRGL2: "c/o José Núñez" },
    { rings: [cw(-72.598, 44.205, 0.004), ccw(-72.597, 44.206, 0.001)] }), // outer ring + hole
  3: parcel(3, "001-001-00003", { OWNER1: "Multi-Part Trust" },
    { rings: [cw(-72.590, 44.201, 0.001), cw(-72.588, 44.201, 0.001)] }),   // two outer rings -> MultiPolygon
  4: parcel(4, "001-001-00004", { ZIPGL: null, PROPTYPE: null }, sq(-72.559, 44.201)),
  5: parcel(5, "002-001-00005", {}, sq(-72.399, 44.101)),
  6: parcel(6, "002-001-00006", {}, sq(-72.397, 44.101)),
  7: parcel(7, "002-001-00007", {}, null),                                   // no geometry at all
  8: parcel(8, "002-001-00008", {}, sq(-72.393, 44.101)),
  9: parcel(9, "002-001-00009", {}, sq(-72.391, 44.101)),
  10: parcel(10, "003-001-00010", {}, sq(-72.299, 44.001)),
  11: parcel(11, "004-001-00011", {}, sq(-72.199, 44.001)),
};
const key = (ring) => JSON.stringify(ring[0]);
const PARCELS_BY_SPA = {
  [key(Z1)]: [1, 2, 3],
  [key(Z2)]: [3, 4],            // parcel 3 also touches zone 2 -> must be de-duplicated
  [key(SW1)]: [5, 6, 7, 8, 9],  // 5 parcels, page cap 2 -> 3 pages
  [key(GW_1234)]: [10],
  [key(SW_1234)]: [11],
  [key(GW_7777)]: [],
};

const unquote = (s) => s.replace(/''/g, "'");

function handle(url, p) {
  const which = [GW, SW, WS, PARCELS].find((k) => url.includes(k));
  if (!which) throw new Error(`mock: unexpected URL ${url}`);

  if (which === PARCELS) {
    if (p.objectIds) {
      const ids = new Set(String(p.objectIds).split(",").map(Number));
      return {
        spatialReference: SR,
        features: [...ids].filter((id) => P[id]).map((id) => P[id]),
      };
    }
    if (p.returnIdsOnly === "true") {
      const poly = JSON.parse(p.geometry);
      const ids = PARCELS_BY_SPA[key(poly.rings[0])];
      if (!ids) throw new Error("mock: unknown SPA polygon sent to parcels layer");
      return { objectIds: ids };
    }
    const poly = JSON.parse(p.geometry);
    const ids = PARCELS_BY_SPA[key(poly.rings[0])];
    if (!ids) throw new Error("mock: unknown SPA polygon sent to parcels layer");
    const offset = Number(p.resultOffset || 0);
    const page = ids.slice(offset, offset + PAGE_CAP);
    const out = { spatialReference: SR, features: page.map((id) => P[id]) };
    if (offset + PAGE_CAP < ids.length) out.exceededTransferLimit = true;
    return out;
  }

  const rows = which === WS ? WATER_SOURCES : LAYERS[which];
  const where = String(p.where);
  let feats;
  let m;
  if ((m = where.match(/^\(UPPER\(WSID\) LIKE UPPER\('(.*)%'\) OR UPPER\(WSID\) LIKE UPPER\('%(.*)'\)\)$/s))) {
    const v = unquote(m[1]).toUpperCase();
    const hit = rows.filter((r) => r.attributes.WSID.toUpperCase().startsWith(v) || r.attributes.WSID.toUpperCase().endsWith(v));
    const distinct = [...new Set(hit.map((r) => r.attributes.WSID))].sort();
    feats = distinct.slice(0, Number(p.resultRecordCount || 1000)).map((w) => ({ attributes: { WSID: w } }));
    return { features: feats };
  }
  if ((m = where.match(/^UPPER\(WSID\) = UPPER\('(.*)'\)$/s))) {
    const v = unquote(m[1]).toUpperCase();
    feats = rows.filter((r) => r.attributes.WSID.toUpperCase() === v);
    return { spatialReference: SR, features: feats };
  }
  return { error: { code: 400, message: `mock: unsupported where: ${where}` } };
}

module.exports = { handle, P, PARCELS_BY_SPA };
