# -*- coding: utf-8 -*-
"""虚拟心率带（标准 BLE HRS 假设备）—— MicroPython / ESP32-C3

用途：给 control-panel 及移动端做心率接入测试，替代真实心率带。
实现标准 GATT：
  0x180D Heart Rate        0x2A37 测量(Notify/Read) 0x2A38 佩戴位置(Read) 0x2A39 控制点(Write)
  0x180F Battery           0x2A19 电量(Read/Notify)
  0x180A Device Info       0x2A29/0x2A24/0x2A25/0x2A26 厂商/型号/序列号(基础MAC)/固件版本
  0x00FF 面板身份          0xFF04 只读 JSON，格式遵循 docs/adr/0010
  0xFFE0 测试控制          0xFFE1 写文本命令  0xFFE2 通知状态（仅在无其它中央连接时可用）

控制：REPL 或 BLE 0xFFE1 写命令；命令见 docs/note.md / README.md
"""
import bluetooth
import gc
import machine
import struct
import sys
import time
from micropython import const

_IRQ_CENTRAL_CONNECT = const(1)
_IRQ_CENTRAL_DISCONNECT = const(2)
_IRQ_GATTS_WRITE = const(3)

FLAG_R = bluetooth.FLAG_READ
FLAG_W = bluetooth.FLAG_WRITE
FLAG_WN = bluetooth.FLAG_WRITE_NO_RESPONSE
FLAG_N = bluetooth.FLAG_NOTIFY

UUID_HRS = bluetooth.UUID(0x180D)
UUID_BAT = bluetooth.UUID(0x180F)
UUID_DIS = bluetooth.UUID(0x180A)
UUID_IDENT = bluetooth.UUID(0x00FF)
UUID_CTRL = bluetooth.UUID(0xFFE0)

FIRMWARE_VERSION = "v1.0.0"
MODEL = "HRM-C3-MOCK"
MANUFACTURER = "UnderSilicon Test"

ADV_INTERVAL_US = 200000  # 200ms，够快能被网页蓝牙/panel 立刻发现


def mac_hex():
    """eFuse 基础 MAC 的 12 位小写 hex，与串口/MQTT device_id 同源。"""
    return "".join("%02x" % b for b in machine.unique_id()[:6])


# ---- 心率场景模型 ----
# cycle：0-30s 静息 68 / 30-90s 爬到 150 / 90-150s 保持 150 / 150-180s 回落到 90
CYCLE = ((0, 30, 68, 68), (30, 90, 68, 150), (90, 150, 150, 150), (150, 180, 150, 90))
CYCLE_LEN = 180
TAU_PER_S = 0.12  # 一阶惯性系数，时间常数约 8s，模拟真实心率滞后

STATE = {
    "mode": "cycle",  # cycle | rest | fixed | nocontact | silent | off
    "hr_fixed": 150.0,
    "hr": 68.0,
    "noise": 1.5,  # bpm 抖动
    "contact": True,
    "rr": True,
    "energy": True,
    "energy_kj": 0.0,
    "battery": 100,
    "adv": True,
    "name": "HRM-Virtual",
    "uptime_ms": 0,
    "conn": None,
    "notify_count": 0,
}


def _target(now_s):
    mode = STATE["mode"]
    if mode == "fixed":
        return STATE["hr_fixed"]
    if mode == "rest":
        return 68.0
    if mode == "cycle":
        t = now_s % CYCLE_LEN
        for a, b, va, vb in CYCLE:
            if a <= t < b:
                return va + (vb - va) * (t - a) / float(b - a)
    return STATE["hr"]


def _update(dt_ms):
    STATE["uptime_ms"] += dt_ms
    now_s = STATE["uptime_ms"] / 1000.0
    target = _target(now_s)
    k = min(1.0, dt_ms / 1000.0 * TAU_PER_S)
    jitter = (time.ticks_us() % 1000 - 500) / 500.0 * STATE["noise"] * k
    hr = STATE["hr"] + (target - STATE["hr"]) * k + jitter
    STATE["hr"] = min(220.0, max(35.0, hr))
    if STATE["contact"] and STATE["mode"] not in ("nocontact", "silent"):
        STATE["energy_kj"] += STATE["hr"] / 60.0 * dt_ms / 1000.0 * 0.15


def _packet():
    """标准 Heart Rate Measurement（8 位心率 + 能量消耗 + RR 间期）。"""
    live = STATE["contact"] and STATE["mode"] not in ("nocontact", "silent")
    hr = int(STATE["hr"] + 0.5) if live else 0
    # Sensor Contact 两位字段：bit2 = 支持检测，bit1 = 已检测到接触。
    # live → 0x06（支持且接触）；未接触 → 0x04（支持但未检测到接触，心率报 0）。
    flags = 0x06 if live else 0x04
    if live and STATE["energy"]:
        flags |= 0x08
    if live and STATE["rr"]:
        flags |= 0x10
    data = bytearray((flags, hr & 0xFF))
    if flags & 0x08:
        data += struct.pack("<H", int(STATE["energy_kj"]) & 0xFFFF)
    if flags & 0x10:
        rr = int(61440.0 / hr) if hr else 1024  # 1/1024s 单位
        data += struct.pack("<H", min(0xFFFF, max(1, rr)))
    return bytes(data)


def _identity_json():
    """面板 0xFF04 身份特征，格式见 docs/adr/0010。"""
    return ('{"device_id":"%s","firmware_version":"%s"}' % (mac_hex(), FIRMWARE_VERSION)).encode()


SERVICES = (
    (UUID_HRS, (
        (bluetooth.UUID(0x2A37), FLAG_N | FLAG_R),  # Heart Rate Measurement
        (bluetooth.UUID(0x2A38), FLAG_R),           # Body Sensor Location
        (bluetooth.UUID(0x2A39), FLAG_W | FLAG_WN),  # Heart Rate Control Point
    )),
    (UUID_BAT, (
        (bluetooth.UUID(0x2A19), FLAG_R | FLAG_N),  # Battery Level
    )),
    (UUID_DIS, (
        (bluetooth.UUID(0x2A29), FLAG_R),  # Manufacturer Name
        (bluetooth.UUID(0x2A24), FLAG_R),  # Model Number
        (bluetooth.UUID(0x2A25), FLAG_R),  # Serial Number（基础 MAC）
        (bluetooth.UUID(0x2A26), FLAG_R),  # Firmware Revision
    )),
    (UUID_IDENT, (
        (bluetooth.UUID(0xFF04), FLAG_R),  # 面板身份 JSON
    )),
    (UUID_CTRL, (
        (bluetooth.UUID(0xFFE1), FLAG_W | FLAG_WN),  # 测试命令写入
        (bluetooth.UUID(0xFFE2), FLAG_N | FLAG_R),   # 状态回读/通知
    )),
)


class VirtualHrm:
    def __init__(self):
        self.ble = bluetooth.BLE()
        self.ble.active(True)
        self.ble.config(gap_name=STATE["name"])
        self.ble.irq(self._irq)
        (
            (self.h_meas, self.h_loc, self.h_ctrl),
            (self.h_bat,),
            (self.h_mfr, self.h_model, self.h_serial, self.h_fw),
            (self.h_ident,),
            (self.h_wcmd, self.h_status),
        ) = self.ble.gatts_register_services(SERVICES)
        self.ble.gatts_set_buffer(self.h_wcmd, 96)
        self.ble.gatts_write(self.h_loc, b"\x01")  # 1 = 胸部
        self.ble.gatts_write(self.h_mfr, MANUFACTURER.encode())
        self.ble.gatts_write(self.h_model, MODEL.encode())
        self.ble.gatts_write(self.h_serial, mac_hex().encode())
        self.ble.gatts_write(self.h_fw, FIRMWARE_VERSION.encode())
        self.ble.gatts_write(self.h_ident, _identity_json())
        self.ble.gatts_write(self.h_bat, bytes((STATE["battery"],)))
        self.ble.gatts_write(self.h_meas, _packet())
        self._advertise()

    def _advertise(self):
        if not STATE["adv"]:
            self.ble.gap_advertise(None)
            return
        name = STATE["name"].encode()
        adv = bytearray()
        adv += bytes((2, 0x01, 0x06))  # LE General Discoverable
        adv += bytes((3, 0x03, 0x0D, 0x18))  # 16-bit UUID: Heart Rate 0x180D
        adv += bytes((3, 0x19, 0x40, 0x03))  # appearance: Heart Rate Sensor
        adv += bytes((len(name) + 1, 0x09)) + name
        self.ble.gap_advertise(ADV_INTERVAL_US, adv_data=bytes(adv))

    def _irq(self, event, data):
        if event == _IRQ_CENTRAL_CONNECT:
            conn, _, _ = data
            STATE["conn"] = conn
            print("[hrm] central connected handle=%s" % conn)
        elif event == _IRQ_CENTRAL_DISCONNECT:
            STATE["conn"] = None
            STATE["notify_count"] = 0
            print("[hrm] disconnected, re-advertising")
            self._advertise()
        elif event == _IRQ_GATTS_WRITE:
            conn, attr = data
            if attr == self.h_wcmd:
                try:
                    text = self.ble.gatts_read(self.h_wcmd).decode().strip()
                except Exception:
                    text = ""
                if text:
                    self.reply(cmd(text))

    def reply(self, text):
        """把状态写到 0xFFE2（有订阅则通知）。"""
        payload = text.encode("utf-8")[:96]
        try:
            self.ble.gatts_write(self.h_status, payload, True)
        except Exception:
            pass
        print("[hrm] " + text)

    def notify(self):
        """向订阅者推一帧心率测量。silent 模式不发（模拟戴着但无数据）。"""
        if STATE["mode"] == "silent":
            return
        self.ble.gatts_write(self.h_meas, _packet(), True)
        STATE["notify_count"] += 1

    def notify_battery(self):
        self.ble.gatts_write(self.h_bat, bytes((STATE["battery"],)), True)


def status():
    return (
        "mode=%s hr=%.1f contact=%d rr=%d energy=%.2fkJ battery=%d adv=%s name=%s conn=%s n=%d up=%.1fs"
        % (
            STATE["mode"], STATE["hr"], STATE["contact"], STATE["rr"],
            STATE["energy_kj"], STATE["battery"], STATE["adv"], STATE["name"],
            STATE["conn"], STATE["notify_count"], STATE["uptime_ms"] / 1000.0,
        )
    )


_MODES = ("cycle", "rest", "fixed", "nocontact", "silent")


def cmd(text):
    """执行一条或多条测试命令（空格或分号分隔），返回状态文本。"""
    results = []
    touched_adv = False
    for item in str(text).replace(";", " ").replace(",", " ").split():
        key, _, value = item.partition("=")
        key = key.strip().lower()
        try:
            result = _one(key, value.strip())
        except Exception as exc:
            result = "ERR %s (%s)" % (item, exc)
        if key in ("name", "adv"):
            touched_adv = True
        if result:
            results.append(result)
    if touched_adv:
        refresh_adv()
    return " | ".join(results) if results else status()


def _one(key, value):
    if key == "hr":
        STATE["mode"] = "fixed"
        STATE["hr_fixed"] = float(value)
        STATE["hr"] = min(220.0, max(35.0, float(value)))  # 固定值立即生效
        return "hr=%.1f (fixed)" % STATE["hr"]
    if key == "mode":
        mode = value.lower()
        if mode not in _MODES:
            raise ValueError("mode 需为 %s" % "/".join(_MODES))
        STATE["mode"] = mode
        if mode == "fixed":
            STATE["hr"] = STATE["hr_fixed"]
        return "mode=%s" % STATE["mode"]
    if key == "contact":
        STATE["contact"] = value.lower() in ("1", "on", "true", "yes")
        return "contact=%d" % STATE["contact"]
    if key == "rr":
        STATE["rr"] = value.lower() in ("1", "on", "true", "yes")
        return "rr=%d" % STATE["rr"]
    if key == "energy":
        STATE["energy"] = value.lower() not in ("0", "off", "false", "no")
        if not STATE["energy"]:
            STATE["energy_kj"] = 0.0
        return "energy=%d %.2fkJ" % (STATE["energy"], STATE["energy_kj"])
    if key == "reset":
        STATE["energy_kj"] = 0.0
        return "energy reset"
    if key == "battery":
        STATE["battery"] = min(100, max(0, int(value)))
        if _hrm is not None:  # 立即写入特征，便于测试马上读到
            _hrm.ble.gatts_write(_hrm.h_bat, bytes((STATE["battery"],)), True)
        return "battery=%d" % STATE["battery"]
    if key == "noise":
        STATE["noise"] = max(0.0, float(value))
        return "noise=%.1f" % STATE["noise"]
    if key in ("name", "adv"):
        if key == "name":
            STATE["name"] = value or STATE["name"]
        else:
            STATE["adv"] = value.lower() in ("1", "on", "true", "yes")
        return "name=%s adv=%s" % (STATE["name"], STATE["adv"])
    if key in ("status", "?"):
        return status()
    if key in ("help",):
        return "hr=N mode=cycle/rest/fixed/nocontact/silent contact=0/1 rr=0/1 energy=0/1 battery=N noise=F name=X adv=on/off status"
    raise ValueError("未知命令")


# ---- 模块级入口：main.py 调 run()，REPL 里调 cmd() ----
_hrm = None


def start():
    """初始化（幂等）：首次注册 GATT，之后只确保在广播。"""
    global _hrm
    if _hrm is None:
        _hrm = VirtualHrm()
    else:
        _hrm._advertise()
    return _hrm


def refresh_adv():
    if _hrm is not None:
        _hrm._advertise()


def stop_adv():
    if _hrm is not None:
        _hrm.ble.gap_advertise(None)


def run(max_seconds=None):
    """主循环：1Hz 推心率，60s 推电量。Ctrl-C 可中断，BLE 连接不受影响。"""
    hrm = start()
    last = time.ticks_ms()
    next_tx = last
    next_bat = time.ticks_add(last, 60000)
    try:
        while True:
            time.sleep_ms(20)
            now = time.ticks_ms()
            dt = time.ticks_diff(now, last)
            last = now
            _update(dt)
            if time.ticks_diff(now, next_tx) >= 0:
                next_tx = time.ticks_add(now, 1000)
                hrm.notify()
            if time.ticks_diff(now, next_bat) >= 0:
                next_bat = time.ticks_add(now, 60000)
                hrm.notify_battery()
            if max_seconds and STATE["uptime_ms"] > max_seconds * 1000:
                return hrm
    except KeyboardInterrupt:
        print("[hrm] 主循环已中断；BLE 保持连接，用 cmd('...') 改参数、run() 继续")
        return hrm


