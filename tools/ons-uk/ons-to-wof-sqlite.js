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
const { feature, point, featureCollection } = require('@turf/helpers');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const pointOnFeature = require('@turf/point-on-feature').default;
const turfVoronoi = require('@turf/voronoi').default;
const turfIntersect = require('@turf/intersect').default;
const turfDifference = require('@turf/difference').default;
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
const HIERARCHY_ORDER = ['country', 'region', 'county', 'localadmin', 'locality', 'neighbourhood'];

// WOF ID syntetycznego Londynu (ghost loader)
const SYNTHETIC_LONDON_ID = 999999999;

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
 * Wyznacza punkt leżący WEWNĄTRZ geometrii.
 *
 * Naiwny centroid (średnia wierzchołków) może wypaść poza poligonem dla
 * nieregularnych kształtów — taki punkt użyty do point-in-polygon przy
 * budowaniu hierarchii daje błędnych rodziców.
 *
 * Strategia:
 * 1. Jeśli centroid leży wewnątrz poligonu — użyj go.
 * 2. W przeciwnym razie użyj @turf/point-on-feature (point-on-surface).
 */
function calculateInnerPoint(geometry, centroid) {
  if (!geometry) return centroid;

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
 * Oblicza zagregowany centroid z wielu features
 * Używane dla syntetycznego Londynu
 */
function calculateAggregatedCentroid(features) {
  if (!features || features.length === 0) {
    return { lat: 0, lon: 0 };
  }
  
  const sumLat = features.reduce((sum, f) => sum + f.centroid.lat, 0);
  const sumLon = features.reduce((sum, f) => sum + f.centroid.lon, 0);
  
  return {
    lat: sumLat / features.length,
    lon: sumLon / features.length
  };
}

/**
 * Oblicza zagregowany bounding box z wielu features
 * Używane dla syntetycznego Londynu
 */
function calculateAggregatedBBox(features) {
  if (!features || features.length === 0) {
    return '0,0,0,0';
  }
  
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  
  for (const f of features) {
    const bbox = f.bbox.split(',').map(parseFloat);
    const [bMinLon, bMinLat, bMaxLon, bMaxLat] = bbox;
    
    if (bMinLat < minLat) minLat = bMinLat;
    if (bMaxLat > maxLat) maxLat = bMaxLat;
    if (bMinLon < minLon) minLon = bMinLon;
    if (bMaxLon > maxLon) maxLon = bMaxLon;
  }
  
  return [minLon, minLat, maxLon, maxLat].join(',');
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
         props.UTLA22CD ||  // Upper Tier LAs 2022 (metropolitan counties E11)
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
         props.UTLA22NM ||
         props.LAD24NM ||
         props.BUA22NM ||
         props.name ||
         props.NAME ||
         null;
}

/**
 * Wczytuje geometrię Greater London z pliku Nominatim JSON
 * Nominatim API zwraca format: { ..., "geometry": { "type": "...", "coordinates": [...] } }
 */
function loadGreaterLondonGeometry(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    log('yellow', `⚠️  Greater London geometry file not found: ${filePath}`);
    return null;
  }
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    
    // Nominatim details endpoint returns geometry in 'geometry' field
    if (data.geometry && data.geometry.type && data.geometry.coordinates) {
      log('green', `   ✅ Loaded Greater London geometry from ${path.basename(filePath)}`);
      log('blue', `      Type: ${data.geometry.type}`);
      return data.geometry;
    }
    
    log('red', `   ❌ Invalid geometry format in ${filePath}`);
    return null;
  } catch (e) {
    log('red', `   ❌ Error loading Greater London geometry: ${e.message}`);
    return null;
  }
}

/**
 * Ekstrahuje tag place=* z properties GeoJSON wygenerowanego przez ogr2ogr.
 * Warstwa points ma kolumnę `place`, warstwa multipolygons trzyma tag
 * w hstore `other_tags` ("place"=>"suburb").
 */
function extractOsmPlaceTag(props) {
  if (props.place) return props.place;
  
  if (typeof props.other_tags === 'string') {
    const match = props.other_tags.match(/"place"=>"([^"]+)"/);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * Generuje numeryczny WOF ID dla feature z OSM.
 * Prefix 7 - brak kolizji z ONS (prefix 8) i narzędziem OSM (prefix 9).
 * Przy kolizji hasha wewnątrz zbioru inkrementuje aż do wolnego ID.
 */
function osmIdToWofId(osmId, usedIds) {
  const str = String(osmId);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  
  let id = parseInt(`7${(Math.abs(hash) % 100000000).toString().padStart(8, '0')}`);
  while (usedIds.has(id)) id++;
  usedIds.add(id);
  return id;
}

/**
 * Wczytuje dzielnice (place=suburb/neighbourhood/quarter) z GeoJSON
 * wygenerowanego przez extract-osm-neighbourhoods.sh.
 */
function loadOsmNeighbourhoods(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    log('yellow', `⚠️  OSM neighbourhoods file not found: ${filePath}`);
    return [];
  }
  
  const ACCEPTED_PLACE_TAGS = ['suburb', 'neighbourhood', 'quarter'];
  
  const features = loadFeaturesFromFile(filePath);
  const raw = [];
  
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const props = f.properties || {};
    
    const name = props.name;
    if (!name) continue;
    
    const placeTag = extractOsmPlaceTag(props);
    if (!placeTag || !ACCEPTED_PLACE_TAGS.includes(placeTag)) continue;
    
    const geometry = f.geometry;
    if (!geometry || !geometry.coordinates) continue;
    if (!['Point', 'Polygon', 'MultiPolygon'].includes(geometry.type)) continue;
    
    const osmId = props['@id'] || props.osm_id || props.osm_way_id || `osm_nbr_${i}`;
    
    raw.push({ osmId, name, placeTag, geometry });
  }
  
  return raw;
}

/**
 * Przetwarza dzielnice z OSM na features WOF (placetype=neighbourhood).
 *
 * - Features z poligonem: użyte wprost (src:geom = 'osm').
 * - Features punktowe: przybliżony polygon Voronoi przycięty do zawierającego
 *   localadmin (src:geom = 'osm-voronoi') - bez tego dzielnice-nody nie byłyby
 *   trafiane przez point-in-polygon.
 *
 * Modyfikuje processedFeatures i stats in-place.
 */
function processOsmNeighbourhoods(rawNeighbourhoods, processedFeatures, stats) {
  const normalizeName = (n) => String(n).toLowerCase().trim();
  
  const usedIds = new Set(processedFeatures.map(f => f.wofId));
  usedIds.add(SYNTHETIC_LONDON_ID);
  
  // Indeks localadmin z bbox do szybkiego przypisywania punktów
  const localadmins = processedFeatures
    .filter(f => f.placetype === 'localadmin' && f.geometry)
    .map(la => {
      const [minLon, minLat, maxLon, maxLat] = String(la.bbox).split(',').map(Number);
      return { la, minLon, minLat, maxLon, maxLat };
    });
  
  const polygonRaw = rawNeighbourhoods.filter(r => r.geometry.type !== 'Point');
  const pointRaw = rawNeighbourhoods.filter(r => r.geometry.type === 'Point');
  
  log('blue', `   Polygons: ${polygonRaw.length}, points: ${pointRaw.length}`);
  
  let added = 0;
  
  // 1. Dzielnice z prawdziwym poligonem
  const polygonRecords = [];
  for (const raw of polygonRaw) {
    const coords = extractAllCoordinates(raw.geometry);
    if (coords.length < 3) continue;
    
    const centroid = calculateCentroid(coords);
    const innerPoint = calculateInnerPoint(raw.geometry, centroid);
    
    const record = {
      wofId: osmIdToWofId(raw.osmId, usedIds),
      onsCode: `OSM_${raw.osmId}`,
      name: raw.name,
      placetype: 'neighbourhood',
      centroid,
      innerPoint,
      bbox: calculateBBox(coords),
      area: calculateArea(raw.geometry),
      geometry: raw.geometry,
      nameEn: null,
      srcGeom: 'osm'
    };
    
    polygonRecords.push(record);
    processedFeatures.push(record);
    added++;
  }
  
  // Indeks poligonów po nazwie do deduplikacji node+polygon tej samej dzielnicy
  const polygonsByName = new Map();
  for (const rec of polygonRecords) {
    const key = normalizeName(rec.name);
    if (!polygonsByName.has(key)) polygonsByName.set(key, []);
    polygonsByName.get(key).push(rec);
  }
  
  // 2. Dzielnice punktowe: dedup + grupowanie po localadmin
  const groups = new Map();  // localadmin feature -> [{raw, lon, lat}]
  let dedupedPoints = 0;
  let orphanPoints = 0;
  
  for (const raw of pointRaw) {
    const [lon, lat] = raw.geometry.coordinates;
    const pt = point([lon, lat]);
    
    // Skip node jeśli istnieje polygon o tej samej nazwie zawierający punkt
    const twins = polygonsByName.get(normalizeName(raw.name));
    if (twins && twins.some(rec => {
      try { return booleanPointInPolygon(pt, rec.geometry); }
      catch (e) { return false; }
    })) {
      dedupedPoints++;
      continue;
    }
    
    // Znajdź zawierający localadmin (bbox prefilter + PiP)
    let containing = null;
    for (const cand of localadmins) {
      if (lon < cand.minLon || lon > cand.maxLon || lat < cand.minLat || lat > cand.maxLat) continue;
      try {
        if (booleanPointInPolygon(pt, cand.la.geometry)) {
          containing = cand.la;
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!containing) {
      orphanPoints++;
      continue;
    }
    
    if (!groups.has(containing)) groups.set(containing, []);
    groups.get(containing).push({ raw, lon, lat });
  }
  
  log('blue', `   Deduplicated points (polygon twin exists): ${dedupedPoints}`);
  log('blue', `   Points outside any localadmin (skipped):   ${orphanPoints}`);
  
  // 3. Voronoi per localadmin
  const smallSquare = (lon, lat) => {
    const d = 0.0015; // ~150m
    return {
      type: 'Polygon',
      coordinates: [[
        [lon - d, lat - d], [lon + d, lat - d],
        [lon + d, lat + d], [lon - d, lat + d],
        [lon - d, lat - d]
      ]]
    };
  };
  
  let voronoiCount = 0;
  let fallbackCount = 0;
  
  // Indeks bbox dzielnic-poligonów: ich teren wycinamy z komórek Voronoi,
  // żeby enklawy z prawdziwą granicą (np. Chorltonville wewnątrz
  // Chorlton-cum-Hardy) zostały przy swoim poligonie
  const polygonIndex = polygonRecords.map(rec => {
    const [minLon, minLat, maxLon, maxLat] = String(rec.bbox).split(',').map(Number);
    return { rec, minLon, minLat, maxLon, maxLat };
  });
  
  for (const [la, pts] of groups) {
    const [laMinLon, laMinLat, laMaxLon, laMaxLat] = String(la.bbox).split(',').map(Number);
    const pad = 0.01;
    const voronoiBBox = [laMinLon - pad, laMinLat - pad, laMaxLon + pad, laMaxLat + pad];
    
    let cells = null;
    try {
      const fc = featureCollection(pts.map(p => point([p.lon, p.lat])));
      cells = turfVoronoi(fc, { bbox: voronoiBBox });
    } catch (e) {
      cells = null;
    }
    
    const laFeature = feature(la.geometry);
    
    // Dzielnice-poligony mogące przecinać ten localadmin (bbox prefilter)
    const laPolygons = polygonIndex.filter(p =>
      p.minLon <= laMaxLon && p.maxLon >= laMinLon &&
      p.minLat <= laMaxLat && p.maxLat >= laMinLat
    );
    
    for (let i = 0; i < pts.length; i++) {
      const { raw, lon, lat } = pts[i];
      
      // Przytnij komórkę Voronoi do granicy localadmin
      let clipped = null;
      const cell = cells && cells.features ? cells.features[i] : null;
      
      if (cell && cell.geometry) {
        try {
          clipped = turfIntersect(cell, laFeature);
        } catch (e) {
          clipped = null;
        }
      }
      
      // Wytnij z komórki teren dzielnic z prawdziwym poligonem
      if (clipped && clipped.geometry) {
        const [cMinLon, cMinLat, cMaxLon, cMaxLat] = calculateBBox(extractAllCoordinates(clipped.geometry)).split(',').map(Number);
        
        for (const p of laPolygons) {
          if (!clipped) break;
          if (p.minLon > cMaxLon || p.maxLon < cMinLon || p.minLat > cMaxLat || p.maxLat < cMinLat) continue;
          
          try {
            clipped = turfDifference(clipped, feature(p.rec.geometry));
          } catch (e) {
            // difference failed - keep current cell (possible overlap is acceptable)
          }
        }
      }
      
      let geometry = null;
      if (clipped && clipped.geometry) {
        geometry = clipped.geometry;
        voronoiCount++;
      } else {
        geometry = smallSquare(lon, lat);
        fallbackCount++;
      }
      
      const coords = extractAllCoordinates(geometry);
      // Pozycja oryginalnego node'a - stabilny punkt do budowania hierarchii
      // (rodzice liczeni od pozycji dzielnicy, nie od kształtu komórki)
      const centroid = { lat, lon };
      
      processedFeatures.push({
        wofId: osmIdToWofId(raw.osmId, usedIds),
        onsCode: `OSM_${raw.osmId}`,
        name: raw.name,
        placetype: 'neighbourhood',
        centroid,
        innerPoint: centroid,
        bbox: calculateBBox(coords),
        area: calculateArea(geometry),
        geometry,
        nameEn: null,
        srcGeom: 'osm-voronoi'
      });
      added++;
    }
  }
  
  log('blue', `   Voronoi polygons: ${voronoiCount}, fallback squares: ${fallbackCount}`);
  
  stats.processed += added;
  stats.byPlacetype['neighbourhood'] = (stats.byPlacetype['neighbourhood'] || 0) + added;
  
  log('green', `   ✅ Added ${added} neighbourhoods\n`);
}

/**
 * Buduje indeks potencjalnych rodziców per placetype.
 * Kandydaci posortowani po area (rosnąco — preferujemy najmniejszy zawierający
 * polygon) z rozparsowanym bbox do szybkiego pre-filtra.
 */
function buildParentIndex(allFeatures) {
  const index = {};
  for (const pt of HIERARCHY_ORDER) index[pt] = [];

  for (const f of allFeatures) {
    if (!f.geometry || f.isSynthetic) continue;
    if (!index[f.placetype]) continue;

    const [minLon, minLat, maxLon, maxLat] = String(f.bbox).split(',').map(Number);
    index[f.placetype].push({ feature: f, minLon, minLat, maxLon, maxLat });
  }

  for (const pt of HIERARCHY_ORDER) {
    index[pt].sort((a, b) => a.feature.area - b.feature.area);
  }

  return index;
}

/**
 * Znajduje parent dla danego feature używając Point-in-Polygon.
 *
 * Jeśli na bezpośrednio wyższym poziomie nie ma kandydata zawierającego punkt
 * (np. brak metropolitan county), iteruje dalej w górę hierarchii — bez tego
 * łańcuch urywał się i region/country zostawały -1.
 */
function findParent(innerPoint, placetype, parentIndex) {
  const placetypeIndex = HIERARCHY_ORDER.indexOf(placetype);
  if (placetypeIndex <= 0) return null; // country nie ma parent

  const pt = point([innerPoint.lon, innerPoint.lat]);

  for (let level = placetypeIndex - 1; level >= 0; level--) {
    const candidates = parentIndex[HIERARCHY_ORDER[level]];

    for (const cand of candidates) {
      // Pre-filtr bbox przed kosztownym point-in-polygon
      if (innerPoint.lon < cand.minLon || innerPoint.lon > cand.maxLon ||
          innerPoint.lat < cand.minLat || innerPoint.lat > cand.maxLat) {
        continue;
      }

      try {
        if (booleanPointInPolygon(pt, cand.feature.geometry)) {
          return cand.feature;
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
function buildHierarchy(featureData, parentIndex, londonBoroughIds, hasSyntheticLondon) {
  const hierarchy = {
    country_id: -1,
    region_id: -1,
    county_id: -1,
    localadmin_id: -1,
    locality_id: -1,
    neighbourhood_id: -1
  };
  
  // Ustaw własny ID
  hierarchy[`${featureData.placetype}_id`] = featureData.wofId;
  
  // Iteruj w górę hierarchii (findParent sam przeskakuje brakujące poziomy)
  let currentFeature = featureData;
  
  while (currentFeature) {
    const parent = findParent(
      currentFeature.innerPoint || currentFeature.centroid,
      currentFeature.placetype,
      parentIndex
    );
    
    if (!parent) break;
    
    // Dodaj parent do hierarchii (nie nadpisuj już ustawionych poziomów)
    const parentKey = `${parent.placetype}_id`;
    if (hierarchy[parentKey] === -1) {
      hierarchy[parentKey] = parent.wofId;
    }
    
    // Przejdź do parent
    currentFeature = parent;
  }
  
  // Special case: everything inside a London Borough (E09) should have "London"
  // as locality (boroughs themselves, and neighbourhoods within them).
  // This ensures Pelias returns "London" instead of borough names in locality field.
  if (hasSyntheticLondon &&
      hierarchy.locality_id === -1 &&
      hierarchy.localadmin_id !== -1 &&
      londonBoroughIds.has(hierarchy.localadmin_id)) {
    hierarchy.locality_id = SYNTHETIC_LONDON_ID;
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
function convertOnsToWofSqlite(inputPath, outputPath, londonGeojsonPath, osmNeighbourhoodsPath) {
  log('cyan', '\n🇬🇧  ONS to WOF SQLite Converter');
  log('cyan', '=====================================\n');
  
  // Load Greater London geometry for synthetic London locality
  let londonGeometry = null;
  if (londonGeojsonPath) {
    log('blue', '🏙️  Loading Greater London boundary...');
    londonGeometry = loadGreaterLondonGeometry(londonGeojsonPath);
    if (!londonGeometry) {
      log('yellow', '⚠️  Will create synthetic London without geometry (hierarchy only)');
    }
    console.log(); // Empty line
  }
  
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
    
    // Skip BUA features that duplicate London Borough names
    // London Boroughs (E09) are already mapped as localadmin, 
    // we don't want duplicate locality entries for them
    if (placetype === 'locality' && onsCode.startsWith('E63')) {
      const isDuplicateLondonBUA = processedFeatures.some(f => 
        f.placetype === 'localadmin' && 
        f.onsCode.startsWith('E09') && 
        f.name === name
      );
      
      if (isDuplicateLondonBUA) {
        stats.skipped++;
        progressBar1.update(i + 1, { status: `Skipped (London Borough BUA duplicate)` });
        continue;
      }
    }
    
    const coords = extractAllCoordinates(geometry);
    const centroid = calculateCentroid(coords);
    const innerPoint = calculateInnerPoint(geometry, centroid);
    const bbox = calculateBBox(coords);
    const area = calculateArea(geometry);
    
    const wofId = onsCodeToWofId(onsCode);
    
    processedFeatures.push({
      wofId,
      onsCode,
      name,
      placetype,
      centroid,
      innerPoint,
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
  
  // Deduplicate features sharing an ONS code - E06/E08/E09 districts appear in
  // BOTH the CTYUA (counties) and LAD datasets. Without dedup they'd get
  // duplicate ancestors rows (geojson/spr dedupe via INSERT OR REPLACE,
  // ancestors does not).
  {
    const seenCodes = new Set();
    const deduped = [];
    let dupCount = 0;
    
    for (const f of processedFeatures) {
      if (seenCodes.has(f.onsCode)) {
        stats.processed--;
        stats.byPlacetype[f.placetype]--;
        stats.skipped++;
        dupCount++;
        continue;
      }
      seenCodes.add(f.onsCode);
      deduped.push(f);
    }
    
    if (dupCount > 0) {
      processedFeatures.length = 0;
      processedFeatures.push(...deduped);
      log('yellow', `⚠️  Removed ${dupCount} duplicate features (same ONS code in multiple datasets)\n`);
    }
  }
  
  // Create synthetic "London" locality for all London Boroughs
  log('blue', '🏙️  Creating synthetic London locality...');
  const londonBoroughs = processedFeatures.filter(f => 
    f.placetype === 'localadmin' && f.onsCode.startsWith('E09')
  );
  
  if (londonBoroughs.length > 0) {
    // Calculate fallback values from boroughs
    const londonCentroid = calculateAggregatedCentroid(londonBoroughs);
    const londonBBox = calculateAggregatedBBox(londonBoroughs);
    const londonArea = londonBoroughs.reduce((sum, b) => sum + b.area, 0);
    
    // If we have external London geometry, use it for centroid/bbox
    let finalCentroid = londonCentroid;
    let finalBBox = londonBBox;
    let finalArea = londonArea;
    
    if (londonGeometry) {
      const coords = extractAllCoordinates(londonGeometry);
      if (coords.length > 0) {
        finalCentroid = calculateCentroid(coords);
        finalBBox = calculateBBox(coords);
        finalArea = calculateArea(londonGeometry);
      }
    }
    
    // Use special WOF ID for synthetic London (999999999)
    // Strategy: Store in SPR with placetype='macrocounty' (unused in UK, comes after localadmin in search)
    // but keep wof:placetype='locality' in GeoJSON body so hierarchy resolution works correctly
    // This allows: boroughs found via localadmin PiP -> London resolved from their hierarchy
    const syntheticLondon = {
      wofId: SYNTHETIC_LONDON_ID,
      onsCode: 'SYNTHETIC_LONDON',
      name: 'London',
      placetype: 'locality',  // Used in GeoJSON body for hierarchy resolution
      centroid: finalCentroid,
      innerPoint: calculateInnerPoint(londonGeometry, finalCentroid),
      bbox: finalBBox,
      area: finalArea,
      geometry: londonGeometry || null,  // Use OSM boundary if available
      nameEn: null,
      isSynthetic: true
    };
    
    processedFeatures.push(syntheticLondon);
    stats.processed++;
    stats.byPlacetype['locality'] = (stats.byPlacetype['locality'] || 0) + 1;
    
    log('green', `   ✅ Created synthetic London locality from ${londonBoroughs.length} boroughs`);
    log('blue', `   📍 Centroid: ${finalCentroid.lat.toFixed(4)}, ${finalCentroid.lon.toFixed(4)}`);
    log('blue', `   📏 Area: ${finalArea.toFixed(2)} km²`);
    if (londonGeometry) {
      log('blue', `   🗺️  Using Greater London boundary from OSM (relation 175342)`);
      log('blue', `   🔧 Ghost loader technique: SPR placetype=macrocounty, GeoJSON wof:placetype=locality`);
    } else {
      log('yellow', `   ⚠️  No external geometry - hierarchy only (localadmin PiP will still work)`);
    }
    console.log();
  } else {
    log('yellow', '   ⚠️  No London Boroughs found, skipping synthetic London creation\n');
  }
  
  // OSM neighbourhoods (optional): suburb/neighbourhood/quarter -> placetype=neighbourhood
  if (osmNeighbourhoodsPath) {
    log('blue', '🏘️  Loading OSM neighbourhoods...');
    const rawNeighbourhoods = loadOsmNeighbourhoods(osmNeighbourhoodsPath);
    log('blue', `   Found ${rawNeighbourhoods.length} named suburb/neighbourhood/quarter features`);
    
    if (rawNeighbourhoods.length > 0) {
      processOsmNeighbourhoods(rawNeighbourhoods, processedFeatures, stats);
    } else {
      console.log();
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
  
  // Indeks rodziców (bbox + sort po area) budowany raz — bez tego Pass 2
  // skanuje liniowo wszystkie features dla każdego szukania rodzica
  const parentIndex = buildParentIndex(processedFeatures);
  
  // London Boroughs (E09) - do reguły locality=London
  const londonBoroughIds = new Set(
    processedFeatures
      .filter(f => f.placetype === 'localadmin' && f.onsCode.startsWith('E09'))
      .map(f => f.wofId)
  );
  const hasSyntheticLondon = processedFeatures.some(f => f.onsCode === 'SYNTHETIC_LONDON');
  
  const featuresWithHierarchy = [];
  
  for (let i = 0; i < processedFeatures.length; i++) {
    const featureData = processedFeatures[i];
    
    // Buduj hierarchię
    const hierarchy = buildHierarchy(featureData, parentIndex, londonBoroughIds, hasSyntheticLondon);
    
    featuresWithHierarchy.push({
      ...featureData,
      hierarchy
    });
    
    progressBar2.update(i + 1, { status: featureData.name.substring(0, 30) });
    
    // Extra logging for monitoring progress
    if ((i + 1) % 500 === 0) {
      console.log(`   Progress: ${i + 1}/${processedFeatures.length} (${Math.round((i+1)/processedFeatures.length*100)}%)`);
    }
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
      
      // Określ parent_id (pierwszy USTAWIONY wyższy poziom w hierarchii —
      // niektóre poziomy mogą nie istnieć, np. brak county w części kraju)
      const placetypeIndex = HIERARCHY_ORDER.indexOf(fd.placetype);
      let parentId = -1;
      
      for (let level = placetypeIndex - 1; level >= 0; level--) {
        const candidate = fd.hierarchy[`${HIERARCHY_ORDER[level]}_id`];
        if (candidate && candidate !== -1) {
          parentId = candidate;
          break;
        }
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
          
          'geom:latitude': (fd.innerPoint || fd.centroid).lat,
          'geom:longitude': (fd.innerPoint || fd.centroid).lon,
          'geom:bbox': fd.bbox,
          'geom:area': fd.area,
          
          'mz:is_current': 1,
          'mz:hierarchy_label': 1,
          
          'edtf:cessation': 'uuuu',
          'edtf:inception': 'uuuu',
          
          'src:geom': fd.srcGeom || 'ons',
          'src:geom_alt': [],
          
          ...(fd.srcGeom ? { 'osm:id': fd.onsCode.replace(/^OSM_/, '') } : { 'ons:code': fd.onsCode }),
          
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
      // Synthetic features MUST be in geojson table to be loaded into wofData
      // The SPR placetype='macrocounty' ensures it's loaded by macrocounty worker (after localadmin)
      // so it won't interfere with borough PiP lookups
      insertGeojson.run(fd.wofId, JSON.stringify(wofRecord));
      
      // Insert SPR
      // For synthetic features: use 'macrocounty' in SPR (ghost loader technique)
      // This ensures London is loaded into wofData by macrocounty worker (comes after localadmin)
      // while GeoJSON body keeps wof:placetype='locality' for proper hierarchy resolution
      const sprPlacetype = fd.isSynthetic ? 'macrocounty' : fd.placetype;
      const countryValue = fd.placetype === 'country' ? '' : 'GB';
      insertSpr.run(
        fd.wofId,
        parentId,
        fd.name,
        sprPlacetype,
        countryValue,
        (fd.innerPoint || fd.centroid).lat,
        (fd.innerPoint || fd.centroid).lon,
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
  .option('--london-geojson <path>', 'Path to Greater London GeoJSON file (for synthetic London locality)')
  .option('--osm-neighbourhoods <path>', 'Path to OSM neighbourhoods GeoJSON (from extract-osm-neighbourhoods.sh)')
  .parse(process.argv);

const options = program.opts();

// Run conversion
convertOnsToWofSqlite(options.input, options.output, options.londonGeojson, options.osmNeighbourhoods);
