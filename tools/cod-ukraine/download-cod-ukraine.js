#!/usr/bin/env node
/**
 * Download Ukraine COD-AB administrative boundaries from HDX.
 *
 * Picks a file that actually contains admin level 4 (settlements). The GeoJSON
 * bundle is tried first. If it has no ADM4 features, the shapefile bundle is
 * downloaded and converted with ogr2ogr.
 *
 * Data: OCHA COD-AB Ukraine (CC BY-IGO), geometry from SSPE Kartographia.
 * https://data.humdata.org/dataset/cod-ab-ukr
 *
 * Usage: node download-cod-ukraine.js -o ./output [--skip-download]
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const HDX_PACKAGE = 'https://data.humdata.org/api/3/action/package_show?id=cod-ab-ukr';
const USER_AGENT = 'pelias-cod-ukraine/1.0';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  red: '\x1b[31m'
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function parseArgs(argv) {
  const opts = { output: null, skipDownload: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--output') {
      opts.output = argv[++i];
    } else if (arg === '--skip-download') {
      opts.skipDownload = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node download-cod-ukraine.js -o OUTPUT_DIR [--skip-download]');
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }
  if (!opts.output) {
    console.error('Output directory is required (-o)');
    process.exit(1);
  }
  opts.output = path.resolve(opts.output);
  return opts;
}

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        resolve(fetchBuffer(next, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const next = new URL(res.headers.location, url).href;
        log('gray', `      Redirect: ${next}`);
        res.resume();
        resolve(downloadFile(next, dest, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const file = fs.createWriteStream(dest);
      let received = 0;
      let reported = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received - reported >= 20 * 1024 * 1024) {
          reported = received;
          log('gray', `      ${(received / 1024 / 1024).toFixed(0)} MB`);
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(received)));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

function pickResource(resources, kind) {
  if (kind === 'geojson') {
    return resources.find((r) => /geojson\.zip$/i.test(r.name || ''))
      || resources.find((r) => String(r.format || '').toLowerCase() === 'geojson');
  }
  return resources.find((r) => /\.shp\.zip$/i.test(r.name || ''))
    || resources.find((r) => String(r.format || '').toLowerCase() === 'shp');
}

function resourceUrl(resource) {
  return resource.download_url || resource.url;
}

function extractZip(zipPath, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', dest], { stdio: 'inherit' });
    return;
  } catch (err) {
    log('yellow', '      unzip failed, trying python3');
  }
  execFileSync('python3', ['-c',
    'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
    zipPath, dest
  ], { stdio: 'inherit' });
}

function walk(dir, extensions) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '__MACOSX' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walk(full, extensions));
    } else if (extensions.some((ext) => ent.name.toLowerCase().endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A dedicated ADM4 file is named like ukr_admin4.geojson.
 * A combined file is detected by non-empty adm4_pcode values or admin_level 4.
 */
function fileLevelHint(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const match = base.match(/adm(?:in)?[_-]?([0-4])(?!\d)/);
  return match ? parseInt(match[1], 10) : null;
}

// Point, line and capital layers share pcodes with the polygon layers.
// When the bundle has one file per admin level, keep only those.
function selectBoundaryFiles(files) {
  const dedicated = files.filter((file) => fileLevelHint(file) !== null);
  if (dedicated.length > 0) return dedicated;
  return files.filter((file) => !/(points|lines|capitals)/i.test(path.basename(file)));
}

function countAdm4(filePath) {
  return new Promise((resolve, reject) => {
    if (fileLevelHint(filePath) === 4) {
      resolve({ dedicatedFile: true, adminLevel4: 0, pcode: 0 });
      return;
    }
    let leftover = '';
    let adminLevel4 = 0;
    let pcode = 0;
    const levelRe = /"admin_lev(?:el|e)"\s*:\s*"?4"?(?!\d)/gi;
    const pcodeRe = /"adm4_pcode"\s*:\s*"([^"\\]+)"/gi;
    const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
    rs.on('data', (chunk) => {
      const text = leftover + chunk;
      leftover = text.slice(-64);
      const scan = text.slice(0, Math.max(0, text.length - 64));
      levelRe.lastIndex = 0;
      pcodeRe.lastIndex = 0;
      const levels = scan.match(levelRe);
      const pcodes = scan.match(pcodeRe);
      if (levels) adminLevel4 += levels.length;
      if (pcodes) pcode += pcodes.length;
    });
    rs.on('end', () => {
      const tail = leftover;
      levelRe.lastIndex = 0;
      pcodeRe.lastIndex = 0;
      const levels = tail.match(levelRe);
      const pcodes = tail.match(pcodeRe);
      if (levels) adminLevel4 += levels.length;
      if (pcodes) pcode += pcodes.length;
      resolve({ dedicatedFile: false, adminLevel4, pcode });
    });
    rs.on('error', reject);
  });
}

async function filesContainAdm4(files) {
  let total = 0;
  for (const file of files) {
    const hit = await countAdm4(file);
    const n = hit.dedicatedFile ? 1 : (hit.adminLevel4 + hit.pcode);
    log('gray', `      ${path.basename(file)}: ${hit.dedicatedFile ? 'filename is ADM4' : `${hit.adminLevel4} admin_level=4, ${hit.pcode} adm4_pcode`}`);
    total += n;
  }
  return total > 0;
}

function convertShapefiles(shpFiles, destDir) {
  try {
    execFileSync('ogr2ogr', ['--version'], { stdio: 'ignore' });
  } catch (err) {
    throw new Error('ogr2ogr (GDAL) is required to convert the shapefile bundle. Install gdal (brew install gdal / apt install gdal-bin).');
  }
  fs.mkdirSync(destDir, { recursive: true });
  const outputs = [];
  for (const shp of shpFiles) {
    const base = path.basename(shp, path.extname(shp));
    const out = path.join(destDir, `${base}.geojson`);
    log('cyan', `      ogr2ogr ${base}.shp -> ${path.basename(out)}`);
    execFileSync('ogr2ogr', ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', out, shp], { stdio: 'inherit' });
    outputs.push(out);
  }
  return outputs;
}

function writeManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log('green', `      Manifest: ${manifestPath}`);
  log('green', `      GeoJSON files: ${manifest.files.length}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(opts.output, 'manifest.json');

  if (opts.skipDownload && fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const missing = (existing.files || []).filter((file) => !fs.existsSync(file));
    if (existing.files && existing.files.length && missing.length === 0) {
      log('gray', '      Manifest exists, skipping download');
      return;
    }
    log('yellow', '      Manifest is stale, downloading again');
  }

  fs.mkdirSync(opts.output, { recursive: true });
  log('cyan', '      Fetching HDX package cod-ab-ukr');
  const body = await fetchBuffer(HDX_PACKAGE);
  const pkg = JSON.parse(body.toString('utf8'));
  if (!pkg.success) {
    throw new Error('HDX package_show failed');
  }
  const result = pkg.result;
  const resources = result.resources || [];
  const geojsonRes = pickResource(resources, 'geojson');
  const shpRes = pickResource(resources, 'shp');
  if (!geojsonRes && !shpRes) {
    throw new Error('HDX package has neither a GeoJSON nor a Shapefile resource');
  }

  const license = {
    id: result.license_id || 'cc-by-igo',
    title: result.license_title || 'Creative Commons Attribution for Intergovernmental Organisations (CC BY-IGO)',
    url: result.license_url || 'http://creativecommons.org/licenses/by/3.0/igo/legalcode',
    attribution: 'OCHA Field Information Services Section (FISS); State Scientific Production Enterprise "Kartographia"'
  };

  let chosenFiles = [];
  let sourceName = null;
  let sourceUrl = null;

  if (geojsonRes) {
    sourceName = geojsonRes.name;
    sourceUrl = resourceUrl(geojsonRes);
    const zipPath = path.join(opts.output, geojsonRes.name || 'ukr_admin_boundaries.geojson.zip');
    log('cyan', `      Downloading GeoJSON: ${sourceUrl}`);
    await downloadFile(sourceUrl, zipPath);
    const extracted = path.join(opts.output, 'extracted-geojson');
    log('cyan', '      Extracting GeoJSON bundle');
    extractZip(zipPath, extracted);
    const geojsonFiles = walk(extracted, ['.geojson', '.json']);
    log('cyan', `      Checking ${geojsonFiles.length} JSON file(s) for ADM4`);
    if (await filesContainAdm4(geojsonFiles)) {
      chosenFiles = selectBoundaryFiles(geojsonFiles);
    } else {
      log('yellow', '      GeoJSON bundle has no ADM4 settlements');
    }
  }

  if (chosenFiles.length === 0) {
    if (!shpRes) {
      throw new Error('GeoJSON bundle has no ADM4 and the package has no shapefile to fall back to');
    }
    sourceName = shpRes.name;
    sourceUrl = resourceUrl(shpRes);
    const zipPath = path.join(opts.output, shpRes.name || 'ukr_admin_boundaries.shp.zip');
    log('cyan', `      Downloading Shapefile: ${sourceUrl}`);
    await downloadFile(sourceUrl, zipPath);
    const extracted = path.join(opts.output, 'extracted-shp');
    log('cyan', '      Extracting Shapefile bundle');
    extractZip(zipPath, extracted);
    const shpFiles = walk(extracted, ['.shp']);
    if (shpFiles.length === 0) {
      throw new Error('Shapefile bundle contains no .shp files');
    }
    const convertedDir = path.join(opts.output, 'geojson-from-shp');
    chosenFiles = selectBoundaryFiles(convertShapefiles(shpFiles, convertedDir));
    log('cyan', '      Checking converted shapefile for ADM4');
    if (!(await filesContainAdm4(chosenFiles))) {
      throw new Error('Shapefile conversion produced no ADM4 settlements');
    }
  }

  writeManifest(manifestPath, {
    dataset: 'cod-ab-ukr',
    datasetTitle: result.title,
    sourceName,
    sourceUrl,
    license,
    downloadedAt: new Date().toISOString(),
    files: chosenFiles.map((file) => path.resolve(file))
  });
}

main().catch((err) => {
  log('red', `ERROR: ${err.message}`);
  process.exit(1);
});
