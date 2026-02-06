# OSM Administrative Boundaries to WOF

Tools for converting OpenStreetMap administrative boundaries to WOF SQLite format for Pelias.

## Files

### Standard Boundaries

- **`prepare-osm-boundaries.sh`** - Main script (Linux/macOS)
- **`prepare-osm-boundaries.ps1`** - Main script (Windows PowerShell)
- **`osm-to-wof-sqlite.js`** - Converts OSM to WOF SQLite

### Hierarchical Boundaries

- **`prepare-osm-hierarchical.sh`** - Hierarchical version (Linux/macOS)
- **`prepare-osm-hierarchical.ps1`** - Hierarchical version (Windows PowerShell)
- **`osm-to-wof-hierarchical.js`** - Converts OSM with hierarchy building

## Usage

### Standard Version

```bash
cd tools/osm
./prepare-osm-boundaries.sh
```

### Hierarchical Version

```bash
cd tools/osm
./prepare-osm-hierarchical.sh
```

## Data Source

OpenStreetMap administrative boundaries via Overpass API or PBF extracts.

## Output

- `whosonfirst-data-osm.db` - Standard version
- `whosonfirst-data-osm-hierarchical.db` - Hierarchical version

Both compatible with Pelias WOF admin lookup.

## License

Data: ODbL (OpenStreetMap)  
Scripts: MIT
