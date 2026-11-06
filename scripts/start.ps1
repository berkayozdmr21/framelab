param([string]$Dotnet = 'dotnet')
$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$env:ASPNETCORE_ENVIRONMENT='Development'
$env:ASPNETCORE_URLS='http://127.0.0.1:9261'
$env:DataPath=Join-Path $PWD '.runtime/local'
$env:MediaPath=Join-Path $env:DataPath 'media'
$env:FFmpegPath=if(Test-Path '.tools/ffmpeg/ffmpeg.exe'){Join-Path $PWD '.tools/ffmpeg/ffmpeg.exe'}else{'ffmpeg'}
$env:FFprobePath=if(Test-Path '.tools/ffmpeg/ffprobe.exe'){Join-Path $PWD '.tools/ffmpeg/ffprobe.exe'}else{'ffprobe'}
& $env:FFmpegPath -version | Select-Object -First 1
if($LASTEXITCODE -ne 0){throw 'Install FFmpeg and add it to PATH first.'}
npm ci
if($LASTEXITCODE -ne 0){throw 'npm install failed'}
& $Dotnet build src/FrameLab.Api -v quiet
if($LASTEXITCODE -ne 0){throw 'API build failed'}
& $Dotnet build src/FrameLab.Worker -v quiet
if($LASTEXITCODE -ne 0){throw 'Worker build failed'}
$api=Start-Process -FilePath $Dotnet -ArgumentList 'src/FrameLab.Api/bin/Debug/net10.0/FrameLab.Api.dll' -WindowStyle Hidden -PassThru
try {
 for($i=0;$i -lt 30;$i++){try{Invoke-RestMethod http://127.0.0.1:9261/health | Out-Null;break}catch{Start-Sleep -Seconds 1}}
 $worker=Start-Process -FilePath $Dotnet -ArgumentList 'src/FrameLab.Worker/bin/Debug/net10.0/FrameLab.Worker.dll' -WindowStyle Hidden -PassThru
 Write-Host 'FrameLab: http://127.0.0.1:9260 | berkay / Framelab2026!'
 npm run dev
} finally {
 if($worker -and !$worker.HasExited){Stop-Process -Id $worker.Id}
 if(!$api.HasExited){Stop-Process -Id $api.Id}
}
