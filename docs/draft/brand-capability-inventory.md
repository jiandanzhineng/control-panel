# 品牌设备按物理效果挂能力

机械：`strength`（单轴 0–255）+ `motors`（多路 value 0–255、direction 1/-1）。
电击：`shock`（电压 0–100）+ `estim`（通道、intensity 0–255、wave 预设 ID）。
泵：`pump`。

杯/玩具挂 strength+motors；郊狼/YCY 电击挂 shock+estim；灌肠挂 pump。
`strength` 只改主轴且只正转。未知波形忽略。
