#!/bin/bash
# Bash script to prepare OSM boundaries for conversion
# Usage: ./prepare-osm-boundaries.sh -r dolnoslaskie [-c poland] [-o ./output]

set -e

# Kolory
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

# Domyślne wartości
COUNTRY="poland"
OUTPUT_DIR="."
SKIP_DOWNLOAD=false
SKIP_CONVERT=false

# Parsowanie argumentów
usage() {
    echo "Usage: $0 -r REGION [-c COUNTRY] [-o OUTPUT_DIR] [--skip-download] [--skip-convert]"
    echo ""
    echo "Options:"
    echo "  -r, --region       Region name (e.g., dolnoslaskie) [required]"
    echo "  -c, --country      Country name (default: poland)"
    echo "  -o, --output       Output directory (default: current directory)"
    echo "  --skip-download    Skip downloading OSM data"
    echo "  --skip-convert     Skip GeoJSON conversion"
    echo "  -h, --help         Show this help message"
    echo ""
    echo "Example:"
    echo "  $0 -r dolnoslaskie"
    echo "  $0 -r mazowieckie -c poland -o /tmp/boundaries"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -r|--region)
            REGION="$2"
            shift 2
            ;;
        -c|--country)
            COUNTRY="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --skip-download)
            SKIP_DOWNLOAD=true
            shift
            ;;
        --skip-convert)
            SKIP_CONVERT=true
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

# Sprawdź czy region jest podany
if [ -z "$REGION" ]; then
    echo -e "${RED}Error: Region is required${NC}"
    usage
fi

# Konfiguracja
GEOFABRIK_BASE="http://download.geofabrik.de/europe"
PBF_URL="${GEOFABRIK_BASE}/${COUNTRY}/${REGION}-latest.osm.pbf"
PBF_FILE="${OUTPUT_DIR}/${REGION}-latest.osm.pbf"
BOUNDARIES_PBF="${OUTPUT_DIR}/${REGION}-admin-boundaries.osm.pbf"
GEOJSON_FILE="${OUTPUT_DIR}/${REGION}-boundaries.geojson"
SQLITE_FILE="${OUTPUT_DIR}/whosonfirst-data-osm-admin-${REGION}.db"

# Utwórz katalog wyjściowy
mkdir -p "$OUTPUT_DIR"

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN} OSM Boundaries Preparation Script${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo -e "${BLUE}Region:  ${NC}$REGION"
echo -e "${BLUE}Country: ${NC}$COUNTRY"
echo -e "${BLUE}Output:  ${NC}$OUTPUT_DIR"
echo ""

# Krok 1: Pobierz dane OSM
echo -e "${YELLOW}[1/4] Downloading OSM data...${NC}"

if [ "$SKIP_DOWNLOAD" = true ]; then
    echo -e "${GRAY}      Skipping download (--skip-download)${NC}"
elif [ -f "$PBF_FILE" ]; then
    echo -e "${GRAY}      File exists, skipping download${NC}"
else
    echo -e "${GRAY}      URL: $PBF_URL${NC}"
    
    if command -v wget &> /dev/null; then
        wget -O "$PBF_FILE" "$PBF_URL"
    elif command -v curl &> /dev/null; then
        curl -L -o "$PBF_FILE" "$PBF_URL"
    else
        echo -e "${RED}      ERROR: wget or curl not found!${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}      Downloaded: $PBF_FILE${NC}"
fi

# Krok 2: Filtruj granice administracyjne
echo ""
echo -e "${YELLOW}[2/4] Filtering administrative boundaries...${NC}"

if ! command -v osmium &> /dev/null; then
    echo -e "${RED}      ERROR: osmium-tool not found!${NC}"
    echo -e "${YELLOW}      Install with: apt install osmium-tool${NC}"
    echo -e "${YELLOW}      Or: brew install osmium-tool${NC}"
    echo ""
    echo -e "${CYAN}      Alternative: Use Overpass Turbo to export GeoJSON directly${NC}"
    echo -e "${CYAN}      https://overpass-turbo.eu/${NC}"
    exit 1
fi

if [ -f "$BOUNDARIES_PBF" ]; then
    echo -e "${GRAY}      File exists, skipping filter${NC}"
else
    osmium tags-filter "$PBF_FILE" r/boundary=administrative -o "$BOUNDARIES_PBF" --overwrite
    echo -e "${GREEN}      Filtered: $BOUNDARIES_PBF${NC}"
fi

# Krok 3: Konwertuj do GeoJSON
echo ""
echo -e "${YELLOW}[3/4] Converting to GeoJSON...${NC}"

if ! command -v ogr2ogr &> /dev/null; then
    echo -e "${RED}      ERROR: ogr2ogr (GDAL) not found!${NC}"
    echo -e "${YELLOW}      Install with: apt install gdal-bin${NC}"
    echo -e "${YELLOW}      Or: brew install gdal${NC}"
    exit 1
fi

if [ "$SKIP_CONVERT" = true ]; then
    echo -e "${GRAY}      Skipping conversion (--skip-convert)${NC}"
elif [ -f "$GEOJSON_FILE" ]; then
    echo -e "${GRAY}      File exists, skipping conversion${NC}"
else
    ogr2ogr -f GeoJSON \
        "$GEOJSON_FILE" \
        "$BOUNDARIES_PBF" \
        multipolygons
    
    SIZE=$(du -h "$GEOJSON_FILE" | cut -f1)
    echo -e "${GREEN}      Created: $GEOJSON_FILE ($SIZE)${NC}"
fi

# Krok 4: Konwertuj do WOF SQLite
echo ""
echo -e "${YELLOW}[4/4] Converting to WOF SQLite format...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Sprawdź czy node jest zainstalowany
if ! command -v node &> /dev/null; then
    echo -e "${RED}      ERROR: Node.js not found!${NC}"
    echo -e "${YELLOW}      Install with: apt install nodejs${NC}"
    echo -e "${YELLOW}      Or: brew install node${NC}"
    exit 1
fi

# Sprawdź czy node_modules istnieje
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo -e "${GRAY}      Installing dependencies...${NC}"
    cd "$SCRIPT_DIR"
    npm install
    cd - > /dev/null
fi

# Uruchom konwersję
node "$SCRIPT_DIR/osm-to-wof-sqlite.js" \
    -i "$GEOJSON_FILE" \
    -o "$SQLITE_FILE" \
    --country PL

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} SUCCESS!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}Output file: $SQLITE_FILE${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo -e "  1. Copy to WOF data directory:"
echo -e "${GRAY}     cp $SQLITE_FILE \${DATA_DIR}/whosonfirst/sqlite/${NC}"
echo ""
echo -e "  2. Restart PIP service:"
echo -e "${GRAY}     docker compose restart pip${NC}"
echo ""
echo -e "  3. Reimport OSM data:"
echo -e "${GRAY}     docker compose run --rm openstreetmap ./bin/start${NC}"
echo ""

