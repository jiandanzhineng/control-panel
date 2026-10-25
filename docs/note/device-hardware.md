# 具体设备硬件与协议速查

## 役次元杯 YCY-FJB-03
广播名 `YCY-FJB-03`，真机地址 `FF:26:02:28:4C:CD`。GATT `FF40/FF41写/FF42通知`。控制帧 6 字节 `35 12 旋转 震动 第三轴 校验`（旋转 0–40）。品牌页连上后有旋转/震动/第三轴滑条。连上后灯不闪是正常连接态。

## SOSEXY（繁野啵啵贝）
广播名 `SOSEXY`，内部类型 `SOSEXY_PID0004`，品牌码 `sosexy`。GATT `EE01/EE02通知/EE03写`；strength 0–255 同时映射震动与吸吮，独立 vibration/suction 直接 0–100，shock 映射微电流。协议 `backend/brands/protocols/sosexy.js`。页面展示「繁野 / 啵啵贝」，不归役次元。

## GXP 艾萝机娘二代
广播名 `Xa9935`（部分匹配），内部类型 `GXP_XA9935`，品牌码 `gxp`。GATT 控制写 `FF03`、通知 `FF02`（不解析）。strength 0–255→电机 0–100%；震动模式 1–12 仅品牌页试控；震动强度字段未确认不发。协议见 `docs/device/brand/gxp-xa9935-ble-control.md`。

## 郊狼
- 2.0：品牌页 shock 双通道 0–100；estim 分通道 A/B 0–255，不传波形预设编号。
- 3.0：广播名 `47L` 或写特征 `150A`；GATT `180C/150A`，`B0` 每 100ms，连上写 `BF`。设备类型仍是 `DGLAB`。写特征不得落到 `2a00`；网页蓝牙 V2 选择器不含 `47L`。

## FJB / TDD / 灌肠机
- YCY-FJB-03 用上面的 6 字节杯帧；其他 FJB/TDD/FJB-01 走官方 `35 12` A/B/C（0–20）。
- 灌肠机一代写 `FFB1`，默认工作 60 秒，明文剩余字节随机填充。

## 俯卧撑游戏输出槽
`vibrator` 是共用电机输出槽，可接 TD01 或 PJ01，奖励与惩罚都用 `vibratorIntensity`，各自保留时长参数。游戏在 `backend/games/pushup-detection`，移动端 `assets/games/pushup-detection` 同步。定向测试 `npm --prefix backend test -- --runInBand pushup-detection-output.test.js`。
