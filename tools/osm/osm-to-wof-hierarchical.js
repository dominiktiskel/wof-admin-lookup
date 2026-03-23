#!/usr/bin/env node
/**
 * OSM Administrative Boundaries to WOF SQLite Converter WITH HIERARCHY
 * 
 * This version builds a complete administrative hierarchy from OSM data,
 * making it a full replacement for WOF data.
 * 
 * Features:
 * - Processes ALL admin levels (country, region, county, localadmin, locality, borough, neighbourhood)
 * - Builds parent-child relationships using Point-in-Polygon lookups
 * - Creates complete wof:hierarchy for each feature
 * - Populates ancestors table for fast hierarchy queries
 * 
 * Usage:
 *   node osm-to-wof-hierarchical.js -i boundaries.geojson -o whosonfirst-data-osm-full-pl.db
 * 
 * The output SQLite file should be placed in:
 *   /data/whosonfirst/sqlite/
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const turfArea = require('@turf/area').default;
const { feature, point } = require('@turf/helpers');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { program } = require('commander');
const cliProgress = require('cli-progress');

// Mapowanie admin_level OSM na placetype WOF
const ADMIN_LEVEL_TO_PLACETYPE = {
  '2': 'country',
  '4': 'region',
  '5': 'region',      // UK regions (e.g., South East England)
  '6': 'county',
  '7': 'localadmin',
  '8': 'locality',
  '9': 'borough',
  '10': 'neighbourhood'
};

// Mapowanie place=* OSM na placetype WOF
// Używane gdy feature nie ma admin_level (np. place=city bez boundary=administrative)
const PLACE_TO_PLACETYPE = {
  'city': 'locality',
  'town': 'locality',
  'village': 'locality',
  'hamlet': 'locality',
  'isolated_dwelling': 'locality',
  'suburb': 'neighbourhood',
  'neighbourhood': 'neighbourhood',
  'quarter': 'neighbourhood'
};

// Hierarchia poziomów (od najwyższego do najniższego)
const HIERARCHY_ORDER = ['country', 'region', 'county', 'localadmin', 'locality', 'borough', 'neighbourhood'];

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
  
  // Iteracyjne obliczanie min/max aby uniknąć "Maximum call stack size exceeded"
  // dla dużych geometrii (spread operator nie działa dla >~100k elementów)
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
 * Generuje unikalny ID w formacie WOF
 */
function generateWofId(osmId, adminLevel) {
  const baseId = Math.abs(parseInt(osmId) || 0);
  const level = parseInt(adminLevel) || 8;
  return parseInt(`9${level.toString().padStart(2, '0')}${(baseId % 100000000).toString().padStart(8, '0')}`);
}

/**
 * Znajduje parent dla danego feature używając Point-in-Polygon
 */
function findParent(centroid, placetype, potentialParents) {
  // Określ parent placetype
  const placetypeIndex = HIERARCHY_ORDER.indexOf(placetype);
  if (placetypeIndex <= 0) return null; // country nie ma parent
  
  const parentPlacetype = HIERARCHY_ORDER[placetypeIndex - 1];
  
  // Filtruj tylko odpowiednie placetype
  const candidates = potentialParents.filter(p => p.placetype === parentPlacetype);
  
  if (candidates.length === 0) return null;
  
  // Utwórz punkt z centroidu
  const pt = point([centroid.lon, centroid.lat]);
  
  // Znajdź pierwszy polygon który zawiera punkt
  // Sortuj po area (malejąco) aby preferować bardziej szczegółowe boundaries
  const sortedCandidates = candidates.sort((a, b) => b.area - a.area);
  
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
    locality_id: -1,
    borough_id: -1,
    neighbourhood_id: -1
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
 * Główna funkcja konwersji
 */
function convertGeoJsonToWofSqlite(inputPath, outputPath, options = {}) {
  log('cyan', '\n🗺️  OSM to WOF SQLite Converter (WITH HIERARCHY)');
  log('cyan', '================================================\n');
  
  if (!fs.existsSync(inputPath)) {
    log('red', `❌ Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }
  
  log('blue', `📂 Reading GeoJSON: ${inputPath}`);
  
  // Wczytaj GeoJSON
  let geojson;
  try {
    const content = fs.readFileSync(inputPath, 'utf8');
    geojson = JSON.parse(content);
  } catch (e) {
    log('red', `❌ Error parsing GeoJSON: ${e.message}`);
    process.exit(1);
  }
  
  // Obsługa różnych formatów
  let features = [];
  if (geojson.type === 'FeatureCollection') {
    features = geojson.features || [];
  } else if (geojson.type === 'Feature') {
    features = [geojson];
  } else if (Array.isArray(geojson)) {
    features = geojson;
  }
  
  log('blue', `📊 Found ${features.length} features in GeoJSON\n`);
  
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
    
    // Określ placetype - najpierw z admin_level, potem z place=*
    const adminLevel = props.admin_level || props['admin_level'];
    const placeTag = props.place || props['place'];
    
    let placetype = null;
    let effectiveAdminLevel = adminLevel;
    
    if (adminLevel && ADMIN_LEVEL_TO_PLACETYPE[adminLevel]) {
      // Ma admin_level - użyj mapowania admin_level
      placetype = ADMIN_LEVEL_TO_PLACETYPE[adminLevel];
    } else if (placeTag && PLACE_TO_PLACETYPE[placeTag]) {
      // Nie ma admin_level ale ma place=* - użyj mapowania place
      placetype = PLACE_TO_PLACETYPE[placeTag];
      // Przypisz pseudo admin_level na podstawie placetype (dla generateWofId)
      effectiveAdminLevel = placetype === 'locality' ? '8' : '10';
    }
    
    if (!placetype) {
      stats.skipped++;
      const reason = adminLevel ? `unknown level ${adminLevel}` : (placeTag ? `unknown place ${placeTag}` : 'no admin_level/place');
      progressBar1.update(i + 1, { status: `Skipped (${reason})` });
      continue;
    }
    
    let geometry = feature.geometry;
    let isPointDerived = false;
    
    // Dla punktów (place=*) stwórz minimalny polygon wokół punktu
    if (geometry && geometry.type === 'Point') {
      isPointDerived = true;
      const [lon, lat] = geometry.coordinates;
      // Stwórz mały kwadrat ~100m wokół punktu (0.001° ≈ 100m)
      const offset = 0.001;
      geometry = {
        type: 'Polygon',
        coordinates: [[
          [lon - offset, lat - offset],
          [lon + offset, lat - offset],
          [lon + offset, lat + offset],
          [lon - offset, lat + offset],
          [lon - offset, lat - offset]
        ]]
      };
    }
    
    if (!isValidGeometry(geometry)) {
      stats.skipped++;
      progressBar1.update(i + 1, { status: 'Skipped (invalid geometry)' });
      continue;
    }
    
    const name = props.name || 
                 props['name:en'] ||
                 props['name:pl'] || 
                 props['official_name'] ||
                 props['alt_name'] ||
                 props['loc_name'] ||
                 null;
    
    if (!name) {
      stats.skipped++;
      progressBar1.update(i + 1, { status: 'Skipped (no name)' });
      continue;
    }
    
    // Filter out statistical subregions (NUTS3) at admin_level=8.
    // In GZM (Silesian Metropolis) and other areas, these are tagged as
    // admin_level=8 but represent statistical regions, not actual localities
    // (e.g. "Subregion gliwicki", "Podregion sosnowiecki").
    if (placetype === 'locality' && adminLevel === '8' && /^(sub|pod)region/i.test(name)) {
      stats.skipped++;
      stats.filteredSubregions = (stats.filteredSubregions || 0) + 1;
      progressBar1.update(i + 1, { status: `Skipped subregion: ${name.substring(0, 20)}` });
      continue;
    }
    
    const coords = extractAllCoordinates(geometry);
    const centroid = calculateCentroid(coords);
    const bbox = calculateBBox(coords);
    const area = calculateArea(geometry);
    
    const osmId = props['@id'] || 
                  props.osm_id || 
                  props['osm:id'] ||
                  props.id ||
                  `osm_${i}`;
    
    const wofId = generateWofId(osmId, effectiveAdminLevel || '8');
    
    const population = parseInt(props.population) || null;
    const wikidata = props.wikidata || props['wikidata'] || null;
    const wikipedia = props.wikipedia || props['wikipedia'] || null;
    
    processedFeatures.push({
      wofId,
      osmId,
      name,
      placetype,
      adminLevel: effectiveAdminLevel || '8',
      placeTag,
      isPointDerived,
      centroid,
      bbox,
      area,
      geometry,
      population,
      wikidata,
      wikipedia,
      nameEn: props['name:en'],
      nameDe: props['name:de'],
      namePl: props['name:pl']
    });
    
    stats.processed++;
    stats.byPlacetype[placetype] = (stats.byPlacetype[placetype] || 0) + 1;
    progressBar1.update(i + 1, { status: `${name.substring(0, 30)}...` });
  }
  
  progressBar1.stop();
  
  log('green', `✅ Pass 1 complete: ${stats.processed} features processed`);
  if (stats.filteredSubregions) {
    log('yellow', `   Filtered statistical subregions: ${stats.filteredSubregions}`);
  }
  
  // POST-PASS 1: Upgrade point-derived localities and fill gaps
  log('magenta', '\n🔧 Post-processing: upgrading locality geometries...');
  
  const localadmins = processedFeatures.filter(f => f.placetype === 'localadmin');
  let upgradedCount = 0;
  let createdCount = 0;
  
  // Step A: For place=city/town point-derived localities, replace the tiny ~100m
  // polygon with the containing localadmin's polygon for proper PIP coverage.
  // Only city/town -- NOT village/hamlet! In rural gminy the localadmin polygon
  // covers many villages, so upgrading a village point to the gmina polygon would
  // create an oversized locality that swallows neighbouring villages.
  const UPGRADE_PLACE_TAGS = ['city', 'town'];
  
  for (const loc of processedFeatures) {
    if (loc.placetype !== 'locality' || !loc.isPointDerived) continue;
    if (!loc.placeTag || !UPGRADE_PLACE_TAGS.includes(loc.placeTag)) continue;
    
    const pt = point([loc.centroid.lon, loc.centroid.lat]);
    const matchingLocaladmin = localadmins.find(la => {
      try { return booleanPointInPolygon(pt, la.geometry); }
      catch (e) { return false; }
    });
    
    if (matchingLocaladmin) {
      loc.geometry = matchingLocaladmin.geometry;
      loc.area = matchingLocaladmin.area;
      loc.bbox = matchingLocaladmin.bbox;
      upgradedCount++;
    }
  }
  
  // Step B: Safety net - for localadmins with no locality polygon covering them,
  // create a synthetic locality if a place=city/town point exists inside.
  // Only city/town -- villages have their own admin_level=8 boundaries in OSM.
  for (const la of localadmins) {
    const laPt = point([la.centroid.lon, la.centroid.lat]);
    
    const coveredByLocality = processedFeatures.some(f => {
      if (f.placetype !== 'locality') return false;
      if (f.isPointDerived && f.area < 1) return false;
      try { return booleanPointInPolygon(laPt, f.geometry); }
      catch (e) { return false; }
    });
    
    if (coveredByLocality) continue;
    
    // Check if a place=city/town point is within this localadmin
    const hasCityPoint = processedFeatures.some(f =>
      f.placetype === 'locality' && f.isPointDerived &&
      UPGRADE_PLACE_TAGS.includes(f.placeTag) &&
      (() => {
        try {
          return booleanPointInPolygon(point([f.centroid.lon, f.centroid.lat]), la.geometry);
        } catch (e) { return false; }
      })()
    );
    
    if (hasCityPoint) continue;
    
    // No locality and no city point - check if the localadmin itself has a city/town
    // place tag on its boundary relation (some OSM relations have both boundary=admin + place=city)
    if (la.placeTag && UPGRADE_PLACE_TAGS.includes(la.placeTag)) {
      const syntheticId = generateWofId(la.osmId + 900000000, '8');
      processedFeatures.push({
        wofId: syntheticId,
        osmId: la.osmId,
        name: la.name,
        placetype: 'locality',
        adminLevel: '8',
        placeTag: la.placeTag,
        isPointDerived: false,
        centroid: la.centroid,
        bbox: la.bbox,
        area: la.area,
        geometry: la.geometry,
        population: la.population,
        wikidata: la.wikidata,
        wikipedia: la.wikipedia,
        nameEn: la.nameEn,
        nameDe: la.nameDe,
        namePl: la.namePl
      });
      createdCount++;
      stats.processed++;
      stats.byPlacetype['locality'] = (stats.byPlacetype['locality'] || 0) + 1;
    }
  }
  
  log('green', `   Upgraded point localities:    ${upgradedCount}`);
  log('green', `   Created synthetic localities: ${createdCount}`);
  log('green', '');
  
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
  
  // Schemat
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
          'wof:country': options.countryCode || 'PL',
          
          'geom:latitude': fd.centroid.lat,
          'geom:longitude': fd.centroid.lon,
          'geom:bbox': fd.bbox,
          'geom:area': fd.area,
          
          'mz:is_current': 1,
          'mz:hierarchy_label': 1,
          
          'edtf:cessation': 'uuuu',
          'edtf:inception': 'uuuu',
          
          'src:geom': 'openstreetmap',
          'src:geom_alt': [],
          
          'osm:id': fd.osmId,
          'osm:admin_level': fd.adminLevel,
          
          ...(fd.population && { 'wof:population': fd.population }),
          ...(fd.wikidata && { 'wof:concordances': { 'wd:id': fd.wikidata } }),
          ...(fd.wikipedia && { 'wof:wikipedia': fd.wikipedia }),
          ...(fd.nameEn && { 'name:eng_x_preferred': [fd.nameEn] }),
          ...(fd.nameDe && { 'name:deu_x_preferred': [fd.nameDe] }),
          ...(fd.namePl && { 'name:pol_x_preferred': [fd.namePl] }),
          ...(fd.placetype === 'country' && { 'iso:country': options.countryCode || 'PL' })
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
      const countryValue = fd.placetype === 'country' ? '' : (options.countryCode || 'PL');
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
  if (stats.filteredSubregions) {
    log('yellow', `   Filtered subregions: ${stats.filteredSubregions}`);
  }
  
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
  
  log('green', '\n🎯 Next steps:');
  log('blue', '   1. Copy the SQLite file to your WOF data directory:');
  log('yellow', `      cp ${outputPath} /data/whosonfirst/sqlite/`);
  log('blue', '   2. Remove or backup original WOF files (optional):');
  log('yellow', '      mv /data/whosonfirst/sqlite/whosonfirst-data-*.db /data/whosonfirst/sqlite/backup/');
  log('blue', '   3. Reimport OSM data:');
  log('yellow', '      pelias compose run openstreetmap ./bin/start');
  log('blue', '   4. The new hierarchical data will be loaded automatically\n');
  
  return stats;
}

// CLI
program
  .name('osm-to-wof-hierarchical')
  .description('Convert OSM boundaries to WOF SQLite WITH complete hierarchy')
  .version('1.0.0')
  .requiredOption('-i, --input <path>', 'Input GeoJSON file with OSM boundaries (ALL admin levels)')
  .option('-o, --output <path>', 'Output SQLite file', 'whosonfirst-data-osm-full.db')
  .option('--country <code>', 'ISO 3166-1 alpha-2 country code (e.g., PL)', 'PL')
  .parse(process.argv);

const opts = program.opts();

// Jeśli podano --country, dodaj do nazwy pliku
let outputPath = opts.output;
if (opts.country && !outputPath.includes(opts.country.toLowerCase())) {
  const ext = path.extname(outputPath);
  const base = path.basename(outputPath, ext);
  outputPath = `${base}-${opts.country.toLowerCase()}${ext}`;
}

// Uruchom konwersję
convertGeoJsonToWofSqlite(opts.input, outputPath, {
  countryCode: opts.country
});

