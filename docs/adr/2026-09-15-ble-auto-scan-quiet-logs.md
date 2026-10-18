---
date: 2026-09-15
summary: 后台自动扫描静默不打 info，手动扫描才记 start/found/done
---

# 自动蓝牙扫描不打 info 日志

后台自动连接扫描用 quiet，不写 info；无名字广播一律 debug。手动「扫描蓝牙设备」仍记 start/found/done；连接、写特征、失败保持 info。
