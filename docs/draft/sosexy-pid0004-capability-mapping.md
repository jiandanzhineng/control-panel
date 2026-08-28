# SOSEXY PID 0004 能力映射

SOSEXY PID 0004 在设备层提供四个能力：`strength`、`vibration`、`suction`、`shock`。
`strength` 同时控制震动和吸吮（0–255 映射到设备 0–100）；`vibration` / `suction` 单独控制且直接 0–100；`shock` 控制微电流。设备类型固定为 `SOSEXY_PID0004`。
