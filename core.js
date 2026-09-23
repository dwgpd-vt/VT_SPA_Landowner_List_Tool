(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root);
  } else {
    root.WsidCore = factory(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Feature Layer Data Sources
  // ---------------------------------------------------------------------------

  const SPA_LAYERS = [
    {
      label: "Ground Water SPA",
      url: "https://anrmaps.vermont.gov/arcgis/rest/services/map_services/MAP_ANR_ANRATLASDWGWP_WM_NOCACHE/MapServer/7/query",
    },
    {
      label: "Surface Water SPA",
      url: "https://anrmaps.vermont.gov/arcgis/rest/services/map_services/MAP_ANR_ANRATLASDWGWP_WM_NOCACHE/MapServer/13/query",
    },
  ];

  const PUBLIC_WATER_SOURCES_URL =
    "https://anrmaps.vermont.gov/arcgis/rest/services/map_services/MAP_ANR_ANRATLASDWGWP_WM_NOCACHE/MapServer/4/query";

  const PARCELS_URL =
    "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer/0/query";

  // Fields to write to CSV/Excel
  const EXPORT_FIELDS = [
    "SPAN",
    "PARCID",
    "E911ADDR",
    "TNAME",
    "OWNER1",
    "ADDRGL1",
    "ADDRGL2",
    "CITYGL",
    "STGL",
    "ZIPGL",
    "PROPTYPE",
    "DESCPROP",
  ];

  const PARCEL_QUERY_FIELDS = ["OBJECTID", ...EXPORT_FIELDS]; //Pull OBJECTID to dedupe parcels that intersect multiple SPA polygons.

  const REQUEST_TIMEOUT_MS = 120000;
  const MAX_PARALLEL_PARCEL_QUERIES = 4;
  const PARCEL_DETAIL_BATCH_SIZE = 500;
  const MAX_SPA_QUERY_VERTICES = 50000;

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  class WsidNotFoundError extends Error {}

  // Raised when the ArcGIS service can't be reached or returns an error.
  class ServiceError extends Error {
    constructor(message, cause) {
      super(message);
      this.cause = cause;
    }
  }

  function toQueryString(params) {
    return Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
  }

  async function requestJson(url, { params, method = "GET", label = "GIS service" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res;
    try {
      if (method === "POST") {
        res = await fetch(url, {
          method: "POST",
          body: new URLSearchParams(params),
          signal: controller.signal,
        });
      } else {
        res = await fetch(`${url}?${toQueryString(params)}`, { signal: controller.signal });
      }
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new ServiceError(
          `${label} took too long to respond. Try again in a moment.`,
          err
        );
      }
  
      throw new ServiceError(
        `Could not reach ${label}. Check your internet connection and try again.`,
        err
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new ServiceError(`${label} returned HTTP ${res.status}. Try again in a moment.`);
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new ServiceError(`${label} returned an unreadable response.`, err);
    }
    // ArcGIS reports query errors as HTTP 200 with an `error` object in the body.
    if (data && data.error) {
      const code = data.error.code ? ` (code ${data.error.code})` : "";
      const details = Array.isArray(data.error.details) && data.error.details.length > 0
        ? ` ${data.error.details.join(" ")}`
        : "";
      throw new ServiceError(
        `${label}: ${data.error.message || "query failed"}${code}.${details}`
      );
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  function toGeoJSON(esriGeometry) {
    const t = root.Terraformer;
    if (!t || typeof t.arcgisToGeoJSON !== "function") {
      throw new Error("Terraformer (vendor/t-arcgis.umd.js) is not loaded.");
    }
    return t.arcgisToGeoJSON(esriGeometry);
  }

  function simplifyRing(ring, tolerance) {
    if (!Array.isArray(ring) || ring.length <= 4) return ring;
    const points = ring;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;

    function mark(start, end) {
      let maxDistance = tolerance;
      let split = -1;
      const [x1, y1] = points[start];
      const [x2, y2] = points[end];
      const dx = x2 - x1;
      const dy = y2 - y1;

      for (let index = start + 1; index < end; index += 1) {
        const [x, y] = points[index];
        const distance = dx === 0 && dy === 0
          ? Math.hypot(x - x1, y - y1)
          : Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / Math.hypot(dy, dx);
        if (distance > maxDistance) {
          maxDistance = distance;
          split = index;
        }
      }

      if (split !== -1) {
        keep[split] = 1;
        mark(start, split);
        mark(split, end);
      }
    }

    mark(0, points.length - 1);
    const simplified = points.filter((_point, index) => keep[index]);
    return simplified.length >= 4 ? simplified : ring;
  }

  function simplifyPolygon(esriPolygon, tolerance) {
    return {
      ...esriPolygon,
      rings: (esriPolygon.rings || []).map((ring) => simplifyRing(ring, tolerance)),
    };
  }

  function isSpaGeometryTooComplex(esriPolygon) {
    const vertexCount = (esriPolygon.rings || [])
      .reduce((total, ring) => total + ring.length, 0);
    return vertexCount > MAX_SPA_QUERY_VERTICES;
  }

  // ---------------------------------------------------------------------------
  // WSID matching
  // ---------------------------------------------------------------------------

  function escapeSqlLiteral(value) {
    return String(value).replace(/'/g, "''");
  }

  function isValidWsidQuery(value) {
    return /^[a-z0-9]+$/i.test(String(value));
  }

  // Full WSID or last 4 digets
  function buildWsidLikeWhere(raw) {
    const v = escapeSqlLiteral(raw);
    return `(UPPER(WSID) LIKE UPPER('${v}%') OR UPPER(WSID) LIKE UPPER('%${v}'))`;
  }

  async function findMatchingWsids(raw, limit = 25) {
    const where = buildWsidLikeWhere(raw);
    const urls = [...SPA_LAYERS.map((layer) => layer.url), PUBLIC_WATER_SOURCES_URL];

    const responses = await Promise.allSettled(
      urls.map((url) =>
        requestJson(url, {
          label: "The WSID service",
          params: {
            where,
            outFields: "WSID",
            returnDistinctValues: true,
            returnGeometry: false,
            orderByFields: "WSID",
            resultRecordCount: limit,
            f: "json",
          },
        })
      )
    );

    const successfulResponses = responses.filter((result) => result.status === "fulfilled");
    if (successfulResponses.length === 0) {
      const failure = responses.find((result) => result.status === "rejected");
      throw failure.reason;
    }

    const wsids = new Set();
    for (const result of successfulResponses) {
      const data = result.value;
      for (const f of data.features || []) {
        const val = f.attributes && f.attributes.WSID;
        if (val) wsids.add(String(val).trim());
      }
    }
    return Array.from(wsids).sort().slice(0, limit);
  }

  // Autocomplete: same lookup, capped at 25.
  async function suggestWsids(query) {
    const q = String(query || "").trim();
    if (q.length < 2 || !isValidWsidQuery(q)) return [];
    return findMatchingWsids(q, 25);
  }

  // Turn user input into single WSID or additional choice
  // Throws WsidNotFoundError if nothing matches.
  async function resolveWsid(raw) {
    if (!isValidWsidQuery(raw)) {
      throw new WsidNotFoundError("WSID can contain letters and numbers only.");
    }
    const candidates = await findMatchingWsids(raw, 50);

    if (candidates.length === 0) {
      throw new WsidNotFoundError(`No WSID found matching "${raw}".`);
    }

    const exact = candidates.find((c) => c.toUpperCase() === raw.toUpperCase());
    if (exact) return { wsid: exact };

    if (candidates.length === 1) return { wsid: candidates[0] };

    return { ambiguous: true, candidates: candidates.slice(0, 15) };
  }

  // ---------------------------------------------------------------------------
  // SPA / PWS / parcel queries
  // ---------------------------------------------------------------------------

  async function queryExactSpa(layer, wsid) {
    const data = await requestJson(layer.url, {
      label: layer.label,
      params: {
        where: `UPPER(WSID) = UPPER('${escapeSqlLiteral(wsid)}')`,
        outFields:
          "WSID,SystemName,FacilityName,Facility_ID,FacilityStatus,ActivityStatus,SystemType,WaterType,ZONE_ID",
        returnGeometry: true,
        // reproject to WGS84 for leaflet
        outSR: 4326,
        f: "json",
      },
    });

    return (data.features || []).map((f) => ({
      layer: layer.label,
      attributes: f.attributes,
      geometry: {
        ...f.geometry,
        spatialReference: f.geometry.spatialReference || data.spatialReference || { wkid: 4326 },
      },
    }));
  }

  async function queryPublicWaterSources(wsid) {
    const data = await requestJson(PUBLIC_WATER_SOURCES_URL, {
      label: "Public Water Sources",
      params: {
        where: `UPPER(WSID) = UPPER('${escapeSqlLiteral(wsid)}')`,
        outFields:
          "WSID,SystemName,SystemType,SystemStatus,FacilityName,FacilityID,FacilityStatus,WaterType,Availability,WellType,WellDepth",
        returnGeometry: true,
        outSR: 4326,
        f: "json",
      },
    });

    return (data.features || []).map((f) => ({
      layer: "Public Water Sources",
      ...f.attributes,
      geometry: toGeoJSON({
        ...f.geometry,
        spatialReference: f.geometry.spatialReference || data.spatialReference || { wkid: 4326 },
      }),
    }));
  }

  async function queryIntersectingParcelObjectIds(esriPolygon) {
    if (isSpaGeometryTooComplex(esriPolygon)) {
      throw new ServiceError(
        "This SPA's geometry exceeds the app's processing limits. Try a smaller SPA or contact the app administrator."
      );
    }
    const spatialReference = esriPolygon.spatialReference || { wkid: 4326 };
    const tolerances = [0, 0.00001, 0.00005, 0.0001];
    let lastError;

    for (const tolerance of tolerances) {
      const queryGeometry = tolerance === 0
        ? esriPolygon
        : simplifyPolygon(esriPolygon, tolerance);
      try {
        const idData = await requestJson(PARCELS_URL, {
          method: "POST",
          label: tolerance === 0
            ? "The parcels service (spatial parcel ID query)"
            : `The parcels service (simplified spatial query, tolerance ${tolerance})`,
          params: {
            f: "json",
            geometry: JSON.stringify({ ...queryGeometry, spatialReference }),
            geometryType: "esriGeometryPolygon",
            spatialRel: "esriSpatialRelIntersects",
            inSR: JSON.stringify(spatialReference),
            returnIdsOnly: "true",
          },
        });
        return idData.objectIds || [];
      } catch (error) {
        lastError = error;
        if (!(error instanceof ServiceError) || !/code 400/.test(error.message)) {
          throw error;
        }
      }
    }

    throw new ServiceError(
      "This SPA's geometry exceeds the app's processing limits. Try a smaller SPA or contact the app administrator.",
      lastError
    );
  }

  async function queryParcelDetails(objectIds) {
    const parcels = [];
    for (let start = 0; start < objectIds.length; start += PARCEL_DETAIL_BATCH_SIZE) {
      const batch = objectIds.slice(start, start + PARCEL_DETAIL_BATCH_SIZE);
      const data = await requestJson(PARCELS_URL, {
        method: "POST",
        label: `The parcels service (parcel detail batch ${Math.floor(start / PARCEL_DETAIL_BATCH_SIZE) + 1})`,
        params: {
          f: "json",
          objectIds: batch.join(","),
          outFields: PARCEL_QUERY_FIELDS.join(","),
          returnGeometry: "true",
          outSR: 4326,
        },
      });
      parcels.push(...(data.features || []));
    }

    return parcels;
  }

  async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }

 //Handle SPA zones and deduplicate by facility. Return one row per facility, not one row per SPA polygon.
  function summarizeSpasByFacility(spaAttrs) {
    const seen = new Map();
    for (const s of spaAttrs) {
      const key = `${s.layer}::${s.Facility_ID || s.FacilityName || s.SystemName || ""}`;
      if (!seen.has(key)) {
        seen.set(key, {
          layer: s.layer,
          Facility_ID: s.Facility_ID || null,
          SystemName: s.SystemName || null,
          FacilityName: s.FacilityName || null,
          FacilityStatus: s.FacilityStatus || null,
          ActivityStatus: s.ActivityStatus || null,
        });
      }
    }
    return Array.from(seen.values());
  }

  // ---------------------------------------------------------------------------
  // Search: WSID -> SPA polygons -> intersecting parcels
  // ---------------------------------------------------------------------------
  async function searchWsid(rawInput) {
    const raw = String(rawInput || "").trim();
    if (!raw) throw new Error("wsid is required");


    let resolved;
    try {
      resolved = await resolveWsid(raw);
    } catch (err) {
      if (err instanceof WsidNotFoundError) throw err;
      throw new ServiceError("Could not reach the WSID service. Try again in a moment.", err);
    }
    if (resolved.ambiguous) {
      return { ambiguous: true, query: raw, candidates: resolved.candidates };
    }
    const wsid = resolved.wsid;

    const [spaResults, waterSourceResult] = await Promise.all([
      Promise.allSettled(SPA_LAYERS.map((layer) => queryExactSpa(layer, wsid))),
      Promise.allSettled([queryPublicWaterSources(wsid)]),
    ]);
    const serviceWarnings = [];
    const successfulSpaResults = spaResults.filter((result) => result.status === "fulfilled");
    if (successfulSpaResults.length === 0) {
      throw spaResults.find((result) => result.status === "rejected").reason;
    }
    for (const [index, result] of spaResults.entries()) {
      if (result.status === "rejected") {
        serviceWarnings.push(`${SPA_LAYERS[index].label} was unavailable.`);
      }
    }
    const waterSources = waterSourceResult[0].status === "fulfilled"
      ? waterSourceResult[0].value
      : [];
    if (waterSourceResult[0].status === "rejected") {
      serviceWarnings.push("Public water source locations were unavailable.");
    }
    const spas = successfulSpaResults.flatMap((result) => result.value);

    if (spas.length === 0) {
      return { wsid, spas: [], spaSummary: [], waterSources, parcels: [], count: 0, serviceWarnings };
    }

    const parcelIdGroups = await mapWithConcurrency(
      spas,
      MAX_PARALLEL_PARCEL_QUERIES,
      (spa) => queryIntersectingParcelObjectIds(spa.geometry)
    );
    const objectIds = [...new Set(parcelIdGroups.flat())];
    const parcelGroups = objectIds.length > 0
      ? [await queryParcelDetails(objectIds)]
      : [];

    // De-dupe parcels that intersect with multiple SPA polygons.
    const byObjectId = new Map();
    for (const group of parcelGroups) {
      for (const feature of group) {
        byObjectId.set(feature.attributes.OBJECTID, feature);
      }
    }
    const parcels = Array.from(byObjectId.values());

    const spasForResponse = spas.map((s) => ({
      layer: s.layer,
      ...s.attributes,
      geometry: toGeoJSON(s.geometry), // for the map — every zone, not deduped
    }));

    return {
      wsid,
      spas: spasForResponse,
      spaSummary: summarizeSpasByFacility(spasForResponse), // one row per facility
      waterSources,
      parcels: parcels.map((f) => ({
        ...f.attributes,
        geometry: safeToGeoJSON(f.geometry),
      })),
      count: parcels.length,
      serviceWarnings,
    };
  }

  function safeToGeoJSON(esriGeometry) {
    if (!esriGeometry) return null;
    try {
      return toGeoJSON(esriGeometry);
    } catch (err) {
      console.warn("[search] geometry conversion failed", err && err.message);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  function exportFilenameBase(wsid) {
    return `WSID_${wsid}_parcels`.replace(/[^a-z0-9_.-]+/gi, "_");
  }

  // A parcel record (as returned by searchWsid) -> just the exported fields.
  function toRow(parcel) {
    const row = {};
    for (const field of EXPORT_FIELDS) {
      row[field] = parcel[field] ?? "";
    }
    return row;
  }

  function toCsv(rows) {
    const escape = (value) => {
      const s = String(value ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [EXPORT_FIELDS.join(",")];
    for (const row of rows) {
      lines.push(EXPORT_FIELDS.map((f) => escape(row[f])).join(","));
    }
    return lines.join("\n");
  }

  return {
    // config
    SPA_LAYERS,
    PUBLIC_WATER_SOURCES_URL,
    PARCELS_URL,
    EXPORT_FIELDS,
    // errors
    WsidNotFoundError,
    ServiceError,
    // queries
    suggestWsids,
    searchWsid,
    // exports
    exportFilenameBase,
    toRow,
    toCsv,
    _internals: {
      buildWsidLikeWhere,
      escapeSqlLiteral,
      summarizeSpasByFacility,
      findMatchingWsids,
      isSpaGeometryTooComplex,
    },
  };
});
