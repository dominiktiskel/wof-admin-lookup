#!/usr/bin/env node
/**
 * Download large ONS datasets using pagination to avoid timeouts
 * Usage: node download-ons-paginated.js <dataset> <output-file>
 * 
 * Datasets: countries, regions, counties, lad, bua
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Dataset configurations
const DATASETS = {
    countries: {
        name: 'Countries',
        url: 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Countries_December_2023_Boundaries_UK_BFC/FeatureServer/0/query',
        pageSize: 10
    },
    regions: {
        name: 'Regions', 
        url: 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Regions_December_2023_Boundaries_EN_BFC/FeatureServer/0/query',
        pageSize: 10
    },
    counties: {
        name: 'Counties',
        url: 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Counties_and_Unitary_Authorities_December_2023_Boundaries_UK_BFC/FeatureServer/0/query',
        pageSize: 10  // Small pages for complex geometries
    },
    lad: {
        name: 'Local Authority Districts',
        url: 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_May_2024_Boundaries_UK_BFC/FeatureServer/0/query',
        pageSize: 20
    },
    bua: {
        name: 'Built-up Areas',
        url: 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/BUA_2022_GB/FeatureServer/0/query',
        pageSize: 500  // Server supports up to 1000, using 500 for reliability
    }
};

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
function fetchWithRetry(url, maxRetries = 5, timeout = 120000) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        
        function attempt() {
            attempts++;
            
            const req = https.get(url, { timeout }, (res) => {
                if (res.statusCode === 504 || res.statusCode === 503 || res.statusCode === 502) {
                    if (attempts < maxRetries) {
                        log('yellow', `      Server error ${res.statusCode}, retry ${attempts}/${maxRetries}...`);
                        setTimeout(attempt, 5000);
                        return;
                    }
                    reject(new Error(`Server error ${res.statusCode} after ${maxRetries} attempts`));
                    return;
                }
                
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
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
            });
            
            req.on('error', (err) => {
                if (attempts < maxRetries) {
                    log('yellow', `      Network error, retry ${attempts}/${maxRetries}...`);
                    setTimeout(attempt, 5000);
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

// Get total feature count
async function getFeatureCount(baseUrl) {
    const url = `${baseUrl}?where=1%3D1&returnCountOnly=true&f=json`;
    log('gray', `    Fetching feature count...`);
    const result = await fetchWithRetry(url);
    
    // Handle different response formats
    if (result.count !== undefined) {
        return result.count;
    }
    if (result.properties && result.properties.count !== undefined) {
        return result.properties.count;
    }
    
    // If count not available, return -1 to signal pagination until empty
    log('yellow', `    Warning: Count not available, will paginate until empty page`);
    return -1;
}

// Download a single page of features (offset-based)
async function downloadPage(baseUrl, offset, pageSize) {
    const url = `${baseUrl}?outFields=*&where=1%3D1&f=geojson&resultOffset=${offset}&resultRecordCount=${pageSize}`;
    return await fetchWithRetry(url);
}

// Download features using objectId range (for services that don't support offset)
async function downloadByObjectId(baseUrl, minId, maxId) {
    const where = encodeURIComponent(`OBJECTID>=${minId} AND OBJECTID<=${maxId}`);
    const url = `${baseUrl}?outFields=*&where=${where}&f=geojson`;
    return await fetchWithRetry(url);
}

// Get objectId range for a layer
async function getObjectIdRange(baseUrl) {
    // Get min and max objectIds
    const statsUrl = `${baseUrl}?where=1%3D1&returnIdsOnly=true&f=json`;
    log('gray', `    Fetching objectId range...`);
    const result = await fetchWithRetry(statsUrl);
    
    if (result.objectIds && result.objectIds.length > 0) {
        const ids = result.objectIds.sort((a, b) => a - b);
        return { min: ids[0], max: ids[ids.length - 1], count: ids.length };
    }
    return null;
}

// Main download function with pagination
async function downloadDataset(datasetKey, outputFile) {
    const dataset = DATASETS[datasetKey];
    if (!dataset) {
        console.error(`Unknown dataset: ${datasetKey}`);
        console.error(`Available: ${Object.keys(DATASETS).join(', ')}`);
        process.exit(1);
    }
    
    log('cyan', `\n  Downloading ${dataset.name} with pagination...`);
    
    const allFeatures = [];
    const pageSize = dataset.pageSize;
    const progressFile = outputFile + '.progress.json';
    
    // Use objectId-based pagination for services that don't support offset
    if (dataset.useObjectIdPagination) {
        const idRange = await getObjectIdRange(dataset.url);
        if (!idRange) {
            log('red', `    Could not get objectId range`);
            process.exit(1);
        }
        
        log('green', `    Total features: ${idRange.count} (IDs: ${idRange.min} to ${idRange.max})`);
        
        let currentId = idRange.min;
        
        // Check for existing progress
        if (fs.existsSync(progressFile)) {
            try {
                const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
                allFeatures.push(...progress.features);
                currentId = progress.currentId;
                log('yellow', `    Resuming from ID ${currentId} (${allFeatures.length} features loaded)`);
            } catch (e) {
                log('yellow', `    Could not resume, starting fresh`);
            }
        }
        
        while (currentId <= idRange.max) {
            const maxId = Math.min(currentId + pageSize - 1, idRange.max);
            const pageNum = Math.floor((currentId - idRange.min) / pageSize) + 1;
            const totalPages = Math.ceil((idRange.max - idRange.min + 1) / pageSize);
            
            process.stdout.write(`${colors.gray}    Page ${pageNum}/${totalPages} (IDs ${currentId}-${maxId})...${colors.reset}`);
            
            try {
                const page = await downloadByObjectId(dataset.url, currentId, maxId);
                const features = page.features || [];
                allFeatures.push(...features);
                
                console.log(` ${colors.green}${features.length} features (total: ${allFeatures.length})${colors.reset}`);
                
                // Save progress
                fs.writeFileSync(progressFile, JSON.stringify({
                    currentId: maxId + 1,
                    features: allFeatures
                }));
                
                currentId = maxId + 1;
                await new Promise(r => setTimeout(r, 300));
                
            } catch (err) {
                log('red', ` ERROR: ${err.message}`);
                log('yellow', `    Progress saved. Run again to resume.`);
                process.exit(1);
            }
        }
    } else {
        // Standard offset-based pagination
        const totalCount = await getFeatureCount(dataset.url);
        const unknownTotal = totalCount === -1;
        
        if (unknownTotal) {
            log('yellow', `    Total features: unknown (will paginate until done)`);
        } else {
            log('green', `    Total features: ${totalCount}`);
        }
        
        let offset = 0;
        
        // Check for existing progress file
        if (fs.existsSync(progressFile)) {
            try {
                const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
                allFeatures.push(...progress.features);
                offset = progress.offset;
                log('yellow', `    Resuming from offset ${offset} (${allFeatures.length} features loaded)`);
            } catch (e) {
                log('yellow', `    Could not resume, starting fresh`);
            }
        }
        
        while (unknownTotal || offset < totalCount) {
            const pageNum = Math.floor(offset / pageSize) + 1;
            const totalPages = unknownTotal ? '?' : Math.ceil(totalCount / pageSize);
            process.stdout.write(`${colors.gray}    Page ${pageNum}/${totalPages} (offset ${offset})...${colors.reset}`);
            
            try {
                const page = await downloadPage(dataset.url, offset, pageSize);
                const features = page.features || [];
                
                // If we got no features and total is unknown, we're done
                if (features.length === 0) {
                    console.log(` ${colors.green}no more features (done)${colors.reset}`);
                    break;
                }
                
                allFeatures.push(...features);
                
                console.log(` ${colors.green}${features.length} features (total: ${allFeatures.length})${colors.reset}`);
                
                // Save progress after each page
                fs.writeFileSync(progressFile, JSON.stringify({
                    offset: offset + pageSize,
                    features: allFeatures
                }));
                
                offset += pageSize;
                
                // Small delay to be nice to the server
                await new Promise(r => setTimeout(r, 500));
                
            } catch (err) {
                log('red', ` ERROR: ${err.message}`);
                log('yellow', `    Progress saved. Run again to resume.`);
                process.exit(1);
            }
        }
    }
    
    // Create final GeoJSON
    const geojson = {
        type: 'FeatureCollection',
        features: allFeatures
    };
    
    log('cyan', `    Writing ${allFeatures.length} features to ${outputFile}...`);
    fs.writeFileSync(outputFile, JSON.stringify(geojson));
    
    // Clean up progress file
    if (fs.existsSync(progressFile)) {
        fs.unlinkSync(progressFile);
    }
    
    log('green', `    Done! Downloaded ${allFeatures.length} features.`);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 2) {
    console.log('Usage: node download-ons-paginated.js <dataset> <output-file>');
    console.log('');
    console.log('Datasets:');
    for (const [key, ds] of Object.entries(DATASETS)) {
        console.log(`  ${key.padEnd(12)} - ${ds.name}`);
    }
    console.log('');
    console.log('Example:');
    console.log('  node download-ons-paginated.js counties ons-counties.geojson');
    process.exit(1);
}

const [datasetKey, outputFile] = args;

downloadDataset(datasetKey, outputFile)
    .then(() => process.exit(0))
    .catch(err => {
        console.error(`\nFatal error: ${err.message}`);
        process.exit(1);
    });
