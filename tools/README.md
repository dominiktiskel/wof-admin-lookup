# OSM to WOF SQLite Converter

Narzędzie do konwersji granic administracyjnych z OpenStreetMap (GeoJSON) na format SQLite kompatybilny z Who's on First (WOF) dla Pelias.

## Problem

Dane WOF często nie zawierają granic administracyjnych dla małych miejscowości (wsi, sołectw), szczególnie w Polsce. To narzędzie pozwala uzupełnić dane WOF o aktualne granice z OpenStreetMap.

## Wymagania

- Node.js v18+
- npm

## Instalacja

```bash
cd wof-admin-lookup/tools
npm install
```

## Użycie

### Krok 1: Przygotowanie danych GeoJSON z OSM

Jeśli jeszcze nie masz pliku GeoJSON z granicami OSM, możesz go przygotować:

#### Opcja A: Używając Overpass Turbo (mały obszar)

1. Przejdź na https://overpass-turbo.eu/
2. Wklej zapytanie (przykład dla dolnośląskiego):

```
[out:json][timeout:300];
area["ISO3166-2"="PL-DS"]->.searchArea;
(
  relation["boundary"="administrative"]["admin_level"~"[678910]"](area.searchArea);
);
out body;
>;
out skel qt;
```

3. Kliknij "Run" i wyeksportuj jako GeoJSON

#### Opcja B: Używając osmium-tool (duży obszar, rekomendowane)

```bash
# Pobierz dane OSM
wget http://download.geofabrik.de/europe/poland/dolnoslaskie-latest.osm.pbf

# Filtruj tylko granice administracyjne (relacje boundary=administrative)
osmium tags-filter dolnoslaskie-latest.osm.pbf \
  r/boundary=administrative \
  -o dolnoslaskie-admin-boundaries.osm.pbf

# Konwertuj na GeoJSON (wymaga GDAL/ogr2ogr)
ogr2ogr -f GeoJSON \
  dolnoslaskie-boundaries.geojson \
  dolnoslaskie-admin-boundaries.osm.pbf \
  multipolygons
```

### Krok 2: Konwersja na format WOF SQLite

```bash
# Podstawowe użycie
node osm-to-wof-sqlite.js -i dolnoslaskie-boundaries.geojson -o whosonfirst-data-osm-admin-pl.db

# Z filtrem placetypes (tylko miejscowości)
node osm-to-wof-sqlite.js -i boundaries.geojson -o output.db -p locality,localadmin

# Pełna pomoc
node osm-to-wof-sqlite.js --help
```

### Krok 3: Integracja z Pelias

```bash
# Skopiuj plik do katalogu danych WOF
cp whosonfirst-data-osm-admin-pl.db /data/whosonfirst/sqlite/

# Reimportuj dane OSM
pelias compose run openstreetmap ./bin/start
```

## Mapowanie admin_level → placetype

| admin_level | placetype     | Polska              |
|-------------|---------------|---------------------|
| 2           | country       | Państwo             |
| 4           | region        | Województwo         |
| 6           | county        | Powiat              |
| 7           | localadmin    | Gmina               |
| 8           | locality      | Miasto/Wieś         |
| 9           | borough       | Dzielnica/Osiedle   |
| 10          | neighbourhood | Sołectwo/Część msc. |

## Opcje CLI

| Opcja | Opis | Domyślnie |
|-------|------|-----------|
| `-i, --input <path>` | Plik wejściowy GeoJSON (wymagany) | - |
| `-o, --output <path>` | Plik wyjściowy SQLite | `whosonfirst-data-osm-admin.db` |
| `-p, --placetypes <types>` | Lista placetypes (oddzielone przecinkami) | wszystkie |
| `--country <code>` | Kod kraju ISO (dodawany do nazwy pliku) | `PL` |

## Struktura wyjściowa

Wygenerowany plik SQLite zawiera tabelę `geojson` zgodną z formatem WOF:

```sql
CREATE TABLE geojson (
  id INTEGER PRIMARY KEY,  -- wof:id
  body TEXT NOT NULL       -- pełny rekord GeoJSON
);
```

Każdy rekord zawiera:

```json
{
  "type": "Feature",
  "id": 908123456789,
  "properties": {
    "wof:id": 908123456789,
    "wof:name": "Nazwa miejscowości",
    "wof:placetype": "locality",
    "geom:latitude": 51.1234,
    "geom:longitude": 17.5678,
    "geom:bbox": "17.5,51.0,17.6,51.2",
    "osm:id": "relation/123456",
    "osm:admin_level": "8",
    "mz:is_current": 1
  },
  "geometry": { ... }
}
```

## Rozwiązywanie problemów

### Błąd "Invalid geometry"

Niektóre granice OSM mogą mieć niepoprawną geometrię. Skrypt próbuje je naprawić automatycznie. Jeśli nadal są problemy:

```bash
# Użyj mapshaper do naprawy geometrii przed konwersją
npm install -g mapshaper
mapshaper boundaries.geojson -clean -o fixed-boundaries.geojson
```

### Duży plik wyjściowy

Granice administracyjne mogą być bardzo szczegółowe. Możesz uprościć geometrię:

```bash
# Uprość geometrię przed konwersją
mapshaper boundaries.geojson -simplify 10% -o simplified.geojson
```

### Konflikty ID z WOF

Wygenerowane ID zaczynają się od `9xx` (np. `908123456789`) aby uniknąć kolizji z prawdziwymi ID WOF.

## Jak to działa z Pelias

1. `wof-admin-lookup` automatycznie wczytuje wszystkie pliki `whosonfirst-data-*.db` z katalogu `sqlite/`
2. Podczas importu OSM, Point-in-Polygon lookup sprawdza wszystkie załadowane poligony
3. Jeśli punkt znajduje się w poligonie z naszego pliku OSM, otrzyma odpowiednią hierarchię administracyjną
4. Priorytet: Twój custom fork już daje pierwszeństwo danym OSM z tagów `addr:*`, ale ten plik uzupełnia brakujące geometrie dla PIP lookup

## Licencja

MIT - Dane OSM są dostępne na licencji ODbL.

