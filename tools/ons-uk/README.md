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

## License

Data: Open Government Licence v3.0  
Scripts: MIT
