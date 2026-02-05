# ONS UK Boundaries Importer

Scripts to download and convert official UK administrative boundaries from ONS (Office for National Statistics) Open Geography Portal into WOF SQLite format for use with Pelias.

## Overview

This provides an alternative to the OSM-based WOF data generation for UK, offering:
- **~8000 locality boundaries** (Built-up Areas) vs. ~300 from OSM
- **Official government boundaries** with proper polygons
- **Complete UK coverage** including all admin levels

## Data Sources

All data is free under the UK Open Government Licence from [ONS Open Geography Portal](https://geoportal.statistics.gov.uk/):

| Dataset | Count | Maps to WOF placetype |
|---------|-------|----------------------|
| Countries (CTRY) | 4 | `country` |
| Regions (RGN) | ~13 | `region` |
| Counties (CTY/CTYUA) | ~50 | `county` |
| Local Authority Districts (LAD) | ~380 | `localadmin` |
| Built-up Areas (BUA) | ~8000 | `locality` |

**Note**: Built-up Areas (BUA) are settlements with populations > 5000, providing significantly better coverage than OSM `place=*` tags for UK geocoding.

## Files Created

### 1. `prepare-ons-uk.sh` (Linux/macOS)

Bash script that:
1. Downloads GeoJSON from ONS ArcGIS REST API endpoints
2. Merges all datasets into a single GeoJSON
3. Calls the Node.js converter

**Usage**:
```bash
cd wof-admin-lookup/tools

# Generate database in current directory
./prepare-ons-uk.sh

# Generate in specific directory
./prepare-ons-uk.sh -o /pelias/data/united-kingdom/whosonfirst/sqlite

# Skip download (use existing files)
./prepare-ons-uk.sh --skip-download
```

### 2. `prepare-ons-uk.ps1` (Windows)

PowerShell equivalent of the bash script.

**Usage**:
```powershell
cd wof-admin-lookup\tools

# Generate database in current directory
.\prepare-ons-uk.ps1

# Generate in specific directory
.\prepare-ons-uk.ps1 -OutputDir "C:\pelias\data\united-kingdom\whosonfirst\sqlite"

# Skip download
.\prepare-ons-uk.ps1 -SkipDownload
```

### 3. `ons-to-wof-sqlite.js`

Node.js converter that:
1. Reads merged GeoJSON
2. Maps ONS codes to WOF placetypes
3. Builds parent-child relationships using Point-in-Polygon
4. Generates WOF hierarchies
5. Writes to SQLite database compatible with Pelias PIP service

**Direct usage** (normally called by shell scripts):
```bash
node ons-to-wof-sqlite.js -i merged.geojson -o whosonfirst-data-ons-uk.db
```

## ONS Code Mapping

ONS uses alphanumeric codes to identify administrative areas. The converter maps these to WOF placetypes:

| ONS Code Prefix | Description | WOF Placetype |
|----------------|-------------|---------------|
| E92, W92, S92, N92 | Countries | `country` |
| E12, E13 | English Regions | `region` |
| E10, E11, W06 | Counties | `county` |
| E06, E07, E08, E09, S12, N09 | Local Authorities | `localadmin` |
| E34, W37, S02 | Built-up Areas | `locality` |

**WOF ID Generation**: ONS codes are hashed to numeric IDs starting with `8` (to avoid collision with OSM-generated IDs that start with `9`).

## Output

The scripts produce: `whosonfirst-data-ons-uk.db`

This SQLite database contains:
- `geojson` table: Full WOF GeoJSON records
- `spr` table: Spatial Properties (indexed for fast lookup)
- `ancestors` table: Parent-child relationships

## Installation

### Prerequisites

- **Node.js** (12+ with npm)
- **curl** or **wget** (for downloading, Linux/macOS)
- **PowerShell 5.1+** (Windows)

### Dependencies

The scripts will automatically install required npm packages:
```bash
cd wof-admin-lookup/tools
npm install
```

Dependencies:
- `better-sqlite3` - SQLite database access
- `@turf/area`, `@turf/helpers`, `@turf/boolean-point-in-polygon` - Geospatial operations
- `commander` - CLI argument parsing
- `cli-progress` - Progress bars

## Integration with Pelias

### Step 1: Generate the database

On your Linux server:
```bash
cd /pelias/wof-admin-lookup/tools
./prepare-ons-uk.sh -o /pelias/data/united-kingdom/whosonfirst/sqlite
```

This creates: `/pelias/data/united-kingdom/whosonfirst/sqlite/whosonfirst-data-ons-uk.db`

### Step 2: Verify the database

```bash
sqlite3 /pelias/data/united-kingdom/whosonfirst/sqlite/whosonfirst-data-ons-uk.db \
  "SELECT placetype, COUNT(*) FROM spr GROUP BY placetype;"
```

Expected output:
```
country|4
region|13
county|~50
localadmin|~380
locality|~8000
```

### Step 3: Configure Pelias

The WOF PIP service automatically loads all `.db` files from the WOF sqlite directory.

**Option A: Use alongside OSM data** (comparison)
- Keep both `whosonfirst-data-osm-full.db` and `whosonfirst-data-ons-uk.db`
- PIP service will use both databases

**Option B: Use only ONS data** (recommended for UK)
```bash
# Backup OSM database
mv /pelias/data/united-kingdom/whosonfirst/sqlite/whosonfirst-data-osm-full.db \
   /pelias/data/united-kingdom/whosonfirst/sqlite/whosonfirst-data-osm-full.db.backup
```

### Step 4: Restart import

```bash
cd /pelias/projects/united-kingdom
pelias import osm
```

The OSM importer will now use ONS boundaries for administrative hierarchy lookups, providing accurate `locality` values for geocoded addresses.

## Comparison: OSM vs ONS

| Aspect | OSM Script | ONS Script |
|--------|-----------|------------|
| Locality count | ~300 | ~8000 |
| Polygon quality | Mixed (some micro-polygons) | Official boundaries |
| Data source | Crowdsourced | Government official |
| Update frequency | Continuous | Annual |
| Coverage | Incomplete for UK | Complete UK |
| Accuracy | Variable | Authoritative |
| Best for | Global consistency | UK-specific accuracy |

## API Endpoints Used

All endpoints are from ONS Open Geography Portal (ArcGIS REST API):

- **Countries**: `Countries_December_2023_Boundaries_UK_BFC`
- **Regions**: `Regions_December_2023_Boundaries_EN_BFC`
- **Counties**: `Counties_and_Unitary_Authorities_December_2023_Boundaries_UK_BFC`
- **LAD**: `Local_Authority_Districts_May_2024_Boundaries_UK_BFC`
- **BUA**: `Built_Up_Areas_December_2022_Boundaries_GB_BFC`

*BFC = Best Fit to Coastline (clipped to high-water mark)*

## Troubleshooting

### "Node.js not found"

Install Node.js:
```bash
# Ubuntu/Debian
sudo apt install nodejs npm

# macOS
brew install node
```

### "curl/wget not found"

```bash
# Ubuntu/Debian
sudo apt install curl

# macOS (curl is preinstalled)
```

### "Failed to download"

- Check internet connectivity
- Verify ONS APIs are accessible: https://geoportal.statistics.gov.uk/
- Try with `--skip-download` if you've manually downloaded files

### Memory errors during conversion

The converter processes ~8500 features with full geometries. If you encounter memory errors:

```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=4096"
node ons-to-wof-sqlite.js -i merged.geojson -o output.db
```

## License

- **Scripts**: MIT License (same as Pelias)
- **ONS Data**: UK Open Government Licence v3.0

## Credits

Created as part of Pelias custom implementation for improved UK geocoding accuracy.

Based on the existing `osm-to-wof-hierarchical.js` converter pattern but adapted for ONS data structures.
