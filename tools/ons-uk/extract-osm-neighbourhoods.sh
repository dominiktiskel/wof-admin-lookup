#!/bin/bash
# Extract UK neighbourhoods (place=suburb/neighbourhood/quarter) from OpenStreetMap
# into a GeoJSON consumable by ons-to-wof-sqlite.js (--osm-neighbourhoods).
#
# ONS has no neighbourhood-level dataset, so the neighbourhood layer
# (Ordsall, Hulme, ...) is sourced from OSM. Polygons are used directly;
# point-only places get approximate Voronoi polygons in the converter.
#
# Usage: ./extract-osm-neighbourhoods.sh [-o OUTPUT_DIR] [--skip-download]

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

OUTPUT_DIR="./output"
SKIP_DOWNLOAD=false
PBF_URL="http://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf"

usage() {
    echo "Usage: $0 [-o OUTPUT_DIR] [--skip-download] [-h|--help]"
    echo ""
    echo "Options:"
    echo "  -o, --output       Output directory (default: ./output)"
    echo "  --skip-download    Skip downloading OSM data (use existing PBF)"
    echo "  -h, --help         Show this help message"
    echo ""
    echo "Produces: OUTPUT_DIR/osm-neighbourhoods.geojson"
    echo "Requires: osmium-tool, GDAL (ogr2ogr), Node.js"
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

mkdir -p "$OUTPUT_DIR"

PBF_FILE="${OUTPUT_DIR}/united-kingdom-latest.osm.pbf"
FILTERED_PBF="${OUTPUT_DIR}/uk-neighbourhoods.osm.pbf"
GEOJSON_POLYGONS="${OUTPUT_DIR}/uk-neighbourhoods-polygons.geojson"
GEOJSON_POINTS="${OUTPUT_DIR}/uk-neighbourhoods-points.geojson"
GEOJSON_FILE="${OUTPUT_DIR}/osm-neighbourhoods.geojson"

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN} OSM UK Neighbourhoods Extraction${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Check required tools
for tool in osmium ogr2ogr node; do
    if ! command -v $tool &> /dev/null; then
        echo -e "${RED}ERROR: $tool not found!${NC}"
        echo -e "${YELLOW}Install with: brew install osmium-tool gdal node (macOS)${NC}"
        echo -e "${YELLOW}          or: apt install osmium-tool gdal-bin nodejs (Debian/Ubuntu)${NC}"
        exit 1
    fi
done

# Step 1: Download UK PBF
echo -e "${YELLOW}[1/3] Downloading OSM data...${NC}"

if [ "$SKIP_DOWNLOAD" = true ]; then
    echo -e "${GRAY}      Skipping download (--skip-download)${NC}"
elif [ -f "$PBF_FILE" ]; then
    echo -e "${GRAY}      File exists, skipping download${NC}"
else
    echo -e "${GRAY}      URL: $PBF_URL${NC}"
    curl -L -o "${PBF_FILE}.tmp" "$PBF_URL"
    mv "${PBF_FILE}.tmp" "$PBF_FILE"
    echo -e "${GREEN}      Downloaded: $PBF_FILE${NC}"
fi

if [ ! -f "$PBF_FILE" ]; then
    echo -e "${RED}ERROR: PBF file not found: $PBF_FILE${NC}"
    exit 1
fi

# Step 2: Filter neighbourhood-level places
echo ""
echo -e "${YELLOW}[2/3] Filtering place=suburb,neighbourhood,quarter...${NC}"

if [ -f "$FILTERED_PBF" ]; then
    echo -e "${GRAY}      File exists, skipping filter${NC}"
else
    # tmp + mv so a crashed osmium run doesn't leave a partial file
    # that the next run would skip over
    osmium tags-filter "$PBF_FILE" \
        nwr/place=suburb,neighbourhood,quarter \
        -o "${FILTERED_PBF}.tmp.osm.pbf" --overwrite
    mv "${FILTERED_PBF}.tmp.osm.pbf" "$FILTERED_PBF"
    echo -e "${GREEN}      Filtered: $FILTERED_PBF${NC}"
fi

# Step 3: Convert to GeoJSON (polygons + points) and merge
echo ""
echo -e "${YELLOW}[3/3] Converting to GeoJSON...${NC}"

if [ -f "$GEOJSON_FILE" ]; then
    echo -e "${GRAY}      File exists, skipping conversion${NC}"
else
    echo -e "${CYAN}      Converting polygons (closed ways / relations)...${NC}"
    ogr2ogr -f GeoJSON "$GEOJSON_POLYGONS" "$FILTERED_PBF" multipolygons 2>/dev/null || true

    echo -e "${CYAN}      Converting points (place nodes)...${NC}"
    ogr2ogr -f GeoJSON "$GEOJSON_POINTS" "$FILTERED_PBF" points 2>/dev/null || true

    echo -e "${CYAN}      Merging polygons and points...${NC}"
    node -e "
    const fs = require('fs');
    const load = (f) => {
        try { return JSON.parse(fs.readFileSync(f, 'utf8')).features || []; }
        catch (e) { return []; }
    };
    const polygons = load('$GEOJSON_POLYGONS');
    const points = load('$GEOJSON_POINTS');
    const merged = { type: 'FeatureCollection', features: [...polygons, ...points] };
    fs.writeFileSync('$GEOJSON_FILE', JSON.stringify(merged));
    console.log('      Merged: ' + polygons.length + ' polygons + ' + points.length + ' points');
    "

    rm -f "$GEOJSON_POLYGONS" "$GEOJSON_POINTS"

    FEATURE_COUNT=$(node -e "const g=JSON.parse(require('fs').readFileSync('$GEOJSON_FILE','utf8')); console.log((g.features||[]).length)")
    if [ "$FEATURE_COUNT" -eq 0 ]; then
        rm -f "$GEOJSON_FILE"
        echo -e "${RED}      ERROR: GeoJSON contains 0 features!${NC}"
        echo -e "${YELLOW}      The filtered PBF is likely corrupted. Delete it and re-run:${NC}"
        echo -e "${YELLOW}      rm \"$FILTERED_PBF\"${NC}"
        exit 1
    fi

    SIZE=$(du -h "$GEOJSON_FILE" | cut -f1)
    echo -e "${GREEN}      Created: $GEOJSON_FILE ($SIZE, $FEATURE_COUNT features)${NC}"
fi

echo ""
echo -e "${GREEN}Done. Next step: run ./prepare-ons-uk.sh - it picks up${NC}"
echo -e "${GREEN}$GEOJSON_FILE automatically (--osm-neighbourhoods).${NC}"
echo ""
