// YCY native BLE <-> HTTP bridge daemon.
// 用 CoreBluetooth 真正连接设备(绕过 macOS Web Bluetooth 对自定义 GATT 的 No Services found 限制),
// 自动发现并缓存真实 SERVICE/CHAR UUID,订阅通知;同时内嵌一个本地 HTTP 服务(端口 3001)托管控制面板,
// 浏览器只通过 localhost 发指令。
//
// 用法:
//   ./ycy_bridge                       # 普通模式:扫描并自动连 YCY 设备
//   ./ycy_bridge <addr>                # 指定连接某个 peripheral UUID(例如 76539FA8-...)
//   ./ycy_bridge -port 3100            # 换端口
//
// 编译:
//   swiftc ycy_bridge.swift -framework CoreBluetooth -framework Network -o ycy_bridge

import Foundation
import CoreBluetooth
import Network

// ======================= 全局状态 =======================
let DEFAULT_PORT = 3001
var PORT = DEFAULT_PORT

var central: CBCentralManager!
var bluetoothOn = false

var discovered: [String: CBPeripheral] = [:]          // id(uuidString) -> peripheral
var connectingId: String? = nil
var target: CBPeripheral? = nil

// 每个设备元信息(含真实服务/特征 UUID)
var deviceMeta: [String: [String: Any]] = [:]         // id -> [name, rssi, ready, services:[[...]]]
// 可序列化的服务/特征明细(用于 /api/devices 展示真实 UUID)
var deviceServices: [String: [[String: Any]]] = [:]    // id -> [[uuid, chars:[[uuid,props]]]]
// 连接后选中的写/通知特征
var connectInfo: [String: [String: String]] = [:]     // id -> [service, write, notify]
// 真实对象引用(用于写/订阅)
var svcRefs: [String: [CBUUID: CBService]] = [:]
var charRefs: [String: [CBUUID: CBCharacteristic]] = [:]
// 通知日志 id -> [hex]
var notifications: [String: [String]] = [:]
// 电量特征引用 id -> CBCharacteristic(连接就绪后读一次并订阅)
var batteryChars: [String: CBCharacteristic] = [:]
// 发现计数(用于去重日志)
var seenNames: Set<String> = []

// 待处理连接地址(命令行指定)
var explicitAddr: String? = nil

// 设备名识别(读 GATT Device Name 0x2A00)状态
var identifyQueue: [String] = []
var identifyingId: String? = nil
var identifyMode: Set<String> = []      // 当前正以识别为目的连接的设备
var identifyOnly: Set<String> = []      // 本次会话属于"仅识别"的设备(不要当成控制目标自动重连)
var identifyNameFound: Set<String> = [] // 已在服务里找到 0x2A00 特征
var identifiedSet: Set<String> = []     // 已成功识别过设备名的 id(避免重复识别)
var identifyFailed: Set<String> = []    // 识别失败/超时, 不再重试
let IDENTIFY_RSSI_THRESHOLD = -60       // 仅识别信号够强的附近设备
let IDENTIFY_MAX_QUEUE = 40
let DEVICE_NAME_CHAR = CBUUID(string: "2A00")
// 标准电池服务 / 电量特征
let BATTERY_SERVICE = CBUUID(string: "180F")
let BATTERY_CHAR = CBUUID(string: "2A19")

let TARGET_KEYWORDS = ["YCY", "YYC", "YSKJ", "YOKO", "YOKONEX", "YISK", "DJ-V2", "YICIYUAN", "DJ"]

// 已知候选服务(自动发现失败时的兜底;优先选这些服务下的写特征)
let CANDIDATE_SERVICES: [String] = [
    "0000ff30-0000-1000-8000-00805f9b34fb",   // YYC-DJ-V2 实测命令服务
    "0000ff40-0000-1000-8000-00805f9b34fb",   // 老玩具(buttplug.io)
    "98a9cd00-ca0a-4cf8-9f85-e93949467558",   // 电刺激 EMS
    "6e400001-b5a3-f393-e0a9-e50e24dcca9e",   // Nordic UART
]

let logQueue = DispatchQueue(label: "ycy.log")
func log(_ s: String) {
    logQueue.async { print(s); fflush(stdout) }
}

// ======================= 工具 =======================
func dataFromHex(_ s: String) -> Data? {
    var s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "0x", with: "")
        .replacingOccurrences(of: " ", with: "")
        .replacingOccurrences(of: ",", with: "")
    s = s.uppercased()
    guard s.count % 2 == 0, !s.isEmpty else { return nil }
    var bytes = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let next = s.index(i, offsetBy: 2, limitedBy: s.endIndex) ?? s.endIndex
        guard let b = UInt8(s[i..<next], radix: 16) else { return nil }
        bytes.append(b)
        i = next
    }
    return bytes
}

func hexFromData(_ d: Data) -> String {
    return d.map { String(format: "%02X", $0) }.joined()
}

func matchesKeyword(_ name: String?) -> Bool {
    guard let n = name, !n.isEmpty else { return false }
    let u = n.uppercased()
    return TARGET_KEYWORDS.contains { u.contains($0.uppercased()) }
}

func queryValue(_ name: String, from query: String) -> String? {
    for part in query.split(separator: "&") {
        let kv = part.split(separator: "=", maxSplits: 1)
        if kv.count == 2, kv[0] == name {
            return String(kv[1]).removingPercentEncoding
        }
    }
    return nil
}

// 资源读取(同目录下的 html / js)
func resourcePath(_ name: String) -> String? {
    let exe = CommandLine.arguments[0]
    let dir = (exe as NSString).deletingLastPathComponent
    let p = (dir as NSString).appendingPathComponent(name)
    return FileManager.default.fileExists(atPath: p) ? p : nil
}

// ======================= CBCentralManagerDelegate =======================
class CentralDelegate: NSObject, CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        bluetoothOn = (central.state == .poweredOn)
        log("[BT] state=\(central.state.rawValue) (\(bluetoothOn ? "on" : "off"))")
        if central.state == .poweredOn {
            startScan()
        }
    }

    func startScan() {
        guard bluetoothOn else { return }
        central.scanForPeripherals(withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        log("[SCAN] 开始扫描(持续) …")
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi: NSNumber) {
        let id = peripheral.identifier.uuidString
        let localName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
            ?? peripheral.name
        let isTarget = matchesKeyword(localName) || matchesKeyword(peripheral.name)
        if let nm = localName, !seenNames.contains(nm) {
            seenNames.insert(nm)
            log("[SCAN] \(nm)  \(id)  rssi=\(rssi.intValue)\(isTarget ? "  <== YCY 候选" : "")")
        }
        discovered[id] = peripheral
        var meta = deviceMeta[id] ?? [:]
        meta["name"] = localName ?? peripheral.name as Any
        meta["rssi"] = rssi.intValue
        deviceMeta[id] = meta

        // 未命名且信号够强 -> 入队识别设备名(读 GATT 0x2A00)
        if (meta["name"] as? String)?.isEmpty != false,
           rssi.intValue >= IDENTIFY_RSSI_THRESHOLD,
           !identifiedSet.contains(id),
           !identifyFailed.contains(id),
           !identifyOnly.contains(id),
           identifyQueue.count < IDENTIFY_MAX_QUEUE {
            identifyQueue.append(id)
            processIdentifyQueue()
        }

        // 自动连接:未连接且命中关键字(或是指令指定的地址)
        if isTarget, target == nil, connectingId == nil {
            if explicitAddr == nil || explicitAddr == id {
                connect(to: peripheral, id: id)
            }
        }
    }

    func connect(to peripheral: CBPeripheral, id: String) {
        connectingId = id
        target = peripheral
        peripheral.delegate = PeripheralDelegate.shared
        log("[CONN] 连接 \(deviceMeta[id]?["name"] ?? id) …")
        central.connect(peripheral, options: nil)
    }

    // ---- 设备名识别(读 GATT Device Name 0x2A00) ----
    func processIdentifyQueue() {
        guard identifyingId == nil, !identifyQueue.isEmpty, bluetoothOn else { return }
        let id = identifyQueue.removeFirst()
        guard let p = discovered[id] else { processIdentifyQueue(); return }
        identifyingId = id
        identifyMode.insert(id)
        identifyOnly.insert(id)
        identifyNameFound.remove(id)
        p.delegate = PeripheralDelegate.shared
        log("[IDENTIFY] 连接以读取设备名 \(id) …")
        central.connect(p, options: nil)
        // 超时保护: 8s 内未识别完则跳过, 避免堵死队列
        let idCopy = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            if identifyingId == idCopy, identifyMode.contains(idCopy) {
                log("[IDENTIFY] 超时跳过 \(idCopy)")
                if let pp = discovered[idCopy] { central.cancelPeripheralConnection(pp) }
            }
        }
    }

    func endIdentify(_ id: String) {
        identifyMode.remove(id)
        identifyOnly.remove(id)
        identifyNameFound.remove(id)
        if identifyingId == id { identifyingId = nil }
        if !identifiedSet.contains(id) { identifyFailed.insert(id) }
        processIdentifyQueue()
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        let id = peripheral.identifier.uuidString
        if identifyMode.contains(id) {
            log("[IDENTIFY] 已连接, 发现服务以读取设备名…")
            peripheral.discoverServices(nil)
            return
        }
        log("[CONN] 已连接 \(deviceMeta[id]?["name"] ?? id), 发现服务…")
        svcRefs[id] = [:]
        charRefs[id] = [:]
        notifications[id] = []
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        let id = peripheral.identifier.uuidString
        if identifyOnly.contains(id) {
            log("[IDENTIFY] 连接失败 \(id): \(error?.localizedDescription ?? "")")
            endIdentify(id)
            return
        }
        log("[CONN] 连接失败 \(deviceMeta[id]?["name"] ?? id): \(error?.localizedDescription ?? "unknown")")
        if connectingId == id { connectingId = nil; target = nil }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        let id = peripheral.identifier.uuidString
        if identifyOnly.contains(id) {
            log("[IDENTIFY] 识别连接断开 \(id)")
            endIdentify(id)
            return
        }
        log("[CONN] 断开 \(deviceMeta[id]?["name"] ?? id)\(error != nil ? " (err: \(error!.localizedDescription))" : "")")
        connectInfo[id] = [:]
        batteryChars[id] = nil
        var meta = deviceMeta[id] ?? [:]
        meta["ready"] = false
        meta["battery"] = nil
        deviceMeta[id] = meta
        if connectingId == id { connectingId = nil }
        if target?.identifier.uuidString == id { target = nil }
        // 尝试重连(若仍是目标)
        if let p = discovered[id], (explicitAddr == nil || explicitAddr == id), bluetoothOn {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                log("[CONN] 1.5s 后重连 \(id) …")
                central.connect(p, options: nil)
            }
        }
    }
}

// ======================= CBPeripheralDelegate =======================
class PeripheralDelegate: NSObject, CBPeripheralDelegate {
    static let shared = PeripheralDelegate()
    var pendingChars = 0
    var pendingSVC: String?

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        let id = peripheral.identifier.uuidString
        if let error = error { log("[SVC] 发现服务出错: \(error.localizedDescription)"); return }
        guard let services = peripheral.services, !services.isEmpty else {
            log("[SVC] 无服务(设备可能仍处异常态)"); return
        }
        log("[SVC] 发现 \(services.count) 个服务:")
        var svcList: [[String: Any]] = []
        if svcRefs[id] == nil { svcRefs[id] = [:] }
        for svc in services {
            log("      - \(svc.uuid.uuidString)")
            svcRefs[id]![svc.uuid] = svc
            svcList.append(["uuid": svc.uuid.uuidString, "chars": []])
        }
        deviceServices[id] = svcList
        var meta = deviceMeta[id] ?? [:]
        meta["services"] = svcList
        deviceMeta[id] = meta
        for svc in services {
            peripheral.discoverCharacteristics(nil, for: svc)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let id = peripheral.identifier.uuidString
        if let error = error { log("[CHAR] 发现特征出错: \(error.localizedDescription)"); return }
        // 识别模式: 找 0x2A00(Device Name) 并读取, 找不到则放弃
        if identifyMode.contains(id) {
            if let chars = service.characteristics {
                for ch in chars where ch.uuid == DEVICE_NAME_CHAR {
                    identifyNameFound.insert(id)
                    peripheral.readValue(for: ch)
                }
            }
            if allCharsDiscovered(peripheral), !identifyNameFound.contains(id) {
                centralDelegate.endIdentify(id)
            }
            return
        }
        guard let chars = service.characteristics else { return }
        for ch in chars {
            if charRefs[id] == nil { charRefs[id] = [:] }
            charRefs[id]![ch.uuid] = ch
            let props = charProps(ch)
            log("      [CHAR] \(ch.uuid.uuidString)  props=\(props.joined(separator: ","))")
            // 写入可序列化明细
            if var list = deviceServices[id] {
                for idx in 0..<list.count where (list[idx]["uuid"] as? String) == service.uuid.uuidString {
                    var entry = list[idx]
                    var chArr = (entry["chars"] as? [[String: Any]]) ?? []
                    chArr.append(["uuid": ch.uuid.uuidString, "props": props])
                    entry["chars"] = chArr
                    list[idx] = entry
                    break
                }
                deviceServices[id] = list
            }
        }
        // 所有服务特征都发现完后,挑选写/通知特征并订阅
        if allCharsDiscovered(peripheral) {
            finalizeConnection(peripheral)
        }
    }

    func allCharsDiscovered(_ peripheral: CBPeripheral) -> Bool {
        guard let services = peripheral.services else { return false }
        for svc in services {
            guard let chars = svc.characteristics, !chars.isEmpty else { return false }
        }
        return true
    }

    func finalizeConnection(_ peripheral: CBPeripheral) {
        let id = peripheral.identifier.uuidString
        guard let services = peripheral.services else { return }
        var writeChar: CBCharacteristic?
        var notifyChar: CBCharacteristic?
        // 优先匹配已知候选服务里的写特征
        for svc in services {
            guard let chars = svc.characteristics else { continue }
            for ch in chars {
                if ch.properties.contains(.write) || ch.properties.contains(.writeWithoutResponse) {
                    if CANDIDATE_SERVICES.contains(svc.uuid.uuidString.lowercased())
                        || CANDIDATE_SERVICES.contains(svc.uuid.uuidString) {
                        writeChar = ch
                    } else if writeChar == nil {
                        writeChar = ch
                    }
                }
                if (ch.properties.contains(.notify) || ch.properties.contains(.indicate)) && notifyChar == nil {
                    notifyChar = ch
                }
            }
        }
        if let wc = writeChar {
            connectInfo[id] = [
                "service": wc.service?.uuid.uuidString ?? "",
                "write": wc.uuid.uuidString,
                "notify": notifyChar?.uuid.uuidString ?? "",
            ]
            log("[READY] 选中写特征 \(wc.service?.uuid.uuidString ?? "?") / \(wc.uuid.uuidString); 通知=\(notifyChar?.uuid.uuidString ?? "无")")
        } else {
            log("[READY] 未发现可写特征! 设备可能不支持 BLE 直控")
        }
        if let nc = notifyChar {
            peripheral.setNotifyValue(true, for: nc)
        }
        // 电量: 找标准 Battery Service 0x180F / Battery Level 0x2A19, 读一次并订阅
        if let bc = findBatteryChar(peripheral) {
            batteryChars[id] = bc
            peripheral.readValue(for: bc)
            if bc.properties.contains(.notify) || bc.properties.contains(.indicate) {
                peripheral.setNotifyValue(true, for: bc)
            }
            log("[BATTERY] 发现电量特征 \(bc.uuid.uuidString), 读取中…")
        }
        var meta = deviceMeta[id] ?? [:]
        meta["ready"] = true
        deviceMeta[id] = meta
        connectingId = nil
    }

    // 在已发现的服务里查找标准电量特征
    func findBatteryChar(_ peripheral: CBPeripheral) -> CBCharacteristic? {
        guard let services = peripheral.services else { return nil }
        for svc in services where svc.uuid == BATTERY_SERVICE {
            if let chars = svc.characteristics {
                for ch in chars where ch.uuid == BATTERY_CHAR { return ch }
            }
        }
        return nil
    }

    func charProps(_ ch: CBCharacteristic) -> [String] {
        var p: [String] = []
        if ch.properties.contains(.read) { p.append("read") }
        if ch.properties.contains(.write) { p.append("write") }
        if ch.properties.contains(.writeWithoutResponse) { p.append("writeWithoutResponse") }
        if ch.properties.contains(.notify) { p.append("notify") }
        if ch.properties.contains(.indicate) { p.append("indicate") }
        return p
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        let id = peripheral.identifier.uuidString
        // 电量特征: 标准 Battery Level, 单字节百分比
        if characteristic.uuid == BATTERY_CHAR {
            if let v = characteristic.value, let level = v.first {
                var m = deviceMeta[id] ?? [:]
                m["battery"] = Int(level)
                deviceMeta[id] = m
                log("[BATTERY] \(id) 电量 \(level)%")
            } else {
                log("[BATTERY] \(id) 读到的电量值为空")
            }
            return
        }
        // 识别模式: 读到设备名后回填并断开
        if identifyMode.contains(id), characteristic.uuid == DEVICE_NAME_CHAR {
            if let v = characteristic.value,
               let name = String(data: v, encoding: .utf8), !name.isEmpty {
                var m = deviceMeta[id] ?? [:]
                m["name"] = name
                deviceMeta[id] = m
                identifiedSet.insert(id)
                log("[IDENTIFY] 设备名: \(name)  (\(id))")
            } else {
                log("[IDENTIFY] 0x2A00 无有效名称 \(id)")
            }
            central.cancelPeripheralConnection(peripheral)
            return
        }
        if let error = error { log("[NOTIFY] 读值出错: \(error.localizedDescription)"); return }
        guard let v = characteristic.value else { return }
        let hex = hexFromData(v)
        log("[NOTIFY] \(characteristic.uuid.uuidString) <- \(hex)")
        notifications[id, default: []].append(hex)
        if notifications[id]!.count > 200 { notifications[id]!.removeFirst() }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error { log("[WRITE] 写失败 \(characteristic.uuid.uuidString): \(error.localizedDescription)") }
    }
}

// ======================= HTTP 服务 =======================
let centralDelegate = CentralDelegate()

func buildHTTP(status: Int, body: Data, contentType: String) -> Data {
    var header = "HTTP/1.1 \(status) OK\r\n"
    header += "Content-Type: \(contentType); charset=utf-8\r\n"
    header += "Content-Length: \(body.count)\r\n"
    header += "Connection: close\r\n"
    header += "Access-Control-Allow-Origin: *\r\n"
    header += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
    header += "Access-Control-Allow-Headers: Content-Type\r\n"
    header += "\r\n"
    return Data(header.utf8) + body
}

func jsonBody(_ obj: Any) -> Data {
    if let d = try? JSONSerialization.data(withJSONObject: obj) { return d }
    return Data("{}".utf8)
}

func deviceListJSON() -> [[String: Any]] {
    var arr: [[String: Any]] = []
    for (id, meta) in deviceMeta {
        var e: [String: Any] = [:]
        e["id"] = id
        e["name"] = meta["name"] ?? ""
        e["rssi"] = meta["rssi"] ?? 0
        e["ready"] = meta["ready"] ?? false
        if let b = meta["battery"] { e["battery"] = b }
        e["services"] = deviceServices[id] ?? []
        e["connection"] = connectInfo[id] ?? [:]
        e["isTarget"] = (connectingId == id || target?.identifier.uuidString == id)
        arr.append(e)
    }
    return arr
}

func handleRequest(_ conn: NWConnection, _ method: String, _ path: String, _ query: String, _ body: Data) {
    let p = path.isEmpty ? "/" : path
    // CORS 预检
    if method == "OPTIONS" {
        conn.send(content: buildHTTP(status: 204, body: Data(), contentType: "text/plain"), completion: .contentProcessed({ _ in conn.cancel() }))
        return
    }
    if method == "GET" && (p == "/" || p == "/index.html") {
        if let rp = resourcePath("bridge-control.html"), let data = FileManager.default.contents(atPath: rp) {
            conn.send(content: buildHTTP(status: 200, body: data, contentType: "text/html"), completion: .contentProcessed({ _ in conn.cancel() }))
        } else {
            let msg = "<h1>YCY Bridge</h1><p>未找到 bridge-control.html(应与本程序同目录)。</p>"
            conn.send(content: buildHTTP(status: 200, body: Data(msg.utf8), contentType: "text/html"), completion: .contentProcessed({ _ in conn.cancel() }))
        }
        return
    }
    if method == "GET" && p == "/api/status" {
        let resp: [String: Any] = [
            "bluetoothOn": bluetoothOn,
            "explicitAddr": explicitAddr ?? "",
            "devices": deviceListJSON(),
            "notifications": notifications,
        ]
        conn.send(content: buildHTTP(status: 200, body: jsonBody(resp), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
        return
    }
    if method == "GET" && p == "/api/devices" {
        conn.send(content: buildHTTP(status: 200, body: jsonBody(["devices": deviceListJSON()]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
        return
    }
    if method == "POST" && p == "/api/rescan" {
        centralDelegate.startScan()
        conn.send(content: buildHTTP(status: 200, body: jsonBody(["ok": true, "msg": "rescan started"]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
        return
    }
    if method == "POST" && p == "/api/connect" {
        let addr = queryValue("addr", from: query)
        var targetId: String?
        if let addr = addr, !addr.isEmpty {
            if discovered[addr] != nil { targetId = addr }
            else {
                // 可能传入的是名字片段
                for (id, meta) in deviceMeta where (meta["name"] as? String)?.uppercased().contains(addr.uppercased()) == true {
                    targetId = id; break
                }
            }
        } else {
            // 连第一个 YCY 候选
            for (id, meta) in deviceMeta where matchesKeyword(meta["name"] as? String) { targetId = id; break }
            if targetId == nil, let first = deviceMeta.keys.first { targetId = first }
        }
        guard let tid = targetId, let periph = discovered[tid] else {
            conn.send(content: buildHTTP(status: 404, body: jsonBody(["ok": false, "msg": "未找到目标设备, 请确认设备已开机且在范围内"]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
            return
        }
        explicitAddr = tid
        centralDelegate.connect(to: periph, id: tid)
        conn.send(content: buildHTTP(status: 200, body: jsonBody(["ok": true, "id": tid, "msg": "connecting"]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
        return
    }
    if method == "POST" && p == "/api/disconnect" {
        let addr = queryValue("addr", from: query)
        if let addr = addr, let periph = discovered[addr] {
            central.cancelPeripheralConnection(periph)
            conn.send(content: buildHTTP(status: 200, body: jsonBody(["ok": true, "msg": "disconnecting \(addr)"]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
        } else {
            if let t = target { central.cancelPeripheralConnection(t) }
            conn.send(content: buildHTTP(status: 200, body: jsonBody(["ok": true, "msg": "disconnecting target"]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
        }
        return
    }
    if method == "POST" && p == "/api/identify" {
        let id = queryValue("id", from: query)
        guard let id = id, !id.isEmpty, discovered[id] != nil else {
            conn.send(content: buildHTTP(status: 404, body: jsonBody(["ok": false, "msg": "未找到该设备, 请确认 id 正确且设备已开机"]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
            return
        }
        if !identifyOnly.contains(id) { identifyQueue.append(id); centralDelegate.processIdentifyQueue() }
        conn.send(content: buildHTTP(status: 200, body: jsonBody(["ok": true, "msg": "identifying", "id": id]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
        return
    }
    if method == "POST" && p == "/api/send" {
        // body: {"addr":"...", "frame":"35120047"} 或 {"addr":"...", "frames":["3512..","..."]}
        var payload: [String: Any] = [:]
        if let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] { payload = obj }
        let addr = (payload["addr"] as? String) ?? queryValue("addr", from: query)
        let frames: [String]
        if let f = payload["frame"] as? String { frames = [f] }
        else if let fa = payload["frames"] as? [String] { frames = fa }
        else { frames = [] }

        // 解析写特征覆盖(可选)
        let writeOverride = payload["write"] as? String

        let targetId: String? = {
            if let addr = addr, !addr.isEmpty, let _ = discovered[addr] { return addr }
            if let t = target { return t.identifier.uuidString }
            return connectInfo.keys.first
        }()
        guard let tid = targetId, let periph = discovered[tid] else {
            conn.send(content: buildHTTP(status: 409, body: jsonBody(["ok": false, "msg": "未连接任何设备"]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
            return
        }
        let info = connectInfo[tid] ?? [:]
        let writeUuidStr = writeOverride ?? info["write"] ?? ""
        guard !writeUuidStr.isEmpty else {
            conn.send(content: buildHTTP(status: 409, body: jsonBody(["ok": false, "msg": "设备尚未发现写特征/未就绪", "connection": info]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
            return
        }
        let writeUUID = CBUUID(string: writeUuidStr)
        guard let ch = charRefs[tid]?[writeUUID] else {
            conn.send(content: buildHTTP(status: 409, body: jsonBody(["ok": false, "msg": "写特征未缓存, 设备可能未就绪", "connection": info, "write": writeUuidStr]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
            return
        }
        var written: [String] = []
        for fr in frames {
            guard let data = dataFromHex(fr) else {
                conn.send(content: buildHTTP(status: 400, body: jsonBody(["ok": false, "msg": "非法 hex 帧: \(fr)"]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
                return
            }
            let type: CBCharacteristicWriteType = ch.properties.contains(.write) ? .withResponse : .withoutResponse
            log("[WRITE] -> \(hexFromData(data)) (\(type == .withResponse ? "withResponse" : "withoutResponse")))")
            DispatchQueue.main.async { periph.writeValue(data, for: ch, type: type) }
            written.append(hexFromData(data))
        }
        conn.send(content: buildHTTP(status: 200, body: jsonBody(["ok": true, "written": written, "id": tid]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
        return
    }

    conn.send(content: buildHTTP(status: 404, body: jsonBody(["ok": false, "msg": "not found: \(method) \(p)"]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
}

func startHTTPServer() {
    let listener = try! NWListener(using: .tcp, on: NWEndpoint.Port(integerLiteral: UInt16(PORT)))
    listener.stateUpdateHandler = { st in
        switch st {
        case .ready: log("[HTTP] 监听 http://localhost:\(PORT)  (控制面板: http://localhost:\(PORT)/ )")
        case .failed(let e): log("[HTTP] 监听失败: \(e)")
        default: break
        }
    }
    listener.newConnectionHandler = { conn in
        conn.start(queue: .global())
        var buf = Data()
        func receive() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, isComplete, error in
                if let data = data, !data.isEmpty { buf.append(data) }
                if error != nil { conn.cancel(); return }
                // 解析请求行 + 头
                if let str = String(data: buf, encoding: .utf8),
                   let headerEnd = str.range(of: "\r\n\r\n") {
                    let head = String(str[..<headerEnd.upperBound])
                    let headerLines = head.split(separator: "\r\n")
                    guard let reqLine = headerLines.first?.split(separator: " ") as? [Substring], reqLine.count >= 2 else {
                        conn.cancel(); return
                    }
                    let method = String(reqLine[0])
                    let fullPath = String(reqLine[1])
                    let parts = fullPath.split(separator: "?", maxSplits: 1)
                    let path = String(parts[0])
                    let query = parts.count > 1 ? String(parts[1]) : ""
                    // Content-Length
                    var contentLen = 0
                    for line in headerLines {
                        if line.lowercased().hasPrefix("content-length:") {
                            contentLen = Int(line.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) ?? "") ?? 0
                        }
                    }
                    let headerBytes = head.utf8.count
                    let bodySoFar = buf.count - headerBytes
                    if bodySoFar >= contentLen {
                        let body = buf.subdata(in: headerBytes..<buf.count)
                        handleRequest(conn, method, path, query, body)
                        return
                    }
                }
                if isComplete { conn.cancel(); return }
                receive()
            }
        }
        receive()
    }
    listener.start(queue: .global())
}

// ======================= main =======================
func parseArgs() {
    let args = CommandLine.arguments.dropFirst()
    var i = args.startIndex
    while i < args.endIndex {
        let a = args[i]
        if a == "-port", i + 1 < args.endIndex { PORT = Int(args[i+1]) ?? DEFAULT_PORT; i += 2; continue }
        if a.hasPrefix("76539") || a.uppercased().hasPrefix("YYC") || a.uppercased().hasPrefix("YCY")
            || a.contains("-") && a.split(separator: "-").count == 5 {
            explicitAddr = a
        }
        i += 1
    }
    if let addr = explicitAddr { log("[INIT] 指定目标地址: \(addr)") }
}

parseArgs()
startHTTPServer()
central = CBCentralManager(delegate: centralDelegate, queue: nil)
log("[INIT] YCY BLE<->HTTP 桥启动 (端口 \(PORT)). 等待蓝牙就绪…")
RunLoop.main.run()
