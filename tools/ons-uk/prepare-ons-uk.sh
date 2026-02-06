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
    echo "  - Regions (9 features - England only)"
    echo "  - Counties (218 features)"
    echo "  - Local Authority Districts (361 features)"
    echo "  - Built-up Areas (8545 features)"
    echo ""
    echo "Requires: Node.js, download-ons-paginated.js in same directory"
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
LONDON_FILE="${OUTPUT_DIR}/data/greater-london.geojson"
SQLITE_FILE="${OUTPUT_DIR}/whosonfirst-data-ons-uk.db"

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN} ONS UK Boundaries to WOF SQLite${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo -e "${BLUE}Output directory: ${NC}$OUTPUT_DIR"
echo ""

# Script directory (for finding download-ons-paginated.js)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Step 1: Download ONS data
echo -e "${YELLOW}[1/4] Downloading ONS administrative boundaries...${NC}"

if [ "$SKIP_DOWNLOAD" = true ]; then
    echo -e "${GRAY}      Skipping download (--skip-download)${NC}"
else
    # Check if Node.js is available
    if ! command -v node &> /dev/null; then
        echo -e "${RED}      ERROR: Node.js not found!${NC}"
        echo -e "${YELLOW}      Install with: apt install nodejs${NC}"
        exit 1
    fi
    
    # Check if download script exists
    DOWNLOAD_SCRIPT="$SCRIPT_DIR/download-ons-paginated.js"
    if [ ! -f "$DOWNLOAD_SCRIPT" ]; then
        echo -e "${RED}      ERROR: download-ons-paginated.js not found!${NC}"
        exit 1
    fi
    
    echo -e "${GRAY}      Using paginated download (reliable for large datasets)${NC}"
    echo ""
    
    # Download each dataset using pagination
    echo -e "${CYAN}      [1/5] Countries (4 features)...${NC}"
    if [ -f "$COUNTRIES_FILE" ] && [ -s "$COUNTRIES_FILE" ]; then
        echo -e "${GRAY}            File exists, skipping${NC}"
    else
        node "$DOWNLOAD_SCRIPT" countries "$COUNTRIES_FILE"
    fi
    
    echo -e "${CYAN}      [2/5] Regions (9 features - England only)...${NC}"
    if [ -f "$REGIONS_FILE" ] && [ -s "$REGIONS_FILE" ]; then
        echo -e "${GRAY}            File exists, skipping${NC}"
    else
        node "$DOWNLOAD_SCRIPT" regions "$REGIONS_FILE"
    fi
    
    echo -e "${CYAN}      [3/5] Counties (~218 features)...${NC}"
    if [ -f "$COUNTIES_FILE" ] && [ -s "$COUNTIES_FILE" ]; then
        echo -e "${GRAY}            File exists, skipping${NC}"
    else
        node "$DOWNLOAD_SCRIPT" counties "$COUNTIES_FILE"
    fi
    
    echo -e "${CYAN}      [4/5] Local Authority Districts (~361 features)...${NC}"
    if [ -f "$LAD_FILE" ] && [ -s "$LAD_FILE" ]; then
        echo -e "${GRAY}            File exists, skipping${NC}"
    else
        node "$DOWNLOAD_SCRIPT" lad "$LAD_FILE"
    fi
    
    echo -e "${CYAN}      [5/5] Built-up Areas (~8545 features, may take a while)...${NC}"
    if [ -f "$BUA_FILE" ] && [ -s "$BUA_FILE" ]; then
        echo -e "${GRAY}            File exists, skipping${NC}"
    else
        node "$DOWNLOAD_SCRIPT" bua "$BUA_FILE"
    fi
fi

# Step 2: Download Greater London boundary (for synthetic London locality)
echo ""
echo -e "${YELLOW}[2/4] Downloading Greater London boundary from OpenStreetMap...${NC}"

if [ "$SKIP_DOWNLOAD" = true ]; then
    echo -e "${GRAY}      Skipping download (--skip-download)${NC}"
else
    # Create data directory if it doesn't exist
    mkdir -p "${OUTPUT_DIR}/data"
    
    echo -e "${CYAN}      Greater London (OSM relation 175342)...${NC}"
    if [ -f "$LONDON_FILE" ] && [ -s "$LONDON_FILE" ]; then
        echo -e "${GRAY}            File exists, skipping${NC}"
    else
        # Download from Nominatim
        echo -e "${GRAY}            Downloading from Nominatim...${NC}"
        curl -sSL -o "$LONDON_FILE" \
            "https://nominatim.openstreetmap.org/details.php?osmtype=R&osmid=175342&polygon_geojson=1&format=json"
        
        # Verify download
        if [ -f "$LONDON_FILE" ] && [ -s "$LONDON_FILE" ]; then
            SIZE=$(du -h "$LONDON_FILE" | cut -f1)
            echo -e "${GREEN}            ✓ Downloaded successfully ($SIZE)${NC}"
        else
            echo -e "${RED}            ERROR: Download failed${NC}"
            exit 1
        fi
    fi
fi

# Step 3: Verify downloaded files
echo ""
echo -e "${YELLOW}[3/4] Verifying downloaded files...${NC}"

# Check if all source files exist
MISSING_FILES=false
for file in "$COUNTRIES_FILE" "$REGIONS_FILE" "$COUNTIES_FILE" "$LAD_FILE" "$BUA_FILE" "$LONDON_FILE"; do
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

# Step 4: Convert to WOF SQLite
echo ""
echo -e "${YELLOW}[4/4] Converting to WOF SQLite format...${NC}"

# Check if node_modules exists (in parent tools directory)
if [ ! -d "$SCRIPT_DIR/../node_modules" ]; then
    echo -e "${GRAY}      Installing dependencies...${NC}"
    cd "$SCRIPT_DIR/.."
    npm install
    cd - > /dev/null
fi

# Run converter with multiple input files (no merge needed)
echo -e "${CYAN}      This may take 10-20 minutes - processing ~9000 features...${NC}"

INPUT_FILES="${COUNTRIES_FILE},${REGIONS_FILE},${COUNTIES_FILE},${LAD_FILE},${BUA_FILE}"

node "$SCRIPT_DIR/ons-to-wof-sqlite.js" \
    -i "$INPUT_FILES" \
    -o "$SQLITE_FILE" \
    --london-geojson "$LONDON_FILE"

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
echo -e "${GREEN}This database provides ~9000 UK admin boundaries (incl. 8500+ localities)!${NC}"
echo ""
