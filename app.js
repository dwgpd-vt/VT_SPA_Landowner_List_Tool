(() => {
  const wsidInput = document.getElementById("wsidInput");
  const wsidOptions = document.getElementById("wsidOptions");
  const searchBtn = document.getElementById("searchBtn");
  const statusLine = document.getElementById("statusLine");

  const spaSummary = document.getElementById("spaSummary");
  const spaChips = document.getElementById("spaChips");

  const tableWrap = document.getElementById("tableWrap");
  const parcelsBody = document.getElementById("parcelsBody");
  const parcelCount = document.getElementById("parcelCount");
  const exportButtons = document.querySelectorAll(".export-buttons [data-format]");

  const resultsEmpty = document.getElementById("resultsEmpty");
  const resultsEmptyText = resultsEmpty.querySelector("p");

  const disambigPanel = document.getElementById("disambigPanel");
  const disambigChips = document.getElementById("disambigChips");

  const mapPanelEl = document.querySelector(".map-panel");
  const resultsPanelEl = document.getElementById("resultsPanel");
  const mapFullscreenBtn = document.getElementById("mapFullscreenBtn");
  const resultsFullscreenBtn = document.getElementById("resultsFullscreenBtn");

  // Query + export-building logic lives in core.js
  const { EXPORT_FIELDS } = WsidCore;

  const DEFAULT_EMPTY_MESSAGE =
    "No search yet. Enter a WSID above to view associated parcels";

  const SPA_COLORS = {
    "Ground Water SPA": "#E8BEFF",
    "Surface Water SPA": "#E6E600",
  };
  const WATER_SOURCE_STATUS_COLORS = {
    A: "#00E6A9",
    I: "#E60000",
    P: "#FFFF00",
  };
  const VERMONT_CENTER = [44.05, -72.7];
  const VERMONT_ZOOM = 8;

  function getWaterSourceRadius(status, zoom) {
    const baseRadius = status === "A" ? 5 : 5;
    return Math.max(3.5, baseRadius - Math.max(0, VERMONT_ZOOM - zoom) * 0.75);
  }

  let debounceTimer = null;
  let suggestionRequestId = 0;
  let hasResults = false;
  let currentParcels = [];
  let currentWsid = null; // the resolved WSID of the last successful search
  const PARCEL_MIN_ZOOM = 14;

  // ---- Map ---------------------------------------------------------------

  const map = L.map("map", {
    scrollWheelZoom: true,
    preferCanvas: true,
  }).setView(VERMONT_CENTER, VERMONT_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const spaLayerGroup = L.layerGroup().addTo(map);
  const publicWaterSourcesLayerGroup = L.layerGroup().addTo(map);
  const parcelLayerGroup = L.layerGroup().addTo(map);

  function updateParcelVisibility() {
    if (map.getZoom() >= PARCEL_MIN_ZOOM) {
      parcelLayerGroup.addTo(map);
    } else {
      parcelLayerGroup.remove();
    }
  }

  map.on("zoomend", () => {
    publicWaterSourcesLayerGroup.eachLayer((sourceLayer) => {
      sourceLayer.eachLayer((marker) => {
        marker.setRadius(getWaterSourceRadius(marker.options.waterSourceStatus, map.getZoom()));
      });
    });
    updateParcelVisibility();
  });
  updateParcelVisibility();

  setTimeout(() => map.invalidateSize(), 0);
  window.addEventListener("resize", () => map.invalidateSize());

  function renderSpaMap(spas, waterSources) {
    spaLayerGroup.clearLayers();
    publicWaterSourcesLayerGroup.clearLayers();
    parcelLayerGroup.clearLayers();

    const spaBounds = L.latLngBounds([]);
    let hasMapFeatures = false;

    if (spas && spas.length > 0) {
      spas.forEach((s) => {
        if (!s.geometry) return;
        const color = SPA_COLORS[s.layer] || "#14606b";
        const name = s.SystemName || s.FacilityName || "SPA";
        const status = s.FacilityStatus || s.ActivityStatus || "";

        const layer = L.geoJSON(s.geometry, {
          style: { color, weight: 2, fillColor: color, fillOpacity: 0.25 },
        }).bindPopup(
          `<strong>${escapeHtml(name)}</strong><br>${escapeHtml(s.layer)}${
            status ? " &middot; " + escapeHtml(status) : ""
          }`
        );
        layer.addTo(spaLayerGroup);
        spaBounds.extend(layer.getBounds());
        hasMapFeatures = true;
      });
    }

    if (waterSources && waterSources.length > 0) {
      waterSources.forEach((source) => {
        if (!source.geometry) return;
        const name = source.SystemName || source.FacilityName || "Public Water Source";
        const status = source.FacilityStatus || source.SystemStatus || "";
        const facilityStatus = String(source.FacilityStatus || "").trim().toUpperCase();
        const sourceColor = WATER_SOURCE_STATUS_COLORS[facilityStatus] || "#e76f51";
        const layer = L.geoJSON(source.geometry, {
          pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
            radius: getWaterSourceRadius(facilityStatus, map.getZoom()),
            color: "#000000",
            weight: 1,
            fillColor: sourceColor,
            fillOpacity: facilityStatus === "I" ? 0.6 : 0.95,
            waterSourceStatus: facilityStatus,
          }),
        }).bindPopup(
          `<strong>${escapeHtml(name)}</strong><br>Public Water Sources${
            status ? " &middot; " + escapeHtml(status) : ""
          }`
        );
        layer.addTo(publicWaterSourcesLayerGroup);
        hasMapFeatures = true;
      });
    }

    if (currentParcels.length > 0 && currentParcels.some((parcelData) => parcelData.geometry)) {
      currentParcels.forEach((parcelData) => {
        if (!parcelData.geometry) return;
        const parcelLayer = L.geoJSON(parcelData.geometry, {
          style: {
            color: "#000000",
            weight: 1,
            fill: false,
          },
        });
        const span = String(parcelData.SPAN || "").trim();
        if (span) {
          parcelLayer.bindPopup(`<strong>SPAN:</strong> ${escapeHtml(span)}`);
        }
        parcelLayer.addTo(parcelLayerGroup);
        hasMapFeatures = true;
      });
    }

    updateParcelVisibility();

    if (!hasMapFeatures || !spaBounds.isValid()) {
      map.setView(VERMONT_CENTER, VERMONT_ZOOM);
      return;
    }
    map.fitBounds(spaBounds, { padding: [24, 24], maxZoom: 20 });
  }
  let fullscreenPanel = null; // the currently maximized panel element, or null

  function setFullscreen(panelEl, buttonEl, on) {
    panelEl.classList.toggle("is-fullscreen", on);
    buttonEl.textContent = on ? "⤡" : "⤢";
    buttonEl.title = on ? "Exit full screen" : "Full screen";
    buttonEl.setAttribute("aria-pressed", String(on));
  }

  function toggleFullscreen(panelEl, buttonEl) {
    const turningOn = panelEl !== fullscreenPanel;

    if (fullscreenPanel) {
      const prevButton = fullscreenPanel === mapPanelEl ? mapFullscreenBtn : resultsFullscreenBtn;
      setFullscreen(fullscreenPanel, prevButton, false);
      fullscreenPanel = null;
    }

    if (turningOn) {
      setFullscreen(panelEl, buttonEl, true);
      fullscreenPanel = panelEl;
    }

    document.body.classList.toggle("has-fullscreen-panel", Boolean(fullscreenPanel));
    setTimeout(() => map.invalidateSize(), 50); // Leaflet needs to re-measure its container
  }

  mapFullscreenBtn.addEventListener("click", () => toggleFullscreen(mapPanelEl, mapFullscreenBtn));
  resultsFullscreenBtn.addEventListener("click", () => toggleFullscreen(resultsPanelEl, resultsFullscreenBtn));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && fullscreenPanel) {
      toggleFullscreen(fullscreenPanel, fullscreenPanel === mapPanelEl ? mapFullscreenBtn : resultsFullscreenBtn);
    }
  });
  // ---- WSID autocomplete -------------------------------------------------

  wsidInput.addEventListener("input", () => {
    const q = wsidInput.value.trim();
    const requestId = ++suggestionRequestId;
    clearTimeout(debounceTimer);
    if (q.length < 2) {
      wsidOptions.innerHTML = "";
      return;
    }
    debounceTimer = setTimeout(() => fetchSuggestions(q, requestId), 250);
  });

  async function fetchSuggestions(q, requestId) {
    try {
      const list = await WsidCore.suggestWsids(q);
      if (requestId !== suggestionRequestId || wsidInput.value.trim() !== q) return;
      wsidOptions.innerHTML = list
        .map((wsid) => `<option value="${escapeHtml(wsid)}"></option>`)
        .join("");
    } catch (err) {
      console.error(err);
    }
  }

  // ---- Search -------------------------------------------------------------

  wsidInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  searchBtn.addEventListener("click", () => runSearch());

  async function runSearch(overrideValue) {
    const wsid = (overrideValue ?? wsidInput.value).trim();
    if (!wsid) {
      setStatus("Enter or select a WSID first.", true);
      return;
    }

    hideDisambig();
    setBusy(true);
    setStatus(`Searching SPAs and parcels for "${wsid}"...`);
    setExportEnabled(false);

    currentWsid = null;

    try {
      const data = await WsidCore.searchWsid(wsid);

      if (data.ambiguous) {
        currentParcels = [];
        showDisambig(data.query, data.candidates);
        renderSpas([]);
        renderSpaMap([], []);
        renderParcels([], `"${data.query}" matches more than one WSID — pick one above.`);
        return;
      }

      wsidInput.value = data.wsid; // reflect the resolved full WSID
      currentWsid = data.wsid;
      currentParcels = data.parcels || [];
      renderSpas(data.spaSummary);
      renderSpaMap(data.spas, data.waterSources);

      if (data.spas.length === 0) {
        setStatus(`No Ground Water or Surface Water SPA found for WSID ${data.wsid}.`, true);
        renderParcels([], `No Ground Water or Surface Water SPA found for WSID ${data.wsid}.`);
      } else if (data.parcels.length === 0) {
        setStatus(`Found ${data.spas.length} SPA(s) for ${data.wsid}, but no intersecting parcels.`);
        renderParcels([], "The matched SPA(s) don't intersect any parcels.");
      } else {
        setStatus(`Found ${data.parcels.length} parcel(s) across ${data.spas.length} SPA(s) for WSID ${data.wsid}.`);
        renderParcels(data.parcels);
        setExportEnabled(true);
      }
      if (data.serviceWarnings && data.serviceWarnings.length > 0) {
        setStatus(`${statusLine.textContent} ${data.serviceWarnings.join(" ")}`);
      }
    } catch (err) {
      console.error(err);
      const rawMessage = err.message || "Something went wrong.";
      const isOversizedParcelQuery = /parcels service.*(400|504|query failed|Unable to perform query)/i.test(rawMessage);
      const message = isOversizedParcelQuery
        ? "This SPA's geometry exceeds the app's processing limits. Try a smaller SPA or contact the app administrator."
        : rawMessage;
      setStatus(message, true);
      spaSummary.hidden = true;
      currentParcels = [];
      renderSpaMap([], []);
      renderParcels([], message);
    } finally {
      setBusy(false);
    }
  }

  function showDisambig(query, candidates) {
    setStatus(`"${query}" matches more than one WSID — pick one below.`);
    disambigPanel.hidden = false;
    disambigChips.innerHTML = candidates
      .map((c) => `<button type="button" class="disambig-chip" data-wsid="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
      .join("");
    disambigChips.querySelectorAll("[data-wsid]").forEach((btn) => {
      btn.addEventListener("click", () => {
        wsidInput.value = btn.dataset.wsid;
        runSearch(btn.dataset.wsid);
      });
    });
  }

  function hideDisambig() {
    disambigPanel.hidden = true;
    disambigChips.innerHTML = "";
  }

  function renderSpas(facilities) {
    if (!facilities || facilities.length === 0) {
      spaSummary.hidden = true;
      return;
    }
    spaSummary.hidden = false;
    spaChips.innerHTML = facilities
      .map((s) => {
        const isGw = s.layer === "Ground Water SPA";
        const name = s.SystemName || s.FacilityName || "(unnamed)";
        return `
          <div class="spa-chip ${isGw ? "gw" : "sw"}">
            <span class="dot"></span>
            <span class="name">${escapeHtml(name)}</span>
            <span class="meta">${s.Facility_ID ? `&middot; ${escapeHtml(s.Facility_ID)} ` : ""}&middot; ${escapeHtml(s.layer)}</span>
          </div>`;
      })
      .join("");
  }
  function renderParcels(parcels, emptyMessage) {
    hasResults = Boolean(parcels && parcels.length > 0);
    parcelCount.textContent = parcels ? parcels.length : 0;

    if (!hasResults) {
      tableWrap.hidden = true;
      resultsEmpty.hidden = false;
      resultsEmptyText.textContent = emptyMessage || DEFAULT_EMPTY_MESSAGE;
      parcelsBody.innerHTML = "";
      return;
    }

    resultsEmpty.hidden = true;
    tableWrap.hidden = false;
    parcelsBody.innerHTML = parcels
      .map((p) => `<tr>${[
        `<td>${escapeHtml(p.SPAN)}</td>`,
        `<td>${escapeHtml(p.PARCID)}</td>`,
        `<td>${escapeHtml(p.E911ADDR)}</td>`,
        `<td>${escapeHtml(p.TNAME)}</td>`,
        `<td>${escapeHtml(p.OWNER1)}</td>`,
        `<td>${formatMailingAddress(p)}</td>`,
        `<td>${escapeHtml(p.PROPTYPE)}</td>`,
        `<td>${escapeHtml(p.DESCPROP)}</td>`,
      ].join("")}</tr>`)
      .join("");
  }

  function formatMailingAddress(parcel) {
    return [parcel.ADDRGL1, parcel.ADDRGL2, parcel.CITYGL, parcel.STGL, parcel.ZIPGL]
      .filter((part) => String(part ?? "").trim())
      .map((part) => escapeHtml(part))
      .join("<br>");
  }

  // ---- Export ---------------------------------------------------------------

  // Files are built in the browser from the current search result. ExcelJS is only fetched the first time XLSX is used.
  const VENDOR_SCRIPTS = {
    xlsx: "vendor/exceljs.min.js",
  };
  const scriptPromises = {};

  function loadScript(src) {
    if (!scriptPromises[src]) {
      scriptPromises[src] = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.onload = resolve;
        el.onerror = () => {
          delete scriptPromises[src]; // allow a retry
          reject(new Error(`Could not load ${src}.`));
        };
        document.head.appendChild(el);
      });
    }
    return scriptPromises[src];
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function buildExport(format) {
    const base = WsidCore.exportFilenameBase(currentWsid);
    const rows = currentParcels.map(WsidCore.toRow);

    if (format === "csv") {
      return {
        filename: `${base}.csv`,
        blob: new Blob([WsidCore.toCsv(rows)], { type: "text/csv;charset=utf-8" }),
      };
    }

    if (format === "xlsx") {
      await loadScript(VENDOR_SCRIPTS.xlsx);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Parcels");
      sheet.columns = EXPORT_FIELDS.map((f) => ({ header: f, key: f, width: 22 }));
      sheet.addRows(rows);
      sheet.getRow(1).font = { bold: true };
      const buffer = await workbook.xlsx.writeBuffer();
      return {
        filename: `${base}.xlsx`,
        blob: new Blob([buffer], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      };
    }

    throw new Error(`Unknown export format "${format}".`);
  }

  async function runExport(format) {
    if (!hasResults || !currentWsid) return;

    setExportEnabled(false);
    setStatus(`Preparing ${format.toUpperCase()} file...`);

    try {
      const { filename, blob, skipped } = await buildExport(format);
      downloadBlob(blob, filename);
      setStatus(
        skipped
          ? `Downloaded ${filename} (${skipped} parcel(s) without geometry were left out).`
          : `Downloaded ${filename}.`
      );
    } catch (err) {
      console.error(err);
      setStatus(`Export failed: ${err.message || "unknown error"} Try again.`, true);
    } finally {
      setExportEnabled(hasResults);
    }
  }

  exportButtons.forEach((btn) => {
    btn.addEventListener("click", () => runExport(btn.dataset.format));
  });

  function setExportEnabled(enabled) {
    exportButtons.forEach((btn) => { btn.disabled = !enabled; });
  }

  // ---- Small helpers ----------------------------------------------------

  function setBusy(busy) {
    searchBtn.disabled = busy;
    wsidInput.disabled = busy;
  }

  function setStatus(message, isError = false) {
    const contactText = "contact the app administrator";
    const contactIndex = message.indexOf(contactText);
    statusLine.replaceChildren();
    if (contactIndex === -1) {
      statusLine.textContent = message;
    } else {
      statusLine.append(document.createTextNode(message.slice(0, contactIndex)));
      const contactLink = document.createElement("a");
      contactLink.href = "mailto:ANR.DWGPDSourceProtection@vermont.gov";
      contactLink.textContent = contactText;
      statusLine.append(contactLink);
      statusLine.append(document.createTextNode(message.slice(contactIndex + contactText.length)));
    }
    statusLine.classList.toggle("is-error", Boolean(isError));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  // Initial state: table hidden, default message showing, exports disabled.
  renderParcels([]);
  setExportEnabled(false);

  // Custom url/search parameter to pre-fill the WSID input and run a search on page load.
  const initialWsid = (new URLSearchParams(window.location.search).get("wsid") || "").trim();
  if (initialWsid) {
    wsidInput.value = initialWsid;
    runSearch();
  }
})();
