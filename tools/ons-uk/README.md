# ONS UK Administrative Boundaries to WOF

Tools for downloading and converting official UK ONS (Office for National Statistics) administrative boundaries to WOF SQLite format for Pelias.

## Files

- **`prepare-ons-uk.sh`** - Main orchestration script (Linux/macOS)
- **`prepare-ons-uk.ps1`** - Main orchestration script (Windows PowerShell)
- **`download-ons-paginated.js`** - Downloads ONS data with pagination and retry logic
- **`ons-to-wof-sqlite.js`** - Converts GeoJSON to WOF SQLite format
- **`merge-geojson.js`** - Merges multiple GeoJSON files (utility)
- **`test-ons-api.ps1`** - API testing script

## Usage

### Linux/macOS

```bash
cd tools/ons-uk
./prepare-ons-uk.sh
```

### Windows

```powershell
cd tools\ons-uk
.\prepare-ons-uk.ps1
```

## Data Sources

- **Countries** (4 features) - E92 codes
- **Regions** (9 features) - England only, E12 codes
- **Counties** (218 features) - E10/E11 codes
- **Local Authority Districts** (361 features) - E06-E09, W06, S12, N09 codes
- **Built-up Areas** (8,545 features) - E63, W45, S45, K08 codes

**Total: ~9,137 features**

## Output

`whosonfirst-data-ons-uk.db` - SQLite database compatible with Pelias WOF admin lookup

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

## License

Data: Open Government Licence v3.0  
Scripts: MIT
