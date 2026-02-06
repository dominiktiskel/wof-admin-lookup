#!/bin/bash
# Script to download and convert IGN (Spain) administrative boundaries
# into WOF SQLite format
#
# Usage: ./prepare-ign-spain.sh [-o OUTPUT_DIR] [--skip-download]

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
    echo "  --skip-download    Skip downloading IGN data (use existing files)"
    echo "  -h, --help         Show this help message"
    echo ""
    echo "This script downloads official Spanish administrative boundaries from IGN"
    echo "(Instituto Geográfico Nacional) and converts them to WOF SQLite format."
    echo ""
    echo "Data sources (all under CC BY 4.0 license):"
    echo "  - Country (1 feature - Spain)"
    echo "  - Autonomous Communities (19 features)"
    echo "  - Provinces (52 features)"
    echo "  - Municipalities (~8,124 features)"
    echo ""
    echo "Requires: Node.js, download-ign-spain.js in same directory"
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
COUNTRY_FILE="${OUTPUT_DIR}/ign-country.geojson"
REGIONS_FILE="${OUTPUT_DIR}/ign-regions.geojson"
PROVINCES_FILE="${OUTPUT_DIR}/ign-provinces.geojson"
MUNICIPALITIES_FILE="${OUTPUT_DIR}/ign-municipalities.geojson"
SQLITE_FILE="${OUTPUT_DIR}/whosonfirst-data-ign-spain.db"

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN} IGN Spain Boundaries to WOF SQLite${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo -e "${BLUE}Output directory: ${NC}$OUTPUT_DIR"
echo ""

# Script directory (for finding download-ign-spain.js)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Step 1: Download IGN data
echo -e "${YELLOW}[1/3] Downloading IGN administrative boundaries...${NC}"

if [ "$SKIP_DOWNLOAD" = true ]; then
    echo -e "${GRAY}      Skipping download (--skip-download)${NC}"
else
    # Check if Node.js is available
    if ! command -v node &> /dev/null; then
        echo -e "${RED}      ERROR: Node.js not found!${NC}"
        echo -e "${YELLOW}      Install with: apt install nodejs (or yum/brew depending on OS)${NC}"
        exit 1
    fi
    
    # Check if download script exists
    DOWNLOAD_SCRIPT="$SCRIPT_DIR/download-ign-spain.js"
    if [ ! -f "$DOWNLOAD_SCRIPT" ]; then
        echo -e "${RED}      ERROR: download-ign-spain.js not found!${NC}"
        echo -e "${YELLOW}      Expected location: $DOWNLOAD_SCRIPT${NC}"
        exit 1
    fi
    
    echo -e "${GRAY}      Using OGC API-Features from IGN${NC}"
    echo -e "${GRAY}      API: https://api-features.ign.es/${NC}"
    echo ""
    
    # Download each administrative level
    echo -e "${CYAN}      [1/4] Country (Spain)...${NC}"
    if [ -f "$COUNTRY_FILE" ] && [ -s "$COUNTRY_FILE" ]; then
        echo -e "${GRAY}            File exists, skipping${NC}"
    else
        node "$DOWNLOAD_SCRIPT" country "$COUNTRY_FILE"
    fi
    
    echo -e "${CYAN}      [2/4] Autonomous Communities (19 features)...${NC}"
    if [ -f "$REGIONS_FILE" ] && [ -s "$REGIONS_FILE" ]; then
        echo -e "${GRAY}            File exists, skipping${NC}"
    else
        node "$DOWNLOAD_SCRIPT" regions "$REGIONS_FILE"
    fi
    
    echo -e "${CYAN}      [3/4] Provinces (52 features)...${NC}"
    if [ -f "$PROVINCES_FILE" ] && [ -s "$PROVINCES_FILE" ]; then
        echo -e "${GRAY}            File exists, skipping${NC}"
    else
        node "$DOWNLOAD_SCRIPT" provinces "$PROVINCES_FILE"
    fi
    
    echo -e "${CYAN}      [4/4] Municipalities (~8,124 features, may take 10-15 minutes)...${NC}"
    if [ -f "$MUNICIPALITIES_FILE" ] && [ -s "$MUNICIPALITIES_FILE" ]; then
        echo -e "${GRAY}            File exists, skipping${NC}"
    else
        node "$DOWNLOAD_SCRIPT" municipalities "$MUNICIPALITIES_FILE"
    fi
fi

# Step 2: Verify downloaded files
echo ""
echo -e "${YELLOW}[2/3] Verifying downloaded files...${NC}"

# Check if all source files exist
MISSING_FILES=false
for file in "$COUNTRY_FILE" "$REGIONS_FILE" "$PROVINCES_FILE" "$MUNICIPALITIES_FILE"; do
    if [ ! -f "$file" ]; then
        echo -e "${RED}      ERROR: Missing file: $file${NC}"
        MISSING_FILES=true
    elif [ ! -s "$file" ]; then
        echo -e "${RED}      ERROR: Empty file: $file${NC}"
        MISSING_FILES=true
    else
        SIZE=$(du -h "$file" | cut -f1)
        echo -e "${GREEN}      ✓ ${NC}$(basename $file) ($SIZE)"
    fi
done

if [ "$MISSING_FILES" = true ]; then
    echo -e "${RED}      Some files are missing. Run without --skip-download to download them.${NC}"
    exit 1
fi

# Step 3: Convert to WOF SQLite
echo ""
echo -e "${YELLOW}[3/3] Converting to WOF SQLite format...${NC}"

# Check if node_modules exists
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo -e "${GRAY}      Installing dependencies...${NC}"
    cd "$SCRIPT_DIR"
    npm install
    cd - > /dev/null
fi

# Run converter with multiple input files (no merge needed)
echo -e "${CYAN}      This may take 15-30 minutes - processing ~8,200 features...${NC}"

INPUT_FILES="${COUNTRY_FILE},${REGIONS_FILE},${PROVINCES_FILE},${MUNICIPALITIES_FILE}"

node "$SCRIPT_DIR/ign-to-wof-sqlite.js" \
    -i "$INPUT_FILES" \
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
echo -e "${GRAY}     cd /pelias/projects/spain${NC}"
echo -e "${GRAY}     pelias import osm${NC}"
echo ""
echo -e "${GREEN}This database provides ~8,200 Spanish admin boundaries!${NC}"
echo ""
