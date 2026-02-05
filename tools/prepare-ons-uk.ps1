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
$LadFile = Join-Path $OutputDir "ons-lad.geojson"
$BuaFile = Join-Path $OutputDir "ons-bua.geojson"
$MergedFile = Join-Path $OutputDir "ons-uk-merged.geojson"
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

# Step 1: Download ONS data
Write-Host "[1/3] Downloading ONS administrative boundaries..." -ForegroundColor Yellow

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
    Download-File -Url $LadUrl -OutputFile $LadFile -Description "Local Authority Districts (~380 features)"
    
    # BUA is largest - show special message
    Write-Host "      Downloading Built-up Areas (~8000 features, may take a while)..." -ForegroundColor Cyan
    Download-File -Url $BuaUrl -OutputFile $BuaFile -Description "Built-up Areas"
}

# Step 2: Merge GeoJSON files
Write-Host ""
Write-Host "[2/3] Merging GeoJSON files..." -ForegroundColor Yellow

if (Test-Path $MergedFile) {
    Write-Host "      Removing existing merged file" -ForegroundColor Gray
    Remove-Item $MergedFile -Force
}

# Check if all source files exist
$sourceFiles = @($CountriesFile, $RegionsFile, $CountiesFile, $LadFile, $BuaFile)
foreach ($file in $sourceFiles) {
    if (-not (Test-Path $file)) {
        Write-Host "      ERROR: Missing file: $file" -ForegroundColor Red
        exit 1
    }
}

# Merge using Node.js
Write-Host "      Merging 5 GeoJSON files..." -ForegroundColor Cyan

# Create inline Node.js script
$nodeScript = @"
const fs = require('fs');

const files = [
    '$($CountriesFile -replace '\\', '\\')',
    '$($RegionsFile -replace '\\', '\\')',
    '$($CountiesFile -replace '\\', '\\')',
    '$($LadFile -replace '\\', '\\')',
    '$($BuaFile -replace '\\', '\\')'
];

const merged = {
    type: 'FeatureCollection',
    features: []
};

let totalFeatures = 0;

for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const features = data.features || [];
    merged.features.push(...features);
    const filename = file.split(/[\\\\\/]/).pop();
    console.log('  Loaded ' + filename + ': ' + features.length + ' features');
    totalFeatures += features.length;
}

fs.writeFileSync('$($MergedFile -replace '\\', '\\')', JSON.stringify(merged));
console.log('  Total features: ' + totalFeatures);
"@

# Check if node is installed
try {
    $null = Get-Command node -ErrorAction Stop
} catch {
    Write-Host "      ERROR: Node.js not found!" -ForegroundColor Red
    Write-Host "      Install from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Run Node.js script
try {
    $nodeScript | node
    Write-Host "      Created: " -NoNewline -ForegroundColor Green
    Write-Host $MergedFile -ForegroundColor Green
} catch {
    Write-Host "      ERROR: Failed to merge files" -ForegroundColor Red
    Write-Host "      $_" -ForegroundColor Red
    exit 1
}

# Step 3: Convert to WOF SQLite
Write-Host ""
Write-Host "[3/3] Converting to WOF SQLite format..." -ForegroundColor Yellow

$ScriptDir = $PSScriptRoot

# Check if node_modules exists
$NodeModulesPath = Join-Path $ScriptDir "node_modules"
if (-not (Test-Path $NodeModulesPath)) {
    Write-Host "      Installing dependencies..." -ForegroundColor Gray
    
    Push-Location $ScriptDir
    try {
        npm install
    } catch {
        Write-Host "      ERROR: Failed to install dependencies" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Pop-Location
}

# Run converter
Write-Host "      This may take a while - processing ~8500 features..." -ForegroundColor Cyan

$ConverterScript = Join-Path $ScriptDir "ons-to-wof-sqlite.js"

if (-not (Test-Path $ConverterScript)) {
    Write-Host "      ERROR: Converter script not found: $ConverterScript" -ForegroundColor Red
    exit 1
}

try {
    & node $ConverterScript -i $MergedFile -o $SqliteFile
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
Write-Host "This database provides ~8000 proper locality boundaries!" -ForegroundColor Green
Write-Host ""
