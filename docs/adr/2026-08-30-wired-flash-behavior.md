---
date: 2026-08-30
summary: 固件更新占串口最高优先级，插线烧录对齐 Flash Tool 自动复位
supersedes: wired-flash-highest-priority.md, wired-flash-match-flash-tool.md
---

# 插线烧录行为：最高优先级与自动复位

1. 固件更新是串口相关流程的最高优先级：发起时自动停止并释放面板内其他流程对目标串口的占用，其他内部串口流程不得阻止抢占。
2. 插线烧录按 Flash Tool / esptool 自动复位：同一串口句柄上做复位并立即同步；打开串口时不得把 DTR/RTS 拉回运行态。客户无需手动进下载模式。
