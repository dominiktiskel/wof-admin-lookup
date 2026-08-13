#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Script to download and convert ONS (Office for National Statistics) 
    administrative boundaries for UK into WOF SQLite format

.DESCRIPTION
    Downloads official UK administrative boundaries from ONS Open Geography Portal
    and converts them to WOF SQLite format for use with Pelias.
    
    All data is free under Open Government Licence.
    
    Data sources:
    - Countries (4 features)
    - Regions (~13 features)
    - Counties (~50 features)
    - Local Authority Districts (~380 features)
    - Built-up Areas (~8000 features)

.PARAMETER OutputDir
    Output directory (default: current directory)

.PARAMETER SkipDownload
    Skip downloading ONS data (use existing files)

.EXAMPLE
    .\prepare-ons-uk.ps1 -OutputDir "C:\pelias\data\united-kingdom\whosonfirst\sqlite"
    
.EXAMPLE
    .\prepare-ons-uk.ps1 -OutputDir ".\output" -SkipDownload
#>

param(
    [Parameter(HelpMessage="Output directory")]
    [string]$OutputDir = ".",
    
    [Parameter(HelpMessage="Skip downloading ONS data")]
    [switch]$SkipDownload = $false
)

# Set strict mode
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Create output directory
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# Resolve to absolute path
$OutputDir = (Resolve-Path $OutputDir).Path

# File paths
$CountriesFile = Join-Path $OutputDir "ons-countries.geojson"
$RegionsFile = Join-Path $OutputDir "ons-regions.geojson"
$CountiesFile = Join-Path $OutputDir "ons-counties.geojson"
$MetroCountiesFile = Join-Path $OutputDir "ons-metrocounties.geojson"
$LadFile = Join-Path $OutputDir "ons-lad.geojson"
$BuaFile = Join-Path $OutputDir "ons-bua.geojson"
$DataDir = Join-Path $OutputDir "data"
$LondonFile = Join-Path $DataDir "greater-london.geojson"
$NeighbourhoodsFile = Join-Path $OutputDir "osm-neighbourhoods.geojson"
$SqliteFile = Join-Path $OutputDir "whosonfirst-data-ons-uk.db"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " ONS UK Boundaries to WOF SQLite" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Output directory: " -NoNewline -ForegroundColor Blue
Write-Host $OutputDir
Write-Host ""

# ONS API URLs (ArcGIS REST API endpoints)
# Using 2023/2024 boundaries with BFC (Best Fit Clipped to coastline)
$CountriesUrl = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Countries_December_2023_Boundaries_UK_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson"
$RegionsUrl = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Regions_December_2023_Boundaries_EN_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson"
$CountiesUrl = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Counties_and_Unitary_Authorities_December_2023_Boundaries_UK_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson"
$LadUrl = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_May_2024_Boundaries_UK_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson"
$BuaUrl = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Built_Up_Areas_December_2022_Boundaries_GB_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson"
# Upper Tier LAs filtered to metropolitan counties (E11) - E10/unitaries are covered by other datasets
$MetroCountiesUrl = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Upper_Tier_Local_Authorities_December_2022_Boundaries_UK_BFC/FeatureServer/0/query?outFields=*&where=UTLA22CD%20LIKE%20%27E11%25%27&f=geojson"

# Step 1: Download ONS data
Write-Host "[1/4] Downloading ONS administrative boundaries..." -ForegroundColor Yellow

if ($SkipDownload) {
    Write-Host "      Skipping download (--SkipDownload)" -ForegroundColor Gray
} else {
    # Function to download with progress
    function Download-File {
        param(
            [string]$Url,
            [string]$OutputFile,
            [string]$Description
        )
        
        if (Test-Path $OutputFile) {
            Write-Host "        File exists, skipping" -ForegroundColor Gray
            return
        }
        
        try {
            Write-Host "      Downloading $Description..." -ForegroundColor Cyan
            
            # Use Invoke-WebRequest with progress
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $Url -OutFile $OutputFile -UseBasicParsing
            $ProgressPreference = 'Continue'
            
            Write-Host "        Downloaded: " -NoNewline -ForegroundColor Green
            Write-Host $OutputFile -ForegroundColor Green
        } catch {
            Write-Host "        ERROR: Failed to download" -ForegroundColor Red
            Write-Host "        $_" -ForegroundColor Red
            throw
        }
    }
    
    Download-File -Url $CountriesUrl -OutputFile $CountriesFile -Description "Countries (4 features)"
    Download-File -Url $RegionsUrl -OutputFile $RegionsFile -Description "Regions (~13 features)"
    Download-File -Url $CountiesUrl -OutputFile $CountiesFile -Description "Counties (~50 features)"
    Download-File -Url $MetroCountiesUrl -OutputFile $MetroCountiesFile -Description "Metropolitan Counties (6 features - E11)"
    Download-File -Url $LadUrl -OutputFile $LadFile -Description "Local Authority Districts (~380 features)"
    
    # BUA is largest - show special message
    Write-Host "      Downloading Built-up Areas (~8000 features, may take a while)..." -ForegroundColor Cyan
    Download-File -Url $BuaUrl -OutputFile $BuaFile -Description "Built-up Areas"
}

# Step 2: Download Greater London boundary (for synthetic London locality)
Write-Host ""
Write-Host "[2/4] Downloading Greater London boundary from OpenStreetMap..." -ForegroundColor Yellow

if ($SkipDownload) {
    Write-Host "      Skipping download (--SkipDownload)" -ForegroundColor Gray
} else {
    # Create data directory if it doesn't exist
    if (-not (Test-Path $DataDir)) {
        New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    }
    
    Write-Host "      Greater London (OSM relation 175342)..." -ForegroundColor Cyan
    if (Test-Path $LondonFile) {
        Write-Host "        File exists, skipping" -ForegroundColor Gray
    } else {
        Write-Host "        Downloading from Nominatim..." -ForegroundColor Gray
        try {
            $LondonUrl = "https://nominatim.openstreetmap.org/details.php?osmtype=R&osmid=175342&polygon_geojson=1&format=json"
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $LondonUrl -OutFile $LondonFile -UseBasicParsing
            $ProgressPreference = 'Continue'
            
            $fileSize = (Get-Item $LondonFile).Length
            $fileSizeMB = [math]::Round($fileSize / 1MB, 2)
            Write-Host "        Downloaded successfully (" -NoNewline -ForegroundColor Green
            Write-Host "$fileSizeMB MB" -NoNewline -ForegroundColor Green
            Write-Host ")" -ForegroundColor Green
        } catch {
            Write-Host "        ERROR: Download failed" -ForegroundColor Red
            Write-Host "        $_" -ForegroundColor Red
            exit 1
        }
    }
}

# Step 3: Verify downloaded files
Write-Host ""
Write-Host "[3/4] Verifying downloaded files..." -ForegroundColor Yellow

# Check if all source files exist
$sourceFiles = @($CountriesFile, $RegionsFile, $CountiesFile, $MetroCountiesFile, $LadFile, $BuaFile, $LondonFile)
$missingFiles = $false

foreach ($file in $sourceFiles) {
    if (-not (Test-Path $file)) {
        Write-Host "      ERROR: Missing file: $file" -ForegroundColor Red
        $missingFiles = $true
    } elseif ((Get-Item $file).Length -eq 0) {
        Write-Host "      ERROR: Empty file: $file" -ForegroundColor Red
        $missingFiles = $true
    } else {
        $fileSize = (Get-Item $file).Length
        $fileSizeKB = [math]::Round($fileSize / 1KB, 0)
        $fileSizeMB = [math]::Round($fileSize / 1MB, 2)
        $displaySize = if ($fileSize -gt 1MB) { "$fileSizeMB MB" } else { "$fileSizeKB KB" }
        $fileName = Split-Path $file -Leaf
        Write-Host "      OK: $fileName ($displaySize)" -ForegroundColor Green
    }
}

if ($missingFiles) {
    Write-Host "      Some files are missing. Run without -SkipDownload to download them." -ForegroundColor Red
    exit 1
}

# Step 4: Convert to WOF SQLite
Write-Host ""
Write-Host "[4/4] Converting to WOF SQLite format..." -ForegroundColor Yellow

$ScriptDir = $PSScriptRoot

# Check if node_modules exists (in parent tools directory)
$ParentDir = Split-Path $ScriptDir -Parent
$NodeModulesPath = Join-Path $ParentDir "node_modules"
if (-not (Test-Path $NodeModulesPath)) {
    Write-Host "      Installing dependencies..." -ForegroundColor Gray
    
    Push-Location $ParentDir
    try {
        npm install
    } catch {
        Write-Host "      ERROR: Failed to install dependencies" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Pop-Location
}

# Run converter with multiple input files (no merge needed)
Write-Host "      This may take 10-20 minutes - processing ~9000 features..." -ForegroundColor Cyan

$ConverterScript = Join-Path $ScriptDir "ons-to-wof-sqlite.js"

if (-not (Test-Path $ConverterScript)) {
    Write-Host "      ERROR: Converter script not found: $ConverterScript" -ForegroundColor Red
    exit 1
}

# Create comma-separated input files list
$InputFiles = "$CountriesFile,$RegionsFile,$CountiesFile,$MetroCountiesFile,$LadFile,$BuaFile"

# Optional: OSM neighbourhoods (generated by extract-osm-neighbourhoods.sh)
$NeighbourhoodsArgs = @()
if ((Test-Path $NeighbourhoodsFile) -and ((Get-Item $NeighbourhoodsFile).Length -gt 0)) {
    Write-Host "      Including OSM neighbourhoods: $NeighbourhoodsFile" -ForegroundColor Cyan
    $NeighbourhoodsArgs = @("--osm-neighbourhoods", $NeighbourhoodsFile)
} else {
    Write-Host "      No OSM neighbourhoods file found ($NeighbourhoodsFile)" -ForegroundColor Yellow
    Write-Host "      Run extract-osm-neighbourhoods.sh first to include the neighbourhood layer" -ForegroundColor Yellow
}

try {
    & node $ConverterScript -i $InputFiles -o $SqliteFile --london-geojson $LondonFile @NeighbourhoodsArgs
} catch {
    Write-Host "      ERROR: Conversion failed" -ForegroundColor Red
    Write-Host "      $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " SUCCESS!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Output file: " -NoNewline -ForegroundColor Cyan
Write-Host $SqliteFile -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  1. Copy database to WOF data directory:" -ForegroundColor Blue
Write-Host "     Copy-Item `"$SqliteFile`" `"/data/whosonfirst/sqlite/`"" -ForegroundColor Gray
Write-Host ""
Write-Host "  2. Verify the database:" -ForegroundColor Blue
Write-Host "     sqlite3 `"$SqliteFile`" `"SELECT placetype, COUNT(*) FROM spr GROUP BY placetype;`"" -ForegroundColor Gray
Write-Host ""
Write-Host "  3. Restart Pelias import:" -ForegroundColor Blue
Write-Host "     cd /pelias/projects/united-kingdom" -ForegroundColor Gray
Write-Host "     pelias import osm" -ForegroundColor Gray
Write-Host ""
Write-Host "This database provides ~9000 UK admin boundaries (incl. 8500+ localities)!" -ForegroundColor Green
Write-Host ""
