# ADR: 插线烧录对齐 Flash Tool 自动复位

状态：draft  
日期：2026-08-30

## 决定

插线烧录按 Flash Tool / esptool 自动复位：同一串口句柄上做复位并立即同步。打开串口时不得把 DTR/RTS 拉回运行态。客户无需手动进下载模式。
