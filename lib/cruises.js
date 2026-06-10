// lib/cruises.js — Expedition Cruise Atlas query layer
// Shared in-memory query over the sailings feed, mirroring the Hotel Atlas
// lib/hotels.js contract so the concierge can query cruises exactly like hotels.
// Pure functions, one-time JSON load, unit-testable without an HTTP server.
//
// Lives outside api/ on purpose: anything under api/ becomes a Vercel route.
// Source of truth stays sailings.json (the same feed the globe loads); this
// layer normalizes each sailing, maps its region onto a marquee key, and
// supports q / region / country / month filtering + pagination + a deep link.

const raw = require("../sailings.json");
const meta = require("../atlas-meta.json");

const ATLAS_URL =
  process.env.ATLAS_CRUISE_URL || "https://expedition-cruise-map.vercel.app";

const ci = (s) => String(s == null ? "" : s).toLowerCase().trim();
const norm = (s) => ci(s)
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

// Connector + genre words dropped from free-text `q` so "alaska expedition
// cruises" matches on "alaska" rather than failing on the genre nouns.
const Q_STOPWORDS = new Set([
  "in", "the", "of", "at", "on", "a", "an", "and", "to", "for", "near", "or", "by",
  "cruise", "cruises", "expedition", "expeditions", "sailing", "sailings",
  "voyage", "voyages", "ship", "trip", "trips",
]);

// Non-marquee cruise regions that should still bind when the concierge or a
// deep link sends them as `region`. These are not Living Atlas chart keys, but
// they are real cruise atlas regions/destinations.
const REGION_SEARCH_ALIASES = {
  "alaska": { labels: ["alaska & yukon"], terms: ["alaska"] },
  "alaska and yukon": { labels: ["alaska & yukon"], terms: ["alaska"] },
  "yukon": { labels: ["alaska & yukon"], terms: ["yukon"] },
  "caribbean": { labels: ["caribbean & bermuda"], terms: ["caribbean"], requireLabel: true },
  "caribbean and bermuda": { labels: ["caribbean & bermuda"], terms: ["caribbean", "bermuda"], requireLabel: true },
  "bermuda": { labels: ["caribbean & bermuda"], terms: ["bermuda"], requireLabel: true },
  "baja": { labels: [], terms: ["baja"] },
  "baja california": { labels: [], terms: ["baja"] },
  "sea of cortez": { labels: [], terms: ["sea of cortez"] },
  "sea cortez": { labels: [], terms: ["sea of cortez"] },
  "seychelles": { labels: ["africa & indian ocean"], terms: ["seychelles"], requireLabel: true },
  "the seychelles": { labels: ["africa & indian ocean"], terms: ["seychelles"], requireLabel: true },
  "british isles": { labels: ["northern europe & british isles"], terms: ["british isles"], requireLabel: true },
  "northern europe": { labels: ["northern europe & british isles"], terms: ["northern europe"], requireLabel: true },
  "northern europe and british isles": { labels: ["northern europe & british isles"], terms: ["british isles"], requireLabel: true },
};

function nonMarqueeRegionMatcher(raw) {
  const alias = REGION_SEARCH_ALIASES[norm(raw)];
  if (!alias) return null;
  const labels = (alias.labels || []).map(norm).filter(Boolean);
  const terms = (alias.terms || []).map(norm).filter(Boolean);
  return (c) => {
    const label = norm(c.regionLabel);
    const hay = norm(`${c.name} ${c.operator} ${c.regionLabel}`);
    if (alias.requireLabel) {
      return labels.includes(label) && (!terms.length || terms.some((term) => hay.includes(term)));
    }
    return labels.includes(label) || terms.some((term) => hay.includes(term));
  };
}

// Marquee region keys the Living Atlas can plot.
const MARQUEE = new Set([
  "antarctica", "arctic", "galapagos", "amazon", "polynesia",
  "patagonia", "kimberley", "mediterranean", "norway", "japan", "namibia",
]);
// Representative centroid [lng,lat] per marquee key (for the regions aggregate).
const MARQUEE_CENTER = {
  antarctica: [0, -71], arctic: [18, 79], galapagos: [-90.5, -0.7],
  amazon: [-60, -3], polynesia: [-149.4, -17.6], patagonia: [-72, -49],
  kimberley: [126, -16], mediterranean: [14, 39], norway: [10, 65],
  japan: [138, 37], namibia: [16, -22],
};

// Cruise region NAME -> marquee key (only the ones that genuinely map).
const REGION_MARQUEE = {
  "Antarctica": "antarctica",
  "Arctic": "arctic",
  "Galápagos": "galapagos",
  "Amazon & South America": "amazon",
  "Hawaii & Tahiti": "polynesia",
  "Mediterranean": "mediterranean",
  "Norway, Fjords & Coast": "norway",
};
// Keyword override scanned from the sailing name (e.g. a Kimberley sailing filed
// under "Australia, NZ & South Pacific", or Patagonia under "Amazon & S. America").
const KEYWORDS = [
  ["antarctica", "antarctica"], ["galápagos", "galapagos"], ["galapagos", "galapagos"],
  ["amazon", "amazon"], ["patagonia", "patagonia"], ["kimberley", "kimberley"],
  ["namibia", "namibia"], ["norway", "norway"], ["svalbard", "arctic"],
  ["tahiti", "polynesia"], ["japan", "japan"],
];
function correctedRegionName(regionName, name) {
  const t = norm(name);
  if (t.includes("alaska")) return "Alaska & Yukon";
  if (t.includes("baja") || t.includes("sea of cortez")) return "Baja California";
  if (t.includes("seychelles")) return "Africa & Indian Ocean";
  if (t.includes("caribbean")) return "Caribbean & Bermuda";
  return regionName;
}
function marqueeFor(regionName, name) {
  const t = ci(name);
  for (const [kw, key] of KEYWORDS) if (t.includes(kw)) return key;
  return REGION_MARQUEE[regionName] || null;
}

// --- normalize raw rows -> records (one-time at module load) ---------------
const cruises = (() => {
  const idx = {};
  (raw.schema || []).forEach((k, i) => (idx[k] = i));
  const base = raw.urlBase || (ATLAS_URL + "/cruises/sailings/");
  return (raw.rows || []).map((row) => {
    const id = row[idx.id];
    const name = row[idx.name];
    const regionName = correctedRegionName(row[idx.region], name);
    const regionLabel = regionName && !/^other$/i.test(regionName) ? regionName : null;
    const slug = row[idx.slug] || "";
    const start = row[idx.start] || null;
    return {
      id: `cr_${id}`,
      type: "cruise",
      name,
      operator: row[idx.operator] || null,
      brand: row[idx.operator] || null,
      regionLabel,
      region: marqueeFor(regionName, name),
      country: null,
      nights: Number(row[idx.nights]) || null,
      startDate: start,
      month: start ? String(start).slice(0, 7) : null,
      bookUrl: id && slug ? `${base}${id}/${slug}` : ATLAS_URL,
    };
  });
})();

// --- filtering -------------------------------------------------------------
function filterCruises(params = {}) {
  const { q, region, country, month, operator, ids } = params;
  let list = cruises;

  if (ids != null && String(ids).trim() !== "") {
    const set = new Set(String(ids).split(",").map((s) => s.trim()).filter(Boolean));
    list = list.filter((c) => set.has(c.id));
  }
  if (region) {
    const v = ci(region);
    if (MARQUEE.has(v)) {
      list = list.filter((c) => c.region === v);
    } else {
      const matchesRegion = nonMarqueeRegionMatcher(region);
      if (matchesRegion) list = list.filter(matchesRegion);
    }
  }
  if (operator) { const v = ci(operator); list = list.filter((c) => ci(c.operator) === v); }
  if (month) { const v = String(month).trim(); list = list.filter((c) => c.month === v); }

  const hay = (c) => `${ci(c.name)} ${ci(c.operator)} ${ci(c.regionLabel)}`;
  if (country != null && String(country).trim() !== "") {
    const matchesRegion = nonMarqueeRegionMatcher(country);
    if (matchesRegion) {
      list = list.filter(matchesRegion);
    } else {
      const v = ci(country); list = list.filter((c) => hay(c).includes(v));
    }
  }
  if (q != null && String(q).trim() !== "") {
    const tokens = ci(q).split(/\s+/).filter((t) => t && !Q_STOPWORDS.has(t));
    if (tokens.length) {
      const matchesRegion = nonMarqueeRegionMatcher(tokens.join(" "));
      if (matchesRegion) {
        list = list.filter(matchesRegion);
      } else {
        list = list.filter((c) => tokens.every((t) => hay(c).includes(t)));
      }
    }
  }
  return list;
}

// --- pagination (limit default 6 for the Guide, hard cap 24) ---------------
function clampLimit(rawN) { let n = parseInt(rawN, 10); if (!Number.isFinite(n) || n <= 0) n = 6; if (n > 24) n = 24; return n; }
function clampOffset(rawN) { let n = parseInt(rawN, 10); if (!Number.isFinite(n) || n < 0) n = 0; return n; }

// --- deep link (chat-to-atlas handoff) -------------------------------------
function buildDeepLink(params = {}) {
  const usp = new URLSearchParams();
  for (const k of ["region", "country", "operator", "month", "q"]) {
    const val = params[k];
    if (val != null && String(val).trim() !== "") usp.set(k, String(val).trim());
  }
  const qs = usp.toString();
  return qs ? `${ATLAS_URL}?${qs}` : ATLAS_URL;
}

// --- region aggregate (marquee count + centroid) ---------------------------
function regions() {
  const tally = {};
  for (const c of cruises) if (c.region && MARQUEE.has(c.region)) tally[c.region] = (tally[c.region] || 0) + 1;
  const out = Object.keys(tally).map((region) => ({
    region, count: tally[region],
    center: MARQUEE_CENTER[region] || null,
    deepLink: buildDeepLink({ region }),
  })).sort((a, b) => b.count - a.count);
  const total = out.reduce((n, r) => n + r.count, 0);
  return { total, count: out.length, regions: out };
}

// --- full query: filter + paginate + deepLink ------------------------------
function query(params = {}) {
  const matched = filterCruises(params);
  const total = matched.length;
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);
  const results = matched.slice(offset, offset + limit);
  return { total, count: results.length, results, deepLink: buildDeepLink(params) };
}

module.exports = {
  cruises, filterCruises, clampLimit, clampOffset, buildDeepLink, query, regions,
  MARQUEE, ATLAS_URL,
};
