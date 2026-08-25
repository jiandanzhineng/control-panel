// DG-LAB Coyote 原生 BLE <-> HTTP 桥 (端口 3002)。
// 与 ycy_bridge.swift 同思路：用 CoreBluetooth 真正连接设备，绕过 macOS Web Bluetooth
// 对自定义 GATT 的 "No Services found" 限制（Coyote 3.0 在 Chrome 下连上后枚举不到服务）。
// 自动发现真实 SERVICE/CHAR UUID，自动识别电量特征并读取/订阅，浏览器通过 localhost 取数据。
//
// 用法:
//   ./dglab_bridge                  # 普通模式:扫描并自动连 Coyote 设备
//   ./dglab_bridge <addr>           # 指定连接某个 peripheral UUID
//   ./dglab_bridge -port 3102       # 换端口
//
// 编译:
//   swiftc dglab_bridge.swift -framework CoreBluetooth -framework Network -o dglab_bridge

import Foundation
import CoreBluetooth
import Network

// ======================= 全局状态 =======================
let DEFAULT_PORT = 3002
var PORT = DEFAULT_PORT

var central: CBCentralManager!
var bluetoothOn = false

var discovered: [String: CBPeripheral] = [:]
var connectingId: String? = nil
var target: CBPeripheral? = nil

var deviceMeta: [String: [String: Any]] = [:]
var deviceServices: [String: [[String: Any]]] = [:]
var connectInfo: [String: [String: String]] = [:]
var svcRefs: [String: [CBUUID: CBService]] = [:]
var charRefs: [String: [CBUUID: CBCharacteristic]] = [:]
var notifications: [String: [String]] = [:]
// 电量: id -> 最近一次读到的百分比(0-100)，nil 表示未知
var lastBattery: [String: Int?] = [:]
// 选中的电量特征 UUID: id -> uuidString
var batteryCharUuid: [String: String] = [:]
var seenNames: Set<String> = []

var explicitAddr: String? = nil

// Coyote / 郊狼 设备名关键字（含 3.0 的 47L 前缀与 2.0 的 D-LAB/DG-LAB）
let TARGET_KEYWORDS = ["D-LAB", "DG-LAB", "47L", "COYOTE", "YSKJ", "ESTIM"]

let logQueue = DispatchQueue(label: "dglab.log")
func log(_ s: String) {
    logQueue.async { print(s); fflush(stdout) }
}

// ======================= 工具 =======================
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
        if central.state == .poweredOn { startScan() }
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
            log("[SCAN] \(nm)  \(id)  rssi=\(rssi.intValue)\(isTarget ? "  <== Coyote 候选" : "")")
        }
        discovered[id] = peripheral
        var meta = deviceMeta[id] ?? [:]
        meta["name"] = localName ?? peripheral.name as Any
        meta["rssi"] = rssi.intValue
        deviceMeta[id] = meta

        // 注意：发现后不再自动连接。改由前端在“本机直连”模式下经 /api/connect 显式连接，
        // 以免与网页蓝牙(Web Bluetooth)同时连接同一台设备产生冲突（尤其 macOS 下两个栈抢同一台）。
    }

    func connect(to peripheral: CBPeripheral, id: String) {
        connectingId = id
        target = peripheral
        peripheral.delegate = PeripheralDelegate.shared
        log("[CONN] 连接 \(deviceMeta[id]?["name"] ?? id) …")
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        let id = peripheral.identifier.uuidString
        log("[CONN] 已连接 \(deviceMeta[id]?["name"] ?? id), 发现服务…")
        svcRefs[id] = [:]
        charRefs[id] = [:]
        notifications[id] = []
        lastBattery[id] = nil
        batteryCharUuid[id] = ""
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        let id = peripheral.identifier.uuidString
        log("[CONN] 连接失败 \(deviceMeta[id]?["name"] ?? id): \(error?.localizedDescription ?? "unknown")")
        if connectingId == id { connectingId = nil; target = nil }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        let id = peripheral.identifier.uuidString
        log("[CONN] 断开 \(deviceMeta[id]?["name"] ?? id)\(error != nil ? " (err: \(error!.localizedDescription))" : "")")
        connectInfo[id] = [:]
        batteryCharUuid[id] = ""
        var meta = deviceMeta[id] ?? [:]
        meta["ready"] = false
        deviceMeta[id] = meta
        if connectingId == id { connectingId = nil }
        if target?.identifier.uuidString == id { target = nil }
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
        guard let chars = service.characteristics else { return }
        for ch in chars {
            if charRefs[id] == nil { charRefs[id] = [:] }
            charRefs[id]![ch.uuid] = ch
            let props = charProps(ch)
            log("      [CHAR] \(ch.uuid.uuidString)  props=\(props.joined(separator: ","))")
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

    // 自动识别电量特征并订阅：优先可读(read)且读出来是单字节 0-100 的；否则 notify/indicate；
    // 否则任意可读特征。选完后立即读一次并订阅通知。
    func finalizeConnection(_ peripheral: CBPeripheral) {
        let id = peripheral.identifier.uuidString
        guard let services = peripheral.services else { return }
        var batteryChar: CBCharacteristic?
        // 1) 先找可读特征，逐个读，挑出返回单字节 0-100 的
        var candidateRead: CBCharacteristic?
        var candidateNotify: CBCharacteristic?
        for svc in services {
            guard let chars = svc.characteristics else { continue }
            for ch in chars {
                if ch.properties.contains(.read) {
                    candidateRead = candidateRead ?? ch
                    peripheral.readValue(for: ch)
                }
                if (ch.properties.contains(.notify) || ch.properties.contains(.indicate)) && candidateNotify == nil {
                    candidateNotify = ch
                }
            }
        }
        // batteryChar 暂定为 notify 特征(大多数 DG-LAB 电量走 notify)；
        // 真正判定在 didUpdateValueFor 里按「首字节 0-100」校准，若 notify 首字节非电量则退化为可读特征。
        batteryChar = candidateNotify ?? candidateRead
        if let bc = batteryChar {
            batteryCharUuid[id] = bc.uuid.uuidString
            log("[READY] 候选电量特征 \(bc.uuid.uuidString) (notify=\(candidateNotify != nil), read=\(candidateRead != nil))")
            if bc.properties.contains(.notify) || bc.properties.contains(.indicate) {
                peripheral.setNotifyValue(true, for: bc)
            }
            if bc.properties.contains(.read) {
                peripheral.readValue(for: bc)
            }
        } else {
            log("[READY] 未发现电量特征")
        }
        var meta = deviceMeta[id] ?? [:]
        meta["ready"] = true
        deviceMeta[id] = meta
        connectingId = nil
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
        if let error = error { log("[NOTIFY] 读值出错: \(error.localizedDescription)"); return }
        guard let v = characteristic.value else { return }
        let hex = hexFromData(v)
        log("[NOTIFY] \(characteristic.uuid.uuidString) <- \(hex)")
        notifications[id, default: []].append(hex)
        if notifications[id]!.count > 200 { notifications[id]!.removeFirst() }
        // 电量识别：DG-LAB/Coyote 电量以「单字节、值 0-100」经 notify 上报（实测 3.0 电量特征=1500）。
        // 规则：①带 notify/indicate 的特征的单字节 0-100 直接记为电量（最可信）；
        // ②只读特征(无 notify)的单字节 0-100 仅在电量未知时兜底，避免被 0009 这类非电量字段(返回 0x00)覆盖。
        if v.count == 1, let b = Int(exactly: v[0]), b >= 0, b <= 100 {
            let hasNotify = characteristic.properties.contains(.notify) || characteristic.properties.contains(.indicate)
            if hasNotify {
                if lastBattery[id] == nil || lastBattery[id]! != b {
                    lastBattery[id] = b
                    log("[BATTERY] \(id) = \(b)% (notify char \(characteristic.uuid.uuidString))")
                }
            } else if lastBattery[id] == nil {
                lastBattery[id] = b
                log("[BATTERY] \(id) = \(b)% (read-only char \(characteristic.uuid.uuidString), fallback)")
            }
        }
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

// 递归把任意 Swift 对象转成 JSON 安全类型。关键：Swift 的 Optional（含双层 Optional，
// 如 [String:Int?] 的下标结果 Int??）在 JSONSerialization 里会抛 NSException（try? 抓不住），
// 必须用 Mirror 剥掉 Optional 包装、nil 转 NSNull，否则 /api/status 会直接 abort 进程。
func sanitizeForJSON(_ obj: Any) -> Any {
    if obj is NSNull { return NSNull() }
    if let s = obj as? String { return s }
    if let n = obj as? NSNumber { return n }
    if let b = obj as? Bool { return b }
    if let i = obj as? Int { return i }
    if let d = obj as? Double { return d }
    if let f = obj as? Float { return f }
    if let data = obj as? Data { return data.base64EncodedString() }
    if let arr = obj as? [Any] { return arr.map { sanitizeForJSON($0) } }
    if let dict = obj as? [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in dict { out[k] = sanitizeForJSON(v) }
        return out
    }
    let mirrored = Mirror(reflecting: obj)
    if mirrored.displayStyle == .optional {
        if let some = mirrored.children.first?.value { return sanitizeForJSON(some) }
        return NSNull()
    }
    return "\(obj)"
}

func jsonBody(_ obj: Any) -> Data {
    let safe = sanitizeForJSON(obj)
    if let d = try? JSONSerialization.data(withJSONObject: safe) { return d }
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
        e["services"] = deviceServices[id] ?? []
        e["connection"] = connectInfo[id] ?? [:]
        e["battery"] = lastBattery[id] as Any
        e["isTarget"] = (connectingId == id || target?.identifier.uuidString == id)
        arr.append(e)
    }
    return arr
}

func handleRequest(_ conn: NWConnection, _ method: String, _ path: String, _ query: String, _ body: Data) {
    let p = path.isEmpty ? "/" : path
    if method == "OPTIONS" {
        conn.send(content: buildHTTP(status: 204, body: Data(), contentType: "text/plain"), completion: .contentProcessed({ _ in conn.cancel() }))
        return
    }
    if method == "GET" && (p == "/" || p == "/index.html") {
        let msg = "<h1>DG-LAB Coyote Bridge</h1><p>REST on port \(PORT). Endpoints: /api/status /api/devices /api/connect?addr= /api/disconnect?addr= /api/rescan /api/battery?addr=</p>"
        conn.send(content: buildHTTP(status: 200, body: Data(msg.utf8), contentType: "text/html"), completion: .contentProcessed({ _ in conn.cancel() }))
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
    if method == "GET" && p == "/api/battery" {
        let addr = queryValue("addr", from: query)
        let tid: String? = addr ?? target?.identifier.uuidString ?? connectInfo.keys.first
        let b = tid.flatMap { lastBattery[$0] }
        conn.send(content: buildHTTP(status: 200, body: jsonBody(["id": tid ?? "", "battery": b as Any, "known": b != nil]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
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
                for (id, meta) in deviceMeta where (meta["name"] as? String)?.uppercased().contains(addr.uppercased()) == true {
                    targetId = id; break
                }
            }
        } else {
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
    conn.send(content: buildHTTP(status: 404, body: jsonBody(["ok": false, "msg": "not found: \(method) \(p)"]), contentType: "application/json"), completion: .contentProcessed({ _ in conn.cancel() }))
}

func startHTTPServer() {
    let listener = try! NWListener(using: .tcp, on: NWEndpoint.Port(integerLiteral: UInt16(PORT)))
    listener.stateUpdateHandler = { st in
        switch st {
        case .ready: log("[HTTP] 监听 http://localhost:\(PORT)")
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
            || (a.contains("-") && a.split(separator: "-").count == 5) {
            explicitAddr = a
        }
        i += 1
    }
    if let addr = explicitAddr { log("[INIT] 指定目标地址: \(addr)") }
}

parseArgs()
startHTTPServer()
central = CBCentralManager(delegate: centralDelegate, queue: nil)
log("[INIT] DG-LAB Coyote BLE<->HTTP 桥启动 (端口 \(PORT)). 等待蓝牙就绪…")
RunLoop.main.run()
