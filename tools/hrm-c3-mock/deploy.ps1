# 部署虚拟心率带固件到 ESP32-C3（默认 COM17）
# 用法：pwsh -File deploy.ps1            # 或 pwsh -File deploy.ps1 -Port COM17
param([string]$Port = "COM17")

$mp = "C:\Users\46907\.espressif\python_env\idf5.2_py3.11_env\Scripts\python.exe"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

& $mp -m mpremote connect $Port fs cp "$here\hrm.py" :hrm.py
& $mp -m mpremote connect $Port fs cp "$here\main.py" :main.py
& $mp -m mpremote connect $Port reset
Write-Host "已部署到 $Port（重启后 main.py 自动运行）"
