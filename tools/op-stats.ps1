# 拉取游戏埋点统计（OpenPanel 自托管实例）并打印汇总
# 凭证优先取环境变量 OPENPANEL_CLIENT_ID / OPENPANEL_CLIENT_SECRET，否则读 E:\smart\.env
# 用法: pwsh -File tools\op-stats.ps1            # 全量汇总
#       pwsh -File tools\op-stats.ps1 -Days 30   # 只看最近 30 天
param(
  [string]$Project = 'undersilicon-electron-pc',
  [string]$Base = 'https://op.shiroha.tech/api',
  [int]$Days = 0,
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$cid = $env:OPENPANEL_CLIENT_ID
$sec = $env:OPENPANEL_CLIENT_SECRET
if (-not $cid -or -not $sec) {
  $envFile = 'E:\smart\.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match '^\s*OPENPANEL_CLIENT_ID\s*=\s*(.+)$') { $cid = $Matches[1].Trim() }
      if ($line -match '^\s*OPENPANEL_CLIENT_SECRET\s*=\s*(.+)$') { $sec = $Matches[1].Trim() }
    }
  }
}
if (-not $cid -or -not $sec) { throw 'missing OPENPANEL_CLIENT_ID / OPENPANEL_CLIENT_SECRET (env or E:\smart\.env)' }
$h = @{ 'openpanel-client-id' = $cid; 'openpanel-client-secret' = $sec }
if (-not $Out) { $Out = Join-Path $PSScriptRoot '..\.tmp\op-stats.json' }

function Get-AllEvents([string]$Event, [string]$Start, [string]$End) {
  $all = New-Object System.Collections.Generic.List[object]
  $page = 1
  while ($page -le 60) {
    $u = "$Base/export/events?projectId=$Project&event=$Event&limit=100&page=$page&includes=properties"
    if ($Start) { $u += "&start=$Start" }
    if ($End) { $u += "&end=$End" }
    $r = Invoke-RestMethod -Uri $u -Headers $h -TimeoutSec 120
    foreach ($e in $r.data) { $all.Add($e) }
    if (-not $r.meta -or $page -ge $r.meta.pages) { break }
    $page++
  }
  return $all
}

function Get-Count([string]$Event, [string]$Start, [string]$End) {
  $u = "$Base/export/events?projectId=$Project&event=$Event&limit=1"
  if ($Start) { $u += "&start=$Start" }
  if ($End) { $u += "&end=$End" }
  (Invoke-RestMethod -Uri $u -Headers $h -TimeoutSec 60).meta.totalCount
}

$start = ''
if ($Days -gt 0) { $start = (Get-Date).ToUniversalTime().AddDays(-$Days).ToString('yyyy-MM-ddTHH:mm:ssZ') }
$result = [ordered]@{}
$result['range'] = if ($Days -gt 0) { "last $Days days (from $start)" } else { 'all time' }
foreach ($n in @('app_launch', 'game_start', 'game_stop', 'plugin_start', 'plugin_stop', 'device_connect', 'firmware_upgrade', 'wired_flash_start', 'game_upload', 'game_delete')) {
  $result[$n] = Get-Count $n $start ''
}
$stops = Get-AllEvents 'game_stop' $start ''
$starts = Get-AllEvents 'game_start' $start ''
# 该自托管实例的 /export/events 会忽略 start/end，只按 totalCount 计数，因此时间过滤在本地做。
if ($Days -gt 0) {
  $cut = (Get-Date).ToUniversalTime().AddDays(-$Days)
  $stops = @($stops | Where-Object { ([datetime]$_.createdAt).ToUniversalTime() -gt $cut })
  $starts = @($starts | Where-Object { ([datetime]$_.createdAt).ToUniversalTime() -gt $cut })
}

$byGame = [ordered]@{}
foreach ($r in ($starts | Group-Object { $_.properties.game_id } | Sort-Object Count -Descending)) {
  if ($r.Name) { $byGame[$r.Name] = $r.Count }
}
$result['game_start_by_game'] = $byGame

$dur = [ordered]@{}
foreach ($r in $stops) {
  $g = $r.properties.game_id; if (-not $g) { continue }
  $v = 0.0; [double]::TryParse($r.properties.duration_ms, [ref]$v) | Out-Null
  if (-not $dur.Contains($g)) { $dur[$g] = @{ n = 0; nz = 0; sum = 0.0; max = 0.0 } }
  $d = $dur[$g]; $d.n++
  if ($v -gt 0) { $d.nz++; $d.sum += $v; if ($v -gt $d.max) { $d.max = $v } }
}
$dd = [ordered]@{}
foreach ($k in ($dur.Keys | Sort-Object { -$dur[$_].sum })) {
  $d = $dur[$k]
  $dd[$k] = [ordered]@{
    stops = $d.n
    with_duration = $d.nz
    hours = [math]::Round($d.sum / 3600000, 2)
    avg_min = if ($d.nz) { [math]::Round($d.sum / $d.nz / 60000, 1) } else { 0 }
    max_min = [math]::Round($d.max / 60000, 1)
  }
}
$result['duration'] = $dd
$totalMs = ($stops | ForEach-Object { $v = 0.0; [double]::TryParse($_.properties.duration_ms, [ref]$v) | Out-Null; $v } | Measure-Object -Sum).Sum
$result['total_hours'] = [math]::Round($totalMs / 3600000, 2)
$result['unique_devices_game_stop'] = ($stops | Where-Object { $_.deviceId } | Select-Object -ExpandProperty deviceId -Unique).Count
$result | ConvertTo-Json -Depth 6 | Set-Content -Path $Out -Encoding UTF8
$result | ConvertTo-Json -Depth 6
Write-Output "# saved: $Out"
