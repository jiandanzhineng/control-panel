# 能力（Capability）与操作（Operation）模型 — 设计决策记录

> **本文件的设计决策已合并到 `docs/game-runtime-unified-design.html`。**
> 设备清单已独立为 `docs/device-registry.md`。
> 以下仅保留待讨论项。

---

## 待讨论 / 待定项

- operation 的 `invoke` 内是否支持 `ctx.op('otherOp')` 调用本设备的其他操作（操作间复用）——当前设计不需要，按需再加。
