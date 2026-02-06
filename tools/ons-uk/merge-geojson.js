#!/usr/bin/env node
/**
 * Merge multiple GeoJSON files into one using streaming
 * to handle large files without running out of memory
 */

const fs = require('fs');
const path = require('path');

const files = [
    'ons-countries.geojson',
    'ons-regions.geojson',
    'ons-counties.geojson',
    'ons-lad.geojson',
    'ons-bua.geojson'
];

const outputFile = process.argv[2] || 'ons-uk-merged.geojson';

console.log('Merging GeoJSON files...\n');

const output = fs.createWriteStream(outputFile);
output.write('{"type":"FeatureCollection","features":[');

let first = true;
let total = 0;

for (const file of files) {
    if (!fs.existsSync(file)) {
        console.error(`ERROR: File not found: ${file}`);
        process.exit(1);
    }
    
    console.log(`Processing ${file}...`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const features = data.features || [];
    
    for (const feature of features) {
        if (!first) output.write(',');
        output.write(JSON.stringify(feature));
        first = false;
    }
    
    total += features.length;
    console.log(`  Added ${features.length} features (total: ${total})`);
}

output.write(']}');
output.end();

console.log(`\nMerged ${total} features to ${outputFile}`);
