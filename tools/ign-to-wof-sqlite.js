#!/usr/bin/env node
/**
 * IGN (Spain) Administrative Boundaries to WOF SQLite Converter
 * 
 * Converts official Spanish IGN (Instituto Geográfico Nacional) boundary data
 * from GeoJSON format to WOF SQLite format for use with Pelias.
 * 
 * Features:
 * - Processes all admin levels (country, region, county, localadmin)
 * - Builds parent-child relationships using Point-in-Polygon lookups
 * - Creates complete wof:hierarchy for each feature
 * - Uses INE codes for stable IDs
 * 
 * Usage:
 *   node ign-to-wof-sqlite.js -i merged.geojson -o whosonfirst-data-ign-spain.db
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const turfArea = require('@turf/area').default;
const { feature, point } = require('@turf/helpers');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { program } = require('commander');
const cliProgress = require('cli-progress');

// Spanish Administrative Hierarchy
// INE Code Structure:
// - Comunidad Autónoma: 2 digits (01-19)
// - Provincia: 2 digits (01-52)
// - Municipio: 5 digits (PPMMM where PP=provincia, MMM=municipio within provincia)

const HIERARCHY_ORDER = ['country', 'region', 'county', 'localadmin'];

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(color, ...args) {
  console.log(colors[color], ...args, colors.reset);
}

/**
 * Extract all coordinates from geometry
 */
function extractAllCoordinates(geometry) {
  const coords = [];
  
  function extract(arr) {
    if (!Array.isArray(arr)) return;
    if (arr.length >= 2 && typeof arr[0] === 'number' && typeof arr[1] === 'number') {
      coords.push(arr);
    } else {
      arr.forEach(extract);
    }
  }
  
  if (geometry && geometry.coordinates) {
    extract(geometry.coordinates);
  }
  
  return coords;
}

/**
 * Calculate centroid from coordinate list
 */
function calculateCentroid(coords) {
  if (!coords || coords.length === 0) {
    return { lat: 0, lon: 0 };
  }
  
  const sum = coords.reduce((acc, c) => ({
    lon: acc.lon + c[0],
    lat: acc.lat + c[1]
  }), { lon: 0, lat: 0 });
  
  return {
    lat: sum.lat / coords.length,
    lon: sum.lon / coords.length
  };
}

/**
 * Calculate bounding box
 */
function calculateBBox(coords) {
  if (!coords || coords.length === 0) {
    return '0,0,0,0';
  }
  
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  
  for (const coord of coords) {
    if (coord[0] < minLon) minLon = coord[0];
    if (coord[0] > maxLon) maxLon = coord[0];
    if (coord[1] < minLat) minLat = coord[1];
    if (coord[1] > maxLat) maxLat = coord[1];
  }
  
  return [minLon, minLat, maxLon, maxLat].join(',');
}

/**
 * Calculate polygon area in km²
 */
function calculateArea(geometry) {
  try {
    const geojsonFeature = feature(geometry);
    const area = turfArea(geojsonFeature);
    return Math.round(area / 1000000 * 100) / 100;
  } catch (e) {
    return 0;
  }
}

/**
 * Validate geometry
 */
function isValidGeometry(geometry) {
  if (!geometry) return false;
  if (!geometry.type) return false;
  if (!geometry.coordinates) return false;
  if (!['Polygon', 'MultiPolygon'].includes(geometry.type)) return false;
  
  const coords = extractAllCoordinates(geometry);
  return coords.length >= 3;
}

/**
 * Convert INE code to numeric WOF ID
 * Use hash function to avoid collisions with OSM IDs (which start with 9)
 * INE IDs will start with 7
 */
function ineCodeToWofId(ineCode) {
  // Simple hash function
  let hash = 0;
  const str = ineCode.toString();
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  // Make it positive and prefix with 7
  const positiveHash = Math.abs(hash) % 100000000;
  return parseInt(`7${positiveHash.toString().padStart(8, '0')}`);
}

/**
 * Determine placetype based on INE code structure
 */
function determinePlacetype(ineCode, nationalLevel) {
  if (!ineCode) return null;
  
  // Use nationalLevel from IGN API if available
  if (nationalLevel) {
    switch(nationalLevel) {
      case '1st order':
        return 'country';
      case '2nd order':
        return 'region';  // Comunidad Autónoma
      case '3rd order':
        return 'county';  // Provincia
      case '6th order':
        return 'localadmin';  // Municipio
    }
  }
  
  // Fallback: determine from code length
  const codeStr = ineCode.toString();
  if (codeStr === '0' || codeStr === 'ES') {
    return 'country';
  } else if (codeStr.length === 2) {
    return 'region';  // Comunidad Autónoma (2 digits)
  } else if (codeStr.length === 5) {
    return 'localadmin';  // Municipio (5 digits: PPMMM)
  }
  
  return null;
}

/**
 * Extract INE code from properties
 * IGN API uses various field names
 */
function extractIneCode(props) {
  // Try various field names that IGN might use
  return props.nationalCode ||
         props.NATCODE ||
         props.codigo ||
         props.code ||
         props.INE ||
         props.CPRO ||  // Provincia code
         props.CMUN ||  // Municipio code
         props.id ||
         null;
}

/**
 * Extract name from properties
 */
function extractName(props) {
  return props.name ||
         props.NAMEUNIT ||
         props.nameUnit ||
         props.nombre ||
         props.NAME ||
         props.NOMBRE ||
         null;
}

/**
 * Extract national level from properties
 */
function extractNationalLevel(props) {
  return props.nationalLevel ||
         props.NATIONALLEVEL ||
         props.nivel ||
         null;
}

/**
 * Find parent for given feature using Point-in-Polygon
 */
function findParent(centroid, placetype, potentialParents) {
  const placetypeIndex = HIERARCHY_ORDER.indexOf(placetype);
  if (placetypeIndex <= 0) return null; // country has no parent
  
  const parentPlacetype = HIERARCHY_ORDER[placetypeIndex - 1];
  
  // Filter only relevant placetype
  const candidates = potentialParents.filter(p => p.placetype === parentPlacetype);
  
  if (candidates.length === 0) return null;
  
  // Create point from centroid
  const pt = point([centroid.lon, centroid.lat]);
  
  // Find first polygon containing the point
  // Sort by area (ascending) to prefer smallest containing polygon
  const sortedCandidates = candidates.sort((a, b) => a.area - b.area);
  
  for (const candidate of sortedCandidates) {
    try {
      if (booleanPointInPolygon(pt, candidate.geometry)) {
        return candidate;
      }
    } catch (e) {
      // Skip invalid geometries
      continue;
    }
  }
  
  return null;
}

/**
 * Build full hierarchy for given feature
 */
function buildHierarchy(featureData, allFeatures) {
  const hierarchy = {
    country_id: -1,
    region_id: -1,
    county_id: -1,
    localadmin_id: -1
  };
  
  // Set own ID
  hierarchy[`${featureData.placetype}_id`] = featureData.wofId;
  
  // Iterate up the hierarchy
  let currentFeature = featureData;
  let currentPlacetype = featureData.placetype;
  
  while (currentFeature && currentPlacetype) {
    // Find parent
    const parent = findParent(currentFeature.centroid, currentPlacetype, allFeatures);
    
    if (!parent) break;
    
    // Add parent to hierarchy
    hierarchy[`${parent.placetype}_id`] = parent.wofId;
    
    // Move to parent
    currentFeature = parent;
    currentPlacetype = parent.placetype;
  }
  
  return hierarchy;
}

/**
 * Load features from a single GeoJSON file
 */
function loadFeaturesFromFile(filePath) {
  log('blue', `📂 Reading: ${filePath}`);
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const geojson = JSON.parse(content);
    
    let features = [];
    if (geojson.type === 'FeatureCollection') {
      features = geojson.features || [];
    } else if (geojson.type === 'Feature') {
      features = [geojson];
    } else if (Array.isArray(geojson)) {
      features = geojson;
    }
    
    log('blue', `   Found ${features.length} features`);
    return features;
  } catch (e) {
    log('red', `❌ Error parsing ${filePath}: ${e.message}`);
    return [];
  }
}

/**
 * Main conversion function
 */
function convertIgnToWofSqlite(inputPath, outputPath) {
  log('cyan', '\n🇪🇸  IGN Spain to WOF SQLite Converter');
  log('cyan', '=====================================\n');
  
  // Handle multiple input files (comma-separated or glob pattern)
  let inputFiles = [];
  
  if (inputPath.includes(',')) {
    // Comma-separated list
    inputFiles = inputPath.split(',').map(f => f.trim());
  } else if (inputPath.includes('*')) {
    // Glob pattern
    const glob = require('glob');
    inputFiles = glob.sync(inputPath);
  } else {
    // Single file
    inputFiles = [inputPath];
  }
  
  // Verify all files exist
  for (const file of inputFiles) {
    if (!fs.existsSync(file)) {
      log('red', `❌ Error: Input file not found: ${file}`);
      process.exit(1);
    }
  }
  
  log('blue', `📂 Loading ${inputFiles.length} GeoJSON file(s)...\n`);
  
  // Load features from all files
  let features = [];
  for (const file of inputFiles) {
    const fileFeatures = loadFeaturesFromFile(file);
    features = features.concat(fileFeatures);
  }
  
  log('blue', `\n📊 Total: ${features.length} features from ${inputFiles.length} file(s)\n`);
  
  // PASS 1: Process all features (without hierarchy)
  log('magenta', '🔄 PASS 1: Processing features...');
  
  const progressBar1 = new cliProgress.SingleBar({
    format: 'Pass 1 |{bar}| {percentage}% | {value}/{total} | {status}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true
  });
  
  progressBar1.start(features.length, 0, { status: 'Starting...' });
  
  const processedFeatures = [];
  const stats = {
    total: features.length,
    processed: 0,
    skipped: 0,
    byPlacetype: {}
  };
  
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const props = feature.properties || {};
    
    const ineCode = extractIneCode(props);
    const nationalLevel = extractNationalLevel(props);
    const placetype = determinePlacetype(ineCode, nationalLevel);
    
    if (!placetype) {
      stats.skipped++;
      progressBar1.update(i + 1, { status: `Skipped (unknown type: ${ineCode})` });
      continue;
    }
    
    let geometry = feature.geometry;
    if (!isValidGeometry(geometry)) {
      stats.skipped++;
      progressBar1.update(i + 1, { status: 'Skipped (invalid geometry)' });
      continue;
    }
    
    const name = extractName(props);
    
    if (!name) {
      stats.skipped++;
      progressBar1.update(i + 1, { status: 'Skipped (no name)' });
      continue;
    }
    
    const coords = extractAllCoordinates(geometry);
    const centroid = calculateCentroid(coords);
    const bbox = calculateBBox(coords);
    const area = calculateArea(geometry);
    
    const wofId = ineCodeToWofId(ineCode);
    
    processedFeatures.push({
      wofId,
      ineCode,
      name,
      placetype,
      centroid,
      bbox,
      area,
      geometry,
      nationalLevel
    });
    
    stats.processed++;
    stats.byPlacetype[placetype] = (stats.byPlacetype[placetype] || 0) + 1;
    progressBar1.update(i + 1, { status: `${name.substring(0, 30)}...` });
  }
  
  progressBar1.stop();
  
  log('green', `✅ Pass 1 complete: ${stats.processed} features processed\n`);
  
  // PASS 2: Build hierarchy
  log('magenta', '🔗 PASS 2: Building hierarchy...');
  
  const progressBar2 = new cliProgress.SingleBar({
    format: 'Pass 2 |{bar}| {percentage}% | {value}/{total} | {status}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true
  });
  
  progressBar2.start(processedFeatures.length, 0, { status: 'Building hierarchy...' });
  
  const featuresWithHierarchy = [];
  
  for (let i = 0; i < processedFeatures.length; i++) {
    const featureData = processedFeatures[i];
    
    // Build hierarchy
    const hierarchy = buildHierarchy(featureData, processedFeatures);
    
    featuresWithHierarchy.push({
      ...featureData,
      hierarchy
    });
    
    progressBar2.update(i + 1, { status: featureData.name.substring(0, 30) });
  }
  
  progressBar2.stop();
  
  log('green', `✅ Pass 2 complete: hierarchy built for ${featuresWithHierarchy.length} features\n`);
  
  // PASS 3: Write to SQLite database
  log('magenta', '💾 PASS 3: Writing to SQLite database...');
  
  if (fs.existsSync(outputPath)) {
    log('yellow', `⚠️  Removing existing database: ${outputPath}`);
    fs.unlinkSync(outputPath);
  }
  
  const db = new Database(outputPath);
  
  // Schema (identical to osm-to-wof-hierarchical.js)
  db.exec(`
    CREATE TABLE IF NOT EXISTS geojson (
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL,
      is_alt INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS geojson_by_id ON geojson(id);
    
    CREATE TABLE IF NOT EXISTS spr (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER DEFAULT -1,
      name TEXT,
      placetype TEXT,
      country TEXT DEFAULT 'ES',
      country_id INTEGER DEFAULT -1,
      region_id INTEGER DEFAULT -1,
      county_id INTEGER DEFAULT -1,
      localadmin_id INTEGER DEFAULT -1,
      locality_id INTEGER DEFAULT -1,
      is_current INTEGER DEFAULT 1,
      is_deprecated INTEGER DEFAULT 0,
      is_ceased INTEGER DEFAULT 0,
      is_superseded INTEGER DEFAULT 0,
      is_superseding INTEGER DEFAULT 0,
      superseded_by TEXT,
      supersedes TEXT,
      lastmodified INTEGER,
      cessation TEXT,
      deprecated TEXT,
      bbox TEXT,
      geom_latitude REAL,
      geom_longitude REAL,
      iso TEXT,
      wof_country TEXT DEFAULT 'ES'
    );
    CREATE INDEX IF NOT EXISTS spr_by_id ON spr(id);
    CREATE INDEX IF NOT EXISTS spr_by_placetype ON spr(placetype);
    CREATE INDEX IF NOT EXISTS spr_by_country ON spr(country);
    CREATE INDEX IF NOT EXISTS spr_by_parent ON spr(parent_id);
  `);
  
  const progressBar3 = new cliProgress.SingleBar({
    format: 'Pass 3 |{bar}| {percentage}% | {value}/{total} | Writing...',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true
  });
  
  progressBar3.start(featuresWithHierarchy.length, 0);
  
  const insertGeojson = db.prepare('INSERT INTO geojson (id, body) VALUES (?, ?)');
  const insertSpr = db.prepare(`
    INSERT INTO spr (
      id, parent_id, name, placetype, country,
      country_id, region_id, county_id, localadmin_id, locality_id,
      bbox, geom_latitude, geom_longitude, iso, wof_country
    ) VALUES (
      ?, ?, ?, ?, 'ES',
      ?, ?, ?, ?, ?,
      ?, ?, ?, 'ES', 'ES'
    )
  `);
  
  const transaction = db.transaction((features) => {
    for (const feat of features) {
      // GeoJSON record
      const geojsonBody = JSON.stringify({
        type: 'Feature',
        id: feat.wofId,
        properties: {
          'wof:id': feat.wofId,
          'wof:name': feat.name,
          'wof:placetype': feat.placetype,
          'wof:country': 'ES',
          'wof:hierarchy': [feat.hierarchy],
          'ign:code': feat.ineCode,
          'ign:level': feat.nationalLevel,
          'geom:area': feat.area,
          'geom:bbox': feat.bbox
        },
        geometry: feat.geometry
      });
      
      insertGeojson.run(feat.wofId, geojsonBody);
      
      // SPR record (parent_id is the immediate parent in hierarchy)
      let parentId = -1;
      const placetypeIndex = HIERARCHY_ORDER.indexOf(feat.placetype);
      if (placetypeIndex > 0) {
        const parentPlacetype = HIERARCHY_ORDER[placetypeIndex - 1];
        parentId = feat.hierarchy[`${parentPlacetype}_id`] || -1;
      }
      
      insertSpr.run(
        feat.wofId,
        parentId,
        feat.name,
        feat.placetype,
        feat.hierarchy.country_id || -1,
        feat.hierarchy.region_id || -1,
        feat.hierarchy.county_id || -1,
        feat.hierarchy.localadmin_id || -1,
        -1,  // locality_id (not used for Spain)
        feat.bbox,
        feat.centroid.lat,
        feat.centroid.lon
      );
    }
  });
  
  transaction(featuresWithHierarchy);
  
  progressBar3.update(featuresWithHierarchy.length);
  progressBar3.stop();
  
  db.close();
  
  log('green', '\n✅ Conversion completed!\n');
  
  // Statistics
  log('cyan', '📊 Statistics:');
  log('cyan', `   Total features:     ${stats.processed}`);
  log('cyan', `   Processed:          ${stats.processed}`);
  log('cyan', `   Skipped:            ${stats.skipped}\n`);
  
  log('cyan', '📍 By placetype:');
  for (const [placetype, count] of Object.entries(stats.byPlacetype)) {
    log('cyan', `   ${placetype.padEnd(15)} ${count}`);
  }
  
  const fileSize = fs.statSync(outputPath).size;
  const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
  
  log('cyan', `\n💾 Output file: ${outputPath}`);
  log('cyan', `   Size: ${fileSizeMB} MB\n`);
  
  log('green', '🎯 Success! Spanish IGN boundaries converted to WOF format.');
  log('green', '   This database provides administrative boundaries for Spain!\n');
  log('cyan', 'Copy this file to /data/whosonfirst/sqlite/ and restart your Pelias import.\n');
}

// Parse command line arguments
program
  .name('ign-to-wof-sqlite')
  .description('Convert IGN Spain administrative boundaries GeoJSON to WOF SQLite format')
  .requiredOption('-i, --input <path>', 'Input GeoJSON file(s) (comma-separated or glob pattern)')
  .requiredOption('-o, --output <path>', 'Output SQLite database file')
  .parse(process.argv);

const options = program.opts();

// Run conversion
convertIgnToWofSqlite(options.input, options.output);
