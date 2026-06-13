// Shared supplier ranking runtime.
// Ranks local atlas records from local data only, so each atlas can function
// independently of Base Camp.

const brandProfilesRaw = require("../data/brand-profiles.json");
const advisorOverlayRaw = require("../data/advisor-overlay.json");
const itineraryFit = require("../data/itinerary-fit.json");

const ci = (s) => String(s == null ? "" : s).toLowerCase().trim();
const norm = (s) => ci(s)
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const RELATIONSHIP_BOOST = { preferred: 12, partner: 6, standard: 0, avoid: -100 };
const TIER_RANK = {
  "ultra-luxury": 8,
  luxury: 7,
  "luxury-expedition": 6,
  "luxury-lifestyle": 6,
  "premium-luxury": 6,
  "premium-plus": 5,
  premium: 4,
  "premium-expedition": 4,
  "premium-family": 4,
  "premium-lifestyle": 4,
  "premium-resort": 4,
  "mass-market": 1,
};

const INTENT_ALIASES = {
  adventure: "active",
  culinary: "foodie",
  first: "first-timer",
  "first timer": "first-timer",
  firsttimer: "first-timer",
  private: "uhnw",
  simple: "first-timer",
  simplevip: "first-timer",
  spa: "wellness",
  vip: "uhnw",
};

function keyedByBrandId(raw) {
  return Object.fromEntries(
    Object.values(raw)
      .filter((row) => row && row.brandId)
      .map((row) => [row.brandId, row])
  );
}

const brandProfiles = keyedByBrandId(brandProfilesRaw);
const advisorOverlay = keyedByBrandId(advisorOverlayRaw);

const brandIndex = (() => {
  const idx = {};
  const add = (label, brandId) => {
    const key = norm(label);
    if (key && brandId && !idx[key]) idx[key] = brandId;
  };
  for (const row of Object.values(brandProfiles)) {
    add(row.brandId, row.brandId);
    add(row.displayName, row.brandId);
    for (const alias of row.aliases || []) add(alias, row.brandId);
  }
  for (const row of Object.values(advisorOverlay)) {
    add(row.brandId, row.brandId);
    for (const alias of row.aliases || []) add(alias, row.brandId);
  }
  return idx;
})();

function intentKey(raw) {
  const key = norm(raw);
  return INTENT_ALIASES[key] || key || null;
}

function resolveBrandId(item, getBrandLabel) {
  const fit = itineraryFit[item.id];
  if (fit && fit.brandId) return fit.brandId;
  const label = getBrandLabel ? getBrandLabel(item) : (item.brand || item.operator);
  const direct = brandIndex[norm(label)];
  if (direct) return direct;
  const text = norm(label);
  for (const [alias, brandId] of Object.entries(brandIndex)) {
    if (alias.length >= 5 && (text.includes(alias) || alias.includes(text))) return brandId;
  }
  return null;
}

function brandIdealFallback(profile, guestType) {
  if (!profile) return 45;
  const guest = norm(guestType);
  const ideal = (profile.idealGuest || []).map(norm);
  const notIdeal = (profile.notIdealFor || []).map(norm);
  if (ideal.includes(guest)) return 60;
  if (notIdeal.includes(guest)) return 20;
  if (guest === "couples" && ideal.includes("honeymoon")) return 54;
  if (guest === "multigen" && ideal.includes("family")) return 54;
  return 30;
}

function notesFor(overlay, guestType) {
  if (!overlay || !Array.isArray(overlay.notes)) return { boost: 0, clientSafe: [] };
  const guest = norm(guestType);
  let boost = 0;
  const clientSafe = [];
  for (const note of overlay.notes) {
    const audience = norm(note.audience || "all");
    if (audience !== "all" && audience !== guest) continue;
    boost += Number(note.weight) || 0;
    if (note.clientSafe && note.note) clientSafe.push(note.note);
  }
  return { boost: Math.min(boost, 10), clientSafe };
}

function buildGuestRationale(profile, fitRow, safeNotes, guestType) {
  const bits = [];
  const guest = norm(guestType);
  if (profile) {
    const ideal = (profile.idealGuest || []).map(norm);
    const notIdeal = (profile.notIdealFor || []).map(norm);
    const vibe = profile.positioning && profile.positioning.vibe;
    if (ideal.includes(guest)) bits.push(`well suited to ${guestType} travelers`);
    if (notIdeal.includes(guest)) bits.push(`not the natural first fit for ${guestType}`);
    if (Array.isArray(vibe) && vibe.length) bits.push(vibe.slice(0, 2).join(", "));
  }
  const a = fitRow && fitRow.attributes;
  if (a) {
    if (a.wildlifeFocus >= 4) bits.push("strong wildlife focus");
    if (a.cultureFocus >= 4) bits.push("culture-rich");
    if (a.wellnessFocus >= 4) bits.push("wellness-forward");
    if (a.privacyFocus >= 4) bits.push("strong privacy signal");
    if (a.remoteness >= 4) bits.push("remote or expeditionary");
    if (a.pace) bits.push(`${a.pace} pace`);
  }
  bits.push(...safeNotes.slice(0, 2));
  return bits.length ? bits.join("; ") : "fit signal is present but needs advisor review";
}

function scoreItem(item, guestType, options = {}) {
  const guest = intentKey(guestType);
  const fitRow = itineraryFit[item.id] || null;
  const brandId = resolveBrandId(item, options.getBrandLabel);
  const profile = brandId ? brandProfiles[brandId] : null;
  const overlay = brandId ? advisorOverlay[brandId] : null;
  const fitValue = fitRow && fitRow.guestFit && fitRow.guestFit[guest];
  const fit = Number.isFinite(fitValue) ? fitValue : brandIdealFallback(profile, guest);
  const notes = notesFor(overlay, guest);
  const relationship = norm(overlay && overlay.relationship);
  const relBoost = RELATIONSHIP_BOOST[relationship] ?? 0;
  const total = fit + notes.boost + relBoost;

  return {
    item,
    brandId,
    profile,
    overlay,
    fitRow,
    fit,
    notesBoost: notes.boost,
    relBoost,
    total,
    avoid: relationship === "avoid",
    alwaysInclude: !!(overlay && overlay.alwaysInclude),
    tierRank: profile ? (TIER_RANK[norm(profile.positioning && profile.positioning.tier)] || 0) : 0,
    guestRationale: buildGuestRationale(profile, fitRow, notes.clientSafe, guest),
  };
}

function normalCompare(a, b, getName) {
  return (b.total - a.total) ||
    (b.relBoost - a.relBoost) ||
    (b.tierRank - a.tierRank) ||
    String(getName(b.item)).localeCompare(String(getName(a.item))) * -1;
}

function rankItems(items, guestType, options = {}) {
  const guest = intentKey(guestType);
  if (!guest) return items;
  const getName = options.getName || ((item) => item.name || item.title || "");
  let scored = items.map((item) => scoreItem(item, guest, options));
  if (!options.allowAvoid) scored = scored.filter((s) => !s.avoid);

  const normal = scored.slice().sort((a, b) => normalCompare(a, b, getName));
  const pinnedBrandIds = new Set();
  for (const s of normal) {
    if (s.alwaysInclude && s.brandId && !pinnedBrandIds.has(s.brandId)) pinnedBrandIds.add(s.brandId);
  }

  return normal
    .sort((a, b) =>
      (Number(pinnedBrandIds.has(b.brandId)) - Number(pinnedBrandIds.has(a.brandId))) ||
      normalCompare(a, b, getName))
    .map((s) => {
      if (options.attachFit === false) return s.item;
      return {
        ...s.item,
        fit: {
          intent: guest,
          score: s.total,
          guestScore: s.fit,
          rationale: s.guestRationale,
          attributes: (s.fitRow && s.fitRow.attributes) || {},
        },
      };
    });
}

module.exports = { rankItems, scoreItem, intentKey };
