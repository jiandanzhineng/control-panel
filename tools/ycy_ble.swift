import Foundation
import CoreBluetooth

// 同时覆盖两种拼写:YCY-DJ-v2 与日志里出现的 YYC-DJ-V2;DJ-V2 作为型号精确匹配。
let TARGET_KEYWORDS = ["YCY", "YYC", "YSKJ", "YOKO", "YOKONEX", "YICIYUAN", "DJ-V2", "DJ-V1"]
let SCAN_TIME: TimeInterval = 240         // 持续扫描总时长(秒)
let PROBE_RSSI: NSNumber = -65            // 对无名设备发起"读名字"探测的 RSSI 门槛(越接近 0 越近)
let PROBE_TIMEOUT: TimeInterval = 8       // 单次探测连接超时(不可连接设备会静默挂起,必须超时取消)
let SEND_TIMEOUT: TimeInterval = 8
let FRAMES_PATH = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/ycy_frames.json"
let LOG_PATH = "/tmp/ycy_ble_log.txt"
let GAP_UUID = "00001800-0000-1000-8000-00805f9b34fb"
let NAME_CHAR = "2A00"

func log(_ msg: String) {
    print(msg)
    if let fh = try? FileHandle(forWritingTo: URL(fileURLWithPath: LOG_PATH)) {
        fh.seekToEndOfFile()
        fh.write((msg + "\n").data(using: .utf8)!)
        try? fh.close()
    }
}

func loadFrames() -> [(label: String, bytes: [UInt8], withResponse: Bool)] {
    guard let data = FileManager.default.contents(atPath: FRAMES_PATH),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        log("WARN: cannot load frames from \(FRAMES_PATH); will only dump services.")
        return []
    }
    var out: [(String, [UInt8], Bool)] = []
    for e in arr {
        guard let label = e["label"] as? String, let hex = e["hex"] as? String else { continue }
        var bytes: [UInt8] = []
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            if let b = UInt8(hex[i..<j], radix: 16) { bytes.append(b) }
            i = j
        }
        out.append((label, bytes, (e["withResponse"] as? Bool) ?? false))
    }
    return out
}

class Scanner: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    var central: CBCentralManager!
    var target: CBPeripheral?
    var targetName = ""
    var frames: [(label: String, bytes: [UInt8], withResponse: Bool)]
    var writableChars: [(peripheral: CBPeripheral, service: CBService, char: CBCharacteristic)] = []
    var sentAll = false
    var finished = false
    var unnamed: [String: Int] = [:]
    var probed = Set<String>()
    var probeTarget: CBPeripheral?
    var probingSet = Set<String>()

    init(frames: [(label: String, bytes: [UInt8], withResponse: Bool)]) {
        self.frames = frames
        super.init()
    }

    func run() {
        try? "".write(toFile: LOG_PATH, atomically: true, encoding: .utf8)
        log("[START] \(Date())  YCY native BLE scanner v3 (命名匹配 + 无名读名探测(8s超时), 持续 \(Int(SCAN_TIME))s)")
        central = CBCentralManager(delegate: self, queue: nil)
        RunLoop.main.run(until: Date().addingTimeInterval(SCAN_TIME + 20))
        if !finished { log("[TIMEOUT] 总超时, 未捕获 YCY 设备。"); exit(2) }
    }

    func startScan() { central.scanForPeripherals(withServices: nil, options: nil) }
    func isProbing(_ p: CBPeripheral) -> Bool { probingSet.contains(p.identifier.uuidString) }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn { log("[BT] powered on, scanning…"); startScan() }
        else { log("[BT] state not poweredOn: \(central.state.rawValue)") }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
            ?? peripheral.name ?? "(unknown)"
        let up = name.uppercased()
        log("[SCAN] \(name)  \(peripheral.identifier.uuidString)  rssi=\(RSSI)")
        // 命名命中(优先于挂起探测)
        if target == nil && TARGET_KEYWORDS.contains(where: { up.contains($0) }) {
            log("[SCAN] >>> MATCH(name): \(name)")
            if let pt = probeTarget { central.cancelPeripheralConnection(pt); probingSet.remove(pt.identifier.uuidString); probeTarget = nil }
            central.stopScan()
            target = peripheral; targetName = name
            peripheral.delegate = self
            central.connect(peripheral, options: nil)
            return
        }
        // 无名设备:近距离且未探测过 → 读名探测(带超时)
        if name == "(unknown)" {
            let id = peripheral.identifier.uuidString
            let r = RSSI.intValue
            unnamed[id] = (unnamed[id] == nil) ? r : min(unnamed[id]!, r)
            if r >= PROBE_RSSI.intValue && !probed.contains(id) && target == nil && probeTarget == nil {
                log("[SCAN] 近距离无名设备 (\(id) rssi=\(r)), 发起读名探测(8s 超时)…")
                probed.insert(id)
                probeTarget = peripheral
                probingSet.insert(id)
                peripheral.delegate = self
                central.connect(peripheral, options: nil)
                let pid = id
                DispatchQueue.main.asyncAfter(deadline: .now() + PROBE_TIMEOUT) { [weak self] in
                    guard let self = self, let pt = self.probeTarget, pt.identifier.uuidString == pid else { return }
                    log("[PROBE] 8s 超时未连上, 取消该探测(允许后续重试)")
                    self.central.cancelPeripheralConnection(pt)
                    self.probingSet.remove(pid)
                    self.probed.remove(pid)
                    self.probeTarget = nil
                }
            }
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        if peripheral === target {
            log("[CONN] connected: \(targetName)"); peripheral.discoverServices(nil); return
        }
        if isProbing(peripheral) {
            log("[PROBE] connected, 读 GAP/Device Name…"); peripheral.discoverServices(nil); return
        }
        log("[CONN] stray connect (ignored): \(peripheral.identifier.uuidString)")
        central.cancelPeripheralConnection(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        if isProbing(peripheral) {
            log("[PROBE] connect failed: \(error?.localizedDescription ?? "unknown")")
            probingSet.remove(peripheral.identifier.uuidString); probed.remove(peripheral.identifier.uuidString); probeTarget = nil; return
        }
        log("[CONN] failed: \(error?.localizedDescription ?? "unknown")"); finished = true; exit(1)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        log("[CONN] disconnected: \(error?.localizedDescription ?? "ok")")
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral === target || isProbing(peripheral) else { log("[SVC] ignored (not target)"); return }
        if let e = error { log("[SVC] error: \(e)"); return }
        guard let svcs = peripheral.services else { return }
        if isProbing(peripheral) {
            if let gap = svcs.first(where: { $0.uuid.uuidString.lowercased() == GAP_UUID }) {
                peripheral.discoverCharacteristics([CBUUID(string: NAME_CHAR)], for: gap)
            } else {
                log("[PROBE] 无 GAP 服务, dump 后断开: " + svcs.map { $0.uuid.uuidString }.joined(separator: ", "))
                central.cancelPeripheralConnection(peripheral)
            }
            return
        }
        log("[SVC] discovered \(svcs.count) services:")
        for svc in svcs { log("  SERVICE \(svc.uuid.uuidString)"); peripheral.discoverCharacteristics(nil, for: svc) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let e = error { log("[CHAR] error: \(e)"); return }
        guard let chars = service.characteristics else { return }
        if isProbing(peripheral) && service.uuid.uuidString.lowercased() == GAP_UUID {
            if let nc = chars.first(where: { $0.uuid.uuidString.lowercased() == NAME_CHAR }) {
                peripheral.readValue(for: nc)
            } else { log("[PROBE] GAP 无 Device Name 特征, 断开"); central.cancelPeripheralConnection(peripheral) }
            return
        }
        guard peripheral === target else { return }
        for ch in chars {
            var ps: [String] = []
            if ch.properties.contains(.read) { ps.append("read") }
            if ch.properties.contains(.write) { ps.append("write") }
            if ch.properties.contains(.writeWithoutResponse) { ps.append("writeWithoutResponse") }
            if ch.properties.contains(.notify) { ps.append("notify") }
            if ch.properties.contains(.indicate) { ps.append("indicate") }
            log("    CHAR \(ch.uuid.uuidString)  [\(ps.joined(separator: ","))]  svc=\(service.uuid.uuidString)")
            if ch.properties.contains(.write) || ch.properties.contains(.writeWithoutResponse) {
                writableChars.append((peripheral, service, ch))
            }
            if ch.properties.contains(.notify) || ch.properties.contains(.indicate) {
                peripheral.setNotifyValue(true, for: ch)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.sendFrames() }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if isProbing(peripheral) && characteristic.uuid.uuidString.lowercased() == NAME_CHAR {
            if let v = characteristic.value, let nm = String(data: v, encoding: .utf8) {
                let up = nm.uppercased()
                log("[PROBE] Device Name = \"\(nm)\"")
                if TARGET_KEYWORDS.contains(where: { up.contains($0) }) {
                    log("[PROBE] >>> 命中 YCY 设备! 转为目标并 dump 服务/发帧")
                    probingSet.remove(peripheral.identifier.uuidString)
                    target = peripheral; targetName = nm
                    for svc in peripheral.services ?? [] {
                        log("  SERVICE \(svc.uuid.uuidString)")
                        peripheral.discoverCharacteristics(nil, for: svc)
                    }
                } else { log("[PROBE] 非 YCY (\(nm)), 断开"); central.cancelPeripheralConnection(peripheral) }
            } else { log("[PROBE] 读名字失败, 断开"); central.cancelPeripheralConnection(peripheral) }
            return
        }
        if let v = characteristic.value {
            let hex = v.map { String(format: "%02X", $0) }.joined()
            log("[NOTIFY] ← \(characteristic.uuid.uuidString): \(hex)")
        } else if let e = error { log("[NOTIFY] error \(characteristic.uuid.uuidString): \(e)") }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let e = error { log("[WRITE-ERR] \(characteristic.uuid.uuidString): \(e)") }
    }

    func sendFrames() {
        guard !sentAll else { return }
        sentAll = true
        if frames.isEmpty { log("[SEND] no frames; finishing."); finish(); return }
        log("[SEND] sending \(frames.count) frames × \(writableChars.count) writable chars:")
        var delay: TimeInterval = 0
        for f in frames {
            for wc in writableChars {
                let d = delay, label = f.label, bytes = f.bytes, wr = f.withResponse
                DispatchQueue.main.asyncAfter(deadline: .now() + d) {
                    let data = Data(bytes)
                    let type: CBCharacteristicWriteType = wr ? .withResponse : .withoutResponse
                    let hex = bytes.map { String(format: "%02X", $0) }.joined()
                    log("  → [\(label)] svc=\(wc.service.uuid.uuidString) char=\(wc.char.uuid.uuidString) hex=\(hex)")
                    wc.peripheral.writeValue(data, for: wc.char, type: type)
                }
            }
            delay += 0.4
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay + SEND_TIMEOUT) { [weak self] in self?.finish() }
    }

    func finish() {
        guard !finished else { return }
        finished = true
        log("[DONE] device=\(targetName)  writableChars=\(writableChars.count)")
        log("[SUMMARY] 把上面 SERVICE/CHAR/NOTIFY 行发我即可定位真实 UUID 与泵命令语义。")
        exit(0)
    }
}

let frames = loadFrames()
let scanner = Scanner(frames: frames)
scanner.run()
