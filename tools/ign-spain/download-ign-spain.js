#!/usr/bin/env node
/**
 * Download Spanish IGN administrative boundaries using OGC API-Features
 * Usage: node download-ign-spain.js <level> <output-file>
 * 
 * Levels: country, regions, provinces, municipalities
 * 
 * Data source: Instituto Geográfico Nacional (IGN)
 * API: https://api-features.ign.es/
 * License: CC BY 4.0
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Ensure directory exists for output file
function ensureDirectoryExists(filePath) {
    const dir = path.dirname(filePath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Administrative level configurations
// Note: IGN API uses URLs for nationalLevel, so we filter on nationallevelname instead
const LEVELS = {
    country: {
        name: 'Spain (Country)',
        filter: null,  // Will download all and filter in post-processing
        nationallevelname: 'País',
        pageSize: 10
    },
    regions: {
        name: 'Comunidades Autónomas',
        filter: null,  // Will download all and filter in post-processing
        nationallevelname: 'Comunidad autónoma',
        pageSize: 50
    },
    provinces: {
        name: 'Provincias',
        filter: null,  // Will download all and filter in post-processing
        nationallevelname: 'Provincia',
        pageSize: 100
    },
    municipalities: {
        name: 'Municipios',
        filter: null,  // Will download all and filter in post-processing
        nationallevelname: 'Municipio',
        pageSize: 1000  // OGC API-Features typically supports up to 1000-10000
    }
};

// Base URL for IGN API-Features
const BASE_URL = 'https://api-features.ign.es/collections/administrativeunit/items';

// Colors for console output
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

// Fetch with timeout and retry
function fetchWithRetry(url, maxRetries = 5, timeout = 180000) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        
        function attempt() {
            attempts++;
            
            const req = https.get(url, { timeout }, (res) => {
                // Handle redirects
                if (res.statusCode === 301 || res.statusCode === 302) {
                    log('gray', `      Redirect to: ${res.headers.location}`);
                    https.get(res.headers.location, { timeout }, handleResponse);
                    return;
                }
                
                handleResponse(res);
            });
            
            function handleResponse(res) {
                if (res.statusCode === 504 || res.statusCode === 503 || res.statusCode === 502) {
                    if (attempts < maxRetries) {
                        const delay = Math.min(5000 * attempts, 30000);
                        log('yellow', `      Server error ${res.statusCode}, retry ${attempts}/${maxRetries} in ${delay/1000}s...`);
                        setTimeout(attempt, delay);
                        return;
                    }
                    reject(new Error(`Server error ${res.statusCode} after ${maxRetries} attempts`));
                    return;
                }
                
                if (res.statusCode !== 200) {
                    let errorData = '';
                    res.on('data', chunk => errorData += chunk);
                    res.on('end', () => {
                        reject(new Error(`HTTP ${res.statusCode}: ${errorData.substring(0, 200)}`));
                    });
                    return;
                }
                
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Invalid JSON: ${e.message}`));
                    }
                });
            }
            
            req.on('error', (err) => {
                if (attempts < maxRetries) {
                    const delay = Math.min(5000 * attempts, 30000);
                    log('yellow', `      Network error, retry ${attempts}/${maxRetries} in ${delay/1000}s...`);
                    setTimeout(attempt, delay);
                    return;
                }
                reject(err);
            });
            
            req.on('timeout', () => {
                req.destroy();
                if (attempts < maxRetries) {
                    log('yellow', `      Timeout, retry ${attempts}/${maxRetries}...`);
                    setTimeout(attempt, 5000);
                    return;
                }
                reject(new Error('Timeout after ' + maxRetries + ' attempts'));
            });
        }
        
        attempt();
    });
}

// Download a page using OGC API-Features standard pagination
async function downloadPage(offset, limit) {
    // OGC API-Features standard query parameters
    const params = new URLSearchParams({
        f: 'json',  // GeoJSON format
        limit: limit.toString(),
        offset: offset.toString()
    });
    
    const url = `${BASE_URL}?${params.toString()}`;
    return await fetchWithRetry(url);
}

// Get total count (if available)
async function getFeatureCount() {
    try {
        // Try to get count using resultType=hits
        const params = new URLSearchParams({
            resultType: 'hits',
            f: 'json'
        });
        
        const url = `${BASE_URL}?${params.toString()}`;
        log('gray', `    Fetching total feature count...`);
        const result = await fetchWithRetry(url);
        
        // OGC API-Features may return count in different ways
        if (result.numberMatched !== undefined) {
            return result.numberMatched;
        }
        if (result.totalFeatures !== undefined) {
            return result.totalFeatures;
        }
        
        // If count not available, return -1 to signal pagination until empty
        log('yellow', `    Warning: Count not available, will paginate until done`);
        return -1;
    } catch (err) {
        log('yellow', `    Could not get count (${err.message}), will paginate until done`);
        return -1;
    }
}

// Main download function with pagination
async function downloadLevel(levelKey, outputFile) {
    const level = LEVELS[levelKey];
    if (!level) {
        console.error(`Unknown level: ${levelKey}`);
        console.error(`Available: ${Object.keys(LEVELS).join(', ')}`);
        process.exit(1);
    }
    
    log('cyan', `\n  Downloading ${level.name} with pagination...`);
    
    const allFeatures = [];
    const pageSize = level.pageSize;
    const progressFile = outputFile + '.progress.json';
    
    log('gray', `    Downloading all features and filtering by: ${level.nationallevelname}`);
    
    let offset = 0;
    let totalDownloaded = 0;
    
    // Check for existing progress file
    if (fs.existsSync(progressFile)) {
        try {
            const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
            allFeatures.push(...progress.features);
            offset = progress.offset;
            log('yellow', `    Resuming from offset ${offset} (${allFeatures.length} filtered features loaded)`);
        } catch (e) {
            log('yellow', `    Could not resume, starting fresh`);
        }
    }
    
    let emptyPages = 0;
    const maxEmptyPages = 3;  // Stop after 3 consecutive empty pages
    
    while (true) {
        const pageNum = Math.floor(offset / pageSize) + 1;
        process.stdout.write(`${colors.gray}    Page ${pageNum} (offset ${offset})...${colors.reset}`);
        
        try {
            const page = await downloadPage(offset, pageSize);
            const features = page.features || [];
            
            // If we got no features
            if (features.length === 0) {
                emptyPages++;
                console.log(` ${colors.yellow}no features${colors.reset}`);
                
                if (emptyPages >= maxEmptyPages) {
                    log('green', `    No more features after ${maxEmptyPages} empty pages (done)`);
                    break;
                }
                
                // Continue to next page in case of gaps
                offset += pageSize;
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            
            // Reset empty page counter when we get features
            emptyPages = 0;
            totalDownloaded += features.length;
            
            // Filter features by nationallevelname
            const filteredFeatures = features.filter(f => {
                const props = f.properties || {};
                return props.nationallevelname === level.nationallevelname;
            });
            
            allFeatures.push(...filteredFeatures);
            
            console.log(` ${colors.green}${filteredFeatures.length}/${features.length} matched (total: ${allFeatures.length})${colors.reset}`);
            
            // Save progress after each page
            ensureDirectoryExists(progressFile);
            fs.writeFileSync(progressFile, JSON.stringify({
                offset: offset + pageSize,
                features: allFeatures
            }));
            
            offset += pageSize;
            
            // Small delay to be nice to the server
            await new Promise(r => setTimeout(r, 500));
            
            // Check if we got fewer features than requested (last page)
            if (features.length < pageSize) {
                log('green', `    Got ${features.length} < ${pageSize}, assuming last page`);
                break;
            }
            
        } catch (err) {
            log('red', ` ERROR: ${err.message}`);
            log('yellow', `    Progress saved. Run again to resume.`);
            process.exit(1);
        }
    }
    
    if (allFeatures.length === 0) {
        log('red', `    ERROR: No features downloaded!`);
        log('yellow', `    This might indicate the filter is incorrect or the API structure has changed.`);
        process.exit(1);
    }
    
    // Create final GeoJSON
    const geojson = {
        type: 'FeatureCollection',
        features: allFeatures
    };
    
    log('cyan', `    Writing ${allFeatures.length} features to ${outputFile}...`);
    ensureDirectoryExists(outputFile);
    fs.writeFileSync(outputFile, JSON.stringify(geojson, null, 2));
    log('green', `    File saved successfully (${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(2)} MB)`);
    
    // Clean up progress file
    if (fs.existsSync(progressFile)) {
        fs.unlinkSync(progressFile);
    }
    
    log('green', `    Done! Downloaded ${allFeatures.length} features.`);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 2) {
    console.log('Usage: node download-ign-spain.js <level> <output-file>');
    console.log('');
    console.log('Administrative Levels:');
    for (const [key, level] of Object.entries(LEVELS)) {
        console.log(`  ${key.padEnd(15)} - ${level.name}`);
    }
    console.log('');
    console.log('Example:');
    console.log('  node download-ign-spain.js municipalities ign-municipalities.geojson');
    console.log('');
    console.log('Data source: Instituto Geográfico Nacional (IGN)');
    console.log('License: CC BY 4.0');
    process.exit(1);
}

const [levelKey, outputFile] = args;

downloadLevel(levelKey, outputFile)
    .then(() => process.exit(0))
    .catch(err => {
        console.error(`\nFatal error: ${err.message}`);
        process.exit(1);
    });
