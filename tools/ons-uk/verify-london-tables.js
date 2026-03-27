#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'output', 'whosonfirst-data-ons-uk.db');
const db = new Database(dbPath, { readonly: true });

console.log('\n========================================');
console.log('🔍 London Tables Verification');
console.log('========================================\n');

// 1. Check if synthetic London is in geojson table
console.log('1️⃣  Synthetic London in geojson table (should be YES):');
const londonInGeojson = db.prepare(`
  SELECT id, json_extract(body, '$.properties."wof:placetype"') as wof_placetype
  FROM geojson 
  WHERE id = 999999999
`).get();

if (londonInGeojson) {
  console.log('   ✅ Found in geojson table');
  console.log(`   GeoJSON wof:placetype: ${londonInGeojson.wof_placetype} (for hierarchy resolution)\n`);
} else {
  console.log('   ❌ NOT in geojson table (will fail hierarchy resolution!)\n');
}

// 2. Check if synthetic London is in spr table
console.log('2️⃣  Synthetic London in spr table (should be YES with placetype=macrocounty):');
const londonInSpr = db.prepare(`
  SELECT id, name, placetype
  FROM spr 
  WHERE id = 999999999
`).get();

if (londonInSpr) {
  console.log('   ✅ Found in spr table');
  console.log(`   Name: ${londonInSpr.name}, SPR placetype: ${londonInSpr.placetype}`);
  if (londonInSpr.placetype === 'macrocounty') {
    console.log('   ✅ SPR placetype is "macrocounty" (ghost loader technique - correct!)\n');
  } else {
    console.log(`   ⚠️  SPR placetype is "${londonInSpr.placetype}" (expected "macrocounty")\n`);
  }
} else {
  console.log('   ❌ NOT found in spr table\n');
}

// 3. Check Kensington and Chelsea in geojson table
console.log('3️⃣  Kensington and Chelsea (borough) in geojson table (should be YES):');
const kensingtonInGeojson = db.prepare(`
  SELECT g.id, json_extract(g.body, '$.properties."wof:name"') as name
  FROM geojson g
  JOIN spr s ON g.id = s.id
  WHERE s.name = 'Kensington and Chelsea' AND s.placetype = 'localadmin'
`).get();

if (kensingtonInGeojson) {
  console.log('   ✅ Found in geojson table');
  console.log(`   ID: ${kensingtonInGeojson.id}, Name: ${kensingtonInGeojson.name}\n`);
} else {
  console.log('   ❌ NOT found in geojson table\n');
}

// 4. Check hierarchy for Kensington
console.log('4️⃣  Kensington and Chelsea hierarchy:');
const kensingtonHierarchy = db.prepare(`
  SELECT a.ancestor_id, a.ancestor_placetype, s.name as ancestor_name
  FROM ancestors a
  JOIN spr s ON a.ancestor_id = s.id
  WHERE a.id = ?
  ORDER BY 
    CASE a.ancestor_placetype
      WHEN 'country' THEN 1
      WHEN 'region' THEN 2
      WHEN 'county' THEN 3
      WHEN 'localadmin' THEN 4
      WHEN 'locality' THEN 5
    END
`).all(kensingtonInGeojson?.id);

kensingtonHierarchy.forEach(h => {
  console.log(`   ${h.ancestor_placetype.padEnd(15)} → ${h.ancestor_name} (ID: ${h.ancestor_id})`);
});

const hasLondonInHierarchy = kensingtonHierarchy.some(h => 
  h.ancestor_placetype === 'locality' && h.ancestor_id === 999999999
);

if (hasLondonInHierarchy) {
  console.log('\n   ✅ Hierarchy includes "London" as locality\n');
} else {
  console.log('\n   ❌ Hierarchy does NOT include "London" as locality\n');
}

// 5. Summary
console.log('5️⃣  Summary:');
const geojsonCount = db.prepare(`SELECT COUNT(*) as count FROM geojson`).get();
const sprCount = db.prepare(`SELECT COUNT(*) as count FROM spr`).get();
const macrocountyCount = db.prepare(`SELECT COUNT(*) as count FROM spr WHERE placetype = 'macrocounty'`).get();

console.log(`   geojson table:  ${geojsonCount.count} features (loaded into wofData for PiP and hierarchy)`);
console.log(`   spr table:      ${sprCount.count} features (metadata)`);
console.log(`   macrocounty:    ${macrocountyCount.count} features (ghost loader: synthetic London)\n`);

if (geojsonCount.count === sprCount.count) {
  console.log('   ✅ All SPR entries have geojson - correct!\n');
} else {
  console.log(`   ⚠️  ${sprCount.count - geojsonCount.count} SPR entries missing from geojson\n`);
}

if (macrocountyCount.count === 1) {
  console.log('   ✅ Exactly 1 macrocounty entry (synthetic London) - correct!\n');
} else {
  console.log('   ⚠️  Expected 1 macrocounty entry, found ' + macrocountyCount.count + '\n');
}

console.log('========================================');
console.log('✅ Verification complete!');
console.log('========================================\n');

db.close();
