#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'output', 'whosonfirst-data-ons-uk.db');
const db = new Database(dbPath, { readonly: true });

console.log('\n========================================');
console.log('🔍 London Locality Verification');
console.log('========================================\n');

// 1. Check for synthetic "London" locality
console.log('1️⃣  Synthetic "London" locality:');
const londonLocality = db.prepare(`
  SELECT id, name, placetype, latitude, longitude
  FROM spr 
  WHERE name = 'London' AND placetype = 'locality'
`).get();

if (londonLocality) {
  console.log('   ✅ Found synthetic London locality');
  console.log(`   ID: ${londonLocality.id}`);
  console.log(`   Coordinates: ${londonLocality.latitude.toFixed(4)}, ${londonLocality.longitude.toFixed(4)}\n`);
} else {
  console.log('   ❌ Synthetic London locality NOT found!\n');
  process.exit(1);
}

// 2. Check London Boroughs have London as locality
console.log('2️⃣  London Boroughs with "London" locality:');
const boroughsWithLondon = db.prepare(`
  SELECT COUNT(*) as count
  FROM spr s
  JOIN ancestors a ON s.id = a.id
  WHERE s.placetype = 'localadmin' 
  AND a.ancestor_placetype = 'locality'
  AND a.ancestor_id = ?
`).get(londonLocality.id);

console.log(`   Found ${boroughsWithLondon.count} London Boroughs linked to "London" locality`);

// 3. Check total London Boroughs
console.log('\n3️⃣  Total London Boroughs (E09):');
const totalBoroughs = db.prepare(`
  SELECT COUNT(*) as count, placetype
  FROM spr 
  WHERE id BETWEEN 836000000 AND 837000000
  AND placetype = 'localadmin'
`).get();

console.log(`   Total: ${totalBoroughs.count} boroughs`);

if (boroughsWithLondon.count === totalBoroughs.count) {
  console.log(`   ✅ All London Boroughs correctly linked to "London" locality\n`);
} else {
  console.log(`   ⚠️  Only ${boroughsWithLondon.count} out of ${totalBoroughs.count} boroughs linked!\n`);
}

// 4. Sample London Borough verification
console.log('4️⃣  Sample verification - Kensington and Chelsea:');
const kensington = db.prepare(`
  SELECT s.id, s.name, s.placetype,
         l.name as locality_name
  FROM spr s
  LEFT JOIN ancestors a ON s.id = a.id AND a.ancestor_placetype = 'locality'
  LEFT JOIN spr l ON a.ancestor_id = l.id
  WHERE s.name = 'Kensington and Chelsea' AND s.placetype = 'localadmin'
`).get();

if (kensington) {
  console.log(`   Borough: ${kensington.name}`);
  console.log(`   Locality: ${kensington.locality_name || 'NONE'}`);
  if (kensington.locality_name === 'London') {
    console.log(`   ✅ Correctly mapped to "London"\n`);
  } else {
    console.log(`   ❌ NOT mapped to "London"!\n`);
  }
}

// 5. Check for duplicate BUA
console.log('5️⃣  Duplicate BUA check:');
const kensingtonBUA = db.prepare(`
  SELECT COUNT(*) as count
  FROM spr 
  WHERE name = 'Kensington and Chelsea' AND placetype = 'locality'
`).get();

if (kensingtonBUA.count === 0) {
  console.log(`   ✅ No duplicate "Kensington and Chelsea" BUA (correctly filtered)\n`);
} else {
  console.log(`   ⚠️  Found ${kensingtonBUA.count} duplicate BUA entries\n`);
}

// 6. Summary statistics
console.log('6️⃣  Database statistics:');
const stats = db.prepare(`
  SELECT placetype, COUNT(*) as count
  FROM spr
  GROUP BY placetype
  ORDER BY 
    CASE placetype
      WHEN 'country' THEN 1
      WHEN 'region' THEN 2
      WHEN 'county' THEN 3
      WHEN 'localadmin' THEN 4
      WHEN 'locality' THEN 5
      ELSE 6
    END
`).all();

stats.forEach(s => {
  console.log(`   ${s.placetype.padEnd(15)} ${s.count}`);
});

console.log('\n========================================');
console.log('✅ Verification complete!');
console.log('========================================\n');

db.close();
