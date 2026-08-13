# ONS UK Administrative Boundaries to WOF

Tools for downloading and converting official UK ONS (Office for National Statistics) administrative boundaries to WOF SQLite format for Pelias. Optionally augmented with an OSM-sourced `neighbourhood` layer (ONS has no neighbourhood-level dataset).

## Files

- **`prepare-ons-uk.sh`** - Main orchestration script (Linux/macOS)
- **`prepare-ons-uk.ps1`** - Main orchestration script (Windows PowerShell)
- **`extract-osm-neighbourhoods.sh`** - Extracts `place=suburb/neighbourhood/quarter` from OSM (optional neighbourhood layer)
- **`download-ons-paginated.js`** - Downloads ONS data with pagination and retry logic
- **`ons-to-wof-sqlite.js`** - Converts GeoJSON to WOF SQLite format
- **`merge-geojson.js`** - Merges multiple GeoJSON files (utility)
- **`pip-test-manchester.js`** - Verification: PiP test on known-problematic Greater Manchester addresses
- **`test-ons-api.ps1`** - API testing script

## Usage

### Linux/macOS

```bash
cd tools/ons-uk

# 1. (optional but recommended) build the OSM neighbourhood layer
#    downloads united-kingdom-latest.osm.pbf (~2.2 GB), requires osmium-tool + GDAL
./extract-osm-neighbourhoods.sh -o ./output

# 2. download ONS data and build the database
#    picks up output/osm-neighbourhoods.geojson automatically if present
./prepare-ons-uk.sh -o ./output
```

### Windows

```powershell
cd tools\ons-uk
.\prepare-ons-uk.ps1 -OutputDir .\output
```

## Data Sources

- **Countries** (4 features) - E92 codes
- **Regions** (9 features) - England only, E12 codes
- **Counties** (218 features) - E10 + unitary codes (unitary duplicates are removed during conversion)
- **Metropolitan Counties** (6 features) - E11 codes (Greater Manchester, Merseyside, South Yorkshire, West Midlands, West Yorkshire, Tyne and Wear)
- **Local Authority Districts** (361 features) - E06-E09, W06, S12, N09 codes
- **Built-up Areas** (8,545 features) - E63, W45, S45, K08 codes
- **OSM neighbourhoods** (~11,000 features, optional) - `place=suburb/neighbourhood/quarter`

## Output

`whosonfirst-data-ons-uk.db` - SQLite database compatible with Pelias WOF admin lookup

Expected placetype counts:

```
country          4
region           9
county          27
localadmin     361
locality      ~8500
neighbourhood ~10500   (only when OSM neighbourhoods are included)
macrocounty      1     (synthetic London, see below)
```

## Neighbourhood layer (OSM)

ONS publishes nothing below Built-up Areas, so neighbourhoods (Ordsall, Hulme, Soho, ...) are sourced from OSM:

- Features with real polygons (closed ways/relations) are used directly (`src:geom: 'osm'`).
- Point-only features (the majority in the UK) get an **approximate Voronoi polygon**: the Voronoi diagram of all place nodes within the containing Local Authority District, clipped to the LAD boundary, with real neighbourhood polygons cut out (`src:geom: 'osm-voronoi'`). This mirrors Nominatim's nearest-suburb behaviour.
- WOF IDs are prefixed with `7` (ONS uses `8`, the OSM tool uses `9`) to avoid collisions.
- Hierarchy building walks up through locality -> localadmin -> county -> region -> country, skipping levels that don't exist at a given location (e.g. no county in many areas), so every record has a complete `wof:hierarchy`.

## Special Handling: London

The ONS data contains 33 London Boroughs (E09 codes) but lacks a unified "Greater London" Built-up Area. To ensure Pelias returns "London" in the `locality` field for all London addresses (instead of individual borough names), the conversion process uses a **"ghost loader" technique**:

1. **Downloads Greater London boundary** - Fetches official boundary from OpenStreetMap (relation 175342)
2. **Creates synthetic "London" locality** - A special feature (WOF ID: 999999999) with geometry from OSM
3. **Uses dual placetype strategy**:
   - **SPR table**: `placetype = 'macrocounty'` - Ensures London is loaded into `wofData` by the macrocounty worker (which runs AFTER localadmin worker)
   - **GeoJSON body**: `wof:placetype = 'locality'` - Ensures hierarchy resolution treats it as a locality
4. **Links all London Boroughs to "London"** - Each borough's hierarchy includes `locality_id` pointing to the synthetic London
5. **Filters duplicate BUA** - Skips Built-up Area features that duplicate London Borough names

**How it works**:
- Search order: neighbourhood → borough → **locality** → **localadmin** → county → **macrocounty** → ...
- Point-in-Polygon lookup for a London address finds the borough in the `localadmin` layer → STOP
- Hierarchy resolution uses the borough's `locality_id` (999999999) to look up London from `wofData`
- London was loaded into `wofData` by the `macrocounty` worker (because SPR says `placetype='macrocounty'`)
- But `wofData` contains the GeoJSON body which says `wof:placetype='locality'`
- Result: Both borough (localadmin) and London (locality) are returned

**Result**: Places in London correctly show:
- `localadmin`: Borough name (e.g., "Kensington and Chelsea")
- `locality`: "London"

You can verify this with:
```bash
node verify-london-tables.js
```

## Verification

```bash
# PiP test on Greater Manchester addresses that used to resolve incorrectly
# (checks neighbourhood/locality/localadmin/county/region + hierarchy completeness)
node pip-test-manchester.js output/whosonfirst-data-ons-uk.db

# hierarchy completeness - should return 0
sqlite3 output/whosonfirst-data-ons-uk.db \
  "SELECT COUNT(*) FROM spr s WHERE s.placetype='locality' AND NOT EXISTS
   (SELECT 1 FROM ancestors a WHERE a.id=s.id AND a.ancestor_placetype='region');"
```

## Deployment (production common-mini / common-mini-2)

The admin hierarchy is baked into Elasticsearch documents **at import time**
(`imports.adminLookup.enabled` in `pelias.json`), so swapping the database
requires a full reimport:

1. Copy `whosonfirst-data-ons-uk.db` to `<DATA_DIR>/whosonfirst/sqlite/` on the server
   (e.g. `C:/data/pelias-common-mini-2/whosonfirst/sqlite/`).
2. **Remove the old UK database** from that directory (the legacy OSM-generated one with
   string IDs like `osm:locality:irlam`) - the PiP service loads *all* `.db` files it finds.
   Keep the other countries' databases (PL/DE/ES).
3. Recreate the index and reimport:
   ```bash
   cd docker/projects/common-mini-2
   docker compose run --rm schema ./bin/create_index
   docker compose run --rm openstreetmap ./bin/start
   ```
4. Verify: `locality_gid` in API responses must be numeric
   (`whosonfirst:locality:899743488`), not `osm:locality:*`. Reverse-geocode a few
   Manchester/Salford points and check `neighbourhood`, `locality`, `county`.

## License

Data: Open Government Licence v3.0 (ONS), ODbL (OSM neighbourhoods)  
Scripts: MIT
