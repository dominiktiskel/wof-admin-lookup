#!/bin/bash
# Script to download and convert ONS (Office for National Statistics) 
# administrative boundaries for UK into WOF SQLite format
#
# Usage: ./prepare-ons-uk.sh [-o OUTPUT_DIR] [--skip-download]

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

# Default values
OUTPUT_DIR="."
SKIP_DOWNLOAD=false

# Parse arguments
usage() {
    echo "Usage: $0 [-o OUTPUT_DIR] [--skip-download] [-h|--help]"
    echo ""
    echo "Options:"
    echo "  -o, --output       Output directory (default: current directory)"
    echo "  --skip-download    Skip downloading ONS data (use existing files)"
    echo "  -h, --help         Show this help message"
    echo ""
    echo "This script downloads official UK administrative boundaries from ONS"
    echo "Open Geography Portal and converts them to WOF SQLite format."
    echo ""
    echo "Data sources (all under Open Government Licence):"
    echo "  - Countries (4 features)"
    echo "  - Regions (~13 features)"
    echo "  - Counties (~50 features)"
    echo "  - Local Authority Districts (~380 features)"
    echo "  - Built-up Areas (~8000 features)"
    echo ""
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --skip-download)
            SKIP_DOWNLOAD=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            usage
            ;;
    esac
done

# Create output directory
mkdir -p "$OUTPUT_DIR"

# File paths
COUNTRIES_FILE="${OUTPUT_DIR}/ons-countries.geojson"
REGIONS_FILE="${OUTPUT_DIR}/ons-regions.geojson"
COUNTIES_FILE="${OUTPUT_DIR}/ons-counties.geojson"
LAD_FILE="${OUTPUT_DIR}/ons-lad.geojson"
BUA_FILE="${OUTPUT_DIR}/ons-bua.geojson"
MERGED_FILE="${OUTPUT_DIR}/ons-uk-merged.geojson"
SQLITE_FILE="${OUTPUT_DIR}/whosonfirst-data-ons-uk.db"

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN} ONS UK Boundaries to WOF SQLite${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo -e "${BLUE}Output directory: ${NC}$OUTPUT_DIR"
echo ""

# ONS API URLs (ArcGIS REST API endpoints)
# Using 2023/2024 boundaries with BFC (Best Fit Clipped to coastline)
COUNTRIES_URL="https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Countries_December_2023_Boundaries_UK_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson"
REGIONS_URL="https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Regions_December_2023_Boundaries_EN_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson"
COUNTIES_URL="https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Counties_and_Unitary_Authorities_December_2023_Boundaries_UK_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson"
LAD_URL="https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_May_2024_Boundaries_UK_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson"
BUA_URL="https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Built_Up_Areas_December_2022_Boundaries_GB_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson"

# Step 1: Download ONS data
echo -e "${YELLOW}[1/3] Downloading ONS administrative boundaries...${NC}"

if [ "$SKIP_DOWNLOAD" = true ]; then
    echo -e "${GRAY}      Skipping download (--skip-download)${NC}"
else
    # Check for curl or wget
    if command -v curl &> /dev/null; then
        # Use HTTP/1.1 to avoid HTTP/2 protocol errors with large files
        # Add retry logic and resume support for reliability
        DOWNLOAD_CMD="curl --http1.1 --retry 5 --retry-delay 5 --retry-all-errors -C - -L -o"
    elif command -v wget &> /dev/null; then
        # wget with retry and continue support
        DOWNLOAD_CMD="wget --tries=5 --wait=5 -c -O"
    else
        echo -e "${RED}      ERROR: curl or wget not found!${NC}"
        exit 1
    fi
    
    echo -e "${GRAY}      Using robust download with HTTP/1.1, retries and resume support${NC}"
    
    echo -e "${CYAN}      Downloading Countries (4 features)...${NC}"
    if [ -f "$COUNTRIES_FILE" ]; then
        echo -e "${GRAY}        File exists, skipping${NC}"
    else
        $DOWNLOAD_CMD "$COUNTRIES_FILE" "$COUNTRIES_URL"
        echo -e "${GREEN}        Downloaded: $COUNTRIES_FILE${NC}"
    fi
    
    echo -e "${CYAN}      Downloading Regions (~13 features)...${NC}"
    if [ -f "$REGIONS_FILE" ]; then
        echo -e "${GRAY}        File exists, skipping${NC}"
    else
        $DOWNLOAD_CMD "$REGIONS_FILE" "$REGIONS_URL"
        echo -e "${GREEN}        Downloaded: $REGIONS_FILE${NC}"
    fi
    
    echo -e "${CYAN}      Downloading Counties (~50 features)...${NC}"
    if [ -f "$COUNTIES_FILE" ]; then
        echo -e "${GRAY}        File exists, skipping${NC}"
    else
        $DOWNLOAD_CMD "$COUNTIES_FILE" "$COUNTIES_URL"
        echo -e "${GREEN}        Downloaded: $COUNTIES_FILE${NC}"
    fi
    
    echo -e "${CYAN}      Downloading Local Authority Districts (~380 features)...${NC}"
    if [ -f "$LAD_FILE" ]; then
        echo -e "${GRAY}        File exists, skipping${NC}"
    else
        $DOWNLOAD_CMD "$LAD_FILE" "$LAD_URL"
        echo -e "${GREEN}        Downloaded: $LAD_FILE${NC}"
    fi
    
    echo -e "${CYAN}      Downloading Built-up Areas (~8000 features, may take a while)...${NC}"
    if [ -f "$BUA_FILE" ]; then
        echo -e "${GRAY}        File exists, skipping${NC}"
    else
        $DOWNLOAD_CMD "$BUA_FILE" "$BUA_URL"
        echo -e "${GREEN}        Downloaded: $BUA_FILE${NC}"
    fi
fi

# Step 2: Merge GeoJSON files
echo ""
echo -e "${YELLOW}[2/3] Merging GeoJSON files...${NC}"

if [ -f "$MERGED_FILE" ]; then
    echo -e "${GRAY}      Removing existing merged file${NC}"
    rm -f "$MERGED_FILE"
fi

# Check if all source files exist
for file in "$COUNTRIES_FILE" "$REGIONS_FILE" "$COUNTIES_FILE" "$LAD_FILE" "$BUA_FILE"; do
    if [ ! -f "$file" ]; then
        echo -e "${RED}      ERROR: Missing file: $file${NC}"
        exit 1
    fi
done

# Merge using Node.js (jq would be alternative but Node is already required)
echo -e "${CYAN}      Merging 5 GeoJSON files...${NC}"

node -e "
const fs = require('fs');

const files = [
    '$COUNTRIES_FILE',
    '$REGIONS_FILE',
    '$COUNTIES_FILE',
    '$LAD_FILE',
    '$BUA_FILE'
];

const merged = {
    type: 'FeatureCollection',
    features: []
};

let totalFeatures = 0;

for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const features = data.features || [];
    merged.features.push(...features);
    console.log('  Loaded ' + file.split('/').pop() + ': ' + features.length + ' features');
    totalFeatures += features.length;
}

fs.writeFileSync('$MERGED_FILE', JSON.stringify(merged));
console.log('  Total features: ' + totalFeatures);
"

echo -e "${GREEN}      Created: $MERGED_FILE${NC}"

# Step 3: Convert to WOF SQLite
echo ""
echo -e "${YELLOW}[3/3] Converting to WOF SQLite format...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}      ERROR: Node.js not found!${NC}"
    echo -e "${YELLOW}      Install with: apt install nodejs${NC}"
    echo -e "${YELLOW}      Or: brew install node${NC}"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo -e "${GRAY}      Installing dependencies...${NC}"
    cd "$SCRIPT_DIR"
    npm install
    cd - > /dev/null
fi

# Run converter
echo -e "${CYAN}      This may take a while - processing ~8500 features...${NC}"

node "$SCRIPT_DIR/ons-to-wof-sqlite.js" \
    -i "$MERGED_FILE" \
    -o "$SQLITE_FILE"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} SUCCESS!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}Output file: $SQLITE_FILE${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo ""
echo -e "  ${BLUE}1. Copy database to WOF data directory:${NC}"
echo -e "${GRAY}     cp $SQLITE_FILE /data/whosonfirst/sqlite/${NC}"
echo ""
echo -e "  ${BLUE}2. Verify the database:${NC}"
echo -e "${GRAY}     sqlite3 $SQLITE_FILE \"SELECT placetype, COUNT(*) FROM spr GROUP BY placetype;\"${NC}"
echo ""
echo -e "  ${BLUE}3. Restart Pelias import:${NC}"
echo -e "${GRAY}     cd /pelias/projects/united-kingdom${NC}"
echo -e "${GRAY}     pelias import osm${NC}"
echo ""
echo -e "${GREEN}This database provides ~8000 proper locality boundaries!${NC}"
echo ""
