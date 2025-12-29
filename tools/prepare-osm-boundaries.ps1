# PowerShell script to prepare OSM boundaries for conversion
# Usage: .\prepare-osm-boundaries.ps1 -Region "dolnoslaskie"

param(
    [Parameter(Mandatory=$true)]
    [string]$Region,
    
    [string]$Country = "poland",
    
    [string]$OutputDir = ".",
    
    [switch]$SkipDownload,
    
    [switch]$SkipConvert
)

$ErrorActionPreference = "Stop"

# Konfiguracja
$GeofabrikBase = "http://download.geofabrik.de/europe"
$PbfUrl = "$GeofabrikBase/$Country/$Region-latest.osm.pbf"
$PbfFile = Join-Path $OutputDir "$Region-latest.osm.pbf"
$BoundariesPbf = Join-Path $OutputDir "$Region-admin-boundaries.osm.pbf"
$GeoJsonFile = Join-Path $OutputDir "$Region-boundaries.geojson"
$SqliteFile = Join-Path $OutputDir "whosonfirst-data-osm-admin-$Region.db"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " OSM Boundaries Preparation Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Region: $Region" -ForegroundColor Blue
Write-Host "Country: $Country" -ForegroundColor Blue
Write-Host "Output: $OutputDir" -ForegroundColor Blue
Write-Host ""

# Krok 1: Pobierz dane OSM
if (-not $SkipDownload) {
    Write-Host "[1/4] Downloading OSM data..." -ForegroundColor Yellow
    
    if (Test-Path $PbfFile) {
        Write-Host "      File exists, skipping download" -ForegroundColor Gray
    } else {
        Write-Host "      URL: $PbfUrl" -ForegroundColor Gray
        
        try {
            # Użyj curl jeśli dostępny (szybszy progress)
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

# Krok 2: Filtruj granice administracyjne
Write-Host ""
Write-Host "[2/4] Filtering administrative boundaries..." -ForegroundColor Yellow

# Sprawdź czy osmium jest zainstalowany
$osmium = Get-Command osmium -ErrorAction SilentlyContinue
if (-not $osmium) {
    Write-Host "      ERROR: osmium-tool not found!" -ForegroundColor Red
    Write-Host "      Install with: choco install osmium-tool" -ForegroundColor Yellow
    Write-Host "      Or: scoop install osmium-tool" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "      Alternative: Use Overpass Turbo to export GeoJSON directly" -ForegroundColor Cyan
    Write-Host "      https://overpass-turbo.eu/" -ForegroundColor Cyan
    exit 1
}

if (Test-Path $BoundariesPbf) {
    Write-Host "      File exists, skipping filter" -ForegroundColor Gray
} else {
    try {
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
        # Konwersja warstwy multipolygons (granice admin już przefiltrowane przez osmium)
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

# Krok 4: Konwertuj do WOF SQLite
Write-Host ""
Write-Host "[4/4] Converting to WOF SQLite format..." -ForegroundColor Yellow

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Sprawdź czy node_modules istnieje
if (-not (Test-Path (Join-Path $scriptDir "node_modules"))) {
    Write-Host "      Installing dependencies..." -ForegroundColor Gray
    Push-Location $scriptDir
    npm install
    Pop-Location
}

try {
    & node (Join-Path $scriptDir "osm-to-wof-sqlite.js") `
        -i $GeoJsonFile `
        -o $SqliteFile `
        --country PL
    
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host " SUCCESS!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Output file: $SqliteFile" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Copy to WOF data directory:" -ForegroundColor White
    Write-Host "     cp $SqliteFile /data/whosonfirst/sqlite/" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  2. Reimport OSM data:" -ForegroundColor White
    Write-Host "     pelias compose run openstreetmap ./bin/start" -ForegroundColor Gray
    Write-Host ""
    
} catch {
    Write-Host "      ERROR: Conversion failed" -ForegroundColor Red
    Write-Host "      $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

