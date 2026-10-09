#!/usr/bin/env node
/**
 * Ukraine COD-AB boundaries to WOF SQLite.
 *
 * Hierarchy comes from admN_pcode attributes, not point-in-polygon.
 * ADM4 polygons are settlement footprints (built-up area), not cadastral limits.
 *
 * Usage:
 *   node cod-to-wof-sqlite.js -i manifest.json -o whosonfirst-data-cod-ua.db
 *   node cod-to-wof-sqlite.js -i ./geojson-dir -o whosonfirst-data-cod-ua.db
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

const HIERARCHY_ORDER = ['country', 'region', 'county', 'localadmin', 'locality', 'borough', 'neighbourhood'];
const LEVEL_TO_PLACETYPE = {
  0: 'country',
  1: 'region',
  2: 'county',
  3: 'localadmin',
  4: 'locality'
};
const EXPECTED = {
  country: 1,
  region: 27,
  county: 139,
  localadmin: 1769,
  locality: 29706
};

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

function lowerProps(props) {
  const out = {};
  for (const [key, value] of Object.entries(props || {})) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function canonicalLang(raw) {
  if (!raw) return null;
  const text = String(raw).trim().toLowerCase().replace(/_/g, '-');
  const primary = text.split('-')[0];
  if (primary === 'uk' || primary === 'ukr' || primary === 'ua' || text.includes('ukrain')) return 'ukr';
  if (primary === 'en' || primary === 'eng' || text.includes('english')) return 'eng';
  if (primary === 'ru' || primary === 'rus' || text.includes('russian')) return 'rus';
  return null;
}

function fileLevelHint(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const match = base.match(/adm(?:in)?[_-]?([0-4])(?!\d)/);
  return match ? parseInt(match[1], 10) : null;
}

function parseLevel(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isNaN(n) ? null : n;
}

function featureLevel(props, hint) {
  const explicit = parseLevel(props.admin_level ?? props.admin_leve ?? props.adm_level);
  if (explicit !== null && LEVEL_TO_PLACETYPE[explicit]) return explicit;
  if (hint !== null && LEVEL_TO_PLACETYPE[hint]) return hint;
  for (let level = 4; level >= 0; level--) {
    if (clean(props[`adm${level}_name`])) return level;
  }
  return null;
}

function collectNameSlots(props, level) {
  const langKeys = ['lang', 'lang1', 'lang2', 'lang3'];
  const genericKeys = ['name', 'name1', 'name2', 'name3'];
  const levelKeys = [0, 1, 2, 3].map((i) => i === 0 ? `adm${level}_name` : `adm${level}_name${i}`);
  const generic = genericKeys.map((key) => clean(props[key])).filter(Boolean);
  const keys = generic.length ? genericKeys : levelKeys;
  const slots = [];
  for (let i = 0; i < keys.length; i++) {
    const name = clean(props[keys[i]]);
    if (!name) continue;
    slots.push({ name, lang: canonicalLang(props[langKeys[i]]) });
  }
  return slots;
}

function namesByLang(slots) {
  const byLang = {};
  for (const slot of slots) {
    if (!slot.lang || byLang[slot.lang]) continue;
    byLang[slot.lang] = slot.name;
  }
  return byLang;
}

function oldNameVariants(props) {
  const langKeys = ['lang', 'lang1', 'lang2', 'lang3'];
  const nameKeys = ['adm3_name_old', 'adm3_name1_old', 'adm3_name2_old', 'adm3_name3_old'];
  const variants = { ukr: [], eng: [], rus: [] };
  for (let i = 0; i < nameKeys.length; i++) {
    const name = clean(props[nameKeys[i]]);
    const lang = canonicalLang(props[langKeys[i]]);
    if (!name || !lang || !variants[lang]) continue;
    if (!variants[lang].includes(name)) variants[lang].push(name);
  }
  return variants;
}

function pcodeToWofId(pcode, usedIds) {
  let hash = 2166136261;
  const text = String(pcode);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash >>>= 0;
  let n = hash % 100000000;
  let id = parseInt(`6${n.toString().padStart(8, '0')}`, 10);
  while (usedIds.has(id)) {
    n = (n + 1) % 100000000;
    id = parseInt(`6${n.toString().padStart(8, '0')}`, 10);
  }
  usedIds.add(id);
  return id;
}

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
  if (geometry && geometry.coordinates) extract(geometry.coordinates);
  return coords;
}

function calculateBBox(coords) {
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
  if (!Number.isFinite(minLon)) return '0,0,0,0';
  return [minLon, minLat, maxLon, maxLat].join(',');
}

function vertexCentroid(coords) {
  if (!coords.length) return { lat: 0, lon: 0 };
  let lon = 0;
  let lat = 0;
  for (const coord of coords) {
    lon += coord[0];
    lat += coord[1];
  }
  return { lon: lon / coords.length, lat: lat / coords.length };
}

function calculateInnerPoint(geometry, centroid) {
  try {
    if (booleanPointInPolygon(point([centroid.lon, centroid.lat]), geometry)) {
      return centroid;
    }
  } catch (err) {
    // fall through
  }
  try {
    const onFeature = pointOnFeature(feature(geometry));
    return {
      lat: onFeature.geometry.coordinates[1],
      lon: onFeature.geometry.coordinates[0]
    };
  } catch (err) {
    return centroid;
  }
}

function isPolygonGeometry(geometry) {
  return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') && geometry.coordinates;
}

function polygonParts(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.slice();
  if (geometry.type === 'GeometryCollection') {
    const parts = [];
    for (const child of geometry.geometries || []) parts.push(...polygonParts(child));
    return parts;
  }
  return [];
}

function asMultiPolygon(parts) {
  return { type: 'MultiPolygon', coordinates: parts };
}

function safeArea(geometry) {
  try {
    return turfArea(feature(geometry));
  } catch (err) {
    return 0;
  }
}

function resolveInputs(input) {
  if (input.includes(',') && !fs.existsSync(input)) {
    return input.split(',').map((item) => item.trim()).filter(Boolean);
  }
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Input not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const files = [];
    function walk(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.geojson$/i.test(ent.name) || /\.json$/i.test(ent.name)) files.push(full);
      }
    }
    walk(resolved);
    return files.filter((file) => !file.endsWith('manifest.json'));
  }
  if (resolved.endsWith('manifest.json')) {
    const manifest = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error('manifest.json has no files');
    }
    return manifest.files;
  }
  return [resolved];
}

function loadFile(filePath) {
  const hint = fileLevelHint(filePath);
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let features;
  if (json.type === 'FeatureCollection') features = json.features || [];
  else if (json.type === 'Feature') features = [json];
  else return null;
  return { hint, features, filePath };
}

function buildCountryFromRegions(regions, usedIds) {
  const parts = [];
  let adm0 = null;
  for (const region of regions) {
    parts.push(...polygonParts(region.geometry));
    if (!adm0 && region.pcodes[0]) adm0 = region.pcodes[0];
  }
  if (parts.length === 0) return null;
  const pcode = adm0 || 'UA';
  const geometry = asMultiPolygon(parts);
  const coords = extractAllCoordinates(geometry);
  const centroid = calculateInnerPoint(geometry, vertexCentroid(coords));
  return {
    wofId: pcodeToWofId(pcode, usedIds),
    pcode,
    pcodes: { 0: pcode },
    placetype: 'country',
    level: 0,
    name: 'Україна',
    names: { ukr: 'Україна', eng: 'Ukraine', rus: 'Украина' },
    variants: { ukr: [], eng: [], rus: [] },
    geometry,
    centroid,
    bbox: calculateBBox(coords),
    area: safeArea(geometry),
    syntheticCountry: true
  };
}

function emptyHierarchy() {
  return {
    country_id: -1,
    region_id: -1,
    county_id: -1,
    localadmin_id: -1,
    locality_id: -1,
    borough_id: -1,
    neighbourhood_id: -1
  };
}

function attachHierarchy(records) {
  const byPcode = new Map();
  for (const record of records) byPcode.set(record.pcode, record);

  for (const record of records) {
    const hierarchy = emptyHierarchy();
    hierarchy[`${record.placetype}_id`] = record.wofId;
    for (let level = record.level - 1; level >= 0; level--) {
      const pcode = record.pcodes[level];
      const parent = pcode && byPcode.get(pcode);
      if (!parent) continue;
      hierarchy[`${LEVEL_TO_PLACETYPE[level]}_id`] = parent.wofId;
    }
    record.hierarchy = hierarchy;
  }

  const countries = records.filter((record) => record.placetype === 'country');
  if (countries.length === 1) {
    const countryId = countries[0].wofId;
    for (const record of records) {
      if (record.hierarchy.country_id === -1) record.hierarchy.country_id = countryId;
    }
  }
}

function parentIdOf(record) {
  const index = HIERARCHY_ORDER.indexOf(record.placetype);
  for (let i = index - 1; i >= 0; i--) {
    const id = record.hierarchy[`${HIERARCHY_ORDER[i]}_id`];
    if (id && id !== -1) return id;
  }
  return -1;
}

function convert(input, outputPath) {
  const files = resolveInputs(input);
  if (files.length === 0) throw new Error('No GeoJSON files to convert');

  log('blue', `Reading ${files.length} file(s)`);
  const loaded = [];
  for (const file of files) {
    const source = loadFile(file);
    if (!source) {
      log('yellow', `   Skipping non-GeoJSON file: ${path.basename(file)}`);
      continue;
    }
    loaded.push(source);
  }
  if (loaded.length === 0) throw new Error('No GeoJSON features found');

  const usedIds = new Set();
  const byPcode = new Map();
  const stats = {
    read: 0,
    skipped: 0,
    duplicates: 0,
    noUkrainian: 0,
    byPlacetype: {}
  };

  for (const source of loaded) {
    for (const item of source.features) {
      stats.read++;
      const props = lowerProps(item.properties);
      const level = featureLevel(props, source.hint);
      if (level === null || !LEVEL_TO_PLACETYPE[level]) {
        stats.skipped++;
        continue;
      }
      const geometryParts = polygonParts(item.geometry);
      if (geometryParts.length === 0) {
        stats.skipped++;
        continue;
      }
      const geometry = geometryParts.length === 1 && item.geometry.type === 'Polygon'
        ? item.geometry
        : asMultiPolygon(geometryParts);
      const pcode = clean(props[`adm${level}_pcode`]);
      if (!pcode) {
        stats.skipped++;
        continue;
      }
      const slots = collectNameSlots(props, level);
      const names = namesByLang(slots);
      let displayName = names.ukr || null;
      if (!displayName) {
        stats.noUkrainian++;
        displayName = slots[0] ? slots[0].name : null;
      }
      if (!displayName) {
        stats.skipped++;
        continue;
      }
      const coords = extractAllCoordinates(geometry);
      const centroid = calculateInnerPoint(geometry, vertexCentroid(coords));
      const record = {
        wofId: null,
        pcode,
        pcodes: {},
        placetype: LEVEL_TO_PLACETYPE[level],
        level,
        name: displayName,
        names,
        variants: level === 3 ? oldNameVariants(props) : { ukr: [], eng: [], rus: [] },
        geometry,
        centroid,
        bbox: calculateBBox(coords),
        area: safeArea(geometry),
        syntheticCountry: false
      };
      for (let parentLevel = 0; parentLevel <= 4; parentLevel++) {
        const parentPcode = clean(props[`adm${parentLevel}_pcode`]);
        if (parentPcode) record.pcodes[parentLevel] = parentPcode;
      }
      record.pcodes[level] = pcode;

      const existing = byPcode.get(pcode);
      if (existing) {
        stats.duplicates++;
        if (record.area > existing.area) byPcode.set(pcode, record);
        continue;
      }
      byPcode.set(pcode, record);
    }
  }

  let records = Array.from(byPcode.values());
  if (!records.some((record) => record.placetype === 'country')) {
    const regions = records.filter((record) => record.placetype === 'region');
    const country = buildCountryFromRegions(regions, usedIds);
    if (country) {
      log('yellow', `   No ADM0 geometry; country polygon assembled from ${regions.length} oblasts`);
      records.push(country);
    }
  }

  for (const record of records) {
    if (record.wofId === null) record.wofId = pcodeToWofId(record.pcode, usedIds);
    stats.byPlacetype[record.placetype] = (stats.byPlacetype[record.placetype] || 0) + 1;
  }

  log('magenta', 'Linking hierarchy by pcode');
  attachHierarchy(records);

  let localitiesMissingAdmin = 0;
  let localitiesMissingLocaladmin = 0;
  for (const record of records) {
    if (record.placetype !== 'locality') continue;
    if (record.hierarchy.country_id === -1 || record.hierarchy.region_id === -1) {
      localitiesMissingAdmin++;
    }
    if (record.hierarchy.localadmin_id === -1) localitiesMissingLocaladmin++;
  }

  writeDatabase(outputPath, records);
  printReport(stats, localitiesMissingAdmin, localitiesMissingLocaladmin, records.length);

  const failures = [];
  for (const [placetype, expected] of Object.entries(EXPECTED)) {
    const got = stats.byPlacetype[placetype] || 0;
    if (placetype === 'locality') {
      if (Math.abs(got - expected) > expected * 0.01) {
        failures.push(`locality ${got} is not about ${expected}`);
      }
    } else if (got !== expected) {
      failures.push(`${placetype} ${got} !== ${expected}`);
    }
  }
  if (localitiesMissingAdmin > 0) {
    failures.push(`${localitiesMissingAdmin} localities missing country_id or region_id`);
  }
  const named = records.length;
  if (named > 0 && stats.noUkrainian / named > 0.01) {
    failures.push(`${stats.noUkrainian} records have no Ukrainian name`);
  }
  if (failures.length) {
    log('red', '\nAcceptance failed:');
    for (const failure of failures) log('red', `   ${failure}`);
    process.exitCode = 1;
  } else {
    log('green', '\nAcceptance passed');
  }
}

function writeDatabase(outputPath, records) {
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const db = new Database(outputPath);
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

  const bar = new cliProgress.SingleBar({
    format: 'Write |{bar}| {percentage}% | {value}/{total}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true
  });
  bar.start(records.length, 0);

  const now = Date.now();
  const transaction = db.transaction(() => {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const parentId = parentIdOf(record);
      const bboxParts = record.bbox.split(',').map(Number);
      const nameProps = {};
      for (const lang of ['ukr', 'eng', 'rus']) {
        if (record.names[lang]) nameProps[`name:${lang}_x_preferred`] = [record.names[lang]];
        const variants = (record.variants[lang] || []).filter((name) => name !== record.names[lang]);
        if (variants.length) nameProps[`name:${lang}_x_variant`] = variants;
      }
      const wofRecord = {
        type: 'Feature',
        id: record.wofId,
        properties: {
          'wof:id': record.wofId,
          'wof:name': record.name,
          'wof:placetype': record.placetype,
          'wof:parent_id': parentId,
          'wof:hierarchy': [record.hierarchy],
          'wof:country': 'UA',
          'wof:lang_x_official': ['ukr'],
          'geom:latitude': record.centroid.lat,
          'geom:longitude': record.centroid.lon,
          'geom:bbox': record.bbox,
          'geom:area': record.area,
          'mz:is_current': 1,
          'mz:hierarchy_label': 1,
          'edtf:cessation': 'uuuu',
          'edtf:inception': 'uuuu',
          'src:geom': 'ocha-cod-ab',
          'src:geom_alt': [],
          'cod:pcode': record.pcode,
          'cod:admin_level': record.level,
          ...nameProps,
          ...(record.placetype === 'country' && {
            'iso:country': 'UA',
            'wof:country_alpha3': 'UKR'
          })
        },
        geometry: record.geometry
      };
      insertGeojson.run(record.wofId, JSON.stringify(wofRecord));
      insertSpr.run(
        record.wofId,
        parentId,
        record.name,
        record.placetype,
        record.placetype === 'country' ? '' : 'UA',
        record.centroid.lat,
        record.centroid.lon,
        bboxParts[1] || 0,
        bboxParts[0] || 0,
        bboxParts[3] || 0,
        bboxParts[2] || 0,
        now
      );
      for (const [key, value] of Object.entries(record.hierarchy)) {
        if (value !== -1 && value !== record.wofId) {
          insertAncestor.run(record.wofId, value, key.replace('_id', ''), now);
        }
      }
      if (i % 500 === 0) bar.update(i);
    }
  });
  transaction();
  bar.update(records.length);
  bar.stop();
  db.close();
  const size = fs.statSync(outputPath).size;
  log('cyan', `\nOutput: ${outputPath}`);
  log('blue', `   Size: ${(size / 1024 / 1024).toFixed(2)} MB`);
}

function printReport(stats, localitiesMissingAdmin, localitiesMissingLocaladmin, written) {
  log('green', '\nConversion completed\n');
  log('cyan', 'Statistics:');
  log('blue', `   Features read:      ${stats.read}`);
  log('green', `   Written:            ${written}`);
  log('yellow', `   Skipped:            ${stats.skipped}`);
  log('yellow', `   Duplicate pcodes:   ${stats.duplicates}`);
  log('yellow', `   No Ukrainian name:  ${stats.noUkrainian}`);
  log('yellow', `   Localities missing country or region: ${localitiesMissingAdmin}`);
  log('yellow', `   Localities missing hromada:           ${localitiesMissingLocaladmin}`);
  log('cyan', '\nBy placetype:');
  for (const placetype of HIERARCHY_ORDER) {
    if (!stats.byPlacetype[placetype]) continue;
    const expected = EXPECTED[placetype];
    const got = stats.byPlacetype[placetype];
    const mark = expected === undefined ? '' : (placetype === 'locality'
      ? (Math.abs(got - expected) <= expected * 0.01 ? ' ok' : ' MISMATCH')
      : (got === expected ? ' ok' : ' MISMATCH'));
    log('blue', `   ${placetype.padEnd(14)} ${String(got).padStart(6)}${expected ? `  expected ${expected}${mark}` : ''}`);
  }
}

program
  .name('cod-to-wof-sqlite')
  .description('Convert Ukraine COD-AB GeoJSON to a Pelias WOF SQLite database')
  .requiredOption('-i, --input <path>', 'manifest.json, a GeoJSON directory, a GeoJSON file, or comma-separated files')
  .option('-o, --output <path>', 'Output SQLite file', 'whosonfirst-data-cod-ua.db')
  .parse(process.argv);

const opts = program.opts();

try {
  convert(opts.input, opts.output);
} catch (err) {
  log('red', `ERROR: ${err.message}`);
  process.exit(1);
}
