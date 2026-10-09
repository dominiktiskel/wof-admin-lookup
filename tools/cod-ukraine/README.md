# Ukraine COD-AB to WOF

Downloads [OCHA COD-AB Ukraine](https://data.humdata.org/dataset/cod-ab-ukr) and converts it to a Pelias WOF SQLite database.

Pelias point-in-polygon ignores `Point` geometries. Official Who's On First localities for Ukraine are mostly points, and OSM has no nationwide village polygons. COD-AB is a polygon set:

| WOF placetype | COD level | Expected count | Geometry |
|---|---|---:|---|
| `country` | ADM0, or the union of ADM1 | 1 | polygon |
| `region` | ADM1 oblast, Crimea, Kyiv, Sevastopol | 27 | polygon |
| `county` | ADM2 raion (2020 reform) | 139 | polygon |
| `localadmin` | ADM3 hromada | 1769 | polygon |
| `locality` | ADM4 settlement | about 29706 | built-up footprint, not the cadastral boundary |

An address inside a settlement footprint gets that settlement. An address outside the footprint keeps the hromada (`localadmin`). Crimea and Sevastopol stay in the file. OCHA documents a pcode mismatch there; this tool does not repair it, so some localities in Sevastopol may have no hromada parent. They still need a country and an oblast or the build fails.

## Files

- `prepare-cod-ukraine.sh` — download and convert
- `download-cod-ukraine.js` — HDX `package_show?id=cod-ab-ukr`, then the bundle that contains ADM4
- `cod-to-wof-sqlite.js` — GeoJSON to `whosonfirst-data-cod-ua.db`

The downloader tries the GeoJSON zip first. If it has no admin level 4, it downloads the shapefile zip and converts it with `ogr2ogr`. Parents are linked by `admN_pcode`, not by point-in-polygon.

`wof:name` is the name whose `lang` / `lang1` / `lang2` / `lang3` tag is Ukrainian. English and Russian go to `name:eng_x_preferred` and `name:rus_x_preferred`. Old hromada names (`adm3_name_old`) are stored as variants. The language column is never inferred from the field index.

Record ids are a stable hash of the pcode with prefix `6`, so they do not collide with OSM (`9`), ONS (`8`), or IGN (`7`) ids in the same `sqlite/` directory.

## Usage

```bash
cd tools/cod-ukraine
./prepare-cod-ukraine.sh
```

Output: `output/whosonfirst-data-cod-ua.db`

```bash
cp output/whosonfirst-data-cod-ua.db "${DATA_DIR}/whosonfirst/sqlite/"
```

The loader picks up every `whosonfirst-data-*.db` in that directory. Re-run the OSM import afterwards so address documents pick up the new parents.

## License

Boundaries: [CC BY-IGO](http://creativecommons.org/licenses/by/3.0/igo/legalcode).

Attribute OCHA Field Information Services Section (FISS) and State Scientific Production Enterprise "Kartographia".

Scripts: MIT. Do not mix this database into an ODbL-only distribution without keeping the COD-AB attribution.
