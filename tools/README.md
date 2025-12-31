# OSM to WOF SQLite Converter

Narzędzie do konwersji granic administracyjnych z OpenStreetMap (GeoJSON) na format SQLite kompatybilny z Who's on First (WOF) dla Pelias.

## Problem

Dane WOF często nie zawierają granic administracyjnych dla małych miejscowości (wsi, sołectw), szczególnie w Polsce. To narzędzie pozwala uzupełnić dane WOF o aktualne granice z OpenStreetMap.

## 🎯 Dwie wersje narzędzia

### **Wersja 1: Uzupełnienie WOF (podstawowa)**
- Pliki: `osm-to-wof-sqlite.js`, `prepare-osm-boundaries.sh/ps1`
- Cel: **Uzupełnienie** istniejących danych WOF o małe miejscowości
- Generuje: Tylko wybrane poziomy (locality, borough, neighbourhood)
- **Brak hierarchii** - wymaga współpracy z oryginalnym WOF
- ⚠️ **Problem**: Może "zasłaniać" oryginalne WOF dane jeśli występują konflikty

### **Wersja 2: Pełna hierarchia (zaawansowana)** ⭐ NOWA!
- Pliki: `osm-to-wof-hierarchical.js`, `prepare-osm-hierarchical.sh/ps1`
- Cel: **Całkowite zastąpienie** danych WOF danymi z OSM
- Generuje: **WSZYSTKIE** poziomy (country, region, county, localadmin, locality, borough, neighbourhood)
- **Pełna hierarchia** - buduje parent-child relationships
- ✅ **Zalety**: Kompletna hierarchia, brak konfliktów, wszystkie admin levels

## Wymagania

- Node.js v18+
- npm
- osmium-tool (do filtrowania PBF)
- GDAL/ogr2ogr (do konwersji na GeoJSON)

## Instalacja

```bash
cd wof-admin-lookup/tools
npm install
```

---

## Użycie - Wersja 1 (Uzupełnienie WOF)

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

---

## Użycie - Wersja 2 (Pełna hierarchia) ⭐ ZAAWANSOWANA

### Automatyczny skrypt (zalecane):

**Bash (Linux/Mac):**
```bash
./prepare-osm-hierarchical.sh -c poland
# lub dla regionu:
./prepare-osm-hierarchical.sh -c poland -r dolnoslaskie
```

**PowerShell (Windows):**
```powershell
.\prepare-osm-hierarchical.ps1 -Country poland
# lub dla regionu:
.\prepare-osm-hierarchical.ps1 -Country poland -Region dolnoslaskie
```

### Ręcznie krok po kroku:

**1. Pobierz dane OSM**
```bash
wget http://download.geofabrik.de/europe/poland-latest.osm.pbf
```

**2. Filtruj granice (WSZYSTKIE poziomy)**
```bash
osmium tags-filter poland-latest.osm.pbf \
  r/boundary=administrative \
  -o poland-admin-boundaries-full.osm.pbf \
  --overwrite
```

**3. Konwertuj na GeoJSON**
```bash
ogr2ogr -f GeoJSON \
  poland-boundaries-full.geojson \
  poland-admin-boundaries-full.osm.pbf \
  multipolygons
```

**4. Generuj SQLite Z HIERARCHIĄ**
```bash
node osm-to-wof-hierarchical.js \
  -i poland-boundaries-full.geojson \
  -o whosonfirst-data-osm-full-pl.db \
  --country PL
```

### Wdrożenie:

**⚠️ WAŻNE**: Ta baza ZASTĘPUJE oryginalne WOF!

```bash
# 1. Backup oryginalnych danych WOF (opcjonalnie)
mkdir -p /data/whosonfirst/sqlite/backup
mv /data/whosonfirst/sqlite/whosonfirst-data-*.db /data/whosonfirst/sqlite/backup/

# 2. Skopiuj nową bazę
cp whosonfirst-data-osm-full-pl.db /data/whosonfirst/sqlite/

# 3. Restart PIP service
docker compose restart pip

# 4. Reimport OSM
pelias compose run openstreetmap ./bin/start
```

### Co buduje Wersja 2:

**3-pass algorytm:**

1. **Pass 1**: Przetwarza wszystkie features z GeoJSON
   - Waliduje geometrie
   - Oblicza centroidy, bbox, area
   - Przygotowuje dane do Pass 2

2. **Pass 2**: Buduje hierarchię
   - Dla każdego feature używa Point-in-Polygon
   - Znajduje parent (np. locality → localadmin → county → region → country)
   - Tworzy pełne `wof:hierarchy` dla każdego poziomu

3. **Pass 3**: Zapisuje do SQLite
   - Tabela `geojson`: Pełne GeoJSON features
   - Tabela `spr`: Metadane z `parent_id`
   - Tabela `ancestors`: Pełna hierarchia dla szybkich zapytań

**Przykład hierarchii:**

```json
{
  "wof:id": 908123456,
  "wof:name": "Zacharzyce",
  "wof:placetype": "locality",
  "wof:parent_id": 904567890,  // localadmin
  "wof:hierarchy": [{
    "locality_id": 908123456,
    "localadmin_id": 904567890,
    "county_id": 906789012,
    "region_id": 904123456,
    "country_id": 902000000
  }]
}
```

### Zalety Wersji 2:

✅ **Kompletna hierarchia** - każdy poziom ma poprawnego parent  
✅ **Brak konfliktów** - zastępuje WOF całkowicie  
✅ **Wszystkie admin levels** - country do neighbourhood  
✅ **Tabela ancestors** - szybkie zapytania o przodków  
✅ **Point-in-Polygon** - automatyczne wykrywanie rodziców  

### Wady Wersji 2:

⚠️ **Wymaga WSZYSTKICH poziomów w OSM** - jeśli OSM nie ma admin_level=2 (country), to nie będzie country!  
⚠️ **Długi czas przetwarzania** - budowanie hierarchii dla 30k features może zająć 10-30 minut  
⚠️ **Zastępuje WOF** - tracisz dodatkowe dane WOF (population, concordances, etc.)  

### Kiedy używać której wersji?

| Scenariusz | Wersja 1 (Uzupełnienie) | Wersja 2 (Pełna hierarchia) |
|------------|-------------------------|------------------------------|
| **Małe miejscowości brak w WOF** | ✅ Zalecane | ⚠️ Overkill |
| **WOF ma błędy w hierarchii** | ❌ Nie zadziała | ✅ Zalecane |
| **Chcesz zachować WOF metadata** | ✅ Zalecane | ❌ Stracisz |
| **Chcesz 100% OSM data** | ❌ Nie zadziała | ✅ Zalecane |
| **Masz kompletne OSM admin levels** | ⚠️ Opcjonalne | ✅ Zalecane |

## Licencja

MIT - Dane OSM są dostępne na licencji ODbL.

