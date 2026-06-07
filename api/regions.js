// GET /api/regions
// Per-marquee-region sailing count + centroid for the Living Atlas resting
// state. Response: { total, count, regions: [ { region, count, center, deepLink } ] }.

const { regions } = require("../lib/cruises");

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
  res.setHeader("Content-Type", "application/json");

  if (req.method && req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  res.status(200).json(regions());
};
