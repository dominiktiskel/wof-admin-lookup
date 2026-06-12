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
const pointOnFeature = require('@turf/point-on-feature').default;
const { program } = require('commander');
const cliProgress = require('cli-progress');

// Country-specific profiles: admin_level → WOF placetype mappings
// Each profile also supports optional post-processing hooks
const COUNTRY_PROFILES = {
  // Poland: standard CEE mapping
  // 6=powiat (county), 7=gmina (localadmin), 8=miasto/wieś (locality)
  'PL': {
    adminLevelMap: {
      '2': 'country',
      '4': 'region',
      '6': 'county',
      '7': 'localadmin',
      '8': 'locality',
      '9': 'borough',
      '10': 'neighbourhood'
    }
  },

  // United Kingdom: UK admin structure
  // 4=constituent country (England/Scotland/Wales/NI), 5=English region / GLA
  // 6=county / metropolitan county (Merseyside), 8=Local Authority District (localadmin)
  // 9=ward (borough), 10=parish (neighbourhood)
  // NOTE: level 8 is deliberately localadmin (not locality) for UK
  //       localities are added via place=city/town/village nodes + synthetic London
  'GB': {
    adminLevelMap: {
      '2': 'country',
      '4': 'region',
      '5': 'region',
      '6': 'county',
      '8': 'localadmin',
      '9': 'borough',
      '10': 'neighbourhood'
    },
    syntheticLondon: true   // enables synthetic "London" locality creation post-Pass-1
  },

  // Germany
  'DE': {
    adminLevelMap: {
      '2': 'country',
      '4': 'region',
      '6': 'county',
      '7': 'localadmin',
      '8': 'locality',
      '9': 'borough',
      '10': 'neighbourhood'
    }
  }
};

// Default/fallback mapping (same as legacy behaviour, works for most countries)
const DEFAULT_ADMIN_LEVEL_MAP = {
  '2': 'country',
  '4': 'region',
  '5': 'region',
  '6': 'county',
  '7': 'localadmin',
  '8': 'locality',
  '9': 'borough',
  '10': 'neighbourhood'
};

// Deprecated global constant kept for reference only — use getAdminLevelMap(countryCode) instead
const ADMIN_LEVEL_TO_PLACETYPE = DEFAULT_ADMIN_LEVEL_MAP;

/**
 * Returns the admin_level → placetype map for the given country code.
 */
function getAdminLevelMap(countryCode) {
  const profile = COUNTRY_PROFILES[countryCode];
  return (profile && profile.adminLevelMap) ? profile.adminLevelMap : DEFAULT_ADMIN_LEVEL_MAP;
}

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
 * Wyznacza punkt reprezentatywny GWARANTOWANIE leżący wewnątrz poligonu.
 *
 * Naiwny centroid (średnia wierzchołków) może wypaść POZA poligonem dla
 * nieregularnych kształtów (np. dzielnica Prądnik Biały w Krakowie — jej
 * średnia wierzchołków leży we wsi Zielonki). Taki punkt użyty do
 * point-in-polygon przy budowaniu hierarchii daje błędnych rodziców.
 *
 * Strategia:
 * 1. Jeśli centroid leży wewnątrz poligonu — użyj go (zachowuje dotychczasowe
 *    zachowanie w typowych przypadkach).
 * 2. W przeciwnym razie użyj @turf/point-on-feature (point-on-surface).
 */
function calculateInnerPoint(geometry, centroid) {
  try {
    if (booleanPointInPolygon(point([centroid.lon, centroid.lat]), geometry)) {
      return centroid;
    }
  } catch (e) {
    // invalid geometry — fall through to point-on-feature
  }

  try {
    const pof = pointOnFeature(feature(geometry));
    return {
      lat: pof.geometry.coordinates[1],
      lon: pof.geometry.coordinates[0]
    };
  } catch (e) {
    return centroid;
  }
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
 * UWAGA: innerPoint musi leżeć WEWNĄTRZ geometrii dziecka (zob. calculateInnerPoint)
 *
 * Jeśli na bezpośrednio wyższym poziomie nie ma kandydata zawierającego punkt,
 * próbuje kolejnych wyższych poziomów (np. locality → localadmin → county → ...).
 * To kluczowe dla miast na prawach powiatu (Kraków, Bytom, ...), które w OSM
 * nie mają relacji admin_level=7 (gmina = miasto = powiat) — bez tego fallbacku
 * hierarchia urywała się na locality i county/region/country zostawały -1.
 */
function findParent(innerPoint, placetype, potentialParents) {
  const placetypeIndex = HIERARCHY_ORDER.indexOf(placetype);
  if (placetypeIndex <= 0) return null; // country nie ma parent
  
  // Utwórz punkt z punktu wewnętrznego
  const pt = point([innerPoint.lon, innerPoint.lat]);
  
  // Iteruj po kolejnych wyższych poziomach aż znajdziemy zawierający poligon
  for (let parentIndex = placetypeIndex - 1; parentIndex >= 0; parentIndex--) {
    const parentPlacetype = HIERARCHY_ORDER[parentIndex];
    
    // Filtruj tylko odpowiednie placetype; skip synthetic features that don't have real geometry
    const candidates = potentialParents.filter(p =>
      p.placetype === parentPlacetype && !p.isSynthetic
    );
    
    if (candidates.length === 0) continue;
    
    // Sort smallest-area-first to prefer the most specific containing polygon.
    // This matches ONS tool behaviour and prevents large national boundaries from
    // "stealing" parent assignments that should go to smaller local boundaries.
    const sortedCandidates = candidates.slice().sort((a, b) => a.area - b.area);
    
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

  // UK: if this localadmin is tagged as a London borough, inject synthetic London
  if (featureData.syntheticLondonId) {
    hierarchy.locality_id = featureData.syntheticLondonId;
  }
  
  // Iteruj w górę hierarchii
  let currentFeature = featureData;
  let currentPlacetype = featureData.placetype;
  
  while (currentFeature && currentPlacetype) {
    // Znajdź parent (używamy punktu wewnętrznego, nie naiwnego centroidu)
    const parent = findParent(currentFeature.innerPoint || currentFeature.centroid, currentPlacetype, allFeatures);
    
    if (!parent) break;

    // Don't overwrite already-set hierarchy IDs (e.g., locality_id already set to London)
    const parentKey = `${parent.placetype}_id`;
    if (hierarchy[parentKey] === undefined || hierarchy[parentKey] === -1) {
      hierarchy[parentKey] = parent.wofId;
    }
    
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

  // Resolve country-specific admin level map
  const countryCode = options.countryCode || null;
  const adminLevelMap = getAdminLevelMap(countryCode);
  const profile = COUNTRY_PROFILES[countryCode] || {};

  if (countryCode) {
    log('blue', `🌍 Country profile: ${countryCode} (${COUNTRY_PROFILES[countryCode] ? 'custom' : 'default'})`);
  }
  
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
    
    // Extract name first (needed for special-case overrides like City of London)
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

    // Określ placetype - najpierw z admin_level, potem z place=*
    const adminLevel = props.admin_level || props['admin_level'];
    const placeTag = props.place || props['place'];
    
    let placetype = null;
    let effectiveAdminLevel = adminLevel;
    
    if (adminLevel && adminLevelMap[adminLevel]) {
      // Ma admin_level - użyj mapowania admin_level (country-specific)
      placetype = adminLevelMap[adminLevel];

      // UK special case: City of London is admin_level=6 (county) but is a borough-equivalent LAD
      if (countryCode === 'GB' && adminLevel === '6' && name === 'City of London') {
        placetype = 'localadmin';
        log('blue', `   🏛️  City of London: overriding admin_level=6 → localadmin`);
      }
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
    const innerPoint = calculateInnerPoint(geometry, centroid);
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
      innerPoint,
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
  
  // POST-PASS 1: Deduplicate and upgrade point-derived localities
  log('magenta', '\n🔧 Post-processing: deduplicating and upgrading locality geometries...');
  
  const localadmins = processedFeatures.filter(f => f.placetype === 'localadmin');
  let upgradedCount = 0;
  let createdCount = 0;
  
  // Step A0: Deduplikacja punktów place=* przykrytych prawdziwym poligonem
  // granicy o tej samej nazwie i placetype (np. node place=city "Kraków"
  // wewnątrz relacji admin_level=8 "Kraków"). Bez tego każde takie
  // miasto/wieś/osiedle ma w bazie dwa rekordy o różnych WOF ID i PIP
  // wybiera między nimi arbitralnie (niestabilne ID między buildami).
  const DEDUP_PLACETYPES = ['locality', 'neighbourhood'];
  const normalizeName = (s) => (s || '').trim().toLowerCase();
  
  const realByPlacetypeAndName = new Map();
  for (const f of processedFeatures) {
    if (!DEDUP_PLACETYPES.includes(f.placetype) || f.isPointDerived) continue;
    const key = `${f.placetype}|${normalizeName(f.name)}`;
    if (!realByPlacetypeAndName.has(key)) realByPlacetypeAndName.set(key, []);
    realByPlacetypeAndName.get(key).push(f);
  }
  
  const duplicatePoints = new Set();
  for (const loc of processedFeatures) {
    if (!DEDUP_PLACETYPES.includes(loc.placetype) || !loc.isPointDerived) continue;
    
    const candidates = realByPlacetypeAndName.get(`${loc.placetype}|${normalizeName(loc.name)}`);
    if (!candidates) continue;
    
    const pt = point([loc.innerPoint.lon, loc.innerPoint.lat]);
    const twin = candidates.find(rl => {
      try { return booleanPointInPolygon(pt, rl.geometry); }
      catch (e) { return false; }
    });
    if (!twin) continue;
    
    // Przenieś metadane z punktu, jeśli poligon granicy ich nie ma
    if (!twin.population && loc.population) twin.population = loc.population;
    if (!twin.wikidata && loc.wikidata) twin.wikidata = loc.wikidata;
    if (!twin.wikipedia && loc.wikipedia) twin.wikipedia = loc.wikipedia;
    
    duplicatePoints.add(loc);
    stats.byPlacetype[loc.placetype]--;
    stats.processed--;
  }
  
  if (duplicatePoints.size > 0) {
    const kept = processedFeatures.filter(f => !duplicatePoints.has(f));
    processedFeatures.length = 0;
    for (const f of kept) processedFeatures.push(f);
  }
  
  // Step A: For place=city/town point-derived localities, replace the tiny ~100m
  // polygon with the containing localadmin's polygon for proper PIP coverage.
  // Only city/town -- NOT village/hamlet! In rural gminy the localadmin polygon
  // covers many villages, so upgrading a village point to the gmina polygon would
  // create an oversized locality that swallows neighbouring villages.
  const UPGRADE_PLACE_TAGS = ['city', 'town'];
  
  // Po deduplikacji: prawdziwe (graniczne) poligony locality, do sprawdzania
  // czy upgrade do poligonu gminy nie połknąłby istniejących miejscowości
  const realLocalities = processedFeatures.filter(f => f.placetype === 'locality' && !f.isPointDerived);
  const containsRealLocalityCache = new Map();
  
  function localadminContainsRealLocality(la) {
    if (containsRealLocalityCache.has(la)) return containsRealLocalityCache.get(la);
    
    // Szybki pre-check po bbox (format: "minLon,minLat,maxLon,maxLat")
    const [minLon, minLat, maxLon, maxLat] = String(la.bbox).split(',').map(Number);
    const result = realLocalities.some(rl => {
      if (rl.innerPoint.lon < minLon || rl.innerPoint.lon > maxLon ||
          rl.innerPoint.lat < minLat || rl.innerPoint.lat > maxLat) return false;
      try { return booleanPointInPolygon(point([rl.innerPoint.lon, rl.innerPoint.lat]), la.geometry); }
      catch (e) { return false; }
    });
    
    containsRealLocalityCache.set(la, result);
    return result;
  }
  
  for (const loc of processedFeatures) {
    if (loc.placetype !== 'locality' || !loc.isPointDerived) continue;
    if (!loc.placeTag || !UPGRADE_PLACE_TAGS.includes(loc.placeTag)) continue;
    
    const pt = point([loc.innerPoint.lon, loc.innerPoint.lat]);
    const matchingLocaladmin = localadmins.find(la => {
      try { return booleanPointInPolygon(pt, la.geometry); }
      catch (e) { return false; }
    });
    
    if (matchingLocaladmin) {
      // Nie podnoś punktu do poligonu gminy, jeśli gmina zawiera już prawdziwe
      // poligony locality - przewymiarowany poligon połknąłby je w PIP
      // (np. punkt place=town Wieliczki vs wsie w gminie miejsko-wiejskiej)
      if (localadminContainsRealLocality(matchingLocaladmin)) continue;
      
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
    const laPt = point([la.innerPoint.lon, la.innerPoint.lat]);
    
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
          return booleanPointInPolygon(point([f.innerPoint.lon, f.innerPoint.lat]), la.geometry);
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
        innerPoint: la.innerPoint,
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
  
  log('green', `   Removed duplicate place points: ${duplicatePoints.size}`);
  log('green', `   Upgraded point localities:      ${upgradedCount}`);
  log('green', `   Created synthetic localities:   ${createdCount}`);
  log('green', '');

  // POST-PASS 1 (GB only): Create synthetic "London" locality
  // In OSM, there is no single city-level polygon for London.
  // London boroughs (admin_level=8) map to localadmin in the GB profile.
  // We need a "London" locality that covers Greater London so that
  // addresses inside GLA show "London" in the locality field.
  //
  // Technique (same as ons-to-wof-sqlite.js):
  // - synthetic feature WOF ID = 999999999
  // - SPR placetype = 'macrocounty' (ghost loader — loaded after localadmin)
  // - GeoJSON wof:placetype = 'locality' (for hierarchy resolution)
  // - All localadmin features inside GLA get locality_id = 999999999
  if (countryCode === 'GB' && profile.syntheticLondon) {
    log('blue', '🏙️  Creating synthetic London locality (GB)...');

    // Find GLA boundary: admin_level=5, name contains "London" or "Greater London"
    const glaFeature = processedFeatures.find(f =>
      f.adminLevel === '5' &&
      f.placetype === 'region' &&
      /london/i.test(f.name)
    );

    if (glaFeature) {
      log('green', `   Found GLA boundary: "${glaFeature.name}" (wofId=${glaFeature.wofId})`);

      // Find all localadmin features inside GLA
      const londonLocaladmins = processedFeatures.filter(f => {
        if (f.placetype !== 'localadmin') return false;
        const pt = point([f.innerPoint.lon, f.innerPoint.lat]);
        try { return booleanPointInPolygon(pt, glaFeature.geometry); }
        catch (e) { return false; }
      });

      log('green', `   London boroughs (localadmin inside GLA): ${londonLocaladmins.length}`);

      // Create the synthetic London locality using GLA geometry
      const syntheticLondon = {
        wofId: 999999999,
        osmId: 'synthetic_london',
        name: 'London',
        placetype: 'locality',    // Used in GeoJSON body for hierarchy resolution
        adminLevel: '8',
        placeTag: 'city',
        isPointDerived: false,
        isSynthetic: true,
        centroid: glaFeature.centroid,
        innerPoint: glaFeature.innerPoint,
        bbox: glaFeature.bbox,
        area: glaFeature.area,
        geometry: glaFeature.geometry,
        population: null,
        wikidata: null,
        wikipedia: null,
        nameEn: 'London',
        nameDe: 'London',
        namePl: 'Londyn'
      };

      processedFeatures.push(syntheticLondon);
      stats.processed++;
      stats.byPlacetype['locality'] = (stats.byPlacetype['locality'] || 0) + 1;

      // Tag all London boroughs with locality_id pointing to synthetic London
      // This happens in buildHierarchy via the isSyntheticLondonBased flag
      for (const la of londonLocaladmins) {
        la.syntheticLondonId = 999999999;
      }

      log('green', `   ✅ Synthetic London created (WOF ID 999999999)`);
      log('blue', `   📍 Centroid: ${syntheticLondon.centroid.lat.toFixed(4)}, ${syntheticLondon.centroid.lon.toFixed(4)}`);
    } else {
      log('yellow', '   ⚠️  GLA boundary (admin_level=5, name~London) not found — synthetic London skipped');
      log('yellow', '       Make sure the England or UK extract includes admin_level=5 boundaries');
    }
  }

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
      
      // Określ parent_id: najbliższy wyższy poziom obecny w hierarchii
      // (z pominięciem brakujących poziomów, np. localadmin dla miast na prawach powiatu)
      const placetypeIndex = HIERARCHY_ORDER.indexOf(fd.placetype);
      let parentId = -1;
      
      for (let pi = placetypeIndex - 1; pi >= 0; pi--) {
        const candidateId = fd.hierarchy[`${HIERARCHY_ORDER[pi]}_id`];
        if (candidateId && candidateId !== -1) {
          parentId = candidateId;
          break;
        }
      }
      
      // Utwórz WOF GeoJSON record
      // For synthetic features (e.g. London): GeoJSON keeps the real placetype (locality)
      // while SPR uses 'macrocounty' as ghost loader technique
      const wofRecord = {
        type: 'Feature',
        id: fd.wofId,
        properties: {
          'wof:id': fd.wofId,
          'wof:name': fd.name,
          'wof:placetype': fd.placetype,   // 'locality' for synthetic London (real placetype)
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
      // Ghost loader technique for synthetic features (London):
      //   SPR placetype = 'macrocounty' so it's loaded AFTER localadmin in PIP workers,
      //   preventing it from interfering with borough PIP lookups.
      //   The GeoJSON body still has wof:placetype='locality' for hierarchy resolution.
      const sprPlacetype = fd.isSynthetic ? 'macrocounty' : fd.placetype;
      const countryValue = fd.placetype === 'country' ? '' : (options.countryCode || 'PL');
      insertSpr.run(
        fd.wofId,
        parentId,
        fd.name,
        sprPlacetype,
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

