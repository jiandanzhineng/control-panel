# -*- coding: utf-8 -*-
"""虚拟心率带（ESP32-C3 / tools/hrm-c3-mock）主机侧自动化测试。

覆盖：标准广播、GATT 结构、身份/设备信息、实时心率订阅、场景命令、
      接触丢失、无 RR、静默（无数据）、电量读取。

用法（已装 bleak 的解释器均可）：
  python host_test.py            # 自动找 HRM-Virtual
  python host_test.py --hrs 3    # 每个场景采样秒数（默认 3）
"""
import argparse
import asyncio
import time

from bleak import BleakClient, BleakScanner

NAME = "HRM-Virtual"
HR_MEAS = "00002a37-0000-1000-8000-00805f9b34fb"
HR_LOC = "00002a38-0000-1000-8000-00805f9b34fb"
BAT_LVL = "00002a19-0000-1000-8000-00805f9b34fb"
MFR_NAME = "00002a29-0000-1000-8000-00805f9b34fb"
MODEL_NO = "00002a24-0000-1000-8000-00805f9b34fb"
SERIAL_NO = "00002a25-0000-1000-8000-00805f9b34fb"
FW_REV = "00002a26-0000-1000-8000-00805f9b34fb"
IDENT = "0000ff04-0000-1000-8000-00805f9b34fb"
CTRL_W = "0000ffe1-0000-1000-8000-00805f9b34fb"
HRS_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb"

results = []
samples = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print("  [%s] %s %s" % ("PASS" if ok else "FAIL", name, detail), flush=True)


def parse(data):
    flags = data[0]
    wide = flags & 0x01
    hr = int.from_bytes(data[1:3], "little") if wide else data[1]
    idx = 3 if wide else 2
    energy = None
    rr = []
    if flags & 0x08:
        energy = int.from_bytes(data[idx:idx + 2], "little")
        idx += 2
    if flags & 0x10:
        while idx + 1 < len(data):
            rr.append(int.from_bytes(data[idx:idx + 2], "little"))
            idx += 2
    return {
        "flags": flags,
        "hr": hr,
        # Sensor Contact 两位字段：bit2 = 支持检测，bit1 = 已检测到接触。
        "contact_supported": bool(flags & 0x04),
        "contact": bool(flags & 0x02),
        "energy": energy,
        "rr": rr,
    }


async def scan_target(timeout=12.0):
    found = {}

    def cb(device, adv):
        found[device.address] = (device, adv)

    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    await asyncio.sleep(timeout)
    await scanner.stop()
    for addr, (device, adv) in found.items():
        name = adv.local_name or device.name or ""
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        if name == NAME or HRS_SERVICE in uuids:
            return device, adv, len(found)
    return None, None, len(found)


def on_notify(_sender, data):
    samples.append((time.time(), parse(bytes(data))))


async def connect_with_retry(device, attempts=3):
    """板子刚复位时 WinRT 偶发找不到设备，重试几次再连。"""
    last = None
    for i in range(attempts):
        try:
            client = BleakClient(device, timeout=20.0)
            await client.connect()
            return client
        except Exception as exc:  # noqa: BLE001
            last = exc
            print("  连接重试 %d/%d：%r" % (i + 1, attempts, exc), flush=True)
            await asyncio.sleep(2.0)
    raise last


CTRL_N = "0000ffe2-0000-1000-8000-00805f9b34fb"  # 状态回读


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hrs", type=float, default=3.0, help="每个场景采样秒数")
    parser.add_argument("--addr", default="", help="直接指定 BLE 地址")
    args = parser.parse_args()

    print("== 1. 标准广播扫描（找 0x180D / %s）==" % NAME, flush=True)
    device, adv, total = await scan_target()
    check("附近能找到 %s" % NAME, device is not None,
          "%s，共 %d 个广播设备" % (device.address if device else "未发现", total))
    if device is None:
        return 1
    uuids = [u.lower() for u in (adv.service_uuids or [])]
    check("广播里带标准心率服务 0x180D", HRS_SERVICE in uuids, str(uuids))
    check("广播名正确", (adv.local_name or "") == NAME, adv.local_name or "")

    async with await connect_with_retry(device) as client:
        print("\n== 2. GATT 结构与身份 ==", flush=True)
        svc = [s.uuid.lower() for s in client.services]
        chars = [c.uuid.lower() for s in client.services for c in s.characteristics]
        check("含 Heart Rate 服务", HRS_SERVICE in svc)
        check("含 Device Info(0x180A) 与面板身份服务(0x00FF)",
              "0000180a-0000-1000-8000-00805f9b34fb" in svc and "000000ff-0000-1000-8000-00805f9b34fb" in svc,
              str([u[:8] for u in svc]))
        check("心率/电量/身份特征齐全",
              all(u in chars for u in (HR_MEAS, BAT_LVL, SERIAL_NO, IDENT)), str(len(chars)) + " 个特征")
        serial = (await client.read_gatt_char(SERIAL_NO)).decode()
        check("序列号 = 基础 MAC 6055f97c342c", serial.lower() == "6055f97c342c", serial)
        mfr = (await client.read_gatt_char(MFR_NAME)).decode()
        model = (await client.read_gatt_char(MODEL_NO)).decode()
        fw = (await client.read_gatt_char(FW_REV)).decode()
        check("厂商/型号/固件可读",
              mfr == "UnderSilicon Test" and model == "HRM-C3-MOCK" and fw.startswith("v"),
              "%s / %s / %s" % (mfr, model, fw))
        ident = (await client.read_gatt_char(IDENT)).decode()
        check("0xFF04 身份 JSON 符合 ADR0010",
              ('"device_id":"%s"' % serial.lower()) in ident and "firmware_version" in ident, ident)
        check("佩戴位置 = 胸部(1)", (await client.read_gatt_char(HR_LOC))[0] == 1)
        return await scenarios(client, args.hrs)


async def send_cmd(client, text):
    await client.write_gatt_char(CTRL_W, text.encode(), response=True)
    await asyncio.sleep(0.3)


async def sample(client, secs):
    samples.clear()
    await asyncio.sleep(secs)
    return [parsed for _, parsed in samples]


async def scenarios(client, secs):
    print("\n== 3. 场景命令（写 0xFFE1）==", flush=True)
    await client.start_notify(HR_MEAS, on_notify)

    await send_cmd(client, "mode=fixed hr=120 noise=0")
    got = await sample(client, secs)
    hrs = [s["hr"] for s in got]
    check("固定 120bpm：读数恒定", bool(hrs) and min(hrs) == 120 and max(hrs) == 120,
          "%d 帧 %s" % (len(hrs), hrs[:5]))
    check("上报速率约 1Hz", secs - 1 <= len(got) <= secs + 2, "%d 帧 / %.0fs" % (len(got), secs))
    last = got[-1] if got else {}
    check("帧内带 RR 间期与能量消耗", bool(last.get("rr")) and last.get("energy") is not None,
          "rr=%s energy=%s" % (last.get("rr"), last.get("energy")))

    await send_cmd(client, "contact=0")
    got = await sample(client, secs)
    check("接触丢失：contact 标志=0 且心率报 0",
          bool(got) and all((not s["contact"]) and s["hr"] == 0 for s in got), "%d 帧" % len(got))
    check("接触丢失帧仍声明支持检测（flags=0x04，Sensor Contact=0b01）",
          bool(got) and all(s["contact_supported"] for s in got),
          "flags=%s" % (hex(got[-1]["flags"]) if got else "-"))

    await send_cmd(client, "contact=1 rr=0")
    got = await sample(client, secs)
    check("关闭 RR：帧里没有 RR 字段", bool(got) and all(not s["rr"] for s in got),
          "flags=%s" % (hex(got[-1]["flags"]) if got else "-"))

    await send_cmd(client, "rr=1 battery=42")
    await sample(client, 1.0)
    batt = (await client.read_gatt_char(BAT_LVL))[0]
    check("电量可设置并立即读到", batt == 42, "battery=%d" % batt)

    await send_cmd(client, "mode=silent")
    got = await sample(client, secs)
    check("静默：连接保持但不再上报（模拟无数据）", len(got) == 0, "收到 %d 帧" % len(got))

    await send_cmd(client, "mode=rest noise=1")
    got = await sample(client, secs + 15)  # 一阶惯性收敛，约 8s 时间常数
    hrs = [s["hr"] for s in got]
    check("恢复静息：心率单调回落到 60~80",
          bool(hrs) and hrs[0] > hrs[-1] and 60 <= hrs[-1] <= 80,
          "%d 帧 %s ... %s" % (len(hrs), hrs[:4], hrs[-3:]))
    check("静息帧仍带 RR", bool(got) and bool(got[-1]["rr"]))

    await send_cmd(client, "mode=cycle noise=1.5")
    status = (await client.read_gatt_char(CTRL_N)).decode()
    check("回到自主循环模式并可回读状态", "mode=cycle" in status, status)
    await client.stop_notify(HR_MEAS)


def summary():
    failed = [row for row in results if not row[1]]
    print("\n===== 结果：%d 通过 / %d 失败 =====" % (len(results) - len(failed), len(failed)), flush=True)
    for name, _, detail in failed:
        print("  FAIL: %s %s" % (name, detail))
    return 1 if failed else 0


if __name__ == "__main__":
    code = 0
    try:
        code = asyncio.run(main())
    except Exception as exc:
        print("测试异常: %r" % (exc,))
        code = 2
    raise SystemExit(summary() or code)


