---
date: 2026-08-18
summary: 删掉「收到MQTT消息」日志，把 topic 并进解析消息那条
---

# MQTT 日志去掉重复的收到消息

日志里「收到MQTT消息」和「解析MQTT消息」重复，删掉收到消息那条，把 topic 整合到解析 MQTT 消息那条上。
