#!/usr/bin/env node
// PIP test: check which polygons (neighbourhood/locality/localadmin/county)
// contain the Greater Manchester test points that production Pelias used to
// resolve incorrectly, and verify the hierarchy stored in the database.
//
// Usage: node pip-test-manchester.js [path-to-db]
const Database = require('better-sqlite3');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { point } = require('@turf/helpers');

const dbPath = process.argv[2] || 'output/whosonfirst-data-ons-uk.db';
const db = new Database(dbPath, { readonly: true });

// Approximate coordinates of the test addresses (from OSM/Nominatim)
const testPoints = [
  { name: '2 Cass Avenue, M5 3AP',      lat: 53.4693, lon: -2.2810, expected: { neighbourhood: 'Ordsall',            locality: 'Salford',    county: 'Greater Manchester' } },
  { name: '15 Parish View, M5 3PA',     lat: 53.4712, lon: -2.2749, expected: { neighbourhood: 'Ordsall',            locality: 'Salford',    county: 'Greater Manchester' } },
  { name: '7 New Vine Street, M15 5ND', lat: 53.4633, lon: -2.2492, expected: { neighbourhood: 'Hulme',              locality: 'Manchester', county: 'Greater Manchester' } },
  { name: '11 Eastleigh Dr, M40 7JD',   lat: 53.5019, lon: -2.2192, expected: { neighbourhood: 'Collyhurst',         locality: 'Manchester', county: 'Greater Manchester' } },
  { name: '40 Brook Avenue, M19 3DQ',   lat: 53.4436, lon: -2.1926, expected: { neighbourhood: 'Levenshulme',        locality: 'Manchester', county: 'Greater Manchester' } },
  { name: '8 West Meade, M21 8FD',      lat: 53.4308, lon: -2.2704, expected: { neighbourhood: 'Chorlton-cum-Hardy', locality: 'Manchester', county: 'Greater Manchester' } },
  { name: '36 Ladysmith Rd, M20 6HP',   lat: 53.4218, lon: -2.2116, expected: { neighbourhood: 'Burnage',            locality: 'Manchester', county: 'Greater Manchester' } },
];

const LAYERS = ['neighbourhood', 'locality', 'localadmin', 'county', 'region'];

// Load all polygons whose bbox could contain any test point
const rows = db.prepare(`
  SELECT s.id, s.name, s.placetype, g.body
  FROM spr s JOIN geojson g ON g.id = s.id
  WHERE s.placetype IN ('neighbourhood','locality','localadmin','county','region')
    AND s.min_latitude < 53.6 AND s.max_latitude > 53.3
    AND s.min_longitude < -2.0 AND s.max_longitude > -2.6
`).all();

const polys = rows.map(r => {
  const f = JSON.parse(r.body);
  return { id: r.id, name: r.name, placetype: r.placetype, geometry: f.geometry, hierarchy: (f.properties['wof:hierarchy'] || [])[0] || {} };
}).filter(p => p.geometry);

const nameById = new Map(
  db.prepare('SELECT id, name FROM spr').all().map(r => [r.id, r.name])
);

console.log(`DB: ${dbPath}`);
console.log(`Candidate polygons in Greater Manchester area: ${polys.length}\n`);

let failures = 0;

for (const tp of testPoints) {
  const pt = point([tp.lon, tp.lat]);
  const hits = polys.filter(p => {
    try { return booleanPointInPolygon(pt, p.geometry); } catch { return false; }
  });

  const byLayer = {};
  for (const layer of LAYERS) {
    byLayer[layer] = hits.filter(h => h.placetype === layer);
  }

  // Check expectations against PiP results
  const problems = [];
  for (const [layer, expectedName] of Object.entries(tp.expected)) {
    const names = byLayer[layer].map(h => h.name);
    if (!names.includes(expectedName)) {
      problems.push(`${layer}: expected "${expectedName}", got [${names.join(', ') || 'none'}]`);
    }
  }

  // Check the hierarchy of the matched neighbourhood is complete
  // (locality/localadmin required by wof-admin-lookup neighbourhood filters,
  //  region/country prove the multi-level parent walk works)
  const nbr = byLayer.neighbourhood.find(h => h.name === tp.expected.neighbourhood);
  if (nbr) {
    for (const key of ['locality_id', 'localadmin_id', 'county_id', 'region_id', 'country_id']) {
      if (!nbr.hierarchy[key] || nbr.hierarchy[key] === -1) {
        problems.push(`neighbourhood hierarchy missing ${key}`);
      }
    }
  }

  const status = problems.length === 0 ? 'OK ' : 'BAD';
  if (problems.length > 0) failures++;

  console.log(`${status} ${tp.name}`);
  for (const layer of LAYERS) {
    const names = byLayer[layer].map(h => h.name).join(', ') || '(none)';
    console.log(`     ${layer.padEnd(14)} ${names}`);
  }
  if (nbr) {
    const chain = ['locality_id', 'localadmin_id', 'county_id', 'region_id', 'country_id']
      .map(k => `${k.replace('_id', '')}=${nameById.get(nbr.hierarchy[k]) || nbr.hierarchy[k]}`)
      .join(', ');
    console.log(`     nbr hierarchy: ${chain}`);
  }
  for (const p of problems) console.log(`     PROBLEM: ${p}`);
  console.log();
}

db.close();

if (failures > 0) {
  console.log(`FAILED: ${failures}/${testPoints.length} test points have problems`);
  process.exit(1);
} else {
  console.log(`PASSED: all ${testPoints.length} test points resolve correctly`);
}
