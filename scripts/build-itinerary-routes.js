// scripts/build-itinerary-routes.js — Expedition Cruise Atlas
// Distills the heavy data/port-itineraries.json (~22 MB) into a slim,
// browser-friendly data/itinerary-routes.json (~3 MB raw / ~0.2 MB gz) that the
// atlas lazy-loads to draw day-by-day routes on the map — mirroring the
// day-by-day itineraries on the Luxury Yacht Atlas.
//
// Run: node scripts/build-itinerary-routes.js
//
// Output shape keeps it tiny by storing only what the map needs:
//   { "_meta": {...}, "routes": { "<sailingId>": [ day, day, ... ] } }
//   day = { d:<dayNumber>, s:<1 if a sea/cruising day, else 0>,
//           p:[ [name, lat, lng], ... ]   // stops; lat/lng null when ungeocoded
//         }

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "data", "port-itineraries.json");
const OUT = path.join(__dirname, "..", "data", "itinerary-routes.json");

function round(n) { return n == null ? null : Math.round(n * 1e4) / 1e4; }

// Great-circle distance between two [lat,lng] points, in degrees of arc.
function havDeg(a, b) {
  const r = Math.PI / 180;
  const la1 = a[0] * r, la2 = b[0] * r, dla = (b[0] - a[0]) * r, dlo = (b[1] - a[1]) * r;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / r;
}
function median(arr) {
  const s = arr.slice().sort((x, y) => x - y), n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
}
// The source geocoder occasionally lands a stop on the wrong continent
// (e.g. "Nauta Cano, Peru" snapped to the Gulf of St. Lawrence). Flag those so
// they don't draw a wild leg across the map. Returns a Set of indices to drop
// from `pts` ([lat,lng] in itinerary order).
function outlierIndices(pts) {
  const drop = new Set(), n = pts.length;
  if (n < 3) return drop;
  // (1) Robust centre test: far from the itinerary's median position, with an
  //     adaptive threshold so genuine long crossings (which spread out) survive.
  const c = [median(pts.map(p => p[0])), median(pts.map(p => p[1]))];
  const dists = pts.map(p => havDeg(p, c));
  const thr = Math.max(30, 3 * median(dists));
  for (let i = 0; i < n; i++) if (dists[i] > thr) drop.add(i);
  // (2) Sequential-spike test (span-independent): a stop the path jumps out to
  //     and immediately returns from, while its neighbours sit close together.
  const keep = [];
  for (let i = 0; i < n; i++) if (!drop.has(i)) keep.push(i);
  for (let j = 1; j < keep.length - 1; j++) {
    const p = pts[keep[j - 1]], cur = pts[keep[j]], nx = pts[keep[j + 1]];
    const dpc = havDeg(p, cur), dcn = havDeg(cur, nx), dpn = havDeg(p, nx);
    if (Math.min(dpc, dcn) > 20 && dpn < 0.6 * (dpc + dcn)) drop.add(keep[j]);
  }
  return drop;
}

function main() {
  const src = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const itineraries = src.itineraries || {};
  const routes = {};
  let withGeo = 0, total = 0, dropped = 0;

  for (const [id, it] of Object.entries(itineraries)) {
    total++;
    // Flatten geocoded stops in order to detect mis-geocoded outliers.
    const flat = []; // {di, si, ll}
    (it.days || []).forEach((day, di) => (day.stops || []).forEach((st, si) => {
      if (st.latitude != null && st.longitude != null) flat.push({ di, si, ll: [st.latitude, st.longitude] });
    }));
    const bad = outlierIndices(flat.map(f => f.ll));
    const dropSet = new Set(); // "di:si" of stops to discard
    bad.forEach(i => dropSet.add(flat[i].di + ":" + flat[i].si));
    dropped += bad.size;

    const days = [];
    let geocoded = 0;
    (it.days || []).forEach((day, di) => {
      const stops = [];
      (day.stops || []).forEach((st, si) => {
        if (dropSet.has(di + ":" + si)) return; // skip mis-geocoded outlier
        const name = st.name || st.poiName || "";
        const lat = round(st.latitude);
        const lng = round(st.longitude);
        if (lat != null && lng != null) geocoded++;
        stops.push([name, lat, lng]);
      });
      days.push({ d: day.day, s: day.isSeaDay ? 1 : 0, p: stops });
    });
    if (geocoded >= 2) withGeo++;
    routes[id] = days;
  }

  const out = {
    _meta: {
      generatedAt: new Date().toISOString(),
      sourceFile: "data/port-itineraries.json",
      routeCount: total,
      traceableCount: withGeo, // >= 2 geocoded stops => drawable on the map
      droppedOutliers: dropped,
      notes: [
        "Slim, map-ready distillation of port-itineraries.json.",
        "Each route is an ordered list of days; p = [name, lat, lng] stops (lat/lng null when ungeocoded).",
        "Mis-geocoded outlier stops (wrong-continent spikes) are dropped so routes don't jump across the map.",
        "Regenerate with: node scripts/build-itinerary-routes.js",
      ],
    },
    routes,
  };

  fs.writeFileSync(OUT, JSON.stringify(out));
  const bytes = fs.statSync(OUT).size;
  console.log(
    "Wrote " + OUT + "\n  routes: " + total +
    "  traceable (>=2 geocoded stops): " + withGeo +
    "\n  dropped mis-geocoded outlier stops: " + dropped +
    "\n  size: " + (bytes / 1e6).toFixed(2) + " MB raw"
  );
}

main();
