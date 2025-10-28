#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
简单的 MQTT 连接测试脚本
尝试连接到 easysmart.local:1883 并输出是否连接成功
"""
import sys
from threading import Event

try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("错误: 未安装 paho-mqtt，请先安装依赖后重试。")
    sys.exit(2)

HOST = "easysmart.local"
PORT = 1883
TIMEOUT_SECONDS = 5

_connected = Event()
_connect_rc = None


def on_connect(client, userdata, flags, rc, properties=None):
    global _connect_rc
    _connect_rc = rc
    if rc == 0:
        _connected.set()


def main() -> int:
    client = mqtt.Client()  # 使用默认 MQTT v3.1.1 协议
    client.on_connect = on_connect

    try:
        client.connect(HOST, PORT, keepalive=5)
    except Exception as e:
        print(f"连接失败: 无法建立到 {HOST}:{PORT} 的 TCP 连接: {e}")
        return 1

    client.loop_start()
    ok = _connected.wait(TIMEOUT_SECONDS)
    client.loop_stop()

    if ok and _connect_rc == 0:
        print(f"连接成功: 已连接到 MQTT 服务 {HOST}:{PORT}")
        return 0
    else:
        if _connect_rc is None:
            print(f"连接失败: 在 {TIMEOUT_SECONDS} 秒内未收到连接确认 (可能是网络或 mDNS 解析问题)")
        else:
            print(f"连接失败: MQTT 返回码 rc={_connect_rc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())