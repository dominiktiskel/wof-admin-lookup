#!/usr/bin/env node
/**
 * OSM Administrative Boundaries to WOF SQLite Converter
 * 
 * Converts GeoJSON file containing OSM administrative boundaries
 * to WOF-compatible SQLite database format for use with Pelias wof-admin-lookup.
 * 
 * Usage:
 *   node osm-to-wof-sqlite.js -i boundaries.geojson -o whosonfirst-data-osm-admin-pl.db
 * 
 * The output SQLite file should be placed in:
 *   /data/whosonfirst/sqlite/
 * 
 * wof-admin-lookup will automatically load all whosonfirst-data-*.db files.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const turfArea = require('@turf/area').default;
const { feature } = require('@turf/helpers');
const { program } = require('commander');
const cliProgress = require('cli-progress');

// Mapowanie admin_level OSM na placetype WOF
// https://wiki.openstreetmap.org/wiki/Tag:boundary%3Dadministrative
const ADMIN_LEVEL_TO_PLACETYPE = {
  '2': 'country',        // kraj
  '4': 'region',         // województwo
  '6': 'county',         // powiat
  '7': 'localadmin',     // gmina
  '8': 'locality',       // miasto/wieś (główny placetype dla miejscowości)
  '9': 'borough',        // dzielnica miasta / osiedle
  '10': 'neighbourhood'  // sołectwo / osiedle / część miejscowości
};

// Prioritety - niższy = ważniejszy (dla rozwiązywania konfliktów)
const PLACETYPE_PRIORITY = {
  'country': 1,
  'region': 2,
  'county': 3,
  'localadmin': 4,
  'locality': 5,
  'borough': 6,
  'neighbourhood': 7
};

// Kolory dla logów
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

function log(color, ...args) {
  console.log(colors[color], ...args, colors.reset);
}

/**
 * Ekstrahuje wszystkie współrzędne z geometrii (obsługuje nested arrays)
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
 * Oblicza bounding box z listy współrzędnych
 */
function calculateBBox(coords) {
  if (!coords || coords.length === 0) {
    return '0,0,0,0';
  }
  
  const lons = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  
  return [
    Math.min(...lons),
    Math.min(...lats),
    Math.max(...lons),
    Math.max(...lats)
  ].join(',');
}

/**
 * Oblicza powierzchnię poligonu w km²
 */
function calculateArea(geometry) {
  try {
    const geojsonFeature = feature(geometry);
    const area = turfArea(geojsonFeature);
    return Math.round(area / 1000000 * 100) / 100; // km² z 2 miejscami
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
 * Próbuje naprawić prostą geometrię (podstawowa walidacja)
 */
function fixGeometry(geometry) {
  if (!geometry) return null;
  
  // Podstawowa walidacja - sprawdź czy geometria ma wymagane pola
  if (!geometry.type || !geometry.coordinates) {
    return null;
  }
  
  // Dla Polygon/MultiPolygon sprawdź czy są współrzędne
  const coords = extractAllCoordinates(geometry);
  if (coords.length < 3) {
    return null;
  }
  
  return geometry;
}

/**
 * Generuje unikalny ID w formacie WOF
 * Używamy przedrostka 9xxxxxxxxx aby uniknąć kolizji z prawdziwymi ID WOF
 */
function generateWofId(osmId, adminLevel) {
  // Bazowy ID z OSM ID i admin_level
  const baseId = Math.abs(parseInt(osmId) || 0);
  const level = parseInt(adminLevel) || 8;
  
  // Format: 9LLNNNNNNNNN gdzie LL = admin_level, N = OSM ID (ostatnie 8 cyfr)
  return parseInt(`9${level.toString().padStart(2, '0')}${(baseId % 100000000).toString().padStart(8, '0')}`);
}

/**
 * Główna funkcja konwersji
 */
function convertGeoJsonToWofSqlite(inputPath, outputPath, options = {}) {
  log('cyan', '\n🗺️  OSM to WOF SQLite Converter');
  log('cyan', '================================\n');
  
  // Sprawdź czy plik wejściowy istnieje
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
  
  // Obsługa różnych formatów GeoJSON
  let features = [];
  if (geojson.type === 'FeatureCollection') {
    features = geojson.features || [];
  } else if (geojson.type === 'Feature') {
    features = [geojson];
  } else if (Array.isArray(geojson)) {
    features = geojson;
  }
  
  log('blue', `📊 Found ${features.length} features in GeoJSON\n`);
  
  // Usuń stary plik jeśli istnieje
  if (fs.existsSync(outputPath)) {
    log('yellow', `⚠️  Removing existing database: ${outputPath}`);
    fs.unlinkSync(outputPath);
  }
  
  // Utwórz bazę SQLite
  log('blue', `💾 Creating SQLite database: ${outputPath}`);
  const db = new Database(outputPath);
  
  // Schemat zgodny z WOF (pelias-whosonfirst SQLiteStream wymaga tabel geojson + spr)
  db.exec(`
    -- Tabela geojson - przechowuje pełne GeoJSON features
    CREATE TABLE IF NOT EXISTS geojson (
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL,
      is_alt INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS geojson_by_id ON geojson(id);
    
    -- Tabela spr (Standard Place Response) - metadane do filtrowania
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
    
    -- Tabela ancestors (opcjonalna - dla hierarchii)
    CREATE TABLE IF NOT EXISTS ancestors (
      id INTEGER,
      ancestor_id INTEGER,
      ancestor_placetype TEXT,
      lastmodified INTEGER
    );
    CREATE INDEX IF NOT EXISTS ancestors_by_id ON ancestors(id);
    CREATE INDEX IF NOT EXISTS ancestors_by_ancestor_id ON ancestors(ancestor_id);
  `);
  
  // Przygotuj statementy INSERT
  const insertGeojson = db.prepare('INSERT OR REPLACE INTO geojson (id, body, is_alt) VALUES (?, ?, 0)');
  const insertSpr = db.prepare(`
    INSERT OR REPLACE INTO spr 
    (id, parent_id, name, placetype, country, latitude, longitude, 
     min_latitude, min_longitude, max_latitude, max_longitude,
     is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, ?)
  `);
  
  // Statystyki
  const stats = {
    total: features.length,
    processed: 0,
    skipped: 0,
    byPlacetype: {}
  };
  
  // Progress bar
  const progressBar = new cliProgress.SingleBar({
    format: 'Converting |{bar}| {percentage}% | {value}/{total} | {status}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true
  });
  
  progressBar.start(features.length, 0, { status: 'Starting...' });
  
  // Przetwarzaj features
  const transaction = db.transaction(() => {
    for (let i = 0; i < features.length; i++) {
      const feature = features[i];
      const props = feature.properties || {};
      
      // Pobierz admin_level
      const adminLevel = props.admin_level || props['admin_level'] || '8';
      const placetype = ADMIN_LEVEL_TO_PLACETYPE[adminLevel];
      
      // Filtruj tylko dozwolone placetypes
      if (!placetype) {
        stats.skipped++;
        progressBar.update(i + 1, { status: `Skipped (unknown level ${adminLevel})` });
        continue;
      }
      
      // Filtruj po placetype jeśli określono
      if (options.placetypes && options.placetypes.length > 0) {
        if (!options.placetypes.includes(placetype)) {
          stats.skipped++;
          progressBar.update(i + 1, { status: `Skipped (${placetype} not in filter)` });
          continue;
        }
      }
      
      // Waliduj geometrię
      let geometry = feature.geometry;
      if (!isValidGeometry(geometry)) {
        geometry = fixGeometry(geometry);
        if (!isValidGeometry(geometry)) {
          stats.skipped++;
          progressBar.update(i + 1, { status: 'Skipped (invalid geometry)' });
          continue;
        }
      }
      
      // Pobierz nazwę (różne warianty tagów OSM)
      const name = props.name || 
                   props['name:pl'] || 
                   props['official_name'] ||
                   props['alt_name'] ||
                   props['loc_name'] ||
                   null;
      
      if (!name) {
        stats.skipped++;
        progressBar.update(i + 1, { status: 'Skipped (no name)' });
        continue;
      }
      
      // Oblicz geometryczne właściwości
      const coords = extractAllCoordinates(geometry);
      const centroid = calculateCentroid(coords);
      const bbox = calculateBBox(coords);
      const area = calculateArea(geometry);
      
      // Pobierz OSM ID
      const osmId = props['@id'] || 
                    props.osm_id || 
                    props['osm:id'] ||
                    props.id ||
                    `osm_${i}`;
      
      // Generuj WOF ID
      const wofId = generateWofId(osmId, adminLevel);
      
      // Pobierz dodatkowe pola
      const population = parseInt(props.population) || null;
      const wikidata = props.wikidata || props['wikidata'] || null;
      const wikipedia = props.wikipedia || props['wikipedia'] || null;
      
      // Utwórz rekord WOF GeoJSON
      const wofRecord = {
        type: 'Feature',
        id: wofId,
        properties: {
          // Wymagane pola WOF
          'wof:id': wofId,
          'wof:name': name,
          'wof:placetype': placetype,
          'wof:parent_id': -1,
          'wof:hierarchy': [],
          
          // Geometria
          'geom:latitude': centroid.lat,
          'geom:longitude': centroid.lon,
          'geom:bbox': bbox,
          'geom:area': area,
          
          // Status
          'mz:is_current': 1,
          'mz:hierarchy_label': 1,
          
          // Daty
          'edtf:cessation': 'uuuu',
          'edtf:inception': 'uuuu',
          
          // Źródło
          'src:geom': 'openstreetmap',
          'src:geom_alt': [],
          
          // OSM metadane
          'osm:id': osmId,
          'osm:admin_level': adminLevel,
          
          // Opcjonalne pola
          ...(population && { 'wof:population': population }),
          ...(wikidata && { 'wof:concordances': { 'wd:id': wikidata } }),
          ...(wikipedia && { 'wof:wikipedia': wikipedia }),
          
          // Alternatywne nazwy (jeśli dostępne)
          ...(props['name:en'] && { 'name:eng_x_preferred': [props['name:en']] }),
          ...(props['name:de'] && { 'name:deu_x_preferred': [props['name:de']] }),
          ...(props['name:pl'] && { 'name:pol_x_preferred': [props['name:pl']] })
        },
        geometry: geometry
      };
      
      // Parsuj bbox na min/max lat/lon
      const bboxParts = bbox.split(',').map(Number);
      const minLon = bboxParts[0] || 0;
      const minLat = bboxParts[1] || 0;
      const maxLon = bboxParts[2] || 0;
      const maxLat = bboxParts[3] || 0;
      
      // Zapisz do obu tabel
      try {
        // Tabela geojson - pełny GeoJSON
        insertGeojson.run(wofId, JSON.stringify(wofRecord));
        
        // Tabela spr - metadane do filtrowania (wymagane przez pelias-whosonfirst)
        insertSpr.run(
          wofId,                    // id
          -1,                       // parent_id
          name,                     // name
          placetype,                // placetype
          options.countryCode || 'PL', // country
          centroid.lat,             // latitude
          centroid.lon,             // longitude
          minLat,                   // min_latitude
          minLon,                   // min_longitude
          maxLat,                   // max_latitude
          maxLon,                   // max_longitude
          Date.now()                // lastmodified
        );
        
        stats.processed++;
        stats.byPlacetype[placetype] = (stats.byPlacetype[placetype] || 0) + 1;
        progressBar.update(i + 1, { status: `${name.substring(0, 30)}...` });
      } catch (e) {
        stats.skipped++;
        progressBar.update(i + 1, { status: `Error: ${e.message.substring(0, 30)}` });
      }
    }
  });
  
  // Wykonaj transakcję
  try {
    transaction();
  } catch (e) {
    log('red', `\n❌ Transaction error: ${e.message}`);
  }
  
  progressBar.stop();
  
  // Zamknij bazę
  db.close();
  
  // Podsumowanie
  log('green', '\n✅ Conversion completed!\n');
  log('cyan', '📊 Statistics:');
  log('blue', `   Total features:     ${stats.total}`);
  log('green', `   Processed:          ${stats.processed}`);
  log('yellow', `   Skipped:            ${stats.skipped}`);
  
  log('cyan', '\n📍 By placetype:');
  Object.entries(stats.byPlacetype)
    .sort((a, b) => PLACETYPE_PRIORITY[a[0]] - PLACETYPE_PRIORITY[b[0]])
    .forEach(([placetype, count]) => {
      log('blue', `   ${placetype.padEnd(15)} ${count}`);
    });
  
  const fileSize = fs.statSync(outputPath).size;
  log('cyan', `\n💾 Output file: ${outputPath}`);
  log('blue', `   Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
  
  log('green', '\n🎯 Next steps:');
  log('blue', '   1. Copy the SQLite file to your WOF data directory:');
  log('yellow', `      cp ${outputPath} /data/whosonfirst/sqlite/`);
  log('blue', '   2. Reimport OSM data:');
  log('yellow', '      pelias compose run openstreetmap ./bin/start');
  log('blue', '   3. The new boundaries will be automatically loaded by wof-admin-lookup\n');
  
  return stats;
}

// CLI
program
  .name('osm-to-wof-sqlite')
  .description('Convert OSM administrative boundaries GeoJSON to WOF SQLite format')
  .version('1.0.0')
  .requiredOption('-i, --input <path>', 'Input GeoJSON file with OSM boundaries')
  .option('-o, --output <path>', 'Output SQLite file', 'whosonfirst-data-osm-admin.db')
  .option('-p, --placetypes <types>', 'Comma-separated list of placetypes to include', (val) => val.split(','))
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
  placetypes: opts.placetypes,
  countryCode: opts.country
});

