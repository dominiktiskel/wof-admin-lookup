# IGN Spain Administrative Boundaries to WOF

Tools for downloading and converting official Spanish IGN (Instituto Geográfico Nacional) administrative boundaries to WOF SQLite format for Pelias.

## Files

- **`prepare-ign-spain.sh`** - Main orchestration script (Linux/macOS)
- **`download-ign-spain.js`** - Downloads IGN data via OGC API-Features
- **`ign-to-wof-sqlite.js`** - Converts GeoJSON to WOF SQLite format

## Usage

### Linux/macOS

```bash
cd tools/ign-spain
./prepare-ign-spain.sh
```

## Data Sources

All data from Instituto Geográfico Nacional via https://api-features.ign.es/

- **Country** (1 feature) - España
- **Autonomous Communities** (19 features) - Comunidades Autónomas
- **Provinces** (52 features) - Provincias
- **Municipalities** (~8,124 features) - Municipios

**Total: ~8,196 features**

## INE Code Structure

- **Country**: Code '0' or 'ES'
- **Region**: 2-digit codes (01-19)
- **Localadmin**: 5-digit codes (PPMMM format)

## Output

`whosonfirst-data-ign-spain.db` - SQLite database compatible with Pelias WOF admin lookup

## License

Data: CC BY 4.0 (IGN)  
Scripts: MIT
