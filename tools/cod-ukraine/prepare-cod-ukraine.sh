#!/bin/bash
# Download Ukraine COD-AB boundaries and convert them to a Pelias WOF SQLite database.
#
# Usage: ./prepare-cod-ukraine.sh [-o OUTPUT_DIR] [--skip-download]

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

OUTPUT_DIR=""
SKIP_DOWNLOAD=false

usage() {
    echo "Usage: $0 [-o OUTPUT_DIR] [--skip-download]"
    echo ""
    echo "Options:"
    echo "  -o, --output       Output directory (default: ./output next to this script)"
    echo "  --skip-download    Reuse an existing manifest.json and GeoJSON files"
    echo "  -h, --help         Show this help message"
    echo ""
    echo "Downloads OCHA COD-AB Ukraine (CC BY-IGO) and writes whosonfirst-data-cod-ua.db."
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$OUTPUT_DIR" ]; then
    OUTPUT_DIR="${SCRIPT_DIR}/output"
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

SQLITE_FILE="${OUTPUT_DIR}/whosonfirst-data-cod-ua.db"
MANIFEST_FILE="${OUTPUT_DIR}/manifest.json"

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN} Ukraine COD-AB to WOF SQLite${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo -e "${BLUE}Output directory: ${NC}$OUTPUT_DIR"
echo ""

if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}ERROR: Node.js not found${NC}"
    exit 1
fi

echo -e "${YELLOW}[1/2] Downloading COD-AB from HDX...${NC}"
DOWNLOAD_ARGS=(-o "$OUTPUT_DIR")
if [ "$SKIP_DOWNLOAD" = true ]; then
    DOWNLOAD_ARGS+=(--skip-download)
fi
node "$SCRIPT_DIR/download-cod-ukraine.js" "${DOWNLOAD_ARGS[@]}"

if [ ! -s "$MANIFEST_FILE" ]; then
    echo -e "${RED}ERROR: manifest.json was not written${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}[2/2] Converting to WOF SQLite...${NC}"

if [ ! -d "$SCRIPT_DIR/../node_modules" ]; then
    echo -e "${GRAY}      Installing tools dependencies...${NC}"
    (cd "$SCRIPT_DIR/.." && npm install)
fi

node "$SCRIPT_DIR/cod-to-wof-sqlite.js" \
    -i "$MANIFEST_FILE" \
    -o "$SQLITE_FILE"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} SUCCESS${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}Output file: $SQLITE_FILE${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo -e "  ${BLUE}1. Copy the database into the WOF sqlite directory:${NC}"
echo -e "${GRAY}     cp $SQLITE_FILE \${DATA_DIR}/whosonfirst/sqlite/${NC}"
echo ""
echo -e "  ${BLUE}2. Check counts:${NC}"
echo -e "${GRAY}     sqlite3 $SQLITE_FILE \"SELECT placetype, COUNT(*) FROM spr GROUP BY placetype;\"${NC}"
echo ""
echo -e "${GREEN}ADM4 localities are settlement footprints. An address outside the footprint stays on the hromada.${NC}"
echo ""
