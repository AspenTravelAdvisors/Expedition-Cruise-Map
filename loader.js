/* ============================================================================
 * Expedition Cruise Atlas — data loader
 * ----------------------------------------------------------------------------
 * Reads the COLUMNAR sailings file (sailings.json) + metadata (atlas-meta.json)
 * and returns ready-to-render sailing objects with URLs and date fields derived.
 *
 * App scope: TRUE EXPEDITION operators only (12 lines). sailings.json is the
 * filtered core set (~3,800 sailings). The old curated itinerary.json is retired.
 *
 * Columnar format keeps the file tiny (~0.8MB raw / ~120KB gz) by storing rows
 * as arrays (no repeated keys) and the URL prefixes once.
 *
 * Usage:
 *     import { loadAtlas } from './loader.js';      // or window.loadAtlas
 *     const atlas = await loadAtlas();
 *     atlas.sailings            // [{id, operator, name, region, url, productUrl,
 *                               //   start, end, nights, startY, startM, startD,
 *                               //   monthKey, dates}, ...]
 *     atlas.OPERATORS           // { "Silversea": {short, domain, color, count}, ... }
 *     atlas.REGIONS             // { "Antarctica": {name, coord:[lat,lng], count}, ... }
 *     atlas.byRegion            // Map region -> sailings[]
 *     atlas.regionOperators(r)  // [{operator, short, color, count}] desc
 *     atlas.sailingsBy({region, operator, months, from, to, futureOnly})
 *     atlas.months              // ["2026-06", ...] sorted, for the date filter
 * ========================================================================== */

const DEFAULTS = { sailings: 'sailings.json', meta: 'atlas-meta.json' };
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function correctedRegionName(region, name) {
  const t = norm(name);
  if (t.includes('alaska')) return 'Alaska & Yukon';
  if (t.includes('baja') || t.includes('sea of cortez')) return 'Baja California';
  if (t.includes('seychelles')) return 'Africa & Indian Ocean';
  if (t.includes('caribbean')) return 'Caribbean & Bermuda';
  return region;
}

/** Expand one columnar row into a sailing object: rebuild URLs + derive dates. */
function rowToSailing(row, urlBase, productBase) {
  const [id, operator, name, start, nights, rawRegion, slug, product] = row;
  const region = correctedRegionName(rawRegion, name);
  const s = {
    id, operator, name, region, nights,
    start,                                                  // ISO "2027-04-01" (may be null)
    url: slug ? urlBase + id + '/' + slug : null,
    productUrl: product ? productBase + product : null,
    startY: null, startM: null, startD: null, monthKey: null, end: null, dates: '',
  };
  if (start) {
    const [y, m, d] = start.split('-').map(Number);
    s.startY = y; s.startM = m; s.startD = d;
    s.monthKey = y + '-' + pad(m);
    const d0 = new Date(Date.UTC(y, m - 1, d));
    const startLabel = pad(d) + ' ' + MON[m - 1] + ' ' + y;
    if (typeof nights === 'number') {
      const d1 = new Date(d0.getTime() + nights * 86400000);
      s.end = d1.toISOString().slice(0, 10);
      s.dates = startLabel + ' – ' + pad(d1.getUTCDate()) + ' ' + MON[d1.getUTCMonth()] + ' ' + d1.getUTCFullYear();
    } else {
      s.dates = startLabel;
    }
  }
  return s;
}

export async function loadAtlas(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const [data, meta] = await Promise.all([
    fetch(cfg.sailings).then(r => { if (!r.ok) throw new Error('sailings.json HTTP ' + r.status); return r.json(); }),
    fetch(cfg.meta).then(r => { if (!r.ok) throw new Error('atlas-meta.json HTTP ' + r.status); return r.json(); }),
  ]);

  const urlBase = data.urlBase || '', productBase = data.productBase || '';
  const sailings = data.rows.map(row => rowToSailing(row, urlBase, productBase));
  const OPERATORS = meta.OPERATORS || {};
  const REGIONS = meta.REGIONS || {};

  const byRegion = new Map();
  const byOperator = new Map();
  for (const s of sailings) {
    if (!byRegion.has(s.region)) byRegion.set(s.region, []);
    byRegion.get(s.region).push(s);
    if (!byOperator.has(s.operator)) byOperator.set(s.operator, []);
    byOperator.get(s.operator).push(s);
  }

  const months = Array.from(new Set(sailings.map(s => s.monthKey).filter(Boolean))).sort();

  /** Operators sailing a region, with counts, sorted by volume. */
  function regionOperators(region) {
    const counts = {};
    for (const s of (byRegion.get(region) || [])) counts[s.operator] = (counts[s.operator] || 0) + 1;
    return Object.entries(counts).map(([operator, count]) => ({
      operator, count,
      short: (OPERATORS[operator] && OPERATORS[operator].short) || operator,
      color: (OPERATORS[operator] && OPERATORS[operator].color) || '#26506e',
    })).sort((a, b) => b.count - a.count);
  }

  /** Filter by region / operator / months(Set or array) / date range / future-only. */
  function sailingsBy({ region, operator, months: mset, from, to, futureOnly } = {}) {
    let list = region ? (byRegion.get(region) || []) : sailings;
    if (operator) list = list.filter(s => s.operator === operator);
    if (mset) { const set = mset instanceof Set ? mset : new Set(mset); if (set.size) list = list.filter(s => set.has(s.monthKey)); }
    if (from) list = list.filter(s => s.start && s.start >= from);
    if (to)   list = list.filter(s => s.start && s.start <= to);
    if (futureOnly) { const today = new Date().toISOString().slice(0, 10); list = list.filter(s => s.start && s.start >= today); }
    return list;
  }

  const mappableRegions = Object.keys(REGIONS).filter(r => Array.isArray(REGIONS[r].coord));

  return { sailings, OPERATORS, REGIONS, months, byRegion, byOperator,
           mappableRegions, regionOperators, sailingsBy };
}

/** Logo fallback chain for any operator: local PNG → Google favicon → DDG → initials. */
export function logoSources(operators, opName) {
  const m = (operators && operators[opName]) || { short: opName, domain: '' };
  if (!m.domain) return [];
  return [
    'logos/' + m.domain + '.png',
    'https://www.google.com/s2/favicons?sz=128&domain=' + m.domain,
    'https://icons.duckduckgo.com/ip3/' + m.domain + '.ico',
  ];
}

if (typeof window !== 'undefined') { window.loadAtlas = loadAtlas; window.logoSources = logoSources; }
