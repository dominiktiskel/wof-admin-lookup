# Simple test script to verify ONS API accessibility
param(
    [switch]$Verbose = $false
)

Write-Host "Testing ONS API endpoints..." -ForegroundColor Cyan
Write-Host ""

$tempFile = Join-Path $env:TEMP "ons-api-test.json"

# Test function
function Test-OnsEndpoint {
    param(
        [string]$Name,
        [string]$Url,
        [string]$CodeField,
        [string]$NameField
    )
    
    Write-Host "Testing $Name..." -NoNewline
    
    try {
        # Add limit to get just 1 record for faster testing
        $testUrl = $Url -replace 'f=geojson', 'resultRecordCount=1&f=geojson'
        
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $testUrl -OutFile $tempFile -UseBasicParsing -TimeoutSec 30 | Out-Null
        $ProgressPreference = 'Continue'
        
        $data = Get-Content $tempFile -Raw | ConvertFrom-Json
        
        if ($data.type -eq 'FeatureCollection' -and $data.features.Count -gt 0) {
            $feature = $data.features[0]
            $code = $feature.properties.$CodeField
            $name = $feature.properties.$NameField
            
            Write-Host " ✓" -ForegroundColor Green
            if ($Verbose) {
                Write-Host "    Sample: $name ($code)" -ForegroundColor Gray
            }
            return $true
        } else {
            Write-Host " ✗ (no features)" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host " ✗ (error: $($_.Exception.Message))" -ForegroundColor Red
        return $false
    }
}

# Test each endpoint
$results = @{}

$url1 = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Countries_December_2023_Boundaries_UK_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson'
$results['Countries'] = Test-OnsEndpoint -Name "Countries" -Url $url1 -CodeField "CTRY23CD" -NameField "CTRY23NM"

$url2 = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Regions_December_2023_Boundaries_EN_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson'
$results['Regions'] = Test-OnsEndpoint -Name "Regions" -Url $url2 -CodeField "RGN23CD" -NameField "RGN23NM"

$url3 = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Counties_and_Unitary_Authorities_December_2023_Boundaries_UK_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson'
$results['Counties'] = Test-OnsEndpoint -Name "Counties" -Url $url3 -CodeField "CTYUA23CD" -NameField "CTYUA23NM"

$url4 = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_May_2024_Boundaries_UK_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson'
$results['LAD'] = Test-OnsEndpoint -Name "Local Authority Districts" -Url $url4 -CodeField "LAD24CD" -NameField "LAD24NM"

$url5 = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Built_Up_Areas_December_2022_Boundaries_GB_BFC/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson'
$results['BUA'] = Test-OnsEndpoint -Name "Built-up Areas" -Url $url5 -CodeField "BUA22CD" -NameField "BUA22NM"

# Clean up
if (Test-Path $tempFile) {
    Remove-Item $tempFile -Force
}

# Summary
Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
$successful = ($results.Values | Where-Object { $_ -eq $true }).Count
$total = $results.Count

if ($successful -eq $total) {
    Write-Host "✓ All $total endpoints are accessible!" -ForegroundColor Green
    Write-Host ""
    Write-Host "You can now run:" -ForegroundColor Yellow
    Write-Host "  .\prepare-ons-uk.ps1 -OutputDir <path>" -ForegroundColor Gray
    exit 0
} else {
    Write-Host "✗ $($total - $successful) of $total endpoints failed" -ForegroundColor Red
    exit 1
}
