<#
.SYNOPSIS
  用 Windows SAPI 生成 16kHz 单声道 16bit WAV，供「语音开始」KWS 测试与假麦克风 E2E 使用。

.DESCRIPTION
  文本从外部 UTF-8 文件按行读取，避免 PowerShell 的 GBK 编码把中文读坏。
  生成后可选做峰值归一化（KWS 对音量敏感，实测 0.84 峰值命中稳定）。

.EXAMPLE
  # 一行一句，输出 <OutDir>\line-1.wav、line-2.wav ...
  pwsh -File tools\gen-voice-wav.ps1 -TextFile texts.txt -OutDir tmp\voice-wav -Prefix line

.EXAMPLE
  # 生成给 Electron 假麦克风用的循环音频（口令前后留静音，见 docs/note.md）
  pwsh -File tools\gen-voice-wav.ps1 -TextFile texts.txt -OutDir tmp\fake-mic -Prefix mic -PadSeconds 2
#>
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Prefix = 'line',
  # SAPI 语速 -10..10，0 为默认
  [int]$Rate = 0,
  [string]$Voice = 'Microsoft Huihui Desktop',
  # 前后各补多少秒静音（假麦克风循环播放时必须留，否则口令会连播、边界被吃掉）
  [double]$PadSeconds = 0,
  # 目标峰值（0~1），0 表示不归一化
  [double]$Peak = 0.84
)

Add-Type -AssemblyName System.Speech

if (-not (Test-Path $TextFile)) { throw "找不到文本文件：$TextFile" }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

$lines = [System.IO.File]::ReadAllLines($TextFile, [System.Text.Encoding]::UTF8)

# 在 16k 单声道 PCM 数据前/后插入静音
function Add-Silence {
  param([string]$Path, [double]$Seconds)
  if ($Seconds -le 0) { return }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $dataOffset = 0
  for ($i = 12; $i -lt $bytes.Length - 8; ) {
    $id = [System.Text.Encoding]::ASCII.GetString($bytes, $i, 4)
    $size = [BitConverter]::ToUInt32($bytes, $i + 4)
    if ($id -eq 'data') { $dataOffset = $i + 8; break }
    $i += 8 + $size + ($size % 2)
  }
  if ($dataOffset -eq 0) { throw "WAV 里找不到 data 块：$Path" }
  $silence = New-Object byte[] ([int](16000 * 2 * $Seconds))
  $out = New-Object System.IO.MemoryStream
  $out.Write($bytes, 0, $dataOffset)
  $out.Write($silence, 0, $silence.Length)
  $out.Write($bytes, $dataOffset, $bytes.Length - $dataOffset)
  $out.Write($silence, 0, $silence.Length)
  $result = $out.ToArray()
  [BitConverter]::GetBytes([uint32]($result.Length - 8)).CopyTo($result, 4)
  $dataLen = [uint32]($bytes.Length - $dataOffset + 2 * $silence.Length)
  [BitConverter]::GetBytes($dataLen).CopyTo($result, $dataOffset - 4)
  [System.IO.File]::WriteAllBytes($Path, $result)
  $out.Dispose()
}

# 把整段音频按目标峰值缩放（KWS 对响度敏感）
function Set-Peak {
  param([string]$Path, [double]$Target)
  if ($Target -le 0) { return }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $dataOffset = 0
  for ($i = 12; $i -lt $bytes.Length - 8; ) {
    $id = [System.Text.Encoding]::ASCII.GetString($bytes, $i, 4)
    $size = [BitConverter]::ToUInt32($bytes, $i + 4)
    if ($id -eq 'data') { $dataOffset = $i + 8; break }
    $i += 8 + $size + ($size % 2)
  }
  if ($dataOffset -eq 0) { throw "WAV 里找不到 data 块：$Path" }
  $count = [int](($bytes.Length - $dataOffset) / 2)
  $peak = 0
  for ($n = 0; $n -lt $count; $n++) {
    $v = [Math]::Abs([BitConverter]::ToInt16($bytes, $dataOffset + $n * 2))
    if ($v -gt $peak) { $peak = $v }
  }
  if ($peak -lt 1) { return }
  $gain = $Target * 32767 / $peak
  for ($n = 0; $n -lt $count; $n++) {
    $v = [int]([BitConverter]::ToInt16($bytes, $dataOffset + $n * 2) * $gain)
    if ($v -gt 32767) { $v = 32767 }
    if ($v -lt -32767) { $v = -32767 }
    [BitConverter]::GetBytes([int16]$v).CopyTo($bytes, $dataOffset + $n * 2)
  }
  [System.IO.File]::WriteAllBytes($Path, $bytes)
}

$index = 0
foreach ($line in $lines) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $index++
  $out = Join-Path $OutDir ("{0}-{1}.wav" -f $Prefix, $index)
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $synth.SelectVoice($Voice) } catch { Write-Warning "没有语音 $Voice，用系统默认" }
  $synth.Rate = $Rate
  $synth.SetOutputToWaveFile($out, $fmt)
  $synth.Speak($line)
  $synth.SetOutputToNull()
  $synth.Dispose()
  Add-Silence -Path $out -Seconds $PadSeconds
  Set-Peak -Path $out -Target $Peak
  Write-Output $out
}
Write-Output ("共生成 {0} 个文件到 {1}" -f $index, (Resolve-Path $OutDir))
