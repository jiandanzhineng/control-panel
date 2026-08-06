# 基础 MAC 是跨连接统一设备 ID

物理设备统一使用固件从 eFuse 读取的基础 MAC 作为设备 ID，保持现有 MQTT topic 不变；串口握手和 BLE 身份读取都必须显式返回同一个基础 MAC。真实 BLE MAC 是由基础 MAC 派生的连接地址，Electron Web Bluetooth 也不保证暴露该地址，因此它只属于连接信息，不作为物理设备身份；这避免了迁移既有设备记录、昵称和玩法映射。
