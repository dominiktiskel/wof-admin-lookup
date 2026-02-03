# PowerShell script to prepare OSM boundaries WITH HIERARCHY
# This version extracts ALL admin levels and builds complete hierarchy
#
# Usage: .\prepare-osm-hierarchical.ps1 -Country "poland" [-Region "dolnoslaskie"]

param(
    [string]$Region,
    
    [Parameter(Mandatory=$true)]
    [string]$Country = "poland",
    
    [string]$OutputDir = ".",
    
    [switch]$SkipDownload,
    
    [switch]$SkipConvert
)

$ErrorActionPreference = "Stop"

# Map country names to Geofabrik directory names
$GeofabrikCountry = $Country
switch ($Country.ToLower()) {
    "great-britain" { $GeofabrikCountry = "united-kingdom" }
    "united-kingdom" { $GeofabrikCountry = "united-kingdom" }
    "uk" { $GeofabrikCountry = "united-kingdom" }
    { $_ -in @("england", "scotland", "wales") } {
        Write-Host "Error: Use 'united-kingdom' as country and specify '$Country' as region" -ForegroundColor Red
        Write-Host "Example: .\prepare-osm-hierarchical.ps1 -Country united-kingdom -Region $Country" -ForegroundColor Yellow
        exit 1
    }
}

# Określ obszar (region lub kraj) i skonstruuj URL
if ($Region) {
    $Area = $Region
    $PbfUrl = "http://download.geofabrik.de/europe/$GeofabrikCountry/$Region-latest.osm.pbf"
    $AreaType = "Region"
} else {
    $Area = $GeofabrikCountry
    $PbfUrl = "http://download.geofabrik.de/europe/$GeofabrikCountry-latest.osm.pbf"
    $AreaType = "Country"
}

# Konfiguracja plików
$PbfFile = Join-Path $OutputDir "$Area-latest.osm.pbf"
$BoundariesPbf = Join-Path $OutputDir "$Area-admin-boundaries-full.osm.pbf"
$GeoJsonFile = Join-Path $OutputDir "$Area-boundaries-full.geojson"
$SqliteFile = Join-Path $OutputDir "whosonfirst-data-osm-full-$Area.db"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " OSM Boundaries Preparation (HIERARCHICAL)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "⚠️  This script extracts ALL admin levels" -ForegroundColor Magenta
Write-Host "   (country, region, county, localadmin, locality, borough, neighbourhood)" -ForegroundColor Magenta
Write-Host "   and builds complete hierarchy for FULL WOF replacement!" -ForegroundColor Magenta
Write-Host ""
Write-Host "Area Type: $AreaType" -ForegroundColor Blue
Write-Host "Country:   $Country" -ForegroundColor Blue
if ($Region) {
    Write-Host "Region:    $Region" -ForegroundColor Blue
}
Write-Host "Output:    $OutputDir" -ForegroundColor Blue
Write-Host ""

# Krok 1: Pobierz dane OSM
if (-not $SkipDownload) {
    Write-Host "[1/4] Downloading OSM data..." -ForegroundColor Yellow
    
    if (Test-Path $PbfFile) {
        Write-Host "      File exists, skipping download" -ForegroundColor Gray
    } else {
        Write-Host "      URL: $PbfUrl" -ForegroundColor Gray
        
        try {
            if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
                & curl.exe -L -o $PbfFile $PbfUrl
            } else {
                Invoke-WebRequest -Uri $PbfUrl -OutFile $PbfFile
            }
            Write-Host "      Downloaded: $PbfFile" -ForegroundColor Green
        } catch {
            Write-Host "      ERROR: Failed to download" -ForegroundColor Red
            Write-Host "      $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
    }
} else {
    Write-Host "[1/4] Skipping download (--SkipDownload)" -ForegroundColor Gray
}

# Krok 2: Filtruj granice administracyjne (WSZYSTKIE poziomy!)
Write-Host ""
Write-Host "[2/4] Filtering administrative boundaries (ALL levels 2-10)..." -ForegroundColor Yellow

$osmium = Get-Command osmium -ErrorAction SilentlyContinue
if (-not $osmium) {
    Write-Host "      ERROR: osmium-tool not found!" -ForegroundColor Red
    Write-Host "      Install with: choco install osmium-tool" -ForegroundColor Yellow
    Write-Host "      Or: scoop install osmium-tool" -ForegroundColor Yellow
    exit 1
}

if (Test-Path $BoundariesPbf) {
    Write-Host "      File exists, skipping filter" -ForegroundColor Gray
} else {
    try {
        Write-Host "      Extracting admin_level 2,4,6,7,8,9,10" -ForegroundColor Cyan
        & osmium tags-filter $PbfFile r/boundary=administrative -o $BoundariesPbf --overwrite
        Write-Host "      Filtered: $BoundariesPbf" -ForegroundColor Green
    } catch {
        Write-Host "      ERROR: osmium failed" -ForegroundColor Red
        Write-Host "      $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

# Krok 3: Konwertuj do GeoJSON
Write-Host ""
Write-Host "[3/4] Converting to GeoJSON..." -ForegroundColor Yellow

$ogr2ogr = Get-Command ogr2ogr -ErrorAction SilentlyContinue
if (-not $ogr2ogr) {
    Write-Host "      ERROR: ogr2ogr (GDAL) not found!" -ForegroundColor Red
    Write-Host "      Install with: choco install gdal" -ForegroundColor Yellow
    Write-Host "      Or download from: https://gdal.org/download.html" -ForegroundColor Yellow
    exit 1
}

if ((Test-Path $GeoJsonFile) -and -not $SkipConvert) {
    Write-Host "      Removing existing GeoJSON..." -ForegroundColor Gray
    Remove-Item $GeoJsonFile -Force
}

if (-not (Test-Path $GeoJsonFile)) {
    try {
        & ogr2ogr -f GeoJSON `
            $GeoJsonFile `
            $BoundariesPbf `
            multipolygons
        
        $size = (Get-Item $GeoJsonFile).Length / 1MB
        Write-Host "      Created: $GeoJsonFile ($([math]::Round($size, 2)) MB)" -ForegroundColor Green
    } catch {
        Write-Host "      ERROR: ogr2ogr failed" -ForegroundColor Red
        Write-Host "      $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "      File exists, skipping conversion" -ForegroundColor Gray
}

# Krok 4: Konwertuj do WOF SQLite Z HIERARCHIĄ
Write-Host ""
Write-Host "[4/4] Converting to WOF SQLite format WITH HIERARCHY..." -ForegroundColor Yellow

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Sprawdź czy node_modules istnieje
if (-not (Test-Path (Join-Path $scriptDir "node_modules"))) {
    Write-Host "      Installing dependencies..." -ForegroundColor Gray
    Push-Location $scriptDir
    npm install
    Pop-Location
}

# Sprawdź czy potrzebujemy @turf/boolean-point-in-polygon
$packageJson = Get-Content (Join-Path $scriptDir "package.json") | ConvertFrom-Json
if (-not ($packageJson.dependencies.'@turf/boolean-point-in-polygon')) {
    Write-Host "      Installing additional dependency: @turf/boolean-point-in-polygon" -ForegroundColor Cyan
    Push-Location $scriptDir
    npm install --save @turf/boolean-point-in-polygon
    Pop-Location
}

try {
    Write-Host "      This may take a while - building complete hierarchy..." -ForegroundColor Cyan
    
    # Map country names to ISO codes
    $CountryCode = switch ($Country.ToLower()) {
        "poland" { "PL" }
        { $_ -in @("great-britain", "united-kingdom", "uk", "england", "scotland", "wales") } { "GB" }
        "germany" { "DE" }
        "france" { "FR" }
        "spain" { "ES" }
        "italy" { "IT" }
        default { $Country.Substring(0, 2).ToUpper() }
    }
    
    & node (Join-Path $scriptDir "osm-to-wof-hierarchical.js") `
        -i $GeoJsonFile `
        -o $SqliteFile `
        --country $CountryCode
    
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host " SUCCESS!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Output file: $SqliteFile" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "⚠️  IMPORTANT: This database contains FULL hierarchy!" -ForegroundColor Magenta
    Write-Host "   It can REPLACE original WOF data completely." -ForegroundColor Magenta
    Write-Host ""
    Write-Host "  1. Backup existing WOF data (optional):" -ForegroundColor Blue
    Write-Host "     mkdir `$DATA_DIR/whosonfirst/sqlite/backup" -ForegroundColor Gray
    Write-Host "     mv `$DATA_DIR/whosonfirst/sqlite/whosonfirst-data-*.db `$DATA_DIR/whosonfirst/sqlite/backup/" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  2. Copy new database to WOF data directory:" -ForegroundColor Blue
    Write-Host "     cp $SqliteFile `$DATA_DIR/whosonfirst/sqlite/" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  3. Restart PIP service:" -ForegroundColor Blue
    Write-Host "     docker compose restart pip" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  4. Reimport OSM data:" -ForegroundColor Blue
    Write-Host "     docker compose run --rm openstreetmap ./bin/start" -ForegroundColor Gray
    Write-Host ""
    Write-Host "✅ The new hierarchical data will provide complete admin hierarchy!" -ForegroundColor Green
    Write-Host ""
    
} catch {
    Write-Host "      ERROR: Conversion failed" -ForegroundColor Red
    Write-Host "      $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

