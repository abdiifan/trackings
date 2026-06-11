// =============================================================================
// PharmaTrack v2 — Pharmaceutical Inventory Management System
// =============================================================================
// Fixes applied vs v8 (script__22_.js baseline):
//  BUG-1  Preview download now exports full filtered dataset (not 500-row slice)
//  BUG-2  Chain/circular reconciliation rules detected and blocked on save
//  BUG-3  pageFilters reset on new file upload so stale plant/MG never persists
//  BUG-4  "Already Expired" KPI now counts only stock-qty > 0 rows (matches table)
//  BUG-5  Target materials blocked from being selected as a new source
//  BUG-6  QC page no longer drops items with QC qty > 0 but zero ETB value
//  BUG-7  rpSetSelected chip close button uses addEventListener, not inline onclick
//  BUG-8  String expiry dates parsed as LOCAL midnight not UTC (timezone fix)
//  BUG-9  CSV tab-character cells now quoted correctly
//  BUG-10 groupBy empty-string bucket renamed to "(Blank)" for chart clarity
//  PERF-1 File size warning before parse (>25 MB)
//  ROBUST localStorage schema validated on load; corrupt entries discarded
//  ROBUST Column header matching is now case-insensitive
//  ROBUST Total Qty removed from QTY_COLS scaling (was scaled then overwritten)
//  ROBUST Conversion factor stored with 9dp rounding to suppress float drift
//
// Specialist review fixes (v2 → v2.1):
//  FIX-R1  aggregateByMaterial: removed duplicate "Value of Stock in Quality
//          Inspection" entry in VAL_COLS that caused double-counting of QC value
//          on QC page and Branch Comparison.
//  FIX-R2  Reconciliation mapping file parser: column indices corrected to match
//          documented format (source, desc, unit, factor, target, desc, unit).
//          Factor now read from index 3; target from index 4; desc from index 5.
//  FIX-R3  Reconciliation cache token strengthened: now includes a lightweight
//          djb2 hash of all material codes so same-size file swaps correctly
//          bust the cache.
//  FIX-R4  renderTransit: removed redundant isNonMedical*/isExcluded* re-filters
//          (rawDf is already fully filtered at parse time). Consistent with all
//          other render* functions.
//  FIX-R5  pageFilters: removed unused "preview" key (filtDf/preview uses its
//          own <select multiple> UI; the pageFilters slot was dead state).
//  FIX-R6  Global search and transit search panels now include CSV + Excel export
//          buttons so users with >200/500 results have an export path.
//  FIX-R7  Branch comparison: replaced native <select multiple> with the standard
//          buildMultiSelect checkbox-dropdown for UX consistency.
//  FIX-R8  loadTransitFile: now also applies isNonMedicalGroup filter when the
//          column is present, consistent with main file parsing.
//  FIX-R9  filters.js: isMedicalCode is now used inside isNonMedicalCode as its
//          positive counterpart (DRY); dead export warning resolved.
//  FIX-R10 Flow page "Material Inventory Flow Lookup" description corrected
//          (was copy-pasted from QC section and incorrectly said "QC stock").
//  FIX-R11 refreshReconcileGroupsList: delete listener now uses { once: true }
//          to prevent double-fire on rapid successive calls.
//  FIX-R12 localStorage: old versioned keys (v1, v2) cleaned up on startup.
//
// Storage-location exclusion & phantom transit hardening (v2.1 → v2.2):
//  FIX-EXCL-SLOC   Materials excluded by storage location (ADG1, ARG1, ASG1 …)
//                   are now also stripped from stockTransitRaw so they cannot
//                   appear anywhere on the site — not even in the transit detail
//                   section.  Cross-filter applied both in loadTransitFile (when
//                   transit file loads after main) and in recomputePhantomTransit
//                   (when main file loads after transit).
//  FIX-PHANTOM-HIDE Phantom transit items (Stock in Transit > 0 but no matching
//                   Purchasing Document AND Supplying Plant in the transit file)
//                   are now hidden from every page except the "Stock in Transit
//                   Detail" section (lower half of the Transit page).  Previously
//                   they appeared with a warning badge in the main transit table,
//                   in Global Search, in Branch Comparison totals, and in the
//                   Inventory Flow transfer / reorder tables.  Now:
//                   • renderTransit main table   — phantom rows excluded
//                   • Global search transit      — phantom rows excluded
//                   • Branch comparison aggMap   — phantom Transit/TransitQty subtracted
//                   • Branch comparison matPlantMap — same subtraction
//                   • Flow transferRows          — phantom rows excluded
//                   • Flow reorderItems          — only non-phantom transit counts
//                   The transit KPI card still shows a count so operators know
//                   unverified items exist; the detail is in the Transit Detail
//                   section where those rows remain visible.
// =============================================================================

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const REQUIRED_COLUMNS = [
  "Material","Material Description","Plant","Plant Name",
  "Storage Location","Description of Storage Location",
  "Special Stock Type","Special Stock Type Description",
  "Unrestricted Stock","Stock in Quality Inspection","Blocked Stock",
  "Batch","Inventory Valuation Type","Material Group Name",
  "Shelf Life Expiration Date","Stock in Transit",
  "Value of Stock in Quality Inspection","Value of Stock in Transit",
  "Value of Unrestricted Stock",
];

const COLORWAY = ["#58a6ff","#3fb950","#d29922","#f85149","#a371f7","#79c0ff","#56d364","#e3b341","#ff7b72","#d2a8ff","#ffa657","#70d9a0"];

// NOTE: Exclusion rules (isNonMedicalCode, isNonMedicalGroup) are loaded from
// filters.js which MUST be included before this script in the HTML.
const PLOTLY_LAYOUT = {
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  font: { family: "IBM Plex Sans", color: "#8b949e", size: 12 },
  xaxis: { gridcolor: "#21262d", zerolinecolor: "#21262d", tickfont: { color: "#8b949e" } },
  yaxis: { gridcolor: "#21262d", zerolinecolor: "#21262d", tickfont: { color: "#8b949e" } },
  legend: { bgcolor: "rgba(0,0,0,0)", font: { color: "#8b949e" } },
  margin: { l: 20, r: 20, t: 40, b: 40 },
  colorway: COLORWAY,
};
const PLOTLY_CONFIG = { displayModeBar: false, responsive: true };

// ── STATE ──────────────────────────────────────────────────────────────────
let rawDf  = [];
let filtDf = [];
let currentPage = "dashboard";

// Stock-in-Transit separate file state
let stockTransitRaw    = [];   // raw rows from the transit xlsx
let stFilterState      = { purDoc: "", supPlant: "" };  // filter state

// Incoming Shelf Life — received goods file state
let incomingRaw        = [];   // raw rows from received goods xlsx
const islFilterState   = { date: "", valType: "", sloc: "", plant: "", flag: "" };

// Page-level filter state — now arrays for multi-select support
// NOTE: "preview" page uses its own <select multiple> UI (filtDf), not pageFilters.
const pageFilters = {
  dashboard: { plants: [], mgs: [], valTypes: [] },
  transit:   { plants: [], mgs: [], valTypes: [] },
  expiry:    { plants: [], mgs: [], valTypes: [] },
  qc:        { plants: [], mgs: [], valTypes: [] },
  branch:    { mgs: [],             valTypes: [] },
  flow:      { plants: [], mgs: [], valTypes: [] },
  incoming:  {},
};

// Returns the base dataset. Reconciliation has been removed; returns rawDf directly.
function getReconciledBase() {
  return rawDf;
}

// FIX BUG-3: reset all page filters when a new file is loaded so stale plant/MG
// values from the previous file can never produce a blank result set.
function resetPageFilters() {
  // BUG-RESET FIX: guard against pages (e.g. "branch") that have no "plants" key
  // BUG-FIX-2: also guard mgs/valTypes keys so "incoming: {}" never gets phantom slots
  Object.keys(pageFilters).forEach(page => {
    if ("plants"   in pageFilters[page]) pageFilters[page].plants   = [];
    if ("mgs"      in pageFilters[page]) pageFilters[page].mgs      = [];
    if ("valTypes" in pageFilters[page]) pageFilters[page].valTypes = [];
  });
}

// ── FORMAT HELPERS ─────────────────────────────────────────────────────────
const fmtETB = v => `ETB ${Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const fmtQty = v => Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

// ── HTML ESCAPE (used by buildTable and reconciliation UI) ──────────────────
function escHtml(str) {
  return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── MATERIAL COLUMN HELPERS ────────────────────────────────────────────────
// SAP sometimes stores the description text in the Material field when no
// numeric/structured code exists. We detect and flag this clearly.

// Returns true if the value looks like free-text description rather than a code.
function looksLikeDescription(val) {
  if (!val) return false;
  const s = String(val).trim();
  if (!s) return false;
  return s.includes(" ") || (s.length > 22 && !/^[\w\-\.\/]+$/.test(s));
}

// Gets the description sibling field from the row, handling both main-data
// rows (Material Description) and transit rows (_st_desc, desc).
function getSiblingDesc(row) {
  if (!row) return "";
  return String(
    row["Material Description"] ?? row["_st_desc"] ?? row["desc"] ?? ""
  ).trim();
}

// Gets the code sibling field — used by desc renderer to detect duplicates.
function getSiblingCode(row) {
  if (!row) return "";
  return String(
    row["Material"] ?? row["_st_material"] ?? row["mat"] ?? ""
  ).trim();
}

// ── renderMatCode(val, row) ────────────────────────────────────────────────
// Renders the "Material Code" cell.
//  • Normal code  → purple monospace
//  • Val looks like a description (has spaces / long) → amber "NAME" badge,
//    styled differently so it's obvious this isn't a structured code
function renderMatCode(val, row) {
  const s = escHtml(String(val ?? "").trim());
  if (!s) return '<span style="color:var(--dim)">—</span>';

  if (looksLikeDescription(val)) {
    // The "code" field actually contains a descriptive name
    return `<span class="mat-name-as-code" title="No structured code — SAP stores the name here">${s}</span>`
         + `<span class="mat-desc-badge" title="Material field contains a name, not a code">NAME</span>`;
  }
  return `<span class="col-mat-code">${s}</span>`;
}

// ── renderMatDesc(val, row) ────────────────────────────────────────────────
// Renders the "Material Description" cell.
//  • If description === code (SAP duplicate) → show italic muted "(same as code)"
//  • Otherwise → normal readable text
function renderMatDesc(val, row) {
  const desc = String(val ?? "").trim();
  const code = getSiblingCode(row);

  if (!desc) return '<span style="color:var(--dim)">—</span>';

  // Description is identical to the code field → don't repeat it
  if (desc === code) {
    return `<span class="mat-desc-same" title="Description is identical to the material code field">— same as code —</span>`;
  }

  return `<span class="col-mat-desc">${escHtml(desc)}</span>`;
}

// ── FIX BUG-8: Timezone-safe expiry date parser ────────────────────────────
// new Date("2024-03-15") is parsed as UTC midnight → in UTC+3 it appears as
// 2024-03-14 after 21:00 local time, causing day-off expiry errors.
// This parser treats yyyy-mm-dd strings as LOCAL midnight to avoid that shift.
function parseExpiryDate(d) {
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  if (!d) return null;
  const s = String(d).trim();
  // yyyy-mm-dd → local date (not UTC)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const dt = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    return isNaN(dt.getTime()) ? null : dt;
  }
  // Fallback for other string formats
  const p = new Date(d);
  return isNaN(p.getTime()) ? null : p;
}

// FIX-EXPIRY-DISPLAY: toISOString() converts local-midnight dates to UTC, producing
// a one-day-earlier date string in UTC+3 (Ethiopia). Use local date parts instead.
function fmtLocalDate(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

// ── LOAD & PROCESS EXCEL ───────────────────────────────────────────────────
function loadFile(file) {
  // FIX PERF-2: warn before parsing very large files
  if (file.size > 25 * 1024 * 1024) {
    if (!confirm(`This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Large files may take a few seconds to parse. Continue?`)) return;
  }

  const statusEl = document.getElementById("fileStatus");
  statusEl.style.display = "block";
  statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;

  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!data.length) { showError("The uploaded file contains no data."); return; }

        const trimmed = data.map(row => {
          const r = {};
          for (const [k, v] of Object.entries(row)) r[k.trim()] = v;
          return r;
        });

        // FIX ROBUST: case-insensitive column header matching
        const colsLower = Object.keys(trimmed[0]).map(c => c.toLowerCase());
        const missing = REQUIRED_COLUMNS.filter(c => !colsLower.includes(c.toLowerCase()));
        if (missing.length) { showError(`Missing columns: ${missing.join(", ")}`); return; }

        let df = trimmed
          .filter(r => { const s = String(r["Special Stock Type"]).trim().toUpperCase(); return s !== "Q" && s !== "W"; })
          .filter(r => !isProjectStockDescription(r["Special Stock Type Description"]))
          .filter(r => !isNonMedicalCode(r["Material"]))
          .filter(r => !isNonMedicalGroup(r["Material Group Name"]))
          .filter(r => !isExcludedStorageLocation(r["Storage Location"]))
          .filter(r => String(r["Inventory Valuation Type"] || "").trim() !== "");

        const numCols = [
          "Unrestricted Stock","Stock in Quality Inspection","Blocked Stock","Stock in Transit",
          "Value of Stock in Quality Inspection","Value of Stock in Transit","Value of Unrestricted Stock",
        ];
        df.forEach(row => {
          numCols.forEach(c => { row[c] = parseFloat(row[c]) || 0; });
          // FIX BUG-8: use timezone-safe parser
          row._expiry = parseExpiryDate(row["Shelf Life Expiration Date"]);
          row["Total Value"] = row["Value of Unrestricted Stock"] + row["Value of Stock in Transit"] + row["Value of Stock in Quality Inspection"];
          row["Total Qty"]   = row["Unrestricted Stock"] + row["Stock in Transit"] + row["Stock in Quality Inspection"];
        });

        df = df.filter(r =>
          r["Unrestricted Stock"] > 0 ||
          r["Stock in Transit"] > 0 ||
          r["Stock in Quality Inspection"] > 0 ||
          r["Blocked Stock"] > 0
        );

        rawDf  = df;
        filtDf = df;

        // ISL-MATCH: re-cross-match received goods against new inventory snapshot
        // (handles the case where incoming file was uploaded before inventory)
        recomputeIslMatch();

        // FIX BUG-3: clear stale page filters from the previous file
        resetPageFilters();
        // FIX-STFILTER: also reset transit-section filter state on new main file load
        // so stale PO/supplying-plant selections from the previous dataset don't persist
        stFilterState = { purDoc: "", supPlant: "" };

        // If transit file was already loaded, stamp phantom flags on the new dataset
        if (stockTransitRaw.length) recomputePhantomTransit();

        showSuccess(file.name, df.length);
        clearError();
        hideLanding();
        document.getElementById("global-search-bar").style.display = "block";
        populateAllFilters();
        // Re-render home KPIs then switch to dashboard
        renderPage("home");
        renderPage(currentPage === "home" ? "dashboard" : currentPage);
      } catch (err) {
        showError(`Could not read Excel file: ${err.message}`);
      }
    }, 30);
  };
  reader.readAsArrayBuffer(file);
}

// ── MULTI-SELECT DROPDOWN BUILDER ─────────────────────────────────────────
// Creates a searchable checkbox dropdown inside .ms-wrap elements.
// wrapId = id of the .ms-wrap container
// items  = array of string values
// onLabel = optional function(selectedArr) → button label string
function buildMultiSelect(wrapId, ddId, items, placeholder) {
  const wrap = document.getElementById(wrapId);
  const dd   = document.getElementById(ddId);
  if (!wrap || !dd) return;

  const btn  = wrap.querySelector(".ms-btn");

  // FIX-LABEL: use a mutable reference so updateLabel always targets the live
  // DOM button even after btn is replaced by freshBtn below.
  let activeBtn = btn;

  // Render options
  function renderItems(filter) {
    const filtered = filter ? items.filter(v => v.toLowerCase().includes(filter.toLowerCase())) : items;
    dd.querySelectorAll(".ms-item").forEach(el => el.remove());
    filtered.forEach(val => {
      const label = document.createElement("label");
      label.className = "ms-item";
      const cb = document.createElement("input");
      cb.type  = "checkbox";
      cb.value = val;
      // Restore checked state
      const page = wrap.dataset.page, key = wrap.dataset.key;
      if (page && key && pageFilters[page] && (pageFilters[page][key] || []).includes(val)) {
        cb.checked = true;
      }
      cb.addEventListener("change", updateLabel);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(val));
      dd.appendChild(label);
    });
  }

  function updateLabel() {
    const checked = [...dd.querySelectorAll("input:checked")].map(c => c.value);
    if (checked.length === 0) {
      activeBtn.innerHTML = `${escHtml(placeholder)} <span class="ms-arrow">▾</span>`;
      activeBtn.classList.remove("ms-active");
    } else {
      const fullLabel = checked.join(", ");
      const display   = fullLabel.length > 32 ? fullLabel.slice(0, 30) + "…" : fullLabel;
      activeBtn.innerHTML = `<span class="ms-selected-names" title="${escHtml(fullLabel)}">${escHtml(display)}</span> <span class="ms-count-badge">${checked.length}</span> <span class="ms-arrow">▾</span>`;
      activeBtn.classList.add("ms-active");
    }
  }

  // Build search box + items
  dd.innerHTML = "";
  const searchInput = document.createElement("input");
  searchInput.className   = "ms-search";
  searchInput.placeholder = "Search…";
  searchInput.type        = "text";
  searchInput.addEventListener("input", e => renderItems(e.target.value));
  dd.appendChild(searchInput);
  renderItems("");

  // Toggle open/close
  // FIX-LISTENER: clone btn to strip any previously registered click listeners from
  // prior buildMultiSelect calls (e.g. when renderBranch rebuilds ms-branch-select).
  const freshBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(freshBtn, btn);
  // FIX-LABEL: update activeBtn to point at the now-live freshBtn so updateLabel
  // writes to the correct element (the old btn is detached from the DOM after replaceChild).
  activeBtn = freshBtn;
  freshBtn.addEventListener("click", e => {
    e.stopPropagation();
    // Close all others first
    document.querySelectorAll(".ms-wrap.open").forEach(w => { if (w !== wrap) w.classList.remove("open"); });
    wrap.classList.toggle("open");
    if (wrap.classList.contains("open")) searchInput.focus();
  });

  // Expose refresh function on the wrap element
  wrap._refreshOptions = function(newItems) {
    // BUG-MULTISELECT FIX: update the items array when newItems is provided
    if (Array.isArray(newItems)) items = newItems;
    renderItems(searchInput.value || "");
    updateLabel();
  };
  wrap._getSelected = function() {
    return [...dd.querySelectorAll("input:checked")].map(c => c.value);
  };
  wrap._clearSelected = function() {
    dd.querySelectorAll("input:checked").forEach(cb => { cb.checked = false; });
    updateLabel();
  };

  updateLabel();
}

// Close dropdowns when clicking outside
document.addEventListener("click", () => {
  document.querySelectorAll(".ms-wrap.open").forEach(w => w.classList.remove("open"));
});

// ── POPULATE FILTER DROPDOWNS ──────────────────────────────────────────────
function populateAllFilters() {
  const plants = [...new Set(rawDf.map(r => r["Plant Name"]))].filter(Boolean).sort();
  const mgs    = [...new Set(rawDf.map(r => r["Material Group Name"]))]
    .filter(Boolean)
    .filter(name => !isNonMedicalGroup(name))
    .sort();

  // Plant multi-selects
  const plantConfigs = [
    { wrapId:"ms-dash-plant",    ddId:"ms-dash-plant-dd",    page:"dashboard", key:"plants" },
    { wrapId:"ms-transit-plant", ddId:"ms-transit-plant-dd", page:"transit",   key:"plants" },
    { wrapId:"ms-expiry-plant",  ddId:"ms-expiry-plant-dd",  page:"expiry",    key:"plants" },
    { wrapId:"ms-qc-plant",      ddId:"ms-qc-plant-dd",      page:"qc",        key:"plants" },
    { wrapId:"ms-flow-plant",    ddId:"ms-flow-plant-dd",    page:"flow",      key:"plants" },
  ];
  plantConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "plants"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, plants, "All Plants");
  });

  // MG multi-selects
  const mgConfigs = [
    { wrapId:"ms-dash-mg",    ddId:"ms-dash-mg-dd",    page:"dashboard", key:"mgs" },
    { wrapId:"ms-transit-mg", ddId:"ms-transit-mg-dd", page:"transit",   key:"mgs" },
    { wrapId:"ms-expiry-mg",  ddId:"ms-expiry-mg-dd",  page:"expiry",    key:"mgs" },
    { wrapId:"ms-qc-mg",      ddId:"ms-qc-mg-dd",      page:"qc",        key:"mgs" },
    { wrapId:"ms-branch-mg",  ddId:"ms-branch-mg-dd",  page:"branch",    key:"mgs" },
    { wrapId:"ms-flow-mg",    ddId:"ms-flow-mg-dd",    page:"flow",      key:"mgs" },
  ];
  mgConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "mgs"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, mgs, "All Material Groups");
  });

  // Valuation Type multi-selects
  const valTypes = [...new Set(rawDf.map(r => getValuationType(r)))]
    .filter(v => v && v !== "(None)")
    .sort();

  const vtConfigs = [
    { wrapId:"ms-dash-vt",    ddId:"ms-dash-vt-dd",    page:"dashboard" },
    { wrapId:"ms-transit-vt", ddId:"ms-transit-vt-dd", page:"transit"   },
    { wrapId:"ms-expiry-vt",  ddId:"ms-expiry-vt-dd",  page:"expiry"    },
    { wrapId:"ms-qc-vt",      ddId:"ms-qc-vt-dd",      page:"qc"        },
    { wrapId:"ms-branch-vt",  ddId:"ms-branch-vt-dd",  page:"branch"    },
    { wrapId:"ms-flow-vt",    ddId:"ms-flow-vt-dd",    page:"flow"      },
  ];
  vtConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "valTypes"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, valTypes, "All Val. Types");
  });

  // Legacy multi-select for Data Preview (kept as-is)
  const plantSelLegacy  = ["filter-plant"];
  const mgSelLegacy     = ["filter-mg"];
  const mgNameSelLegacy = ["filter-mgname"];

  plantSelLegacy.forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = plants.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join("");
  });
  mgSelLegacy.forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = mgs.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join("");
  });
  mgNameSelLegacy.forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = mgs.map(v => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join("");
  });

  // Legacy valuation type select for Preview page
  const vtPreviewSel = document.getElementById("filter-valtype");
  if (vtPreviewSel) {
    const vtPreview = [...new Set(rawDf.map(r => getValuationType(r)))]
      .filter(v => v && v !== "(None)")
      .sort();
    vtPreviewSel.innerHTML = vtPreview.map(v => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join("");
  }
}

// ── APPLY PAGE FILTER ──────────────────────────────────────────────────────
// Uses the memoised reconciled base for performance.
// Also re-enforces base exclusion rules so excluded rows never appear on any page
// even if rawDf somehow contains them (e.g. after reconciliation merges).
function applyPageFilter(page) {
  const f    = pageFilters[page] || {};
  const base = getReconciledBase();
  const plants   = f.plants   || [];
  const mgs      = f.mgs      || [];
  const valTypes = f.valTypes || [];
  return base.filter(r =>
    // Re-apply base exclusion rules (defence-in-depth)
    !isNonMedicalCode(r["Material"]) &&
    !isNonMedicalGroup(r["Material Group Name"]) &&
    !isProjectStockDescription(r["Special Stock Type Description"]) &&
    !isExcludedStorageLocation(r["Storage Location"]) &&
    (function(){ const s = String(r["Special Stock Type"] || "").trim().toUpperCase(); return s !== "Q" && s !== "W"; })() &&
    String(r["Inventory Valuation Type"] || "").trim() !== "" &&
    // Page-level plant / material group / valuation type filters
    (!plants.length   || plants.includes(r["Plant Name"])) &&
    (!mgs.length      || mgs.includes(r["Material Group Name"])) &&
    (!valTypes.length || valTypes.includes(getValuationType(r)))
  );
}

// ── UI HELPERS ─────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById("errorBanner");
  el.textContent = `⚠️ ${msg}`;
  el.style.display = "block";
}
function clearError() { document.getElementById("errorBanner").style.display = "none"; }
function showSuccess(name, n) {
  const el = document.getElementById("fileStatus");
  el.style.display = "block";
  el.innerHTML = `<div class="status-ok">✓ FILE LOADED</div><div class="status-name">${escHtml(name)} (${n.toLocaleString()} records)</div>`;
  document.getElementById("uploadBtnText").textContent = "📂 Change File";
}
function hideLanding() { document.getElementById("landingView").style.display = "none"; }

function kpiCard(label, value, sub, color) {
  return `<div class="kpi-card ${color}"><div class="kpi-label">${escHtml(label)}</div><div class="kpi-value">${escHtml(value)}</div><div class="kpi-sub">${escHtml(sub)}</div></div>`;
}
function setKpis(id, cards) {
  document.getElementById(id).innerHTML = cards.map(([l,v,s,c]) => kpiCard(l,v,s,c)).join("");
}

// ── GROUPBY HELPERS ────────────────────────────────────────────────────────
function groupBy(data, key, aggCols) {
  const map = {};
  data.forEach(row => {
    // FIX BUG-10: label blank keys clearly so charts don't show an invisible bar
    const k = row[key] || "(Blank)";
    if (!map[k]) { map[k] = { [key]: k }; aggCols.forEach(([c]) => { map[k][c] = 0; }); }
    aggCols.forEach(([c,src]) => { map[k][c] += row[src] || 0; });
  });
  return Object.values(map);
}
function sortBy(arr, key, asc=false) { return [...arr].sort((a,b) => asc ? a[key]-b[key] : b[key]-a[key]); }

// ── TABLE BUILDER ──────────────────────────────────────────────────────────
// Columns with raw:true may contain trusted HTML (badges etc.) — all others
// are escaped to prevent XSS from Excel data landing in the DOM.
function buildTable(rows, cols, rowClass, extraClass="") {
  if (!rows.length) return `<div class="alert-info">No data to display.</div>`;
  const thead = `<thead><tr>${cols.map(c => `<th>${escHtml(c.label)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map(row => {
    const cls = rowClass ? rowClass(row) : "";
    return `<tr class="${cls}">${cols.map(c => {
      // Pass both the cell value AND the full row so fmt functions can cross-check sibling fields
      const raw     = c.fmt ? c.fmt(row[c.key], row) : (row[c.key] ?? "");
      const val     = c.raw ? raw : escHtml(String(raw));
      const cellCls = c.cellClass || "";
      return `<td class="${cellCls}">${val}</td>`;
    }).join("")}</tr>`;
  }).join("")}</tbody>`;
  return `<div class="tbl-wrap"><table class="${extraClass}">${thead}${tbody}</table></div>`;
}

// ── EXCEL DOWNLOAD ─────────────────────────────────────────────────────────
function downloadExcel(data, cols, filename) {
  const header = cols.map(c => c.label);
  const rows   = data.map(row => cols.map(c => {
    const v   = row[c.key];
    const raw = c.rawKey ? (row[c.rawKey] ?? v) : v;
    if (c.fmt) return (typeof raw === "number") ? raw : (raw ?? "");
    return raw ?? "";
  }));
  const wsData = [header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, filename);
}

// ── CSV DOWNLOAD ───────────────────────────────────────────────────────────
function downloadCSV(data, cols, filename) {
  const header = cols.map(c => c.label).join(",");
  const rows   = data.map(row => cols.map(c => {
    let v = c.rawKey ? (row[c.rawKey] ?? row[c.key] ?? "") : (row[c.key] ?? "");
    v = String(v ?? "");
    // FIX-CSV-ORDER: quote first (handles commas/tabs/newlines/quotes), THEN
    // apply injection guard — but only on non-quoted values so the ' prefix stays
    // as the literal first character seen by spreadsheet apps.
    const needsQuote = v.includes(",") || v.includes('"') || v.includes("\n") || v.includes("\t");
    if (needsQuote) {
      v = `"${v.replace(/"/g, '""')}"`;
    } else if (/^[=+\-@]/.test(v)) {
      // BUG-FIX-7: removed \r from injection guard regex. A value beginning with
      // \r\n (Windows line ending) would get a spurious ' prefix producing garbage
      // like '\r\nsome text. Carriage returns are already handled by the needsQuote
      // path above via the \n check (they always appear together in Windows line
      // endings). Formula-injection characters =, +, -, @ still guarded.
      v = `'${v}`;
    }
    return v;
  }).join(","));
  const blob = new Blob(["\uFEFF" + header + "\n" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── PLOTLY LAYOUT MERGE ────────────────────────────────────────────────────
function pl(extra={}) {
  return Object.assign({}, PLOTLY_LAYOUT, extra, {
    xaxis:  Object.assign({}, PLOTLY_LAYOUT.xaxis,  extra.xaxis  || {}),
    yaxis:  Object.assign({}, PLOTLY_LAYOUT.yaxis,  extra.yaxis  || {}),
    legend: Object.assign({}, PLOTLY_LAYOUT.legend, extra.legend || {}),
    margin: Object.assign({}, PLOTLY_LAYOUT.margin, extra.margin || {}),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════
function renderDashboard() {
  const df = applyPageFilter("dashboard");

  renderPhantomAlert("dash-phantom-alert", df);

  const totalVal   = df.reduce((s,r) => s + r["Total Value"], 0);
  const transitVal = df.reduce((s,r) => s + r["Value of Stock in Transit"], 0);
  const qcVal      = df.reduce((s,r) => s + r["Value of Stock in Quality Inspection"], 0);
  const availVal   = df.reduce((s,r) => s + r["Value of Unrestricted Stock"], 0);
  const totalQty   = df.reduce((s,r) => s + r["Total Qty"], 0);

  setKpis("dash-kpis", [
    ["Total Inventory Value",    fmtETB(totalVal),   `${fmtQty(totalQty)} total units`,      "blue"],
    ["Stock in Transit Value",   fmtETB(transitVal), `${fmtQty(df.reduce((s,r) => s+r["Stock in Transit"],0))} units`, "amber"],
    ["Value in QC",              fmtETB(qcVal),      `${fmtQty(df.reduce((s,r) => s+r["Stock in Quality Inspection"],0))} units`, "red"],
    ["Available (Unrestricted)", fmtETB(availVal),   `${fmtQty(df.reduce((s,r) => s+r["Unrestricted Stock"],0))} units`, "green"],
    ["Unique Materials",         new Set(df.map(r=>r["Material"])).size.toLocaleString(), `${new Set(df.map(r=>r["Plant"])).size} plants`, "purple"],
  ]);

  // Plant bar — dual axis qty+value
  const plantAgg = sortBy(groupBy(df, "Plant Name", [["val","Total Value"],["qty","Total Qty"]]), "val");
  Plotly.newPlot("chart-plant-val", [
    { type:"bar", name:"Value (ETB)", x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.val), yaxis:"y", marker:{color:"#58a6ff"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
    { type:"scatter", mode:"lines+markers", name:"Quantity", x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.qty), yaxis:"y2", marker:{color:"#3fb950",size:8}, line:{color:"#3fb950"}, hovertemplate:"<b>%{x}</b><br>Qty: %{y:,.0f}<extra></extra>" },
  ], pl({ height:280, margin:{l:20,r:60,t:20,b:80}, yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#3fb950"},title:{text:"Qty",font:{color:"#3fb950"}}}, barmode:"group" }), PLOTLY_CONFIG);

  // Material Group pie (by value)
  const mgAgg = sortBy(groupBy(df, "Material Group Name", [["val","Total Value"]]), "val").slice(0, 12);
  Plotly.newPlot("chart-cat-pie", [{
    type:"pie", labels:mgAgg.map(r=>r["Material Group Name"]), values:mgAgg.map(r=>r.val),
    hole:0.55, textposition:"outside", textinfo:"percent+label",
    marker:{colors:COLORWAY}, hovertemplate:"<b>%{label}</b><br>ETB %{value:,.0f}<br>%{percent}<extra></extra>",
  }], pl({ showlegend:false, height:280, margin:{l:10,r:10,t:30,b:10} }), PLOTLY_CONFIG);

  // Near-expiry by plant (within 6 months)
  const nearCutoff = new Date(); nearCutoff.setMonth(nearCutoff.getMonth() + 6);
  const nearToday  = new Date();
  const nearExpiry = df.filter(r =>
    r._expiry instanceof Date && !isNaN(r._expiry) &&
    r._expiry >= nearToday && r._expiry <= nearCutoff &&
    (r["Unrestricted Stock"] || 0) > 0
  );
  const nearByPlant = sortBy(
    groupBy(nearExpiry, "Plant Name", [["val","Value of Unrestricted Stock"],["qty","Unrestricted Stock"]]),
    "val"
  );
  if (nearByPlant.length) {
    Plotly.newPlot("chart-mg-bar", [
      { type:"bar", name:"Value at Risk (ETB)", x:nearByPlant.map(r=>r["Plant Name"]), y:nearByPlant.map(r=>r.val), yaxis:"y",  marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
      { type:"scatter", mode:"lines+markers", name:"Qty at Risk", x:nearByPlant.map(r=>r["Plant Name"]), y:nearByPlant.map(r=>r.qty), yaxis:"y2", marker:{color:"#f85149",size:8}, line:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>Qty: %{y:,.0f}<extra></extra>" },
    ], pl({ height:420, margin:{l:20,r:60,t:20,b:100}, barmode:"group",
      yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#f85149"},title:{text:"Qty",font:{color:"#f85149"}}}
    }), PLOTLY_CONFIG);
  } else {
    document.getElementById("chart-mg-bar").innerHTML = `<div class="alert-info" style="margin:1rem 0">✓ No near-expiry stock (within 6 months) with quantity on hand.</div>`;
  }

  // Download
  const dlCols = [
    {key:"Plant Name",         label:"Plant"},
    {key:"Material Group Name",label:"Material Group"},
    {key:"Total Value",        label:"Total Value (ETB)", fmt:fmtETB, rawKey:"Total Value"},
    {key:"Total Qty",          label:"Total Qty",         fmt:fmtQty, rawKey:"Total Qty"},
  ];
  const aggForDl = groupBy(df, "Plant Name", [["Total Value","Total Value"],["Total Qty","Total Qty"]]);
  document.getElementById("btn-dl-dash-xlsx").onclick = () => downloadExcel(aggForDl, dlCols, "dashboard_summary.xlsx");
  document.getElementById("btn-dl-dash-csv").onclick  = () => downloadCSV(aggForDl,   dlCols, "dashboard_summary.csv");
}

// ═══════════════════════════════════════════════════════════════════════════
// STOCK IN TRANSIT FILE LOADER
// Loads the separate stock-in-transit Excel (columns: Material, Material
// Description, Plant, Name 1, Purchasing Document, Item, Supplying Plant,
// Special Stock, Quantity, Base Unit of Measure, …).
// Applies the same isNonMedicalCode / isNonMedicalGroup filters as the
// main inventory file so only medical items appear.
// ═══════════════════════════════════════════════════════════════════════════
function loadTransitFile(file) {
  const statusEl = document.getElementById("transitFileStatus");
  statusEl.style.display = "block";
  statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;

  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!data.length) {
          statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ Empty file</div>`;
          return;
        }

        // Trim all column headers
        const trimmed = data.map(row => {
          const r = {};
          for (const [k, v] of Object.entries(row)) r[k.trim()] = v;
          return r;
        });

        // Normalise key column names (case-insensitive lookup)
        const colMap = {};
        if (trimmed.length) {
          Object.keys(trimmed[0]).forEach(k => { colMap[k.toLowerCase()] = k; });
        }
        const getCol = name => colMap[name.toLowerCase()] || name;

        // Apply the same medical filters as the main file
        // FIX-R8: also apply isNonMedicalGroup when the column is present
        let df = trimmed.filter(r => {
          const mat = String(r[getCol("Material")] ?? "").trim();
          if (!mat || isNonMedicalCode(mat)) return false;
          const grp = String(r[getCol("Material Group Name")] ?? "").trim();
          if (grp && isNonMedicalGroup(grp)) return false;
          return true;
        });

        // Normalise Purchasing Document (may come as scientific notation from Excel)
        df = df.map(r => {
          const raw = String(r[getCol("Purchasing Document")] ?? "").trim();
          let purDoc = raw;
          if (/e/i.test(raw)) purDoc = String(Math.round(Number(raw)));
          return {
            "_st_material":     String(r[getCol("Material")]             ?? "").trim(),
            "_st_desc":         String(r[getCol("Material Description")] ?? "").trim(),
            "_st_plant":        String(r[getCol("Plant")]                ?? "").trim(),
            "_st_plantName":    String(r[getCol("Name 1")]               ?? r[getCol("Plant Name")] ?? "").trim(),
            "_st_purDoc":       purDoc,
            "_st_supPlant":     String(r[getCol("Supplying Plant")]      ?? "").trim(),
            "_st_qty":          parseFloat(r[getCol("Quantity")] ?? r[getCol("Order Quantity")] ?? 0) || 0,
            "_st_uom":          String(r[getCol("Base Unit of Measure")] ?? r[getCol("Order Unit")] ?? "").trim(),
            "_st_item":         String(r[getCol("Item")]                 ?? "").trim(),
            "_st_specialStock": String(r[getCol("Special Stock")]        ?? "").trim(),
          };
        });

        // FIX-EXCL-SLOC: Remove any material from stockTransitRaw that was entirely
        // excluded from rawDf (e.g. all its rows fell under an excluded storage location
        // or other parse-time filter).  If the material has no presence in rawDf at all
        // it must not appear anywhere on the site, including the transit detail section.
        if (rawDf.length) {
          const allowedMaterials = new Set(rawDf.map(r => String(r["Material"] || "").trim()));
          df = df.filter(r => allowedMaterials.has(r._st_material));
        }

        stockTransitRaw = df;
        stFilterState   = { purDoc: "", supPlant: "" };

        // Recompute phantom flags now that transit detail is available
        recomputePhantomTransit();

        // Update status
        statusEl.innerHTML = `<div class="status-ok">✓ TRANSIT FILE LOADED</div><div class="status-name">${escHtml(file.name)} (${df.length.toLocaleString()} records)</div>`;
        document.getElementById("transitUploadBtnText").textContent = "📦 Change Transit File";

        // Re-render current page so phantom exclusions take effect immediately
        const reRender = { dashboard: renderDashboard, transit: () => { renderTransit(); renderStockTransitSection(); }, branch: renderBranch, flow: renderFlow };
        if (reRender[currentPage]) reRender[currentPage]();
        else if (currentPage === "transit") renderStockTransitSection();
      } catch (err) {
        statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ ${escHtml(err.message)}</div>`;
      }
    }, 30);
  };
  reader.readAsArrayBuffer(file);
}

// ─── Render the Stock in Transit detail section (lower half of Transit page) ─
function renderStockTransitSection() {
  const noFileEl  = document.getElementById("stock-transit-no-file");
  const contentEl = document.getElementById("stock-transit-content");

  if (!noFileEl || !contentEl) return; // elements not in DOM yet

  if (!stockTransitRaw.length) {
    noFileEl.style.display  = "block";
    contentEl.style.display = "none";
    return;
  }

  noFileEl.style.display  = "none";
  contentEl.style.display = "block";

  // Populate Purchasing Document filter dropdown
  const purDocs = [...new Set(stockTransitRaw.map(r => r._st_purDoc).filter(Boolean))].sort();
  const supPlants = [...new Set(stockTransitRaw.map(r => r._st_supPlant).filter(Boolean))].sort();

  const purDocEl   = document.getElementById("st-filter-pur-doc");
  const supPlantEl = document.getElementById("st-filter-sup-plant");

  purDocEl.innerHTML   = `<option value="">All Purchasing Documents</option>` +
    purDocs.map(d => `<option value="${escHtml(d)}"${stFilterState.purDoc === d ? " selected" : ""}>${escHtml(d)}</option>`).join("");
  supPlantEl.innerHTML = `<option value="">All Supplying Plants</option>` +
    supPlants.map(p => `<option value="${escHtml(p)}"${stFilterState.supPlant === p ? " selected" : ""}>${escHtml(p)}</option>`).join("");

  // Apply active filters from stFilterState
  let df = stockTransitRaw.filter(r =>
    (!stFilterState.purDoc   || r._st_purDoc   === stFilterState.purDoc) &&
    (!stFilterState.supPlant || r._st_supPlant === stFilterState.supPlant)
  );

  // KPIs
  const uniqMats    = new Set(df.map(r => r._st_material)).size;
  const uniqPurDocs = new Set(df.map(r => r._st_purDoc).filter(Boolean)).size;
  const uniqSup     = new Set(df.map(r => r._st_supPlant).filter(Boolean)).size;
  const totalQty    = df.reduce((s, r) => s + r._st_qty, 0);
  setKpis("st-kpis", [
    ["Total Records",          df.length.toLocaleString(),    "After filter",           "blue"],
    ["Unique Materials",       uniqMats.toLocaleString(),     "Distinct SKUs",          "green"],
    ["Purchasing Documents",   uniqPurDocs.toLocaleString(),  "Distinct POs/STO docs",  "amber"],
    ["Supplying Plants",       uniqSup.toLocaleString(),      "Source locations",       "purple"],
    ["Total Qty in Transit",   fmtQty(totalQty),              "Units",                  "blue"],
  ]);

  // Table columns
  const stCols = [
    { key: "_st_material",  label: "Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
    { key: "_st_desc",     label: "Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
    { key: "_st_plant",     label: "Plant Code" },
    { key: "_st_plantName", label: "Plant Name" },
    { key: "_st_purDoc",    label: "Purchasing Document" },
    { key: "_st_item",      label: "Item" },
    { key: "_st_supPlant",  label: "Supplying Plant" },
    { key: "_st_qty",       label: "Quantity", fmt: fmtQty, rawKey: "_st_qty", cellClass: "col-qty" },
    { key: "_st_uom",       label: "UOM" },
  ];

  document.getElementById("st-table-wrap").innerHTML = buildTable(df, stCols);
  document.getElementById("btn-dl-st-csv").onclick  = () => downloadCSV(df,   stCols, "stock_in_transit_detail.csv");
  document.getElementById("btn-dl-st-xlsx").onclick = () => downloadExcel(df, stCols, "stock_in_transit_detail.xlsx");
}

// ─── Lookup helper: get Purchasing Document(s) and Supplying Plant(s) ─────
// For a given material code + plant code, scans stockTransitRaw and returns
// deduplicated comma-separated values. Falls back to "—" when no transit file
// is loaded or no matching rows exist.
function getTransitInfo(material, plantCode) {
  if (!stockTransitRaw.length) return { purDoc: "—", supPlant: "—" };
  const mat  = String(material  || "").trim();
  const plt  = String(plantCode || "").trim().toUpperCase();
  const hits = stockTransitRaw.filter(r =>
    r._st_material === mat &&
    (plt === "" || r._st_plant.toUpperCase() === plt)
  );
  if (!hits.length) return { purDoc: "—", supPlant: "—" };
  const purDocs  = [...new Set(hits.map(r => r._st_purDoc).filter(Boolean))];
  const supPlants= [...new Set(hits.map(r => r._st_supPlant).filter(Boolean))];
  return {
    purDoc:   purDocs.length   ? purDocs.join(", ")   : "—",
    supPlant: supPlants.length ? supPlants.join(", ") : "—",
  };
}

// ─── Phantom Transit Detection ────────────────────────────────────────────
// A transit row is "phantom" (not physically available / unverifiable) when:
//   • The main data has Stock in Transit > 0, AND
//   • The transit detail file is loaded, AND
//   • No matching row in the transit detail has BOTH a Purchasing Document
//     AND a Supplying Plant for that material+plant combo.
//
// Phantom rows are EXCLUDED from all aggregate values (Total Value, Total Qty,
// Value of Stock in Transit, Stock in Transit) on Dashboard, Branch Comparison,
// and Inventory Flow. They are flagged with a warning badge on the Transit page.

function isPhantomTransit(row) {
  // If no transit file is loaded, we cannot judge — treat as valid
  if (!stockTransitRaw.length) return false;
  // Only relevant for rows that actually have transit stock
  if (!(row["Stock in Transit"] > 0)) return false;

  const mat = String(row["Material"] || "").trim();
  const plt = String(row["Plant"]    || "").trim().toUpperCase();
  const hits = stockTransitRaw.filter(r =>
    r._st_material === mat &&
    (plt === "" || r._st_plant.toUpperCase() === plt)
  );
  // No matching entry at all → phantom
  if (!hits.length) return true;
  // Has at least one row with BOTH purchasing doc AND supplying plant → valid
  const hasFullDoc = hits.some(r => r._st_purDoc && r._st_supPlant);
  return !hasFullDoc;
}

// Called after transit file loads OR after main file loads (when transit already exists).
// Stamps each rawDf row with _phantomTransitQty / _phantomTransitVal and
// recomputes Total Value / Total Qty to exclude phantom transit amounts.
// FIX-EXCL-SLOC: also re-purges stockTransitRaw entries whose material was entirely
// excluded from rawDf (defence-in-depth for the case where main file loads after transit).
function recomputePhantomTransit() {
  if (rawDf.length && stockTransitRaw.length) {
    const allowedMaterials = new Set(rawDf.map(r => String(r["Material"] || "").trim()));
    stockTransitRaw = stockTransitRaw.filter(r => allowedMaterials.has(r._st_material));
  }
  rawDf.forEach(row => {
    if (isPhantomTransit(row)) {
      row._phantomTransitQty = row["Stock in Transit"];
      row._phantomTransitVal = row["Value of Stock in Transit"];
    } else {
      row._phantomTransitQty = 0;
      row._phantomTransitVal = 0;
    }
    // Recompute derived totals excluding phantom transit
    row["Total Value"] = row["Value of Unrestricted Stock"]
                       + (row["Value of Stock in Transit"] - row._phantomTransitVal)
                       + row["Value of Stock in Quality Inspection"];
    row["Total Qty"]   = row["Unrestricted Stock"]
                       + (row["Stock in Transit"] - row._phantomTransitQty)
                       + row["Stock in Quality Inspection"];
  });
}

// Returns an object { count, qty, val } for phantom transit rows in a given df slice
function getPhantomSummary(df) {
  const rows = df.filter(r => r._phantomTransitQty > 0);
  return {
    count: rows.length,
    qty:   rows.reduce((s,r) => s + r._phantomTransitQty, 0),
    val:   rows.reduce((s,r) => s + r._phantomTransitVal, 0),
  };
}

// Renders a dismissible alert banner into the element with given id.
// Does nothing (clears el) if there are no phantom rows.
function renderPhantomAlert(containerId, df) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const { count, qty, val } = getPhantomSummary(df);
  if (!count || !stockTransitRaw.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div class="phantom-transit-alert">
      <span class="phantom-alert-icon">⚠️</span>
      <div class="phantom-alert-body">
        <strong>Unverified Transit Stock Excluded</strong>
        <span>${count.toLocaleString()} item${count!==1?"s":""} (${fmtQty(qty)} units · ${fmtETB(val)}) have <em>Stock in Transit</em> but
        lack a <em>Purchasing Document</em> and <em>Supplying Plant</em> in the transit detail file.
        These items are <strong>not physically confirmed</strong> and have been excluded from all quantities and values shown here.</span>
        <a class="phantom-alert-link" onclick="navigateTo('transit')">View on Transit page →</a>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRANSIT
// ═══════════════════════════════════════════════════════════════════════════

// Holds the full transit rows (pre-built) so the search filter can re-slice them.
let _transitRowsCache = [];
let _transitColsCache = [];
// _ho01RowsCache removed — was declared but never populated or read (dead code)

function renderTransit() {
  // rawDf is pre-filtered at parse time — no need to re-apply isNonMedical* guards here.
  // Simply restrict to rows with positive transit qty and value.
  // FIX-PHANTOM-HIDE: phantom transit rows (no PO / no supplying plant) are excluded
  // from the main table entirely; they only appear in the transit detail file section.
  const df = applyPageFilter("transit").filter(r =>
    r["Stock in Transit"] > 0 &&
    r["Value of Stock in Transit"] > 0 &&
    !(r._phantomTransitQty > 0)   // exclude phantom rows from this table
  );

  const totalTV = df.reduce((s,r) => s + r["Value of Stock in Transit"], 0);
  const totalTQ = df.reduce((s,r) => s + r["Stock in Transit"], 0);
  const uniqMat = new Set(df.map(r => r["Material"])).size;

  // Phantom transit summary for transit KPIs — compute from full applyPageFilter set
  const allTransitDf = applyPageFilter("transit").filter(r => r["Stock in Transit"] > 0 && r["Value of Stock in Transit"] > 0);
  const phantomRows = allTransitDf.filter(r => r._phantomTransitQty > 0);
  const phantomCount = phantomRows.length;
  const phantomKpiExtra = phantomCount > 0 && stockTransitRaw.length
    ? [[`Unverified Transit Items`, String(phantomCount), "No PO & Supplying Plant — see Transit Detail section", "red"]]
    : [];

  setKpis("transit-kpis", [
    ["Total Transit Value",        fmtETB(totalTV), "Across all plants",  "amber"],
    ["Total Transit Quantity",     fmtQty(totalTQ), "Units in movement",  "blue"],
    ["Unique Materials in Transit",String(uniqMat), "Distinct SKUs",      "green"],
    ...phantomKpiExtra,
  ]);

  const transitCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name",       label:"Material Group"},
    {key:"Plant Name",                label:"Plant"},
    {key:"_purDoc",                   label:"Purchasing Document"},
    {key:"_supPlant",                 label:"Supplying Plant"},
    {key:"Stock in Transit",          label:"Transit Qty",       fmt:fmtQty, rawKey:"Stock in Transit",          cellClass:"col-qty"},
    {key:"Value of Stock in Transit", label:"Transit Value (ETB)",fmt:fmtETB, rawKey:"Value of Stock in Transit", cellClass:"col-val"},
    {key:"_status",                   label:"Status", raw:true},
  ];
  const transitRows = sortBy([...df], "Value of Stock in Transit").map(r => {
    const info = getTransitInfo(r["Material"], r["Plant"]);
    // BUG-FIX-3: removed dead isPhantom branch — df already filters out phantom rows
    // (!(r._phantomTransitQty > 0) above), so the badge-phantom branch could never
    // execute here. Status is now purely value-based.
    return {
      ...r,
      _purDoc:   info.purDoc,
      _supPlant: info.supPlant,
      _status: r["Value of Stock in Transit"] > 100000 ? "<span class='badge badge-red'>Critical</span>"
        : r["Value of Stock in Transit"] > 50000  ? "<span class='badge badge-amber'>High</span>"
        : r["Value of Stock in Transit"] > 10000  ? "<span class='badge badge-amber'>Medium</span>"
        : "<span class='badge badge-green'>Low</span>",
    };
  });

  // Cache rows for search filtering
  _transitRowsCache = transitRows;
  _transitColsCache = transitCols;

  // Wire chart
  if (df.length) {
    const plantAgg = sortBy(groupBy(df, "Plant Name", [["val","Value of Stock in Transit"],["qty","Stock in Transit"]]), "val");
    Plotly.newPlot("chart-transit-plant", [
      {type:"bar",  name:"Value (ETB)", x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.val), yaxis:"y",  marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>"},
      {type:"scatter", mode:"lines+markers", name:"Qty", x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.qty), yaxis:"y2", marker:{color:"#3fb950",size:8}, line:{color:"#3fb950"}, hovertemplate:"<b>%{x}</b><br>Qty: %{y:,.0f}<extra></extra>"},
    ], pl({height:280,margin:{l:20,r:60,t:20,b:80},yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#3fb950"}}}), PLOTLY_CONFIG);
  } else {
    document.getElementById("chart-transit-plant").innerHTML = "";
  }

  document.getElementById("btn-dl-transit").onclick      = () => downloadCSV(_transitRowsCache,   transitCols.slice(0,-1), "transit_analysis.csv");
  document.getElementById("btn-dl-transit-xlsx").onclick = () => downloadExcel(_transitRowsCache, transitCols.slice(0,-1), "transit_analysis.xlsx");

  // Show all filtered transit items directly (no search gate)
  document.getElementById("transit-table-wrap").innerHTML = transitRows.length
    ? buildTable(transitRows, transitCols, r => r._phantomTransitQty > 0 ? "row-red" : "")
    : `<div class="alert-info">No pharmaceutical transit items found.</div>`;
}

// ── Transit material search — filters main transit table ──────────────────
function renderTransitSearch() {
  const query = (document.getElementById("transit-search-input").value || "").trim().toLowerCase();
  const transitCols = _transitColsCache;

  if (!query) {
    document.getElementById("transit-search-results").innerHTML = "";
    document.getElementById("transit-table-wrap").innerHTML = _transitRowsCache.length
      ? buildTable(_transitRowsCache, transitCols, r => r._phantomTransitQty > 0 ? "row-red" : "")
      : `<div class="alert-info">No pharmaceutical transit items found.</div>`;
    return;
  }

  // Filter transit rows by search query
  const filtered = _transitRowsCache.filter(r => {
    const code = String(r["Material"] || "").toLowerCase();
    const desc = String(r["Material Description"] || "").toLowerCase();
    return code.includes(query) || desc.includes(query);
  });

  document.getElementById("transit-search-results").innerHTML =
    `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.4rem">
      Found <b style="color:var(--text)">${filtered.length}</b> transit record(s) matching "<b style="color:var(--text)">${escHtml(query)}</b>"
    </div>`;

  document.getElementById("transit-table-wrap").innerHTML = filtered.length
    ? buildTable(filtered, transitCols, r => r._phantomTransitQty > 0 ? "row-red" : "")
    : `<div class="alert-info">No transit items match "<b>${escHtml(query)}</b>".</div>`;
}

function clearTransitSearch() {
  document.getElementById("transit-search-input").value = "";
  renderTransitSearch();
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPIRY
// ═══════════════════════════════════════════════════════════════════════════
function renderExpiry() {
  const baseDf  = applyPageFilter("expiry");
  const months  = parseInt(document.querySelector('input[name="expWin"]:checked')?.value || 6);
  const today   = new Date();
  const cutoff  = new Date(today); cutoff.setMonth(cutoff.getMonth() + months);
  const valid   = baseDf.filter(r => r._expiry instanceof Date && !isNaN(r._expiry));

  const expiring     = valid.filter(r => r._expiry >= today && r._expiry <= cutoff && (r["Unrestricted Stock"]||0) > 0 && (r["Value of Unrestricted Stock"]||0) > 0);
  const expired      = valid.filter(r => r._expiry < today);
  // FIX BUG-4: filter zero-qty BEFORE the KPI count so KPI matches the table
  const expiredWithStock = expired.filter(r => (r["Unrestricted Stock"] || 0) > 0);
  const expiredZeroQty   = expired.length - expiredWithStock.length;

  setKpis("expiry-kpis", [
    ["Expiring in Window", String(expiring.length),       `Items within next ${months} months`,             "amber"],
    // FIX BUG-4: use expiredWithStock.length to match what the table shows
    ["Already Expired",   String(expiredWithStock.length),"Items with stock on hand requiring action",      "red"],
    ["At-Risk Value",     fmtETB(expiring.reduce((s,r) => s+r["Value of Unrestricted Stock"],0)),           "Unrestricted stock value","purple"],
    ["At-Risk Quantity",  fmtQty(expiring.reduce((s,r) => s+r["Unrestricted Stock"],0)),                   "Units expiring soon",     "amber"],
  ]);

  if (expiring.length) {
    const monthMap = {}, valMap = {};
    expiring.forEach(r => {
      const key = `${r._expiry.getFullYear()}-${String(r._expiry.getMonth()+1).padStart(2,"0")}`;
      monthMap[key] = (monthMap[key] || 0) + 1;
      valMap[key]   = (valMap[key]   || 0) + r["Value of Unrestricted Stock"];
    });
    const ms = Object.keys(monthMap).sort();
    Plotly.newPlot("chart-expiry-timeline", [
      {type:"bar",   name:"Items Count",   x:ms, y:ms.map(m=>monthMap[m]), marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>%{y} items<extra></extra>"},
      {type:"scatter",mode:"lines+markers",name:"Value at Risk", x:ms, y:ms.map(m=>valMap[m]), yaxis:"y2", marker:{color:"#f85149",size:8}, line:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>"},
    ], pl({height:260,margin:{l:20,r:60,t:20,b:60},yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#f85149"}}}), PLOTLY_CONFIG);

    document.getElementById("chart-expiry-timeline").on("plotly_click", function(data) {
      const pt = data.points[0];
      const monthKey = pt.x;
      const [yr, mo] = monthKey.split("-").map(Number);
      const monthItems = expiring.filter(r => r._expiry.getFullYear() === yr && r._expiry.getMonth() + 1 === mo);
      const drillCols = [
        {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
        {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
        {key:"Material Group Name",         label:"Material Group"},
        {key:"Plant Name",                  label:"Plant"},
        {key:"Description of Storage Location", label:"Storage Location"},
        {key:"_expiryStr",                  label:"Expiry Date"},
        {key:"Unrestricted Stock",          label:"Qty",        fmt:fmtQty, rawKey:"Unrestricted Stock",       cellClass:"col-qty"},
        {key:"Value of Unrestricted Stock", label:"Value (ETB)",fmt:fmtETB, rawKey:"Value of Unrestricted Stock",cellClass:"col-val"},
        {key:"_daysLeft",                   label:"Days Left"},
      ];
      const drillRows = sortBy(
        monthItems.map(r => ({
          ...r,
          _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : "",
          _daysLeft:  r._expiry ? Math.floor((r._expiry - new Date()) / 86400000) : 9999,
        })),
        "_daysLeft", true
      );
      const totalVal   = monthItems.reduce((s,r) => s+r["Value of Unrestricted Stock"], 0);
      const totalQty   = monthItems.reduce((s,r) => s+r["Unrestricted Stock"], 0);
      const monthLabel = new Date(yr, mo-1, 1).toLocaleString("default", {month:"long", year:"numeric"});
      document.getElementById("expiry-drill-title").textContent = "📅 " + monthLabel;
      document.getElementById("expiry-drill-meta").textContent  = `${drillRows.length} items · ${fmtQty(totalQty)} units · ${fmtETB(totalVal)}`;
      document.getElementById("expiry-drill-table").innerHTML   = drillRows.length
        ? buildTable(drillRows, drillCols, r => r._daysLeft <= 30 ? "row-red" : r._daysLeft <= 90 ? "row-amber" : "")
        : '<div class="alert-info">No items for this month.</div>';
      const drillEl = document.getElementById("expiry-drilldown");
      drillEl.style.display = "block";
      drillEl.scrollIntoView({ behavior:"smooth", block:"nearest" });
      document.getElementById("expiry-drill-dl-csv").onclick  = () => downloadCSV(drillRows,  drillCols, `expiry_${monthKey}.csv`);
      document.getElementById("expiry-drill-dl-xlsx").onclick = () => downloadExcel(drillRows, drillCols, `expiry_${monthKey}.xlsx`);
    });
    document.getElementById("expiry-drill-close").onclick = () => {
      document.getElementById("expiry-drilldown").style.display = "none";
    };
  } else {
    document.getElementById("chart-expiry-timeline").innerHTML = "";
    document.getElementById("expiry-drilldown").style.display  = "none";
  }

  document.getElementById("expiry-table-wrap").innerHTML = "";

  if (expiredWithStock.length) {
    document.getElementById("expired-section").style.display = "block";
    const zeroNote = expiredZeroQty
      ? ` <span style="font-size:0.72rem;color:var(--muted);font-weight:400">(${expiredZeroQty} zero-qty records hidden)</span>`
      : "";
    document.getElementById("expired-header").innerHTML = `🔴 Already Expired Items (${expiredWithStock.length})${zeroNote}`;
    const expiredRows = expiredWithStock.map(r => ({...r, _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : ""}));
    document.getElementById("expired-table-wrap").innerHTML = buildTable(expiredRows, [
      {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
      {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
      {key:"Material Group Name",            label:"Material Group"},
      {key:"Plant Name",                     label:"Plant"},
      {key:"Description of Storage Location",label:"Storage Location"},
      {key:"_expiryStr",                     label:"Expiry Date"},
      {key:"Unrestricted Stock",             label:"Qty", fmt:fmtQty, rawKey:"Unrestricted Stock", cellClass:"col-qty"},
    ]);
    document.getElementById("btn-dl-expired").onclick = () => downloadCSV(expiredRows, [
      {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
      {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
      {key:"Plant Name",                     label:"Plant"},
      {key:"Description of Storage Location",label:"Storage Location"},
      {key:"_expiryStr",                     label:"Expiry Date"},
      {key:"Unrestricted Stock",             label:"Qty", rawKey:"Unrestricted Stock"},
    ], "expired_items.csv");
  } else {
    document.getElementById("expired-section").style.display = "none";
  }
}

// ── MATERIAL EXPIRY LOOKUP — filters the main expiry table ───────────────
function renderExpirySearch() {
  const query     = document.getElementById("expiry-search-input").value.trim().toLowerCase();
  const resultsEl = document.getElementById("expiry-search-results");

  if (!query) {
    resultsEl.innerHTML = "";
    // Hide main table and show prompt
    document.getElementById("expiry-table-wrap").innerHTML =
      `<div class="alert-info">🔍 Use the search box above to find and display expiry items.</div>`;
    document.getElementById("expired-section").style.display = "none";
    return;
  }
  if (!rawDf.length) { resultsEl.innerHTML = `<div class="alert-info">No data loaded yet.</div>`; return; }

  const today  = new Date();
  const baseDf = applyPageFilter("expiry");
  const matches = baseDf.filter(r => {
    const code     = String(r["Material"] || "").toLowerCase();
    const desc     = String(r["Material Description"] || "").toLowerCase();
    const hasStock = (r["Unrestricted Stock"] || 0) > 0 && (r["Value of Unrestricted Stock"] || 0) > 0;
    return hasStock && (code.includes(query) || desc.includes(query));
  });

  if (!matches.length) {
    resultsEl.innerHTML = `<div class="alert-info">No materials found matching "<b>${escHtml(query)}</b>".</div>`;
    document.getElementById("expiry-table-wrap").innerHTML = "";
    document.getElementById("expired-section").style.display = "none";
    return;
  }

  const annotated = matches.map(r => {
    const expiryStr = r._expiry ? fmtLocalDate(r._expiry) : "—";
    let daysLeft = null, statusLabel = "No Expiry Date", statusClass = "";
    if (r._expiry instanceof Date && !isNaN(r._expiry)) {
      daysLeft = Math.floor((r._expiry - today) / 86400000);
      if      (daysLeft < 0)   { statusLabel = `Expired ${Math.abs(daysLeft)}d ago`; statusClass = "row-red";   }
      else if (daysLeft <= 30)  { statusLabel = `${daysLeft}d left`;                  statusClass = "row-red";   }
      else if (daysLeft <= 180) { statusLabel = `${daysLeft}d left`;                  statusClass = "row-amber"; }
      else                      { statusLabel = `${daysLeft}d left`;                  statusClass = "";          }
    }
    return { ...r, _expiryStr: expiryStr, _daysLeft: daysLeft ?? 99999, _statusLabel: statusLabel, _statusClass: statusClass };
  });

  const sorted     = annotated.sort((a,b) => a._daysLeft - b._daysLeft);
  const uniqueMats = [...new Set(sorted.map(r => r["Material"]))];
  const summary    = `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.5rem">
    Found <b style="color:var(--text)">${sorted.length}</b> batch/location record(s) across
    <b style="color:var(--text)">${uniqueMats.length}</b> material code(s)
  </div>`;

  const cols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Plant Name",                     label:"Plant"},
    {key:"Description of Storage Location",label:"Storage Location"},
    {key:"Batch",                          label:"Batch"},
    {key:"_expiryStr",                     label:"Expiry Date"},
    {key:"_statusLabel",                   label:"Status"},
    {key:"Unrestricted Stock",             label:"Avail Qty",   fmt:fmtQty, rawKey:"Unrestricted Stock",          cellClass:"col-qty"},
    {key:"Value of Unrestricted Stock",    label:"Value (ETB)", fmt:fmtETB, rawKey:"Value of Unrestricted Stock", cellClass:"col-val"},
  ];

  // Show summary in the lookup result area AND render the main table below
  resultsEl.innerHTML = summary;
  document.getElementById("expiry-table-wrap").innerHTML = buildTable(sorted, cols, r => r._statusClass);

  // Also show the expired-items sub-section if any expired results exist
  const expiredRows = sorted.filter(r => r._daysLeft < 0);
  if (expiredRows.length) {
    document.getElementById("expired-section").style.display = "block";
    document.getElementById("expired-header").innerHTML = `🔴 Already Expired Items (${expiredRows.length})`;
    document.getElementById("expired-table-wrap").innerHTML = buildTable(expiredRows, cols, r => r._statusClass);
  } else {
    document.getElementById("expired-section").style.display = "none";
  }
}

function clearExpirySearch() {
  document.getElementById("expiry-search-input").value = "";
  document.getElementById("expiry-search-results").innerHTML = "";
  document.getElementById("expiry-table-wrap").innerHTML =
    `<div class="alert-info">🔍 Use the search box above to find and display expiry items.</div>`;
  document.getElementById("expired-section").style.display = "none";
}

// ── MATERIAL QC LOOKUP ────────────────────────────────────────────────────
function renderQCSearch() {
  const query     = document.getElementById("qc-search-input").value.trim().toLowerCase();
  const resultsEl = document.getElementById("qc-search-results");
  if (!query) { resultsEl.innerHTML = ""; return; }
  if (!rawDf.length) { resultsEl.innerHTML = `<div class="alert-info">No data loaded yet.</div>`; return; }

  // Aggregate by material so source codes are consolidated into their target code
  // before searching — ensures searching "102-ACET-0102-01" returns the consolidated row
  const baseDf = aggregateByMaterial(
    applyPageFilter("qc").filter(r => (r["Stock in Quality Inspection"] || 0) > 0)
  );

  // Also allow searching by any original source code (maps to target description)

  const matches = baseDf.filter(r => {
    const code  = String(r["Material"] || "").toLowerCase();
    const desc  = String(r["Material Description"] || "").toLowerCase();
    return (code.includes(query) || desc.includes(query));
  });

  if (!matches.length) {
    resultsEl.innerHTML = `<div class="alert-info">No QC stock found matching "<b>${escHtml(query)}</b>".</div>`;
    return;
  }

  const today = new Date();
  const annotated = matches.map(r => {
    const expiryStr = r._expiry ? fmtLocalDate(r._expiry) : "—";
    let daysLeft = null, statusLabel = "No Expiry Date", statusClass = "";
    if (r._expiry instanceof Date && !isNaN(r._expiry)) {
      daysLeft = Math.floor((r._expiry - today) / 86400000);
      if      (daysLeft < 0)   { statusLabel = `Expired ${Math.abs(daysLeft)}d ago`; statusClass = "row-red";   }
      else if (daysLeft <= 30)  { statusLabel = `${daysLeft}d left`;                  statusClass = "row-red";   }
      else if (daysLeft <= 180) { statusLabel = `${daysLeft}d left`;                  statusClass = "row-amber"; }
      else                      { statusLabel = `${daysLeft}d left`;                  statusClass = "";          }
    }

    return { ...r, _expiryStr: expiryStr, _daysLeft: daysLeft ?? 99999, _statusLabel: statusLabel, _statusClass: statusClass, _plantList: r._plantList || r["Plant Name"] || "—" };
  });

  const sorted     = annotated.sort((a,b) => a._daysLeft - b._daysLeft);
  const uniqueMats = [...new Set(sorted.map(r => r["Material"]))];
  const summary    = `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.5rem">
    Found <b style="color:var(--text)">${sorted.length}</b> QC material(s)
    (${uniqueMats.length} unique code(s))
  </div>`;

  const cols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"_plantList",                            label:"Plant(s)"},
    {key:"_expiryStr",                            label:"Shelf Life Expiry"},
    {key:"_statusLabel",                          label:"Expiry Status"},
    {key:"Stock in Quality Inspection",           label:"QC Qty", fmt:fmtQty, rawKey:"Stock in Quality Inspection", cellClass:"col-qty"},
    {key:"Value of Stock in Quality Inspection",  label:"QC Value (ETB)", fmt:fmtETB, rawKey:"Value of Stock in Quality Inspection", cellClass:"col-val"},
  ];
  resultsEl.innerHTML = summary + buildTable(sorted, cols, r => r._statusClass);
}

function clearQCSearch() {
  document.getElementById("qc-search-input").value = "";
  document.getElementById("qc-search-results").innerHTML = "";
}

// ── MATERIAL FLOW LOOKUP ──────────────────────────────────────────────────
function renderFlowSearch() {
  const query     = document.getElementById("flow-search-input").value.trim().toLowerCase();
  const resultsEl = document.getElementById("flow-search-results");
  if (!query) { resultsEl.innerHTML = ""; return; }
  if (!rawDf.length) { resultsEl.innerHTML = `<div class="alert-info">No data loaded yet.</div>`; return; }

  const baseDf = applyPageFilter("flow");
  const matches = baseDf.filter(r => {
    const code = String(r["Material"] || "").toLowerCase();
    const desc = String(r["Material Description"] || "").toLowerCase();
    return code.includes(query) || desc.includes(query);
  });

  if (!matches.length) {
    resultsEl.innerHTML = `<div class="alert-info">No materials found matching "<b>${escHtml(query)}</b>".</div>`;
    return;
  }

  const uniqueMats = [...new Set(matches.map(r => r["Material"]))];
  const summary = `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.5rem">
    Found <b style="color:var(--text)">${matches.length}</b> record(s) across
    <b style="color:var(--text)">${uniqueMats.length}</b> material code(s)
  </div>`;

  const cols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Plant Name",                        label:"Plant"},
    {key:"Material Group Name",               label:"Material Group"},
    {key:"Unrestricted Stock",                label:"Avail Qty",      fmt:fmtQty, rawKey:"Unrestricted Stock",          cellClass:"col-qty"},
    {key:"Stock in Transit",                  label:"Transit Qty",    fmt:fmtQty, rawKey:"Stock in Transit",            cellClass:"col-qty"},
    {key:"Stock in Quality Inspection",       label:"QC Qty",         fmt:fmtQty, rawKey:"Stock in Quality Inspection", cellClass:"col-qty"},
    {key:"Value of Unrestricted Stock",       label:"Avail Value (ETB)", fmt:fmtETB, rawKey:"Value of Unrestricted Stock", cellClass:"col-val"},
    {key:"Value of Stock in Transit",         label:"Transit Value (ETB)", fmt:fmtETB, rawKey:"Value of Stock in Transit", cellClass:"col-val"},
  ];
  resultsEl.innerHTML = summary + buildTable(matches, cols);
}

function clearFlowSearch() {
  document.getElementById("flow-search-input").value = "";
  document.getElementById("flow-search-results").innerHTML = "";
}

// ═══════════════════════════════════════════════════════════════════════════
// QC
// ═══════════════════════════════════════════════════════════════════════════
function renderQC() {
  // FIX BUG-6: removed "&& r["Value of Stock in Quality Inspection"] > 0"
  // SAP sometimes records QC qty > 0 with zero ETB value (non-valuated batches,
  // consignment stock) — these must still appear for physical count audits.
  // RECONCILIATION: aggregate all source codes into their target canonical code
  // so each material appears exactly once (e.g. three ASA variants → one total).
  const rawFiltered = applyPageFilter("qc").filter(r => r["Stock in Quality Inspection"] > 0);
  const df          = aggregateByMaterial(rawFiltered).filter(r => r["Stock in Quality Inspection"] > 0);

  const totalQCVal = df.reduce((s,r) => s + r["Value of Stock in Quality Inspection"], 0);
  const totalQCQty = df.reduce((s,r) => s + r["Stock in Quality Inspection"], 0);
  setKpis("qc-kpis", [
    ["Total Value in QC", fmtETB(totalQCVal), "Across all plants",      "red"],
    ["Total QC Quantity", fmtQty(totalQCQty), "Units under inspection", "amber"],
    ["Unique Materials",  String(new Set(df.map(r=>r["Material"])).size),"Distinct SKUs","blue"],
  ]);

  if (!df.length) { document.getElementById("qc-table-wrap").innerHTML = `<div class="alert-info">✓ No items in quality inspection.</div>`; return; }

  const plantQC = sortBy(groupBy(rawFiltered, "Plant Name", [["val","Value of Stock in Quality Inspection"],["qty","Stock in Quality Inspection"]]), "val");
  Plotly.newPlot("chart-qc-plant", [
    {type:"bar",     name:"Value (ETB)", x:plantQC.map(r=>r["Plant Name"]), y:plantQC.map(r=>r.val), yaxis:"y",  marker:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>"},
    {type:"scatter", mode:"lines+markers", name:"Qty", x:plantQC.map(r=>r["Plant Name"]), y:plantQC.map(r=>r.qty), yaxis:"y2", marker:{color:"#3fb950",size:8}, line:{color:"#3fb950"}, hovertemplate:"<b>%{x}</b><br>Qty: %{y:,.0f}<extra></extra>"},
  ], pl({height:280,margin:{l:20,r:60,t:20,b:80},yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#3fb950"}}}), PLOTLY_CONFIG);

  const qcCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name",                  label:"Material Group"},
    {key:"_plantList",                           label:"Plant(s)"},
    {key:"_expiryStr",                           label:"Shelf Life Expiry"},
    {key:"Stock in Quality Inspection",          label:"QC Qty",        fmt:fmtQty, rawKey:"Stock in Quality Inspection", cellClass:"col-qty"},
    {key:"Value of Stock in Quality Inspection", label:"QC Value (ETB)",fmt:fmtETB, rawKey:"Value of Stock in Quality Inspection", cellClass:"col-val"},
  ];

  const qcRows = sortBy(
    [...df].map(r => ({
      ...r,
      _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : "",
    })),
    "Value of Stock in Quality Inspection"
  );
  document.getElementById("qc-table-wrap").innerHTML = buildTable(qcRows, qcCols, r => r["Value of Stock in Quality Inspection"] > 10000 ? "row-red" : "");
  document.getElementById("btn-dl-qc").onclick      = () => downloadCSV(qcRows,   qcCols, "qc_inspection.csv");
  document.getElementById("btn-dl-qc-xlsx").onclick = () => downloadExcel(qcRows, qcCols, "qc_inspection.xlsx");
}

// ═══════════════════════════════════════════════════════════════════════════
// BRANCH COMPARISON
// ═══════════════════════════════════════════════════════════════════════════
function renderBranch() {
  // BUG-BRANCH-1 FIX: Use baseDf (pre-aggregation, one row per plant per material)
  // for branch totals and matPlantMap. aggregateByMaterial collapses all plants into
  // a single row per material so it CANNOT be used for per-branch breakdowns.
  // aggregateByMaterial is still used for the material tab (Tab 2) display only.
  const baseDf = applyPageFilter("branch");

  renderPhantomAlert("branch-phantom-alert", baseDf);

  // Detect central branch from raw (multi-plant) data
  const plants = [...new Set(baseDf.map(r => String(r["Plant"]).toUpperCase()))];
  // BUG-FIX-6: centralCode was computed but never read anywhere — removed dead variable.
  // All downstream logic uses centralName (the display name).
  let centralName;
  if (plants.includes("HO01")) {
    centralName = baseDf.find(r => String(r["Plant"]).toUpperCase() === "HO01")?.["Plant Name"] || "HO01";
    document.getElementById("branch-central-info").style.display = "none";
  } else {
    const totals = {};
    baseDf.forEach(r => { const p = r["Plant Name"]; totals[p] = (totals[p] || 0) + r["Total Value"]; });
    centralName = Object.entries(totals).sort((a,b) => b[1]-a[1])[0]?.[0] || "";
    document.getElementById("branch-central-info").style.display = "block";
    document.getElementById("branch-central-info").innerHTML = `ℹ️ HO01 not found — using <b>${escHtml(centralName)}</b> as central branch (highest inventory value).`;
  }

  // Build per-branch aggregation from baseDf (correct: each row is one plant)
  // FIX-BRANCH-ITEMS: track unique materials per branch using a Set, not a raw row counter.
  // The old Items++ counted one per storage-location row, inflating counts by 1.5×–2.6×.
  const aggMap = {};
  const aggMatSets = {}; // separate Sets to count unique materials without mutating aggMap
  baseDf.forEach(r => {
    const k = r["Plant Name"];
    if (!aggMap[k]) { aggMap[k] = {PlantName:k,Plant:r["Plant"],TotalValue:0,Unrestricted:0,Transit:0,QC:0,UnrestrictedQty:0,TransitQty:0,QCQty:0,Items:0}; aggMatSets[k] = new Set(); }
    aggMap[k].TotalValue      += r["Total Value"];
    aggMap[k].Unrestricted    += r["Value of Unrestricted Stock"];
    // FIX-PHANTOM-BRANCH: exclude phantom (no PO/supplying plant) transit from branch totals
    const phantomVal = r._phantomTransitVal || 0;
    const phantomQty = r._phantomTransitQty || 0;
    aggMap[k].Transit         += r["Value of Stock in Transit"] - phantomVal;
    aggMap[k].QC              += r["Value of Stock in Quality Inspection"];
    aggMap[k].UnrestrictedQty += r["Unrestricted Stock"];
    aggMap[k].TransitQty      += r["Stock in Transit"] - phantomQty;
    aggMap[k].QCQty           += r["Stock in Quality Inspection"];
    aggMatSets[k].add(String(r["Material"]));
  });
  // Assign correct unique-material counts after accumulation
  Object.keys(aggMap).forEach(k => { aggMap[k].Items = aggMatSets[k].size; });
  const branchAgg = Object.values(aggMap);
  const others    = branchAgg.map(r => r.PlantName).filter(b => b !== centralName);

  // BUG-BRANCH-1 FIX: Build matPlantMap from baseDf so every (material, plant) pair
  // is a separate bucket. Using aggregated df would give only one plant per material.
  const matPlantMap = {};
  baseDf.forEach(r => {
    const mat = r["Material"], pln = r["Plant Name"];
    if (!matPlantMap[mat]) {
      matPlantMap[mat] = {
        desc:  r["Material Description"],
        group: r["Material Group Name"],
      };
    }
    if (!matPlantMap[mat][pln]) matPlantMap[mat][pln] = {Unrestricted:0,Transit:0,QC:0,TotalValue:0,TotalQty:0,UnrestrictedQty:0,TransitQty:0,QCQty:0};
    matPlantMap[mat][pln].Unrestricted    += r["Value of Unrestricted Stock"];
    // FIX-PHANTOM-BRANCH: exclude phantom transit from per-material-per-branch data
    const phantomVal = r._phantomTransitVal || 0;
    const phantomQty = r._phantomTransitQty || 0;
    matPlantMap[mat][pln].Transit         += r["Value of Stock in Transit"] - phantomVal;
    matPlantMap[mat][pln].QC             += r["Value of Stock in Quality Inspection"];
    matPlantMap[mat][pln].TotalValue      += r["Total Value"];
    // BUG-BRANCH-2 FIX: TotalQty is derived — recompute rather than accumulate
    matPlantMap[mat][pln].UnrestrictedQty += r["Unrestricted Stock"];
    matPlantMap[mat][pln].TransitQty      += r["Stock in Transit"] - phantomQty;
    matPlantMap[mat][pln].QCQty           += r["Stock in Quality Inspection"];
    matPlantMap[mat][pln].TotalQty        = matPlantMap[mat][pln].UnrestrictedQty
                                          + matPlantMap[mat][pln].TransitQty
                                          + matPlantMap[mat][pln].QCQty;
  });
  // aggregated df is still needed for the material-level Tab 2 table display
  const df = aggregateByMaterial(baseDf);

  const tabsHtml = `
    <div class="branch-tabs" id="branch-tabs">
      <button class="branch-tab active" data-tab="value">📊 Total Value &amp; Quantity</button>
      <button class="branch-tab" data-tab="material">🔬 Line-Item (Material Across Branches)</button>
    </div>
    <div id="branch-tab-value"></div>
    <div id="branch-tab-material" style="display:none"></div>`;
  document.getElementById("branch-tabs-wrap").innerHTML = tabsHtml;

  document.querySelectorAll(".branch-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".branch-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document.getElementById("branch-tab-value").style.display    = tab === "value"    ? "block" : "none";
      document.getElementById("branch-tab-material").style.display = tab === "material" ? "block" : "none";
      if (tab === "material") renderMaterialTab();
    });
  });

  // FIX-R7: replaced native <select multiple> with buildMultiSelect for UX consistency.
  const branchWrapId = "ms-branch-select";
  const branchDdId   = "ms-branch-select-dd";
  buildMultiSelect(branchWrapId, branchDdId, others, "All Branches");
  // Pre-select all branches so the chart renders immediately without requiring user interaction.
  // FIX-BRANCH-PRESELECT: buildMultiSelect leaves checkboxes unchecked by default.
  // We must explicitly check them so _getSelected() returns all branches on first render.
  const branchWrap = document.getElementById(branchWrapId);
  setTimeout(() => {
    const branchDd = document.getElementById(branchDdId);
    if (branchDd) {
      branchDd.querySelectorAll("input[type=checkbox]").forEach(cb => { cb.checked = true; });
      // Trigger label update if the buildMultiSelect exposed it (call the internal updateLabel via change event)
      branchDd.querySelectorAll("input[type=checkbox]").forEach(cb => cb.dispatchEvent(new Event("change")));
    }
  }, 0);

  function getSelectedBranches() {
    if (!branchWrap || !branchWrap._getSelected) return others;
    const sel = branchWrap._getSelected();
    // FIX-BRANCH-DEFAULT: if nothing is checked (e.g. before user interaction), show all branches
    return sel.length > 0 ? sel : others;
  }

  // ── TAB 1: Total Value ──
  function updateBranchCharts() {
    const selected = getSelectedBranches();
    const wrap     = document.getElementById("branch-tab-value");
    if (!selected.length) { wrap.innerHTML = `<div class="alert-warning">⚠️ Select at least one branch.</div>`; return; }
    const compareNames = [centralName, ...selected];
    const compareDf    = branchAgg.filter(r => compareNames.includes(r.PlantName));

    const bCols = [
      {key:"PlantName",       label:"Plant Name"},
      {key:"TotalValue",      label:"Total Value (ETB)",    fmt:fmtETB, rawKey:"TotalValue"},
      {key:"Unrestricted",    label:"Unrestricted (ETB)",   fmt:fmtETB, rawKey:"Unrestricted"},
      {key:"UnrestrictedQty", label:"Avail Qty",            fmt:fmtQty, rawKey:"UnrestrictedQty", cellClass:"col-qty"},
      {key:"Transit",         label:"Transit (ETB)",        fmt:fmtETB, rawKey:"Transit"},
      {key:"TransitQty",      label:"Transit Qty",          fmt:fmtQty, rawKey:"TransitQty",      cellClass:"col-qty"},
      {key:"QC",              label:"QC (ETB)",             fmt:fmtETB, rawKey:"QC"},
      {key:"QCQty",           label:"QC Qty",               fmt:fmtQty, rawKey:"QCQty",           cellClass:"col-qty"},
      {key:"Items",           label:"# Unique Materials"},
    ];
    wrap.innerHTML = `
      <div id="branch-chart-wrap" style="margin-bottom:1.2rem"></div>
      <div id="branch-table-wrap-inner" style="margin-bottom:1rem">${buildTable(compareDf, bCols, r => r.PlantName === centralName ? "row-blue" : "")}</div>`;
    document.getElementById("btn-dl-branch-csv").onclick  = () => downloadCSV(compareDf,   bCols, "branch_comparison.csv");
    document.getElementById("btn-dl-branch-xlsx").onclick = () => downloadExcel(compareDf, bCols, "branch_comparison.xlsx");

    // BUG-BRANCH-CHART FIX: render a grouped bar chart comparing branches by value category
    const sorted = [...compareDf].sort((a,b) => {
      if (a.PlantName === centralName) return -1;
      if (b.PlantName === centralName) return 1;
      return b.TotalValue - a.TotalValue;
    });
    Plotly.newPlot("branch-chart-wrap", [
      { type:"bar", name:"Unrestricted (ETB)", x:sorted.map(r=>r.PlantName), y:sorted.map(r=>r.Unrestricted), marker:{color:"#3fb950"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
      { type:"bar", name:"In Transit (ETB)",   x:sorted.map(r=>r.PlantName), y:sorted.map(r=>r.Transit),      marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
      { type:"bar", name:"In QC (ETB)",        x:sorted.map(r=>r.PlantName), y:sorted.map(r=>r.QC),           marker:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
    ], pl({ height:300, barmode:"stack", margin:{l:20,r:20,t:30,b:100},
      title:{text:"Inventory Value by Branch", font:{color:"#8b949e",size:13}} }), PLOTLY_CONFIG);
  }

  // ── TAB 2: Material Across Branches ──
  // FIX-BRANCH-TAB2-FILTER: matTabInitialized only guards the one-time UI scaffold build.
  // It must NOT block re-render when the MG filter in Tab 1 changes; we reset it on
  // every renderBranch() call (renderMaterialTab is called fresh each time the tab is opened).
  let matTabInitialized = false;
  function renderMaterialTab() {
    const wrap         = document.getElementById("branch-tab-material");
    // BUG-BRANCH-3 FIX: use baseDf to enumerate plant names — df (aggregated) may
    // collapse multi-plant materials to a single plant, hiding some branch columns.
    const allPlantNames = [...new Set(baseDf.map(r => r["Plant Name"]))].sort((a,b) => {
      if (a === centralName) return -1; if (b === centralName) return 1; return a.localeCompare(b);
    });

    if (!matTabInitialized) {
      matTabInitialized = true;
      // FIX-BRANCH-MG: use baseDf (not aggregated df) so all material groups are available
      const mgNamesForFilter = [...new Set(baseDf.map(r => r["Material Group Name"]))].filter(Boolean).filter(name => !isNonMedicalGroup(name)).sort();
      // Build list of all materials for the multi-select
      const allMatOptions = [...new Set(baseDf.map(r => {
        const code = String(r["Material"] || "").trim();
        const desc = String(r["Material Description"] || "").trim();
        return code + (desc && desc !== code ? " — " + desc : "");
      }))].filter(Boolean).sort();

      wrap.innerHTML = `
        <div style="display:flex;gap:0.8rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:1rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0.8rem">
          <div>
            <div class="nav-label" style="font-size:0.65rem;margin-bottom:3px">Material</div>
            <div class="ms-wrap" id="mat-ms-wrap" style="min-width:260px"><button class="ms-btn" type="button">All Materials <span class="ms-arrow">▾</span></button><div class="ms-dropdown" id="mat-ms-dd"></div></div>
          </div>
          <div>
            <div class="nav-label" style="font-size:0.65rem;margin-bottom:3px">Metric</div>
            <select id="mat-metric" style="background:var(--surface2);border:1px solid var(--border2);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px">
              <option value="TotalValue">Total Value (ETB)</option>
              <option value="Unrestricted">Unrestricted Value (ETB)</option>
              <option value="Transit">Transit Value (ETB)</option>
              <option value="QC">QC Value (ETB)</option>
              <option value="TotalQty">Total Quantity</option>
              <option value="UnrestrictedQty">Available Quantity</option>
              <option value="TransitQty">Transit Quantity</option>
              <option value="QCQty">QC Quantity</option>
            </select>
          </div>
          <div>
            <div class="nav-label" style="font-size:0.65rem;margin-bottom:3px">Material Group</div>
            <select id="mat-mgfilter" style="background:var(--surface2);border:1px solid var(--border2);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px">
              <option value="">All Material Groups</option>
              ${mgNamesForFilter.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join("")}
            </select>
          </div>
          <div>
            <div class="nav-label" style="font-size:0.65rem;margin-bottom:3px">Sort By</div>
            <select id="mat-sort" style="background:var(--surface2);border:1px solid var(--border2);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px">
              <option value="total_desc">Highest Total ↓</option>
              <option value="total_asc">Lowest Total ↑</option>
              <option value="desc_asc">Description A–Z</option>
              <option value="spread_desc">Most Branches ↓</option>
            </select>
          </div>
          <button id="mat-apply" class="apply-btn">Apply</button>
          <button id="mat-dl-csv" class="dl-btn">⬇ CSV</button>
          <button id="mat-dl-xlsx" class="dl-btn">⬇ Excel</button>
        </div>
        <div id="mat-chart-wrap" style="margin-bottom:1rem"></div>
        <div id="mat-table-wrap"></div>`;
      document.getElementById("mat-apply").addEventListener("click", refreshMaterialView);
      // Build the material multi-select after HTML is in DOM
      buildMultiSelect("mat-ms-wrap", "mat-ms-dd", allMatOptions, "All Materials");
    }
    refreshMaterialView();

    function refreshMaterialView() {
      const matWrap   = document.getElementById("mat-ms-wrap");
      const selected  = (matWrap && matWrap._getSelected) ? matWrap._getSelected() : [];
      // selected values are "CODE — DESC" or just "CODE"; extract the code part before " — "
      const selCodes  = selected.map(v => v.split(" — ")[0].trim().toLowerCase());
      const metric    = document.getElementById("mat-metric").value;
      const sortMode  = document.getElementById("mat-sort").value;
      const mgFilter  = document.getElementById("mat-mgfilter").value;
      const isQty     = metric.includes("Qty");
      const fmtFn     = isQty ? fmtQty : fmtETB;

      let materials = Object.entries(matPlantMap)
        .filter(([mat, info]) => {
          if (mgFilter && info.group !== mgFilter) return false;
          if (selCodes.length > 0) {
            // Multi-select: match if material code is one of the selected codes
            return selCodes.includes(mat.toLowerCase());
          }
          return true;
        })
        .map(([mat, info]) => {
          const plantData = {};
          let grandTotal = 0, branchCount = 0;
          allPlantNames.forEach(pn => {
            const v = info[pn] ? info[pn][metric] : 0;
            plantData[pn] = v || 0;
            grandTotal   += plantData[pn];
            if ((info[pn]?.TotalValue || 0) > 0) branchCount++;
          });
          return {mat, desc:info.desc, group:info.group, plantData, grandTotal, branchCount};
        });

      if (sortMode === "total_desc") materials.sort((a,b) => b.grandTotal - a.grandTotal);
      if (sortMode === "total_asc")  materials.sort((a,b) => a.grandTotal - b.grandTotal);
      if (sortMode === "desc_asc")   materials.sort((a,b) => a.desc.localeCompare(b.desc));
      if (sortMode === "spread_desc")materials.sort((a,b) => b.branchCount - a.branchCount);

      const top      = materials.slice(0, 30);
      const chartWrap = document.getElementById("mat-chart-wrap");
      if (!top.length) {
        chartWrap.innerHTML = "";
        document.getElementById("mat-table-wrap").innerHTML = `<div class="alert-info">No materials found.</div>`;
        return;
      }
      chartWrap.innerHTML = "";

      const colDefs = [
        {key:"mat",  label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
        {key:"desc", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
        {key:"group",label:"Material Group"},
        ...allPlantNames.map(pn => ({key:`__p__${pn}`, label:pn, fmt:fmtFn, rawKey:`__r__${pn}`, cellClass:isQty?"col-qty":"col-val"})),
        {key:"grandTotal",  label:"Grand Total", fmt:fmtFn, rawKey:"grandTotal", cellClass:isQty?"col-qty":"col-val"},
        {key:"branchCount", label:"# Branches"},
      ];
      const tableRows = materials.slice(0, 200).map(m => {
        const row = {mat:m.mat, desc:m.desc, group:m.group, grandTotal:m.grandTotal, branchCount:m.branchCount};
        allPlantNames.forEach(pn => { row[`__p__${pn}`] = m.plantData[pn] || 0; row[`__r__${pn}`] = m.plantData[pn] || 0; });
        row["__r__grandTotal"] = m.grandTotal;
        return row;
      });

      const centralKey = `__p__${centralName}`;
      const thead = `<thead><tr>${colDefs.map(c =>
        `<th${c.key === centralKey ? ' style="color:#58a6ff;background:#0d2035"' : ""}>${escHtml(c.label)}</th>`
      ).join("")}</tr></thead>`;
      const tbody = tableRows.map(r => {
        const cells = colDefs.map(c => {
          const v       = r[c.key];
          const raw     = c.raw ? v : null;           // raw HTML — don't escape
          const display = raw != null ? (raw ?? "")
                        : c.fmt ? c.fmt(v)
                        : (v == null ? "" : escHtml(String(v)));
          const isZero  = typeof v === "number" && v === 0;
          const style   = c.key === centralKey ? 'style="color:#58a6ff;background:#0d2035"' : isZero ? 'style="color:#484f58"' : "";
          const cls     = c.cellClass || "";
          return `<td class="${cls}" ${style}>${display}</td>`;
        }).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      document.getElementById("mat-table-wrap").innerHTML = `
        <div style="color:var(--muted);font-size:12px;margin-bottom:6px">Showing ${tableRows.length} of ${materials.length} materials · Blue = Central (${escHtml(centralName)})</div>
        <div class="tbl-wrap"><table>${thead}<tbody>${tbody}</tbody></table></div>
        ${materials.length > 200 ? `<div class="alert-info">Showing first 200 of ${materials.length}. Refine search.</div>` : ""}`;

      const flatCols = [
        {key:"mat", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"}, {key:"desc", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"}, {key:"group",label:"Material Group"},
        ...allPlantNames.map(pn => ({key:`__p__${pn}`, label:pn, rawKey:`__r__${pn}`})),
        {key:"grandTotal",label:"Grand Total"},
      ];
      const btnCsv  = document.getElementById("mat-dl-csv");
      const btnXlsx = document.getElementById("mat-dl-xlsx");
      if (btnCsv)  btnCsv.onclick  = () => downloadCSV(tableRows,   flatCols, "materials_by_branch.csv");
      if (btnXlsx) btnXlsx.onclick = () => downloadExcel(tableRows, flatCols, "materials_by_branch.xlsx");
    }
  }

  // FIX-LISTENER: use onclick (not addEventListener) so re-renders don't stack listeners
  const branchApplyBtn = document.getElementById("branch-select-apply");
  if (branchApplyBtn) branchApplyBtn.onclick = updateBranchCharts;
  updateBranchCharts();
}

// ═══════════════════════════════════════════════════════════════════════════
// INVENTORY FLOW
// ═══════════════════════════════════════════════════════════════════════════
function renderFlow() {
  const df = applyPageFilter("flow");

  renderPhantomAlert("flow-phantom-alert", df);

  const totalVal   = df.reduce((s,r) => s + r["Total Value"], 0);
  const transitVal = df.reduce((s,r) => s + r["Value of Stock in Transit"], 0);
  const qcVal      = df.reduce((s,r) => s + r["Value of Stock in Quality Inspection"], 0);
  const availVal   = df.reduce((s,r) => s + r["Value of Unrestricted Stock"], 0);
  const totalQty   = df.reduce((s,r) => s + r["Total Qty"], 0);
  const availQty   = df.reduce((s,r) => s + r["Unrestricted Stock"], 0);

  // FIX-PHANTOM-FLOW: for reorder alerts, only count non-phantom transit as "incoming"
  const reorderItems = df.filter(r => r["Unrestricted Stock"] === 0 && (
    (r["Stock in Transit"] > 0 && !(r._phantomTransitQty > 0)) ||
    r["Stock in Quality Inspection"] > 0
  ));

  setKpis("flow-kpis", [
    ["Total Inventory",      fmtETB(totalVal),   `${fmtQty(totalQty)} units`,               "blue"],
    ["Available Stock",      fmtETB(availVal),   `${fmtQty(availQty)} units unrestricted`,   "green"],
    ["In Transit (Inbound)", fmtETB(transitVal), `${fmtQty(df.reduce((s,r) => s+r["Stock in Transit"],0))} units`, "amber"],
    ["In QC",                fmtETB(qcVal),      `${fmtQty(df.reduce((s,r) => s+r["Stock in Quality Inspection"],0))} units`, "red"],
    ["Reorder Alerts",       String(reorderItems.length), "Zero unrestricted stock", "red"],
  ]);

  const reorderCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name",       label:"Material Group"},
    {key:"Plant Name",                label:"Plant"},
    {key:"Unrestricted Stock",        label:"Avail Qty",        fmt:fmtQty, rawKey:"Unrestricted Stock",        cellClass:"col-qty"},
    {key:"Stock in Transit",          label:"In Transit",        fmt:fmtQty, rawKey:"Stock in Transit",          cellClass:"col-qty"},
    {key:"Stock in Quality Inspection",label:"In QC",           fmt:fmtQty, rawKey:"Stock in Quality Inspection",cellClass:"col-qty"},
    {key:"Value of Stock in Transit", label:"Transit Value (ETB)",fmt:fmtETB,rawKey:"Value of Stock in Transit", cellClass:"col-val"},
    {key:"_purDoc",                   label:"Purchasing Document"},
    {key:"_supPlant",                 label:"Supplying Plant"},
    {key:"_alert",                    label:"Alert", raw:true},
  ];
  const reorderRows = reorderItems.map(r => {
    const info = getTransitInfo(r["Material"], r["Plant"]);
    return {
      ...r,
      _purDoc:   info.purDoc,
      _supPlant: info.supPlant,
      _alert: r["Stock in Transit"] > 0 && r["Stock in Quality Inspection"] > 0
        ? "<span class='badge badge-red'>Transit+QC</span>"
        : r["Stock in Transit"] > 0
        ? "<span class='badge badge-amber'>Awaiting Transit</span>"
        : "<span class='badge badge-amber'>Awaiting QC Release</span>",
    };
  });
  document.getElementById("reorder-table-wrap").innerHTML = reorderRows.length
    ? buildTable(reorderRows, reorderCols, () => "row-amber")
    : `<div class="alert-info">✓ No reorder alerts — all materials have available unrestricted stock.</div>`;

  // Stock levels chart
  const plantAgg = sortBy(
    groupBy(df, "Plant Name", [["avail","Unrestricted Stock"],["transit","Stock in Transit"],["qc","Stock in Quality Inspection"]]),
    "avail"
  );
  Plotly.newPlot("chart-stock-levels", [
    {type:"bar", name:"Available",  x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.avail),  marker:{color:"#3fb950"}},
    {type:"bar", name:"In Transit", x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.transit), marker:{color:"#d29922"}},
    {type:"bar", name:"In QC",      x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.qc),     marker:{color:"#f85149"}},
  ], pl({height:300,barmode:"stack",margin:{l:20,r:20,t:20,b:80}}), PLOTLY_CONFIG);

  // Inter-location transfers
  const transferCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Plant Name",                label:"Receiving Plant"},
    {key:"_purDoc",                   label:"Purchasing Document"},
    {key:"_supPlant",                 label:"Supplying Plant"},
    {key:"Stock in Transit",          label:"Transit Qty",        fmt:fmtQty, rawKey:"Stock in Transit",          cellClass:"col-qty"},
    {key:"Value of Stock in Transit", label:"Transit Value (ETB)",fmt:fmtETB, rawKey:"Value of Stock in Transit", cellClass:"col-val"},
  ];
  // FIX-PHANTOM-FLOW: exclude phantom transit (no PO/supplying plant) from transfer table
  const transferRows = sortBy(df.filter(r => r["Stock in Transit"] > 0 && !(r._phantomTransitQty > 0)), "Value of Stock in Transit").map(r => {
    const info = getTransitInfo(r["Material"], r["Plant"]);
    return { ...r, _purDoc: info.purDoc, _supPlant: info.supPlant };
  });
  document.getElementById("transfer-table-wrap").innerHTML = transferRows.length
    ? buildTable(transferRows, transferCols)
    : `<div class="alert-info">No inter-location transfers currently in progress.</div>`;

  // Inbound vs available chart
  const inboundAgg = sortBy(
    groupBy(df.filter(r => r["Stock in Transit"] > 0), "Plant Name", [["avail","Unrestricted Stock"],["inbound","Stock in Transit"]]),
    "inbound"
  );
  if (inboundAgg.length) {
    Plotly.newPlot("chart-inbound-outbound", [
      {type:"bar", name:"Available Stock", x:inboundAgg.map(r=>r["Plant Name"]), y:inboundAgg.map(r=>r.avail),   marker:{color:"#3fb950"}},
      {type:"bar", name:"Inbound Transit", x:inboundAgg.map(r=>r["Plant Name"]), y:inboundAgg.map(r=>r.inbound), marker:{color:"#d29922"}},
    ], pl({height:280,barmode:"group",margin:{l:20,r:20,t:20,b:80}}), PLOTLY_CONFIG);
  } else {
    document.getElementById("chart-inbound-outbound").innerHTML = `<div class="alert-info">No transit data to chart.</div>`;
  }

  const flowDlCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Plant Name",                        label:"Plant"},
    {key:"Material Group Name",               label:"Material Group"},
    {key:"Unrestricted Stock",                label:"Available Qty",      rawKey:"Unrestricted Stock"},
    {key:"Stock in Transit",                  label:"Transit Qty",        rawKey:"Stock in Transit"},
    {key:"Stock in Quality Inspection",       label:"QC Qty",             rawKey:"Stock in Quality Inspection"},
    {key:"Value of Unrestricted Stock",       label:"Available Value (ETB)",rawKey:"Value of Unrestricted Stock"},
    {key:"Value of Stock in Transit",         label:"Transit Value (ETB)",rawKey:"Value of Stock in Transit"},
  ];
  document.getElementById("btn-dl-flow-csv").onclick  = () => downloadCSV(df,   flowDlCols, "inventory_flow.csv");
  document.getElementById("btn-dl-flow-xlsx").onclick = () => downloadExcel(df, flowDlCols, "inventory_flow.xlsx");
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA PREVIEW
// ═══════════════════════════════════════════════════════════════════════════
function renderPreview() {
  filtDf = getReconciledBase();
  populatePreviewFilters();
  renderPreviewTable();
}

function populatePreviewFilters() {
  function fill(id, key, excludeFn) {
    const sel = document.getElementById(id); if (!sel) return;
    const vals = [...new Set(rawDf.map(r => r[key]))]
      .filter(Boolean)
      .filter(v => !excludeFn || !excludeFn(v))
      .sort();
    sel.innerHTML = vals.map(v => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join("");
  }
  fill("filter-plant",  "Plant Name",         null);
  fill("filter-mg",     "Material Group Name", isNonMedicalGroup);
  fill("filter-mgname", "Material Group Name", isNonMedicalGroup);

  // Valuation type: extract unique suffixes from the dataset
  const vtSel = document.getElementById("filter-valtype");
  if (vtSel) {
    const valTypes = [...new Set(rawDf.map(r => getValuationType(r)))]
      .filter(v => v && v !== "(None)")
      .sort();
    vtSel.innerHTML = valTypes.map(v => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join("");
  }
}

function applyPreviewFilters() {
  const baseDf     = getReconciledBase();
  const getSelected = id => [...document.querySelectorAll(`#${id} option:checked`)].map(o => o.value);
  const plants      = getSelected("filter-plant");
  const mgs         = getSelected("filter-mg");
  const mgnames     = getSelected("filter-mgname");
  const valTypes    = getSelected("filter-valtype");
  filtDf = baseDf.filter(r =>
    (!plants.length    || plants.includes(r["Plant Name"])) &&
    // BUG-FIX-5: filter-mg and filter-mgname both reference "Material Group Name".
    // Using AND means selecting a value in one but not the other yields no results.
    // Fix: treat them as a union — a row passes if it matches either selection
    // (or neither selection has any values chosen).
    ((!mgs.length && !mgnames.length) ||
      mgs.includes(r["Material Group Name"]) ||
      mgnames.includes(r["Material Group Name"])) &&
    (!valTypes.length  || valTypes.includes(getValuationType(r)))
  );
  renderPreviewTable();
}

function renderPreviewTable() {
  const df = filtDf;
  setKpis("preview-kpis", [
    ["Total Records",    df.length.toLocaleString(),                            "After filtering",           "blue"],
    ["Unique Materials", new Set(df.map(r=>r["Material"])).size.toLocaleString(),"Distinct SKUs",            "green"],
    ["Total Plants",     new Set(df.map(r=>r["Plant"])).size.toLocaleString(),   "Stocking locations",       "amber"],
    ["Material Groups",  new Set(df.map(r=>r["Material Group Name"])).size.toLocaleString(),"Therapeutic categories","purple"],
  ]);
  document.getElementById("preview-count").innerHTML = `Showing <b>${df.length.toLocaleString()}</b> of <b>${rawDf.length.toLocaleString()}</b> records`;

  const cols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Plant Name",                        label:"Plant"},
    {key:"Material Group Name",               label:"Material Group"},
    {key:"Unrestricted Stock",                label:"Avail Qty",        fmt:fmtQty, rawKey:"Unrestricted Stock",          cellClass:"col-qty"},
    {key:"Stock in Transit",                  label:"Transit Qty",      fmt:fmtQty, rawKey:"Stock in Transit",            cellClass:"col-qty"},
    {key:"Stock in Quality Inspection",       label:"QC Qty",           fmt:fmtQty, rawKey:"Stock in Quality Inspection", cellClass:"col-qty"},
    {key:"Value of Unrestricted Stock",       label:"Avail Value (ETB)",fmt:fmtETB, rawKey:"Value of Unrestricted Stock", cellClass:"col-val"},
    {key:"Value of Stock in Transit",         label:"Transit Value (ETB)",fmt:fmtETB,rawKey:"Value of Stock in Transit",  cellClass:"col-val"},
    {key:"Value of Stock in Quality Inspection",label:"QC Value (ETB)", fmt:fmtETB, rawKey:"Value of Stock in Quality Inspection",cellClass:"col-val"},
    {key:"Total Value",                       label:"Total Value (ETB)",fmt:fmtETB, rawKey:"Total Value",                 cellClass:"col-val"},
    {key:"_expiryStr",                        label:"Expiry Date"},
  ];

  // FIX BUG-1: display rows are sliced to 500 for the table, but download rows
  // use the FULL filtered dataset so the export is never silently truncated.
  const displayRows  = df.slice(0, 500).map(r => ({...r, _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : ""}));
  const downloadRows = df.map(r => ({...r, _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : ""}));

  document.getElementById("preview-table-wrap").innerHTML =
    buildTable(displayRows, cols) +
    (df.length > 500
      ? `<div class="alert-warning">⚠️ Showing first 500 of ${df.length.toLocaleString()} records. Downloads include all ${df.length.toLocaleString()} rows.</div>`
      : "");

  // FIX BUG-1: wire download buttons to downloadRows (full set)
  document.getElementById("btn-dl-preview").onclick      = () => downloadCSV(downloadRows,   cols, "pharma_inventory_filtered.csv");
  document.getElementById("btn-dl-preview-xlsx").onclick = () => downloadExcel(downloadRows, cols, "pharma_inventory_filtered.xlsx");
}

// ═══════════════════════════════════════════════════════════════════════════
// AGGREGATE BY MATERIAL (used by QC and Branch Comparison)
// ═══════════════════════════════════════════════════════════════════════════
// Collapses multiple rows with the same material code into ONE row per
// material, summing all qty and value columns and keeping the earliest expiry.
// Also builds a "_plantList" string of all plants stocking the material.

function aggregateByMaterial(df) {
  // NOTE: Total Qty is intentionally excluded from QTY_COLS — it is a derived
  // sum (Unrestricted + Transit + QC) and must be recomputed after aggregation,
  // not accumulated directly (which would double-count it).
  const QTY_COLS = [
    "Unrestricted Stock", "Stock in Quality Inspection",
    "Blocked Stock",      "Stock in Transit",
  ];
  const VAL_COLS = [
    "Value of Unrestricted Stock",
    "Value of Stock in Quality Inspection",
    "Value of Stock in Transit",
    // BUG-FIX-4: "Total Value" removed — it is recomputed from components below
    // (line ~2081). Accumulating it here then overwriting it was wasted work and
    // would double-count if the recompute step were ever skipped.
  ];

  // Group all rows by Material code
  const matMap = {}; // materialCode → aggregated row

  df.forEach(row => {
    const mat = row["Material"];
    if (!mat) return;

    if (!matMap[mat]) {
      matMap[mat] = {
        ...row,
        _allPlants: [],
      };
      if (row["Plant Name"]) matMap[mat]._allPlants.push(row["Plant Name"]);
    } else {
      const target = matMap[mat];
      QTY_COLS.forEach(c => { target[c] = (target[c] || 0) + (row[c] || 0); });
      VAL_COLS.forEach(c => { target[c] = (target[c] || 0) + (row[c] || 0); });
      // Keep earliest expiry
      const te = target["_expiry"], se = row["_expiry"];
      if (se instanceof Date && !isNaN(se)) {
        if (!(te instanceof Date) || isNaN(te) || se < te) target["_expiry"] = se;
      }
      if (row["Plant Name"] && !target._allPlants.includes(row["Plant Name"])) {
        target._allPlants.push(row["Plant Name"]);
      }
      if (!target["Material Group Name"] && row["Material Group Name"]) target["Material Group Name"] = row["Material Group Name"];
    }
  });

  // Recompute derived totals AFTER aggregation to prevent double-counting.
  // Total Qty / Total Value are sums of components — never accumulate directly.
  Object.values(matMap).forEach(row => {
    row["Total Qty"]   = (row["Unrestricted Stock"] || 0) + (row["Stock in Transit"] || 0) + (row["Stock in Quality Inspection"] || 0);
    row["Total Value"] = (row["Value of Unrestricted Stock"] || 0) + (row["Value of Stock in Transit"] || 0) + (row["Value of Stock in Quality Inspection"] || 0);
    const plants = (row._allPlants || []).filter(Boolean).sort();
    row["_plantList"] = plants.length ? plants.join(", ") : (row["Plant Name"] || "—");
  });

  return Object.values(matMap);
}

// ═══════════════════════════════════════════════════════════════════════════
// HOME PAGE
// ═══════════════════════════════════════════════════════════════════════════
function renderHome() {
  // Module cards navigate to their respective page (only if data loaded)
  document.querySelectorAll(".home-module-card[data-page]").forEach(card => {
    card.onclick = () => {
      const target = card.dataset.page;
      if (!rawDf.length) {
        // No file yet — briefly highlight the upload button
        const uploadBtn = document.querySelector(".upload-btn");
        if (uploadBtn) {
          uploadBtn.style.borderColor = "var(--amber)";
          uploadBtn.style.boxShadow   = "0 0 0 3px rgba(210,153,34,0.25)";
          setTimeout(() => {
            uploadBtn.style.borderColor = "";
            uploadBtn.style.boxShadow   = "";
          }, 1600);
        }
        return;
      }
      renderPage(target);
    };
  });

  // Show summary KPIs if data is already loaded
  const kpiRow = document.getElementById("home-kpis");
  if (!rawDf.length) {
    kpiRow.style.display = "none";
    return;
  }
  kpiRow.style.display = "";

  const base       = getReconciledBase();
  const totalVal   = base.reduce((s,r) => s + r["Total Value"], 0);
  const totalQty   = base.reduce((s,r) => s + r["Total Qty"],   0);
  const transitVal = base.reduce((s,r) => s + r["Value of Stock in Transit"], 0);
  const qcVal      = base.reduce((s,r) => s + r["Value of Stock in Quality Inspection"], 0);

  const today      = new Date();
  const in90       = new Date(); in90.setDate(in90.getDate() + 90);
  const expiryCount = base.filter(r =>
    r._expiry instanceof Date && !isNaN(r._expiry) &&
    r._expiry >= today && r._expiry <= in90 &&
    (r["Unrestricted Stock"] || 0) > 0
  ).length;

  setKpis("home-kpis", [
    ["Total Inventory Value",    fmtETB(totalVal),   `${fmtQty(totalQty)} units across all plants`,      "blue"],
    ["Stock in Transit",         fmtETB(transitVal), `Moving between locations`,                          "amber"],
    ["In Quality Inspection",    fmtETB(qcVal),      `Pending QC release`,                               "red"],
    ["Expiring within 90 Days",  expiryCount.toLocaleString() + " items", `Requiring urgent action`,     "purple"],
    ["Unique Materials",         new Set(base.map(r=>r["Material"])).size.toLocaleString(), `Across ${new Set(base.map(r=>r["Plant"])).size} plants`, "green"],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE SWITCHING
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// INCOMING SHELF LIFE — Received Goods File Loader
// Only HO01 plant, only ZME / ZMS / ZLC valuation types. ZMD excluded.
// ═══════════════════════════════════════════════════════════════════════════
function loadIncomingFile(file) {
  const statusEl = document.getElementById("incomingFileStatus");
  statusEl.style.display = "block";
  statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;

  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!data.length) { statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">⚠ File empty</div>`; return; }

        const trimmed = data.map(row => {
          const r = {};
          for (const [k, v] of Object.entries(row)) r[k.trim()] = v;
          return r;
        });

        // Filter: HO01 plant only, ZME/ZMS/ZLC only
        const ALLOWED_VT = ["ZME","ZMS","ZLC"];
        let rows = trimmed.filter(r => {
          const plant = String(r["Plant"] || "").trim().toUpperCase();
          if (plant !== "HO01") return false;
          // Extract suffix from Valuation Type (e.g. "51490_ZME" → "ZME")
          const vt = _islExtractVT(r);
          return ALLOWED_VT.includes(vt);
        });

        // Parse fields from received goods file.
        // ISSUE-1 FIX: Expiry Date comes from inventory (SAP master) during
        // _islCrossMatchInventory(). Posting Date and Valuation Type are
        // sourced from this file.
        rows.forEach(r => {
          r._postingDate = _islParseDate(r["Posting Date"]);
          r._vt          = _islExtractVT(r);
          // SL metrics computed in _islCrossMatchInventory once inventory
          // expiry dates are resolved; initialise to grey for safety
          r._slAtReceiptDays = null;
          r._receiptFlag     = "grey";
          r._remainingSL     = null;
          r._ratio           = null;
          r._flag            = "grey";
          r._isExpired       = false;
          r._dataError       = false;
          // Inventory enrichment fields — populated by _islCrossMatchInventory
          r._inv_plants   = "—";
          r._inv_slocs    = "—";
          r._inv_totalQty = 0;
          r._inv_expiryDate = null;
          r._inInventory    = null;
        });

        // Store all parsed HO01/ZME+ZMS+ZLC rows before cross-match
        incomingRaw = rows;
        // ISSUE-7 NOTE: .slice() is a shallow copy — the row objects
        // themselves are shared between incomingRaw and _incomingRawAll.
        // This is intentional/fine: _islCrossMatchInventory() mutates those
        // shared objects (_inv_*, _flag, etc.) in place, and _incomingRawAll
        // is fully reassigned (not appended to) on the next loadIncomingFile()
        // call, so stale references never leak across file loads.
        _incomingRawAll = rows.slice(); // preserve full list for re-matching

        // ISL-MATCH: cross-match against inventory — keep only rows whose
        // Material + Batch combination exists somewhere in rawDf (any branch),
        // enrich with inventory expiry/plant/qty, compute SL metrics, and
        // group duplicate receipts by Material+Batch (ISSUE-2).
        // Always run — even without inventory loaded yet — so grouping is
        // applied; re-matched again once inventory is uploaded (see
        // recomputeIslMatch).
        _islCrossMatchInventory();

        const n = incomingRaw.length;
        const loadedTotal = rows.length;
        const matchNote = rawDf.length
          ? ` · ${n.toLocaleString()} matched in inventory`
          : ` · Upload inventory to cross-match`;
        statusEl.innerHTML = `<div class="status-ok">✓ LOADED</div><div class="status-name">${escHtml(file.name)}</div><div class="status-name" style="color:var(--green)">${loadedTotal.toLocaleString()} records (HO01 / ZME+ZMS+ZLC)${matchNote}</div>`;
        document.getElementById("incomingUploadBtnText").textContent = `📥 ${file.name}`;

        // Populate filters
        _islPopulateFilters();

        document.getElementById("incoming-no-file").style.display = "none";
        document.getElementById("incoming-content").style.display = "block";

        // ISSUE-8 FIX: always go through renderPage so currentPage is set
        // consistently, regardless of which page we're currently on.
        renderPage("incoming");
      } catch(err) {
        statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">⚠ Error: ${escHtml(err.message)}</div>`;
      }
    }, 30);
  };
  reader.readAsArrayBuffer(file);
}

// =============================================================================
// ISL-MATCH: Cross-match received-goods rows against the main inventory.
//
// Business rule:
//   • Received goods file = HO01 receipts only (company's receiving plant).
//   • Inventory file      = all branches (HO01 + all distribution branches).
//   • A received row is valid only when its Material code AND Batch both
//     appear in at least one inventory row (any plant/branch).
//
// This ensures the shelf-life page shows only batches that are actually
// trackable in the current inventory snapshot — not historical receipts that
// have already been fully distributed and consumed.
//
// incomingRaw is mutated in-place: rows that have no matching inventory
// Material+Batch pair are removed.  The full pre-match list is preserved in
// _incomingRawAll so the match can be re-run after a fresh inventory upload.
// =============================================================================

let _incomingRawAll = [];   // full parsed HO01 list, unfiltered by inventory

/**
 * Builds a lookup from rawDf (all branches) keyed by "material||batch",
 * enriches each received-goods row with inventory-derived fields
 * (_inv_expiryDate, _inv_plants, _inv_slocs, _inv_totalQty), computes the
 * shelf-life metrics via _islCompute(), stamps r._inInventory, and finally
 * groups rows by Material+Batch (ISSUE-2 FIX) so duplicate/partial-delivery
 * receipts collapse into a single reference row per batch.
 *
 * incomingRaw ends up holding the GROUPED, matched rows used for display.
 * _incomingRawAll retains the full ungrouped list (for KPIs/match counts).
 */
function _islCrossMatchInventory() {
  if (!rawDf.length) {
    // Inventory not yet loaded — show everything, mark unknown
    _incomingRawAll.forEach(r => { r._inInventory = null; });
    incomingRaw = _islGroupByMaterialBatch(_incomingRawAll);
    return;
  }

  // Build lookup map from inventory (all branches): key -> { expiry, plants:Set, slocs:Set, totalQty }
  const invMap = new Map();
  rawDf.forEach(r => {
    const mat   = String(r["Material"] || "").trim().toUpperCase();
    const batch = String(r["Batch"]    || "").trim().toUpperCase();
    if (!mat || !batch) return;
    const key = `${mat}||${batch}`;
    let entry = invMap.get(key);
    if (!entry) {
      entry = { expiry: null, plants: new Set(), slocs: new Set(), totalQty: 0 };
      invMap.set(key, entry);
    }
    if (r._expiry instanceof Date && !entry.expiry) entry.expiry = r._expiry;
    const plant = String(r["Plant"] || "").trim().toUpperCase();
    if (plant) entry.plants.add(plant);
    const sloc = String(r["Storage Location"] || "").trim();
    if (sloc) entry.slocs.add(sloc);
    entry.totalQty += (Number(r["Total Qty"]) || 0);
  });

  // Stamp, enrich, and compute SL metrics
  _incomingRawAll.forEach(r => {
    const mat   = String(r["Material"] || "").trim().toUpperCase();
    const batch = String(r["Batch"]    || "").trim().toUpperCase();
    const key   = `${mat}||${batch}`;
    const entry = (mat && batch) ? invMap.get(key) : undefined;
    r._inInventory = !!entry;

    if (entry) {
      r._inv_expiryDate = entry.expiry;
      r._inv_plants     = entry.plants.size ? [...entry.plants].sort().join(" · ") : "—";
      r._inv_slocs      = entry.slocs.size  ? [...entry.slocs].sort().join(" · ")  : "—";
      r._inv_totalQty   = entry.totalQty;
    } else {
      r._inv_expiryDate = null;
      r._inv_plants     = "—";
      r._inv_slocs      = "—";
      r._inv_totalQty   = 0;
    }

    const sl = _islCompute(r._inv_expiryDate, r._postingDate);
    r._slAtReceiptDays = sl.slAtReceiptDays;
    r._receiptFlag     = sl.receiptFlag;
    r._remainingSL     = sl.remainingSLDays;
    r._ratio           = sl.ratio;
    r._flag            = sl.flag;
    r._isExpired       = sl.isExpired;
    r._dataError       = sl.dataError;
  });

  const matched = _incomingRawAll.filter(r => r._inInventory === true);
  incomingRaw = _islGroupByMaterialBatch(matched);
}

/**
 * ISSUE-2 FIX: group received-goods rows by Material+Batch.
 *   • The row with the LATEST Posting Date becomes the reference receipt
 *     (its dates/flags/SL metrics are shown).
 *   • _groupedQty = sum of received quantities across all rows in the group.
 *   • _receiptCount = number of GR postings collapsed into this row.
 * Rows without a usable quantity column contribute 0 to _groupedQty.
 */
function _islGetRowQty(r) {
  const candidates = ["Quantity", "Posted Quantity", "Quantity in Unit of Entry",
    "GR Quantity", "Order Quantity", "Total Qty"];
  for (const c of candidates) {
    if (r[c] !== undefined && r[c] !== "") {
      const n = parseFloat(r[c]);
      if (!isNaN(n)) return n;
    }
  }
  return 0;
}

function _islGroupByMaterialBatch(rows) {
  const groups = new Map();
  rows.forEach(r => {
    const mat   = String(r["Material"] || "").trim().toUpperCase();
    const batch = String(r["Batch"]    || "").trim().toUpperCase();
    const key   = `${mat}||${batch}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(r);
  });

  const result = [];
  groups.forEach(g => {
    // Pick the row with the latest posting date as the reference
    let ref = g[0];
    for (const r of g) {
      const a = ref._postingDate ? ref._postingDate.getTime() : -Infinity;
      const b = r._postingDate   ? r._postingDate.getTime()   : -Infinity;
      if (b > a) ref = r;
    }
    const totalQty = g.reduce((sum, r) => sum + _islGetRowQty(r), 0);
    result.push({ ...ref, _groupedQty: totalQty, _receiptCount: g.length });
  });
  return result;
}

/**
 * Called by loadFile() after rawDf is refreshed so any already-loaded
 * received-goods data is re-matched against the new inventory snapshot.
 */
function recomputeIslMatch() {
  if (!_incomingRawAll.length) return; // no received goods uploaded yet
  _islCrossMatchInventory();
  if (currentPage === "incoming") renderIncomingShelfLife();
  // Update the status line to reflect new match count
  const statusEl = document.getElementById("incomingFileStatus");
  if (statusEl && statusEl.style.display !== "none") {
    const total   = _incomingRawAll.length;
    const matched = incomingRaw.length;
    const existing = statusEl.innerHTML;
    // Replace the last status-name line (match note) or append it
    if (existing.includes("matched in inventory") || existing.includes("Upload inventory")) {
      statusEl.innerHTML = existing.replace(
        / · [\d,]+ matched in inventory| · Upload inventory to cross-match/,
        ` · ${matched.toLocaleString()} matched in inventory`
      );
    }
  }
  // Re-populate ISL filters since the dataset changed
  if (_incomingRawAll.length) _islPopulateFilters();
}

function _islExtractVT(row) {
  // Works for both inventory format "50833_ZME" and export format "50833_ZME"
  const raw = String(row["Valuation Type"] || row["Inventory Valuation Type"] || "").trim();
  if (!raw) return "";
  const i = raw.lastIndexOf("_");
  if (i === -1 || i === raw.length - 1) return raw.toUpperCase();
  return raw.substring(i + 1).toUpperCase();
}

function _islParseDate(v) {
  if (!v) return null;
  // Already a JS Date (cellDates:true path)
  if (v instanceof Date) return isNaN(v.getTime()) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const s = String(v).trim();
  if (!s) return null;
  // yyyy-mm-dd string — treat as local midnight (BUG-ISL-3 / BUG-8 consistent)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const dt = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    return isNaN(dt.getTime()) ? null : dt;
  }
  // BUG-ISL-3 FIX: SAP Excel serial dates use the Lotus 1900 leap-year bug
  // offset, so the correct formula is n - 2 (not n - 1).
  // XLSX.js with cellDates:true should have already converted these, but guard
  // against raw numeric values that bypass that path.
  const n = Number(s);
  if (!isNaN(n) && n > 1000 && n < 2958466) {  // 2958466 = 31-Dec-9999
    const d = new Date(Date.UTC(1900, 0, n - 2));
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  // Generic fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return null;
}

// ISSUE-1 FIX: There are now TWO distinct shelf-life metrics:
//   • SL at Receipt   = Expiry Date − Posting Date (supplier compliance check,
//                        evaluated at the moment goods were received)
//   • SL Remaining    = Expiry Date − TODAY (distribution urgency, what's
//                        actually left right now)
// "flag" (used for KPIs, chart, and the bar in the table) is driven by
// SL Remaining (Today), since that's what matters operationally.
// "receiptFlag" classifies SL at Receipt using year-based thresholds:
//   < 1.5 yr  → red     (supplier delivered with inadequate shelf life)
//   1.5-2 yr  → yellow  (borderline, watch)
//   > 2 yr    → green   (adequate)
const _ISL_YEAR_DAYS = 365.25;

function _islCompute(expiryDate, postingDate) {
  // BUG-ISL-2 FIX: cleaned up duplicate grey branch; distinct cases handled:
  //   • no expiryDate  → grey (cannot calculate anything)
  //   • no postingDate → grey for SL-at-receipt only (no receipt event date)
  if (!expiryDate) {
    return {
      slAtReceiptDays: null, receiptFlag: "grey",
      remainingSLDays: null, ratio: null, flag: "grey", isExpired: false,
      dataError: false,
    };
  }

  const MS_PER_DAY = 86400000;
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // ── SL Remaining (Today): Expiry Date − Today ──────────────────────────
  const remainingSLDays = Math.round((expiryDate - todayMidnight) / MS_PER_DAY);
  const isExpired = remainingSLDays < 0;

  let flag;
  if (isExpired) {
    flag = "expired"; // ISSUE-3 FIX: explicit expired state, not a 0% red bar
  } else {
    // Ratio of remaining SL to a 2-year (730-day) reference window, used only
    // for the progress bar fill so the "today" view also has a visual scale.
    const refWindow = _ISL_YEAR_DAYS * 2;
    const r = remainingSLDays / refWindow;
    flag = r > 0.5 ? "green" : r >= 0.375 ? "yellow" : "red"; // >1yr / 9mo-1yr / <9mo left
  }
  const ratio = isExpired ? null : Math.max(0, Math.min(1, remainingSLDays / (_ISL_YEAR_DAYS * 2)));

  // ── SL at Receipt: Expiry Date − Posting Date ──────────────────────────
  let slAtReceiptDays = null;
  let receiptFlag = "grey";
  let dataError = false;
  if (postingDate) {
    slAtReceiptDays = Math.round((expiryDate - postingDate) / MS_PER_DAY);
    if (slAtReceiptDays <= 0) {
      // ISSUE-4 FIX: production/posting date after expiry is a SAP data
      // quality issue — flag separately, don't silently fold into "red".
      dataError = true;
      receiptFlag = "data_error";
    } else {
      const years = slAtReceiptDays / _ISL_YEAR_DAYS;
      if (years < 1.5)      receiptFlag = "red";
      else if (years <= 2)  receiptFlag = "yellow";
      else                  receiptFlag = "green";
    }
  }

  return { slAtReceiptDays, receiptFlag, remainingSLDays, ratio, flag, isExpired, dataError };
}

function _islPopulateFilters() {
  // BUG-ISL-5 FIX: use fmtLocalDate() (local date parts) not toISOString()
  // which shifts UTC midnight dates by one day in UTC+3 (Ethiopia).

  // Posting dates — sorted descending (most recent first)
  const dates = [...new Set(
    incomingRaw
      .map(r => r._postingDate)
      .filter(d => d instanceof Date)
      .map(d => fmtLocalDate(d))
  )].sort().reverse();

  const dateEl = document.getElementById("isl-filter-date");
  if (dateEl) {
    dateEl.innerHTML = `<option value="">All Posting Dates</option>` +
      dates.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`).join("");
  }

  // Storage locations from received data (HO01 receiving sloc)
  const slocs = [...new Set(incomingRaw.map(r => String(r["Storage Location"] || "").trim()).filter(Boolean))].sort();
  const slocEl = document.getElementById("isl-filter-sloc");
  if (slocEl) {
    slocEl.innerHTML = `<option value="">All Storage Locations</option>` +
      slocs.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join("");
  }

  // BUG-ISL-4 FIX: plant filter — populated from inventory match (_inv_plants)
  // so user can filter to see which received batches are currently at a branch
  const plantSet = new Set();
  incomingRaw.forEach(r => {
    if (r._inv_plants && r._inv_plants !== "—") {
      r._inv_plants.split(" · ").forEach(p => { if (p) plantSet.add(p.trim()); });
    }
  });
  const plants = [...plantSet].sort();
  const plantEl = document.getElementById("isl-filter-plant");
  if (plantEl) {
    plantEl.innerHTML = `<option value="">All Plants</option>` +
      plants.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join("");
  }
}

function _islGetFiltered() {
  const { date, valType, sloc, plant, flag } = islFilterState;
  return incomingRaw.filter(r => {
    // BUG-ISL-5 FIX: compare using local date string (not toISOString)
    if (date) {
      const rd = r._postingDate ? fmtLocalDate(r._postingDate) : "";
      if (rd !== date) return false;
    }
    if (valType && r._vt !== valType) return false;
    if (sloc) {
      const rs = String(r["Storage Location"] || "").trim();
      if (rs !== sloc) return false;
    }
    // BUG-ISL-4 FIX: plant filter — check if any _inv_plants entry matches
    if (plant) {
      const rp = r._inv_plants || "";
      if (!rp.split(" · ").some(p => p.trim() === plant)) return false;
    }
    if (flag && r._receiptFlag !== flag) return false;
    return true;
  });
}

function _islFmtDays(d) {
  if (d === null || d === undefined) return "—";
  return `${d.toLocaleString()} days`;
}

function _islFmtPct(ratio) {
  if (ratio === null || ratio === undefined) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

function _islFlagLabel(flag) {
  if (flag === "green")      return `<span class="isl-flag-green">🟢 Green</span>`;
  if (flag === "yellow")     return `<span class="isl-flag-yellow">🟡 Yellow</span>`;
  if (flag === "red")        return `<span class="isl-flag-red">🔴 Red</span>`;
  if (flag === "expired")    return `<span class="isl-flag-red">⛔ EXPIRED</span>`;
  if (flag === "data_error") return `<span style="background:#a371f7;color:#fff;padding:1px 6px;border-radius:4px;font-weight:700;font-size:0.72rem">⚠ Data Error</span>`;
  return `<span class="isl-flag-grey">⚪ No Expiry Date</span>`;
}

function _islBarHtml(ratio, flag) {
  // ISSUE-3 FIX: explicit EXPIRED state instead of a misleading 0% bar
  if (flag === "expired") return `<span class="isl-flag-red" style="font-size:0.72rem">⛔ EXPIRED</span>`;
  if (ratio === null) return `<span class="isl-flag-grey" style="font-size:0.72rem">No Expiry Date</span>`;
  const pct = Math.max(0, Math.min(100, ratio * 100)).toFixed(1);
  const color = flag === "green" ? "#3fb950" : flag === "yellow" ? "#d29922" : "#f85149";
  return `<div class="isl-bar-wrap">
    <div class="isl-bar-bg"><div class="isl-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <span style="font-size:0.72rem;color:${color};min-width:42px">${pct}%</span>
  </div>`;
}

// ISSUE-1: separate small badge for "SL at Receipt" classification
// (< 1.5yr red, 1.5-2yr yellow, > 2yr green; data_error if posting after expiry)
function _islReceiptFlagLabel(flag) {
  if (flag === "green")      return `<span class="isl-flag-green">🟢 &gt;2yr</span>`;
  if (flag === "yellow")     return `<span class="isl-flag-yellow">🟡 1.5-2yr</span>`;
  if (flag === "red")        return `<span class="isl-flag-red">🔴 &lt;1.5yr</span>`;
  if (flag === "data_error") return `<span style="background:#a371f7;color:#fff;padding:1px 6px;border-radius:4px;font-weight:700;font-size:0.72rem">⚠ Data Error</span>`;
  return `<span class="isl-flag-grey">—</span>`;
}

// ── MATERIAL SEARCH — ISL page ───────────────────────────────────────────
function renderIslSearch() {
  const query     = document.getElementById("isl-search-input").value.trim().toLowerCase();
  const resultsEl = document.getElementById("isl-search-results");

  if (!query) {
    resultsEl.innerHTML = "";
    return;
  }
  if (!incomingRaw.length) {
    resultsEl.innerHTML = `<div class="alert-info">No incoming shelf life data loaded yet.</div>`;
    return;
  }

  const matches = _islGetFiltered().filter(r => {
    const code = String(r["Material"] || "").toLowerCase();
    const desc = String(r["Material Description"] || "").toLowerCase();
    return code.includes(query) || desc.includes(query);
  });

  if (!matches.length) {
    resultsEl.innerHTML = `<div class="alert-info">No records found matching "<b>${escHtml(query)}</b>".</div>`;
    return;
  }

  const uniqueMats = [...new Set(matches.map(r => r["Material"]))];
  const summary = `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.5rem">
    Found <b style="color:var(--text)">${matches.length}</b> record(s) across
    <b style="color:var(--text)">${uniqueMats.length}</b> material code(s)
  </div>`;

  const COLS = [
    { key:"Material",             label:"Material Code" },
    { key:"Material Description", label:"Material Description" },
    { key:"Batch",                label:"Batch" },
    { key:"_vt",                  label:"Val. Type" },
    { key:"Storage Location",     label:"HO01 Receipt Sloc",
      fmt: v => v ? escHtml(String(v)) : "—", raw: true },
    { key:"_postingDate",         label:"Latest Posting Date",
      fmt: v => v ? fmtLocalDate(v) : "—" },
    { key:"_inv_expiryDate",      label:"Expiry Date (Inv)",
      fmt: v => v instanceof Date ? fmtLocalDate(v) : (v ? String(v) : "—") },
    { key:"_slAtReceiptDays",     label:"SL at Receipt (days)", fmt: v => _islFmtDays(v) },
    { key:"_receiptFlag",         label:"SL at Receipt Flag",
      fmt: v => _islReceiptFlagLabel(v), raw: true },
    { key:"_remainingSL",         label:"SL Remaining Today (days)", fmt: v => _islFmtDays(v) },
    { key:"_inv_totalQty",        label:"Total Inv. Qty",
      fmt: v => (v !== undefined && v !== null) ? fmtQty(v) : "—" },
  ];

  resultsEl.innerHTML = summary + buildTable(matches, COLS);
}

function clearIslSearch() {
  document.getElementById("isl-search-input").value = "";
  document.getElementById("isl-search-results").innerHTML = "";
}

function renderIncomingShelfLife() {
  if (!incomingRaw.length) {
    document.getElementById("incoming-no-file").style.display = "";
    document.getElementById("incoming-content").style.display = "none";
    return;
  }
  document.getElementById("incoming-no-file").style.display = "none";
  document.getElementById("incoming-content").style.display = "block";

  const rows = _islGetFiltered();

  // KPIs — based on SL at Receipt Flag (_receiptFlag)
  const total      = rows.length;
  const green      = rows.filter(r => r._receiptFlag === "green").length;
  const yellow     = rows.filter(r => r._receiptFlag === "yellow").length;
  const red        = rows.filter(r => r._receiptFlag === "red").length;
  const dataErrors = rows.filter(r => r._receiptFlag === "data_error").length;
  const grey       = rows.filter(r => r._receiptFlag === "grey").length;

  const totalMatched  = incomingRaw.length;
  const totalReceived = _incomingRawAll.length;
  const matchNote = totalReceived > totalMatched
    ? `${totalMatched.toLocaleString()} batches / ${totalReceived.toLocaleString()} receipts`
    : `${totalMatched.toLocaleString()} batches`;

  setKpis("isl-kpis", [
    ["Matched Batches",    total.toLocaleString(),      `HO01 · ZME/ZMS/ZLC · ${matchNote}`,  "blue"],
    ["🟢 Green (>2yr)",    green.toLocaleString(),      "Adequate SL at receipt",              "green"],
    ["🟡 Yellow (1.5–2yr)", yellow.toLocaleString(),   "Borderline SL at receipt",            "amber"],
    ["🔴 Red (<1.5yr)",    red.toLocaleString(),        "Short SL at receipt",                 "red"],
    ["⚠ Data Errors",      dataErrors.toLocaleString(),"Posting date after expiry (SAP)",     "purple"],
    ["⚪ No Expiry Date",   grey.toLocaleString(),      "Cannot calculate SL at receipt",      "muted"],
  ]);

  // CHART UPDATE: Shelf Life at Receipt Flag distribution by HO01 Storage
  // Location — uses _receiptFlag (Expiry − Posting Date, supplier compliance)
  // grouped by the storage location the goods were received into.
  const slocMap = {};
  rows.forEach(r => {
    const sloc = String(r["Storage Location"] || "").trim() || "(Blank)";
    if (!slocMap[sloc]) slocMap[sloc] = { green:0, yellow:0, red:0, data_error:0, grey:0 };
    const bucket = slocMap[sloc][r._receiptFlag] !== undefined ? r._receiptFlag : "grey";
    slocMap[sloc][bucket]++;
  });
  const slocs = Object.keys(slocMap).sort();
  Plotly.newPlot("isl-chart-sloc", [
    { name:"🟢 Green (>2yr)",        x: slocs, y: slocs.map(s => slocMap[s].green),      type:"bar", marker:{ color:"#3fb950" } },
    { name:"🟡 Yellow (1.5-2yr)",    x: slocs, y: slocs.map(s => slocMap[s].yellow),     type:"bar", marker:{ color:"#d29922" } },
    { name:"🔴 Red (<1.5yr)",        x: slocs, y: slocs.map(s => slocMap[s].red),        type:"bar", marker:{ color:"#f85149" } },
    { name:"⚠ Data Error",          x: slocs, y: slocs.map(s => slocMap[s].data_error), type:"bar", marker:{ color:"#a371f7" } },
    { name:"⚪ No Expiry Date",      x: slocs, y: slocs.map(s => slocMap[s].grey),       type:"bar", marker:{ color:"#6e7681" } },
  ], { ...pl(), barmode:"stack", height:280, title:"Shelf Life at Receipt Flag Distribution by Storage Location" }, PLOTLY_CONFIG);


  // Count info
  const countEl = document.getElementById("isl-count");
  countEl.style.display = "block";
  countEl.textContent = `Showing ${rows.length.toLocaleString()} record${rows.length !== 1 ? "s" : ""}`;

  // BUG-ISL-6 FIX: table columns reflect correct data sources —
  //   • Expiry Date → from inventory (SAP master via _inv_*)
  //   • Posting Date & Document Number → from received goods data (latest receipt = reference)
  //   • Plants in Inventory / Inventory Slocs → enriched from rawDf all branches
  // ISSUE-1: two SL columns (SL at Receipt vs SL Remaining Today)
  // ISSUE-2: grouped quantity / receipt count columns
  const COLS = [
    { key:"Material",             label:"Material Code" },
    { key:"Material Description", label:"Material Description" },
    { key:"Batch",                label:"Batch" },
    { key:"_vt",                  label:"Val. Type" },
    // ── From received goods data (HO01 receipt event, latest of group) ──
    { key:"Storage Location",     label:"HO01 Receipt Sloc",
      fmt: v => v ? escHtml(String(v)) : "—", raw: true },
    { key:"_postingDate",         label:"Latest Posting Date",
      fmt: v => v ? fmtLocalDate(v) : "—" },
    { key:"_groupedQty",          label:"Total Qty Received",
      fmt: v => fmtQty(v) },
    { key:"_receiptCount",        label:"# GR Postings",
      fmt: v => v ? v.toLocaleString() : "1" },
    { key:"Material Document",    label:"GR Document No. (latest)",
      fmt: v => v ? escHtml(String(v)) : "—", raw: true },
    // ── From inventory (authoritative SAP master) ──
    { key:"_inv_expiryDate",      label:"Expiry Date (Inv)",
      fmt: v => v instanceof Date ? fmtLocalDate(v) : (v ? String(v) : "—") },
    // SL at Receipt: Expiry − Posting Date (supplier compliance)
    { key:"_slAtReceiptDays",     label:"SL at Receipt (days)",  fmt: v => _islFmtDays(v) },
    { key:"_receiptFlag",         label:"SL at Receipt Flag",
      fmt: v => _islReceiptFlagLabel(v), raw: true },
    // SL Remaining Today: Expiry − Today (distribution urgency)
    { key:"_remainingSL",         label:"SL Remaining Today (days)",  fmt: v => _islFmtDays(v) },
    // ── Current inventory distribution (all branches) ──
    { key:"_inv_plants",          label:"Plants in Inventory",
      fmt: v => v ? `<span style="font-size:0.7rem;white-space:nowrap">${escHtml(String(v))}</span>` : "—", raw: true },
    { key:"_inv_slocs",           label:"Storage Location",
      fmt: v => v ? `<span style="font-size:0.68rem;color:var(--muted);white-space:nowrap">${escHtml(String(v))}</span>` : "—", raw: true },
    { key:"_inv_totalQty",        label:"Total Inv. Qty",
      fmt: v => (v !== undefined && v !== null) ? fmtQty(v) : "—" },
  ];

  const wrap = document.getElementById("isl-table-wrap");
  if (!rows.length) { wrap.innerHTML = '<p class="alert-info">No records match the current filters.</p>'; return; }

  let html = '<div class="tbl-wrap"><table><thead><tr>';
  COLS.forEach(c => { html += `<th>${escHtml(c.label)}</th>`; });
  html += "</tr></thead><tbody>";

  const LIMIT = 2000;
  rows.slice(0, LIMIT).forEach(r => {
    html += "<tr>";
    COLS.forEach(c => {
      const raw = r[c.key] ?? "";
      const disp = c.fmt ? c.fmt(raw, r) : raw;
      const val  = c.raw ? disp : escHtml(String(disp ?? ""));
      html += `<td>${val}</td>`;
    });
    html += "</tr>";
  });
  html += "</tbody></table></div>";
  if (rows.length > LIMIT) html += `<div class="alert-info" style="margin-top:0.5rem">Showing first ${LIMIT.toLocaleString()} of ${rows.length.toLocaleString()} records. Download Excel/CSV for full data.</div>`;
  wrap.innerHTML = html;

  // ── Download helpers ────────────────────────────────────────────────────────
  // Flatten a row for export: strip HTML from raw columns, format dates/ratios
  const RECEIPT_FLAG_LABEL = { green:">2yr", yellow:"1.5-2yr", red:"<1.5yr", data_error:"Data Error (posting after expiry)", grey:"—" };

  function _islFlatRow(r) {
    return {
      "Material Code":            r["Material"]          || "",
      "Material Description":     r["Material Description"] || "",
      "Batch":                    r["Batch"]             || "",
      "Val. Type":                r._vt                  || "",
      "HO01 Receipt Sloc":        String(r["Storage Location"] || ""),
      "Latest Posting Date":      r._postingDate ? fmtLocalDate(r._postingDate) : "",
      "Total Qty Received":       r._groupedQty   !== undefined ? r._groupedQty   : "",
      "# GR Postings":            r._receiptCount !== undefined ? r._receiptCount : 1,
      "GR Document No. (latest)": String(r["Material Document"] || r["GR Document"] || ""),
      "Expiry Date (Inv)":        r._inv_expiryDate instanceof Date ? fmtLocalDate(r._inv_expiryDate) : (r._inv_expiryDate ? String(r._inv_expiryDate) : ""),
      "SL at Receipt (days)":     r._slAtReceiptDays !== null && r._slAtReceiptDays !== undefined ? r._slAtReceiptDays : "",
      "SL at Receipt Flag":       RECEIPT_FLAG_LABEL[r._receiptFlag] || r._receiptFlag || "",
      "SL Remaining Today (days)": r._remainingSL !== null && r._remainingSL !== undefined ? r._remainingSL : "",
      "Plants in Inventory":      r._inv_plants  || "",
      "Storage Location":          r._inv_slocs   || "",
      "Total Inv. Qty":           r._inv_totalQty !== undefined ? r._inv_totalQty : "",
    };
  }

  // ISSUE-5 FIX: static export key list — doesn't depend on rows[0], so
  // headers are always correct even when the filtered set is empty.
  const EXPORT_KEYS = [
    "Material Code","Material Description","Batch","Val. Type",
    "HO01 Receipt Sloc","Latest Posting Date","Total Qty Received","# GR Postings",
    "GR Document No. (latest)","Expiry Date (Inv)",
    "SL at Receipt (days)","SL at Receipt Flag",
    "SL Remaining Today (days)",
    "Plants in Inventory","Storage Location","Total Inv. Qty",
  ];
  const exportColDefs = EXPORT_KEYS.map(k => ({ key: k, label: k }));

  document.getElementById("btn-dl-incoming-xlsx").onclick = () => {
    const flat = rows.map(_islFlatRow);
    downloadExcel(flat, exportColDefs, "incoming_shelf_life.xlsx");
  };
  document.getElementById("btn-dl-incoming-csv").onclick = () => {
    const flat = rows.map(_islFlatRow);
    downloadCSV(flat, exportColDefs, "incoming_shelf_life.csv");
  };
}

const PAGE_RENDERERS = {
  home:      renderHome,
  dashboard: renderDashboard,
  transit:   renderTransit,
  expiry:    renderExpiry,
  qc:        renderQC,
  branch:    renderBranch,
  flow:      renderFlow,
  preview:   renderPreview,
  incoming:  renderIncomingShelfLife,
};

function renderPage(id) {
  // Home page works even before a file is loaded
  // Incoming Shelf Life works as long as incomingRaw is loaded (its own file)
  if (id !== "home" && id !== "incoming" && !rawDf.length) return;
  if (id === "incoming" && !rawDf.length && !incomingRaw.length) {
    // Show the page shell but with the "no file" message
    currentPage = id;
    document.getElementById("landingView").style.display = "none";
    document.querySelectorAll(".page").forEach(el => { el.style.display = "none"; });
    const pg = document.getElementById("page-incoming");
    if (pg) pg.style.display = "block";
    document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.page === id));
    return;
  }
  currentPage = id;
  // Hide the pre-data landing splash whenever any page is shown
  document.getElementById("landingView").style.display = "none";
  document.querySelectorAll(".page").forEach(el => { el.style.display = "none"; });
  const pg = document.getElementById(`page-${id}`);
  if (pg) pg.style.display = "block";
  document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.page === id));
  try {
    PAGE_RENDERERS[id]?.();
  } catch(e) {
    console.error(`Error rendering ${id}:`, e);
    // Show a friendly in-page error rather than a blank page
    if (pg) pg.innerHTML = `<div class="alert-danger" style="margin-top:2rem">
      ⚠️ An error occurred while rendering this page: <b>${escHtml(e.message)}</b>
      <br><small style="opacity:0.7">Check the browser console for details.</small>
    </div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  // Show Home page immediately (works without data)
  renderPage("home");

  // Nav
  document.querySelectorAll(".nav-btn[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.page;
      // Incoming Shelf Life can be navigated to without the main inventory file
      if (target === "incoming") { renderPage("incoming"); return; }
      renderPage(target);
    });
  });

  // File upload
  document.getElementById("fileInput").addEventListener("change", e => {
    const f = e.target.files[0];
    if (f) loadFile(f);
    // FIX-FILE-RESET: reset value so the same file can be re-uploaded (e.g. after editing)
    e.target.value = "";
  });

  // Incoming Shelf Life file upload
  document.getElementById("incomingFileInput").addEventListener("change", e => {
    const f = e.target.files[0]; if (f) loadIncomingFile(f);
    e.target.value = "";
  });

  // Incoming Shelf Life filter wiring
  document.getElementById("isl-filter-apply").addEventListener("click", () => {
    islFilterState.date    = (document.getElementById("isl-filter-date")    || {}).value || "";
    islFilterState.valType = (document.getElementById("isl-filter-valtype") || {}).value || "";
    islFilterState.sloc    = (document.getElementById("isl-filter-sloc")    || {}).value || "";
    islFilterState.plant   = (document.getElementById("isl-filter-plant")   || {}).value || "";
    islFilterState.flag    = (document.getElementById("isl-filter-flag")    || {}).value || "";
    renderIncomingShelfLife();
  });
  document.getElementById("isl-filter-clear").addEventListener("click", () => {
    islFilterState.date = islFilterState.valType = islFilterState.sloc = islFilterState.plant = islFilterState.flag = "";
    ["isl-filter-date","isl-filter-valtype","isl-filter-sloc","isl-filter-plant","isl-filter-flag"].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = "";
    });
    renderIncomingShelfLife();
  });

  // Stock in Transit file upload
  document.getElementById("transitFileInput").addEventListener("change", e => {
    const f = e.target.files[0]; if (f) loadTransitFile(f);
    e.target.value = "";
  });

  // Stock in Transit section filter wiring
  document.getElementById("st-filter-apply").addEventListener("click", () => {
    stFilterState.purDoc   = (document.getElementById("st-filter-pur-doc")   || {}).value || "";
    stFilterState.supPlant = (document.getElementById("st-filter-sup-plant") || {}).value || "";
    renderStockTransitSection();
  });
  document.getElementById("st-filter-clear").addEventListener("click", () => {
    stFilterState = { purDoc: "", supPlant: "" };
    const purDocEl   = document.getElementById("st-filter-pur-doc");
    const supPlantEl = document.getElementById("st-filter-sup-plant");
    if (purDocEl)   purDocEl.value   = "";
    if (supPlantEl) supPlantEl.value = "";
    renderStockTransitSection();
  });

  // Material transit lookup
  document.getElementById("transit-search-btn").addEventListener("click", renderTransitSearch);
  document.getElementById("transit-search-clear").addEventListener("click", clearTransitSearch);
  document.getElementById("transit-search-input").addEventListener("keydown", e => {
    if (e.key === "Enter") renderTransitSearch();
  });

  // Expiry window radio
  document.getElementById("expiry-window-group").addEventListener("change", () => {
    if (rawDf.length && currentPage === "expiry") renderExpiry();
  });

  // Material expiry lookup
  document.getElementById("expiry-search-btn").addEventListener("click", renderExpirySearch);
  document.getElementById("expiry-search-clear").addEventListener("click", clearExpirySearch);
  document.getElementById("expiry-search-input").addEventListener("keydown", e => {
    if (e.key === "Enter") renderExpirySearch();
  });

  // Material QC lookup
  document.getElementById("qc-search-btn").addEventListener("click", renderQCSearch);
  document.getElementById("qc-search-clear").addEventListener("click", clearQCSearch);
  document.getElementById("qc-search-input").addEventListener("keydown", e => {
    if (e.key === "Enter") renderQCSearch();
  });

  // Material Flow lookup
  document.getElementById("flow-search-btn").addEventListener("click", renderFlowSearch);
  document.getElementById("flow-search-clear").addEventListener("click", clearFlowSearch);
  document.getElementById("flow-search-input").addEventListener("keydown", e => {
    if (e.key === "Enter") renderFlowSearch();
  });

  // ISL material search
  document.getElementById("isl-search-btn").addEventListener("click", renderIslSearch);
  document.getElementById("isl-search-clear").addEventListener("click", clearIslSearch);
  document.getElementById("isl-search-input").addEventListener("keydown", e => {
    if (e.key === "Enter") renderIslSearch();
  });

  // Preview filters
  document.getElementById("btn-apply-filter").addEventListener("click", applyPreviewFilters);
  document.getElementById("btn-clear-filter").addEventListener("click", () => {
    document.querySelectorAll("#filter-plant option,#filter-mg option,#filter-mgname option,#filter-valtype option").forEach(o => { o.selected = false; });
    filtDf = getReconciledBase();
    renderPreviewTable();
  });

  // ── Page filter wiring (event delegation) ──────────────────────────────
  // Uses document-level delegation so listeners survive any DOM rebuild
  // (e.g. the renderPage error path replaces pg.innerHTML entirely).
  // Each Apply/Clear button is identified by its stable ID.

  const PAGE_FILTER_MAP = {
    "dash-filter-apply":    { page:"dashboard", plantWrap:"ms-dash-plant",    mgWrap:"ms-dash-mg",    vtWrap:"ms-dash-vt",    action:"apply" },
    "dash-filter-clear":    { page:"dashboard", plantWrap:"ms-dash-plant",    mgWrap:"ms-dash-mg",    vtWrap:"ms-dash-vt",    action:"clear" },
    "transit-filter-apply": { page:"transit",   plantWrap:"ms-transit-plant", mgWrap:"ms-transit-mg", vtWrap:"ms-transit-vt", action:"apply" },
    "transit-filter-clear": { page:"transit",   plantWrap:"ms-transit-plant", mgWrap:"ms-transit-mg", vtWrap:"ms-transit-vt", action:"clear" },
    "expiry-filter-apply":  { page:"expiry",    plantWrap:"ms-expiry-plant",  mgWrap:"ms-expiry-mg",  vtWrap:"ms-expiry-vt",  action:"apply" },
    "expiry-filter-clear":  { page:"expiry",    plantWrap:"ms-expiry-plant",  mgWrap:"ms-expiry-mg",  vtWrap:"ms-expiry-vt",  action:"clear" },
    "qc-filter-apply":      { page:"qc",        plantWrap:"ms-qc-plant",      mgWrap:"ms-qc-mg",      vtWrap:"ms-qc-vt",      action:"apply" },
    "qc-filter-clear":      { page:"qc",        plantWrap:"ms-qc-plant",      mgWrap:"ms-qc-mg",      vtWrap:"ms-qc-vt",      action:"clear" },
    "branch-filter-apply":  { page:"branch",    plantWrap:null,               mgWrap:"ms-branch-mg",  vtWrap:"ms-branch-vt",  action:"apply" },
    "branch-filter-clear":  { page:"branch",    plantWrap:null,               mgWrap:"ms-branch-mg",  vtWrap:"ms-branch-vt",  action:"clear" },
    "flow-filter-apply":    { page:"flow",      plantWrap:"ms-flow-plant",    mgWrap:"ms-flow-mg",    vtWrap:"ms-flow-vt",    action:"apply" },
    "flow-filter-clear":    { page:"flow",      plantWrap:"ms-flow-plant",    mgWrap:"ms-flow-mg",    vtWrap:"ms-flow-vt",    action:"clear" },
  };

  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("button[id]");
    if (!btn) return;
    const cfg = PAGE_FILTER_MAP[btn.id];
    if (!cfg) return;
    if (!rawDf.length) return;

    e.stopPropagation();
    // Close any open dropdowns first
    document.querySelectorAll(".ms-wrap.open").forEach(w => w.classList.remove("open"));

    if (cfg.action === "apply") {
      if (cfg.plantWrap) {
        const wrap = document.getElementById(cfg.plantWrap);
        pageFilters[cfg.page].plants = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
      if (cfg.mgWrap) {
        const wrap = document.getElementById(cfg.mgWrap);
        pageFilters[cfg.page].mgs = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
      if (cfg.vtWrap) {
        const wrap = document.getElementById(cfg.vtWrap);
        pageFilters[cfg.page].valTypes = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
    } else {
      if (cfg.plantWrap) {
        pageFilters[cfg.page].plants = [];
        const wrap = document.getElementById(cfg.plantWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
      if (cfg.mgWrap) {
        pageFilters[cfg.page].mgs = [];
        const wrap = document.getElementById(cfg.mgWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
      if (cfg.vtWrap) {
        pageFilters[cfg.page].valTypes = [];
        const wrap = document.getElementById(cfg.vtWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
    }
    renderPage(cfg.page);
  });

});

// ── GLOBAL MATERIAL SEARCH ─────────────────────────────────────────────────
(function () {
  function fmt(n) {
    if (n == null || isNaN(+n)) return "—";
    return (+n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // FIX-R6: added export buttons so users with >200 results have a download path.
  // BUG-FIX-1: renamed from buildTable → gsrBuildTable to avoid collision with the
  // global buildTable at line 582 (different signatures: rowClass fn vs exportFilename str).
  function gsrBuildTable(rows, cols, exportFilename) {
    if (!rows.length) return '<p class="gsr-no-data">No matching records found.</p>';
    let html = '<div class="tbl-wrap"><table><thead><tr>';
    cols.forEach(c => { html += `<th>${escHtml(c.label)}</th>`; });
    html += "</tr></thead><tbody>";
    rows.slice(0, 200).forEach(r => {
      html += "<tr>";
      cols.forEach(c => {
        const rawVal = r[c.key] ?? "";
        const display = c.fmt ? c.fmt(rawVal, r) : rawVal;
        const val = c.raw ? display : escHtml(String(display ?? ""));
        const cls = (c.cellClass || c.cls) ? ` class="${c.cellClass || c.cls}"` : "";
        html += `<td${cls}>${val}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    if (rows.length > 200) {
      const safeFile = exportFilename || "search_results.csv";
      html += `<p class="gsr-no-data" style="margin-top:0.4rem">
        Showing first 200 of ${rows.length} rows.
        <button id="gsr-export-${safeFile.replace(/\W/g,'_')}" class="dl-btn" style="font-size:0.72rem;padding:3px 10px;margin-left:6px">⬇ Download all ${rows.length} rows (CSV)</button>
      </p>`;
      // Wire export after insertion via a deferred data attribute approach
      setTimeout(() => {
        const btn = document.getElementById(`gsr-export-${safeFile.replace(/\W/g,'_')}`);
        if (btn) btn.addEventListener("click", () => downloadCSV(rows, cols, safeFile), { once: true });
      }, 0);
    }
    return html;
  }

  function showResultsPanel() {
    document.getElementById("global-search-results-panel").style.display = "block";
  }
  function hideResultsPanel() {
    document.getElementById("global-search-results-panel").style.display = "none";
  }

  function runSearch() {
    const q = (document.getElementById("global-search-input").value || "").trim().toLowerCase();
    const out = document.getElementById("global-search-results");
    if (!q) { out.innerHTML = ""; hideResultsPanel(); return; }

    // ── In-Stock results ──
    const base = rawDf;
    const stockRows = base.filter(r => {
      const code = String(r["Material"] || "").toLowerCase();
      const desc = String(r["Material Description"] || "").toLowerCase();
      return code.includes(q) || desc.includes(q);
    });

    const stockCols = [
      { key: "Material", label: "Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
      { key: "Material Description", label: "Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
      { key: "Plant",                label: "Plant" },
      { key: "Plant Name",           label: "Plant Name" },
      { key: "Material Group Name",  label: "Material Group" },
      { key: "Unrestricted Stock",   label: "Unrestricted Qty",  cls: "col-qty" },
      { key: "Value of Unrestricted Stock", label: "Value (ETB)", cls: "col-val" },
      { key: "Shelf Life Expiration Date",  label: "Expiry" },
    ];

    // ── Transit results (from separate transit file) ──
    const transitCols = [
      { key: "_st_material", label: "Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
      { key: "_st_desc",     label: "Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
      { key: "_st_purDoc",   label: "Purch. Doc." },
      { key: "_st_supPlant", label: "Supplying Plant" },
      { key: "_st_qty",      label: "Qty", cls: "col-qty" },
      { key: "_st_uom",      label: "UoM" },
    ];
    const transitRows = stockTransitRaw.filter(r => {
      const code = String(r["_st_material"] || "").toLowerCase();
      const desc = String(r["_st_desc"]     || "").toLowerCase();
      // FIX-PHANTOM-SEARCH: phantom rows (no PO & no supplying plant) must not appear
      // in global search — they are only visible in the transit detail section
      const isPhantom = !r._st_purDoc && !r._st_supPlant;
      return !isPhantom && (code.includes(q) || desc.includes(q));
    });

    // ── Also search "Stock in Transit" column in main data ──
    // FIX-PHANTOM-SEARCH: exclude phantom rows (no PO/supplying plant) from search results
    const inTransitMain = base.filter(r => {
      const code = String(r["Material"] || "").toLowerCase();
      const desc = String(r["Material Description"] || "").toLowerCase();
      const hasTransit = parseFloat(r["Stock in Transit"] || 0) > 0;
      const isPhantom  = r._phantomTransitQty > 0;
      return hasTransit && !isPhantom && (code.includes(q) || desc.includes(q));
    });

    let html = "";

    // In-Stock section
    html += `<div class="gsr-section-title">
      <span class="gsr-badge gsr-badge-stock">In Stock</span>
      ${stockRows.length} record${stockRows.length !== 1 ? "s" : ""} found
    </div>`;
    html += gsrBuildTable(stockRows, stockCols, "search_results_stock.csv");

    // Transit from separate file (if uploaded)
    if (stockTransitRaw.length > 0) {
      html += `<div class="gsr-section-title" style="margin-top:1.2rem">
        <span class="gsr-badge gsr-badge-transit">In Transit (Transit File)</span>
        ${transitRows.length} record${transitRows.length !== 1 ? "s" : ""} found
      </div>`;
      html += gsrBuildTable(transitRows, transitCols, "search_results_transit.csv");
    } else if (inTransitMain.length > 0) {
      // Fallback: show in-transit column from main data
      html += `<div class="gsr-section-title" style="margin-top:1.2rem">
        <span class="gsr-badge gsr-badge-transit">In Transit (from inventory data)</span>
        ${inTransitMain.length} record${inTransitMain.length !== 1 ? "s" : ""} found
      </div>`;
      const tCols = [
        { key: "Material", label: "Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
        { key: "Material Description", label: "Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
        { key: "Plant",                label: "Plant" },
        { key: "Stock in Transit",     label: "Transit Qty", cls: "col-qty" },
        { key: "Value of Stock in Transit", label: "Transit Value (ETB)", cls: "col-val" },
      ];
      html += gsrBuildTable(inTransitMain, tCols, "search_results_transit_main.csv");
    }

    out.innerHTML = html;
    showResultsPanel();
  }

  function clearSearch() {
    document.getElementById("global-search-input").value = "";
    document.getElementById("global-search-results").innerHTML = "";
    hideResultsPanel();
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("global-search-btn").addEventListener("click", runSearch);
    document.getElementById("global-search-clear").addEventListener("click", clearSearch);
    document.getElementById("global-search-input").addEventListener("keydown", e => {
      if (e.key === "Enter") runSearch();
    });
    document.getElementById("global-search-results-close").addEventListener("click", hideResultsPanel);
  });
})();
