#!/usr/bin/env node
/**
 * ONS Administrative Boundaries to WOF SQLite Converter
 * 
 * Converts official UK ONS (Office for National Statistics) boundary data
 * from GeoJSON format to WOF SQLite format for use with Pelias.
 * 
 * Features:
 * - Processes all admin levels (country, region, county, localadmin, locality)
 * - Builds parent-child relationships using Point-in-Polygon lookups
 * - Creates complete wof:hierarchy for each feature
 * - Uses ONS codes for stable IDs
 * 
 * Usage:
 *   node ons-to-wof-sqlite.js -i merged.geojson -o whosonfirst-data-ons-uk.db
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const turfArea = require('@turf/area').default;
const { feature, point } = require('@turf/helpers');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { program } = require('commander');
const cliProgress = require('cli-progress');

// Mapowanie ONS kodu na placetype WOF
// ONS codes start with letter indicating admin level: E/W/S/N12000001
const ONS_CODE_TO_PLACETYPE = {
  // Country: E92, W92, S92, N92
  'E92': 'country',
  'W92': 'country', 
  'S92': 'country',
  'N92': 'country',
  
  // Region: E12 (English regions), plus Scotland/Wales/NI as regions
  'E12': 'region',
  'E13': 'region',  // Some regions use E13
  
  // County: E10 (ceremonial counties), E11 (metropolitan counties)
  'E10': 'county',
  'E11': 'county',
  'W06': 'county',  // Welsh preserved counties
  
  // Local Authority District: E06-E09 (various types of councils)
  'E06': 'localadmin',  // Unitary Authority
  'E07': 'localadmin',  // Non-metropolitan District
  'E08': 'localadmin',  // Metropolitan District
  'E09': 'localadmin',  // London Borough
  'W06': 'localadmin',  // Welsh Unitary Authority
  'S12': 'localadmin',  // Scottish Council Area
  'N09': 'localadmin',  // Northern Ireland District
  
  // Built-up Area (BUA 2022): E63 (England), W45 (Wales), S45 (Scotland), K08 (cross-border)
  'E63': 'locality',
  'W45': 'locality',
  'S45': 'locality',
  'K08': 'locality'
};

// Hierarchia poziomów (od najwyższego do najniższego)
const HIERARCHY_ORDER = ['country', 'region', 'county', 'localadmin', 'locality'];

// Kolory dla logów
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
 * Ekstrahuje wszystkie współrzędne z geometrii
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
 * Oblicza centroid z listy współrzędnych
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
 * Oblicza bounding box
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
 * Oblicza powierzchnię poligonu w km²
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
 * Waliduje geometrię
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
 * Konwertuje ONS kod na numeryczny WOF ID
 * Używamy hash funkcji aby uniknąć kolizji z OSM IDs (które zaczynają się od 9)
 * ONS IDs będą zaczynać się od 8
 */
function onsCodeToWofId(onsCode) {
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < onsCode.length; i++) {
    const char = onsCode.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  // Make it positive and prefix with 8
  const positiveHash = Math.abs(hash) % 100000000;
  return parseInt(`8${positiveHash.toString().padStart(8, '0')}`);
}

/**
 * Określa placetype na podstawie ONS kodu
 */
function determinePlacetype(onsCode) {
  if (!onsCode) return null;
  
  // Extract prefix (first 3 characters, e.g., E92, E12, E34)
  const prefix = onsCode.substring(0, 3);
  return ONS_CODE_TO_PLACETYPE[prefix] || null;
}

/**
 * Ekstrahuje ONS kod z properties
 * Różne datasety używają różnych nazw pól
 */
function extractOnsCode(props) {
  // Try various field names used by different ONS datasets
  return props.CTRY23CD ||  // Countries 2023
         props.RGN23CD ||   // Regions 2023
         props.CTYUA23CD || // Counties 2023
         props.LAD24CD ||   // LAD 2024
         props.BUA22CD ||   // Built-up Areas 2022
         props.code ||
         props.CODE ||
         null;
}

/**
 * Ekstrahuje nazwę z properties
 */
function extractName(props) {
  return props.CTRY23NM ||
         props.RGN23NM ||
         props.CTYUA23NM ||
         props.LAD24NM ||
         props.BUA22NM ||
         props.name ||
         props.NAME ||
         null;
}

/**
 * Znajduje parent dla danego feature używając Point-in-Polygon
 */
function findParent(centroid, placetype, potentialParents) {
  const placetypeIndex = HIERARCHY_ORDER.indexOf(placetype);
  if (placetypeIndex <= 0) return null; // country nie ma parent
  
  const parentPlacetype = HIERARCHY_ORDER[placetypeIndex - 1];
  
  // Filtruj tylko odpowiednie placetype
  const candidates = potentialParents.filter(p => p.placetype === parentPlacetype);
  
  if (candidates.length === 0) return null;
  
  // Utwórz punkt z centroidu
  const pt = point([centroid.lon, centroid.lat]);
  
  // Znajdź pierwszy polygon który zawiera punkt
  // Sortuj po area (rosnąco) aby preferować najmniejszy zawierający polygon
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
 * Buduje pełną hierarchię dla danego feature
 */
function buildHierarchy(featureData, allFeatures) {
  const hierarchy = {
    country_id: -1,
    region_id: -1,
    county_id: -1,
    localadmin_id: -1,
    locality_id: -1
  };
  
  // Ustaw własny ID
  hierarchy[`${featureData.placetype}_id`] = featureData.wofId;
  
  // Iteruj w górę hierarchii
  let currentFeature = featureData;
  let currentPlacetype = featureData.placetype;
  
  while (currentFeature && currentPlacetype) {
    // Znajdź parent
    const parent = findParent(currentFeature.centroid, currentPlacetype, allFeatures);
    
    if (!parent) break;
    
    // Dodaj parent do hierarchii
    hierarchy[`${parent.placetype}_id`] = parent.wofId;
    
    // Przejdź do parent
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
 * Główna funkcja konwersji
 */
function convertOnsToWofSqlite(inputPath, outputPath) {
  log('cyan', '\n🇬🇧  ONS to WOF SQLite Converter');
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
  
  // PASS 1: Przetwórz wszystkie features (bez hierarchii)
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
    
    const onsCode = extractOnsCode(props);
    const placetype = determinePlacetype(onsCode);
    
    if (!placetype) {
      stats.skipped++;
      progressBar1.update(i + 1, { status: `Skipped (unknown code ${onsCode})` });
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
    
    const wofId = onsCodeToWofId(onsCode);
    
    processedFeatures.push({
      wofId,
      onsCode,
      name,
      placetype,
      centroid,
      bbox,
      area,
      geometry,
      nameEn: props.BUA22NMW || props.LAD24NMW || null  // Welsh names if available
    });
    
    stats.processed++;
    stats.byPlacetype[placetype] = (stats.byPlacetype[placetype] || 0) + 1;
    progressBar1.update(i + 1, { status: `${name.substring(0, 30)}...` });
  }
  
  progressBar1.stop();
  
  log('green', `✅ Pass 1 complete: ${stats.processed} features processed\n`);
  
  // PASS 2: Buduj hierarchię
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
    
    // Buduj hierarchię
    const hierarchy = buildHierarchy(featureData, processedFeatures);
    
    featuresWithHierarchy.push({
      ...featureData,
      hierarchy
    });
    
    progressBar2.update(i + 1, { status: featureData.name.substring(0, 30) });
  }
  
  progressBar2.stop();
  
  log('green', `✅ Pass 2 complete: hierarchy built for ${featuresWithHierarchy.length} features\n`);
  
  // PASS 3: Zapisz do bazy SQLite
  log('magenta', '💾 PASS 3: Writing to SQLite database...');
  
  if (fs.existsSync(outputPath)) {
    log('yellow', `⚠️  Removing existing database: ${outputPath}`);
    fs.unlinkSync(outputPath);
  }
  
  const db = new Database(outputPath);
  
  // Schemat (identyczny jak w osm-to-wof-hierarchical.js)
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
      country TEXT,
      repo TEXT,
      latitude REAL,
      longitude REAL,
      min_latitude REAL,
      min_longitude REAL,
      max_latitude REAL,
      max_longitude REAL,
      is_current INTEGER DEFAULT 1,
      is_deprecated INTEGER DEFAULT 0,
      is_ceased INTEGER DEFAULT 0,
      is_superseded INTEGER DEFAULT 0,
      is_superseding INTEGER DEFAULT 0,
      superseded_by TEXT,
      supersedes TEXT,
      lastmodified INTEGER
    );
    CREATE INDEX IF NOT EXISTS spr_by_id ON spr(id);
    CREATE INDEX IF NOT EXISTS spr_by_placetype ON spr(placetype);
    CREATE INDEX IF NOT EXISTS spr_by_name ON spr(name);
    
    CREATE TABLE IF NOT EXISTS ancestors (
      id INTEGER,
      ancestor_id INTEGER,
      ancestor_placetype TEXT,
      lastmodified INTEGER
    );
    CREATE INDEX IF NOT EXISTS ancestors_by_id ON ancestors(id);
    CREATE INDEX IF NOT EXISTS ancestors_by_ancestor_id ON ancestors(ancestor_id);
  `);
  
  const insertGeojson = db.prepare('INSERT OR REPLACE INTO geojson (id, body, is_alt) VALUES (?, ?, 0)');
  const insertSpr = db.prepare(`
    INSERT OR REPLACE INTO spr 
    (id, parent_id, name, placetype, country, latitude, longitude, 
     min_latitude, min_longitude, max_latitude, max_longitude,
     is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, ?)
  `);
  const insertAncestor = db.prepare(`
    INSERT INTO ancestors (id, ancestor_id, ancestor_placetype, lastmodified)
    VALUES (?, ?, ?, ?)
  `);
  
  const progressBar3 = new cliProgress.SingleBar({
    format: 'Pass 3 |{bar}| {percentage}% | {value}/{total} | {status}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true
  });
  
  progressBar3.start(featuresWithHierarchy.length, 0, { status: 'Writing...' });
  
  const transaction = db.transaction(() => {
    for (let i = 0; i < featuresWithHierarchy.length; i++) {
      const fd = featuresWithHierarchy[i];
      
      // Określ parent_id (pierwszy wyższy poziom w hierarchii)
      const placetypeIndex = HIERARCHY_ORDER.indexOf(fd.placetype);
      let parentId = -1;
      
      if (placetypeIndex > 0) {
        const parentPlacetype = HIERARCHY_ORDER[placetypeIndex - 1];
        parentId = fd.hierarchy[`${parentPlacetype}_id`] || -1;
      }
      
      // Utwórz WOF GeoJSON record
      const wofRecord = {
        type: 'Feature',
        id: fd.wofId,
        properties: {
          'wof:id': fd.wofId,
          'wof:name': fd.name,
          'wof:placetype': fd.placetype,
          'wof:parent_id': parentId,
          'wof:hierarchy': [fd.hierarchy],
          'wof:country': 'GB',
          
          'geom:latitude': fd.centroid.lat,
          'geom:longitude': fd.centroid.lon,
          'geom:bbox': fd.bbox,
          'geom:area': fd.area,
          
          'mz:is_current': 1,
          'mz:hierarchy_label': 1,
          
          'edtf:cessation': 'uuuu',
          'edtf:inception': 'uuuu',
          
          'src:geom': 'ons',
          'src:geom_alt': [],
          
          'ons:code': fd.onsCode,
          
          ...(fd.nameEn && { 'name:cym_x_preferred': [fd.nameEn] }),
          ...(fd.placetype === 'country' && { 'iso:country': 'GB' })
        },
        geometry: fd.geometry
      };
      
      // Parse bbox
      const bboxParts = fd.bbox.split(',').map(Number);
      const minLon = bboxParts[0] || 0;
      const minLat = bboxParts[1] || 0;
      const maxLon = bboxParts[2] || 0;
      const maxLat = bboxParts[3] || 0;
      
      // Insert geojson
      insertGeojson.run(fd.wofId, JSON.stringify(wofRecord));
      
      // Insert SPR
      const countryValue = fd.placetype === 'country' ? '' : 'GB';
      insertSpr.run(
        fd.wofId,
        parentId,
        fd.name,
        fd.placetype,
        countryValue,
        fd.centroid.lat,
        fd.centroid.lon,
        minLat,
        minLon,
        maxLat,
        maxLon,
        Date.now()
      );
      
      // Insert ancestors
      const now = Date.now();
      for (const [key, value] of Object.entries(fd.hierarchy)) {
        if (value !== -1 && value !== fd.wofId) {
          const ancestorPlacetype = key.replace('_id', '');
          insertAncestor.run(fd.wofId, value, ancestorPlacetype, now);
        }
      }
      
      progressBar3.update(i + 1, { status: fd.name.substring(0, 30) });
    }
  });
  
  try {
    transaction();
  } catch (e) {
    log('red', `\n❌ Transaction error: ${e.message}`);
    process.exit(1);
  }
  
  progressBar3.stop();
  
  db.close();
  
  // Podsumowanie
  log('green', '\n✅ Conversion completed!\n');
  log('cyan', '📊 Statistics:');
  log('blue', `   Total features:     ${stats.total}`);
  log('green', `   Processed:          ${stats.processed}`);
  log('yellow', `   Skipped:            ${stats.skipped}`);
  
  log('cyan', '\n📍 By placetype:');
  HIERARCHY_ORDER.forEach(placetype => {
    const count = stats.byPlacetype[placetype] || 0;
    if (count > 0) {
      log('blue', `   ${placetype.padEnd(15)} ${count}`);
    }
  });
  
  const fileSize = fs.statSync(outputPath).size;
  log('cyan', `\n💾 Output file: ${outputPath}`);
  log('blue', `   Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
  
  log('green', '\n🎯 Success! Official ONS boundaries converted to WOF format.');
  log('blue', '   This database provides proper polygon boundaries for ~8000 UK localities!');
  log('cyan', '\nCopy this file to /data/whosonfirst/sqlite/ and restart your Pelias import.\n');
}

// Parse command line arguments
program
  .name('ons-to-wof-sqlite')
  .description('Convert ONS administrative boundaries GeoJSON to WOF SQLite format')
  .version('1.0.0')
  .requiredOption('-i, --input <path>', 'Input GeoJSON file (merged ONS data)')
  .requiredOption('-o, --output <path>', 'Output SQLite file', 'whosonfirst-data-ons-uk.db')
  .parse(process.argv);

const options = program.opts();

// Run conversion
convertOnsToWofSqlite(options.input, options.output);
