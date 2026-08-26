//! 跨平台本机桥（Native Bridge）：Rust + btleplug + axum
//!
//! 取代 macOS 专属的 Swift 桥（tools/ycy_bridge / tools/dglab_bridge），一个二进制通吃
//! Windows(CoreBluetooth→WinRT) / macOS(CoreBluetooth) / Linux(BlueZ)。
//!
//! 桥是纯 GATT 透传 + HTTP REST（轮询，无 WebSocket）。AES-128-ECB 由客户端算好 hex 再经
//! /api/send 下发，桥本身不加密。REST 契约与 Swift 桥保持 100% 兼容，前端零改动。

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Query, State},
    routing::{get, post},
    Json, Router,
};
use btleplug::api::{
    Central, CentralEvent, CentralState, CharPropFlags, Manager as _, Peripheral as _, ScanFilter,
    Service, Characteristic, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral, PeripheralId};
use futures::StreamExt;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

const BATTERY_SERVICE: &str = "180f";
const BATTERY_CHAR: &str = "2a19";
const DEVICE_NAME_CHAR: &str = "2a00";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Brand {
    Ycy,
    Dglab,
}

impl Brand {
    fn keywords(&self) -> &'static [&'static str] {
        match self {
            Brand::Ycy => &[
                "YCY", "YYC", "YSKJ", "YOKO", "YOKONEX", "YISK", "DJ-V2", "YICIYUAN", "DJ",
            ],
            Brand::Dglab => &["D-LAB", "DG-LAB", "47L", "COYOTE", "YSKJ", "ESTIM"],
        }
    }
    fn auto_connect(&self) -> bool {
        *self == Brand::Ycy
    }
    fn candidate_services(&self) -> &'static [&'static str] {
        &[
            "0000ff30-0000-1000-8000-00805f9b34fb",
            "0000ff40-0000-1000-8000-00805f9b34fb",
            "98a9cd00-ca0a-4cf8-9f85-e93949467558",
            "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
        ]
    }
}

fn matches_keyword(brand: Brand, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let u = name.to_uppercase();
    brand.keywords().iter().any(|k| u.contains(&k.to_uppercase()))
}

fn brand_name(b: Brand) -> &'static str {
    match b {
        Brand::Ycy => "YCY",
        Brand::Dglab => "DG-LAB",
    }
}

#[derive(Clone)]
struct CharInfo {
    uuid: String,
    props: Vec<String>,
}

#[derive(Clone, Default)]
struct ConnectionInfo {
    service: String,
    write: String,
    notify: String,
}

#[derive(Clone)]
struct ServiceInfo {
    uuid: String,
    chars: Vec<CharInfo>,
}

#[derive(Clone)]
struct DeviceInfo {
    id: String,
    name: Option<String>,
    rssi: i32,
    ready: bool,
    /// None = 未知；Some(v) = 电量百分比
    battery: Option<i32>,
    services: Vec<ServiceInfo>,
    connection: ConnectionInfo,
    notifications: VecDeque<String>,
    peripheral: Option<Peripheral>,
    identify_only: bool,
}

struct AppState {
    brand: Brand,
    bluetooth_on: Mutex<bool>,
    devices: Mutex<HashMap<String, DeviceInfo>>,
    connecting: Mutex<HashSet<String>>,
    explicit_addr: Mutex<Option<String>>,
    adapter: Adapter,
}

type Shared = Arc<AppState>;

// ======================= 工具 =======================

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02X}", b)).collect()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    let s: String = s.chars().filter(|c| !c.is_whitespace() && *c != ',').collect();
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i + 1 < bytes.len() || (i == 0 && bytes.len() == 2) {
        let hi = hex_val(bytes[i])?;
        let lo = hex_val(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
        if i >= bytes.len() {
            break;
        }
    }
    if out.is_empty() && !s.is_empty() {
        return None;
    }
    Some(out)
}

fn char_props(flags: CharPropFlags) -> Vec<String> {
    let mut v = Vec::new();
    if flags.contains(CharPropFlags::READ) {
        v.push("read".into());
    }
    if flags.contains(CharPropFlags::WRITE) {
        v.push("write".into());
    }
    if flags.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) {
        v.push("writeWithoutResponse".into());
    }
    if flags.contains(CharPropFlags::NOTIFY) {
        v.push("notify".into());
    }
    if flags.contains(CharPropFlags::INDICATE) {
        v.push("indicate".into());
    }
    v
}

fn find_char_by_uuid(services: &BTreeSet<Service>, uuid: &str) -> Option<Characteristic> {
    for svc in services {
        for ch in &svc.characteristics {
            if ch.uuid.to_string().eq_ignore_ascii_case(uuid) {
                return Some(ch.clone());
            }
        }
    }
    None
}

// ======================= 设备查找 =======================

fn find_device<'a>(
    devices: &'a HashMap<String, DeviceInfo>,
    addr: &str,
) -> Option<(&'a String, &'a DeviceInfo)> {
    if addr.is_empty() {
        return None;
    }
    if let Some((k, d)) = devices.get_key_value(addr) {
        return Some((k, d));
    }
    let upper = addr.to_uppercase();
    for (k, d) in devices {
        if d.name
            .as_deref()
            .map(|n| n.to_uppercase().contains(&upper))
            .unwrap_or(false)
        {
            return Some((k, d));
        }
    }
    None
}

fn find_target<'a>(
    brand: Brand,
    devices: &'a HashMap<String, DeviceInfo>,
    addr: &str,
) -> Option<&'a String> {
    if !addr.is_empty() {
        return find_device(devices, addr).map(|(k, _)| k);
    }
    for (k, d) in devices {
        if d.name
            .as_deref()
            .map(|n| matches_keyword(brand, n))
            .unwrap_or(false)
        {
            return Some(k);
        }
    }
    devices.keys().next()
}

// ======================= BLE 事件循环 =======================

async fn ble_loop(state: Shared) -> anyhow::Result<()> {
    let adapter = state.adapter.clone();
    let mut events = adapter.events().await?;

    let powered = matches!(adapter.adapter_state().await, Ok(CentralState::PoweredOn));
    *state.bluetooth_on.lock().await = powered;
    println!(
        "[BT] adapter state = {}",
        if powered { "on" } else { "off" }
    );

    adapter.start_scan(ScanFilter::default()).await?;
    *state.bluetooth_on.lock().await =
        matches!(adapter.adapter_state().await, Ok(CentralState::PoweredOn));
    println!("[SCAN] 开始扫描(持续) …");

    // macOS 上 CoreBluetooth 的 StateUpdate 事件极少触发，不能依赖它判定蓝牙开关；
    // 改为周期轮询适配器状态作为兜底，确保 bluetoothOn 反映真实状态（5s 一次）。
    {
        let poll_state = state.clone();
        let poll_adapter = adapter.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let on = matches!(poll_adapter.adapter_state().await, Ok(CentralState::PoweredOn));
                *poll_state.bluetooth_on.lock().await = on;
            }
        });
    }

    while let Some(ev) = events.next().await {
        match ev {
            CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) => {
                if let Ok(p) = adapter.peripheral(&id).await {
                    let key = id.to_string();
                    update_advertisement(state.clone(), p, key).await;
                }
            }
            CentralEvent::DeviceConnected(_id) => {
                // 连接与发现服务统一在 connect_internal 内处理，避免与事件重复
            }
            CentralEvent::DeviceDisconnected(id) => {
                on_disconnected(state.clone(), id.to_string()).await;
            }
            CentralEvent::StateUpdate(st) => {
                *state.bluetooth_on.lock().await = st == CentralState::PoweredOn;
                println!(
                    "[BT] state = {}",
                    if st == CentralState::PoweredOn { "on" } else { "off" }
                );
            }
            _ => {}
        }
    }
    Ok(())
}

async fn update_advertisement(state: Shared, p: Peripheral, key: String) {
    let props = p.properties().await.ok().flatten();
    let (name, rssi) = match props {
        Some(pr) => (pr.local_name.clone(), pr.rssi),
        None => (None, None),
    };

    let mut is_target = false;
    {
        let mut devices = state.devices.lock().await;
        let entry = devices.entry(key.clone()).or_insert_with(|| DeviceInfo {
            id: key.clone(),
            name: None,
            rssi: 0,
            ready: false,
            battery: None,
            services: vec![],
            connection: ConnectionInfo::default(),
            notifications: VecDeque::new(),
            peripheral: None,
            identify_only: false,
        });
        entry.peripheral = Some(p.clone());
        if name.is_some() {
            entry.name = name;
        }
        if let Some(r) = rssi {
            entry.rssi = r as i32;
        }
        is_target = entry
            .name
            .as_deref()
            .map(|n| matches_keyword(state.brand, n))
            .unwrap_or(false);
    }

    // 收到广播即证明本机蓝牙已开启（覆盖 macOS StateUpdate 不触发的情况）。
    *state.bluetooth_on.lock().await = true;

    // YCY 自动连接命中的设备
    if state.brand.auto_connect() && is_target {
        let should = {
            let c = state.connecting.lock().await;
            !c.contains(&key)
        };
        if should {
            let _ = connect_internal(state.clone(), key.clone()).await;
        }
    }
}

async fn on_disconnected(state: Shared, key: String) {
    {
        let mut devices = state.devices.lock().await;
        if let Some(d) = devices.get_mut(&key) {
            d.ready = false;
            d.battery = None;
            d.connection = ConnectionInfo::default();
        }
    }
    // YCY 自动重连
    if state.brand.auto_connect() {
        let explicit = state.explicit_addr.lock().await.clone();
        let want_reconnect = explicit.as_deref() == Some(key.as_str()) || explicit.is_none();
        if want_reconnect {
            let st = state.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                reconnect(st, key).await;
            });
        }
    }
}

async fn reconnect(state: Shared, key: String) {
    let adapter = state.adapter.clone();
    let uuid = match Uuid::parse_str(&key) {
        Ok(u) => u,
        Err(_) => return,
    };
    let pid: PeripheralId = uuid.into();
    if let Ok(p) = adapter.peripheral(&pid).await {
        let _ = connect_internal(state.clone(), key).await;
        let _ = p;
    }
}

async fn connect_internal(state: Shared, key: String) -> anyhow::Result<()> {
    {
        let mut c = state.connecting.lock().await;
        if c.contains(&key) {
            return Ok(());
        }
        c.insert(key.clone());
    }

    let p = {
        let devices = state.devices.lock().await;
        devices.get(&key).and_then(|d| d.peripheral.clone())
    };

    let result = if let Some(p) = p {
        p.connect().await?;
        p.discover_services().await?;
        let services = p.services();
        finalize(state.clone(), &p, &key, services).await;
        Ok(())
    } else {
        Ok(())
    };

    {
        let mut c = state.connecting.lock().await;
        c.remove(&key);
    }
    result
}

async fn finalize(state: Shared, p: &Peripheral, key: &str, services: BTreeSet<Service>) {
    let mut svc_infos: Vec<ServiceInfo> = Vec::new();
    let mut write_char: Option<Characteristic> = None;
    let mut notify_char: Option<Characteristic> = None;
    let mut battery_char: Option<Characteristic> = None;

    for svc in &services {
        let mut chars = Vec::new();
        for ch in &svc.characteristics {
            let props = char_props(ch.properties);
            chars.push(CharInfo {
                uuid: ch.uuid.to_string(),
                props: props.clone(),
            });

            let svc_str = svc.uuid.to_string().to_lowercase();
            if state.brand == Brand::Ycy {
                if ch.properties.contains(CharPropFlags::WRITE)
                    || ch.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE)
                {
                    let is_candidate = state
                        .brand
                        .candidate_services()
                        .iter()
                        .any(|c| c.to_lowercase() == svc_str);
                    if is_candidate {
                        write_char = Some(ch.clone());
                    } else if write_char.is_none() {
                        write_char = Some(ch.clone());
                    }
                }
                if (ch.properties.contains(CharPropFlags::NOTIFY)
                    || ch.properties.contains(CharPropFlags::INDICATE))
                    && notify_char.is_none()
                {
                    notify_char = Some(ch.clone());
                }
            } else {
                // 郊狼：电量特征优先 notify/indicate，否则可读特征
                if (ch.properties.contains(CharPropFlags::NOTIFY)
                    || ch.properties.contains(CharPropFlags::INDICATE))
                    && battery_char.is_none()
                {
                    battery_char = Some(ch.clone());
                } else if ch.properties.contains(CharPropFlags::READ) && battery_char.is_none() {
                    battery_char = Some(ch.clone());
                }
            }

            // 标准电量特征 0x2A19 优先
            if ch.uuid.to_string().eq_ignore_ascii_case(BATTERY_CHAR) {
                battery_char = Some(ch.clone());
            }
        }
        svc_infos.push(ServiceInfo {
            uuid: svc.uuid.to_string(),
            chars,
        });
    }

    let mut conn = ConnectionInfo::default();
    if let Some(wc) = &write_char {
        conn.service = wc.service_uuid.to_string();
        conn.write = wc.uuid.to_string();
    }
    if let Some(nc) = &notify_char {
        conn.notify = nc.uuid.to_string();
    }

    // 订阅通知特征（YCY=notify char；郊狼=battery char）
    let sub_char: Option<Characteristic> = if state.brand == Brand::Ycy {
        notify_char.clone()
    } else {
        battery_char.clone()
    };
    if let Some(sc) = &sub_char {
        if let Err(e) = p.subscribe(sc).await {
            eprintln!("[SUB] 订阅失败 {}: {:?}", sc.uuid, e);
        }
    }

    // 初始电量读取
    if let Some(bc) = &battery_char {
        if bc.properties.contains(CharPropFlags::READ) {
            if let Ok(v) = p.read(bc).await {
                if v.len() == 1 {
                    let lvl = v[0] as i32;
                    if (0..=100).contains(&lvl) {
                        update_battery(state.clone(), key, lvl).await;
                    }
                }
            }
        }
    }

    // 写回设备信息
    {
        let mut devices = state.devices.lock().await;
        if let Some(d) = devices.get_mut(key) {
            d.services = svc_infos;
            d.connection = conn;
            d.ready = true;
        }
    }

    // 通知回流任务
    if let Some(sc) = sub_char {
        let st = state.clone();
        let key2 = key.to_string();
        let brand = state.brand;
        let p2 = p.clone();
        tokio::spawn(async move {
            if let Ok(mut notifs) = p2.notifications().await {
                while let Some(n) = notifs.next().await {
                    let hex = to_hex(&n.value);
                    {
                        let mut devices = st.devices.lock().await;
                        if let Some(d) = devices.get_mut(&key2) {
                            d.notifications.push_back(hex.clone());
                            if d.notifications.len() > 200 {
                                d.notifications.pop_front();
                            }
                        }
                    }
                    // 郊狼电量：单字节 0-100 经 notify 上报
                    if brand == Brand::Dglab && n.value.len() == 1 {
                        let b = n.value[0] as i32;
                        if (0..=100).contains(&b) {
                            update_battery(st.clone(), &key2, b).await;
                        }
                    }
                }
            }
        });
        let _ = sc;
    }
}

async fn update_battery(state: Shared, key: &str, value: i32) {
    let mut devices = state.devices.lock().await;
    if let Some(d) = devices.get_mut(key) {
        d.battery = Some(value);
    }
}

async fn read_char_by_uuid(state: Shared, key: &str, uuid: &str) -> Option<String> {
    let p = {
        let d = state.devices.lock().await;
        d.get(key).and_then(|d| d.peripheral.clone())
    }?;
    let services = p.services();
    let ch = find_char_by_uuid(&services, uuid)?;
    if let Ok(v) = p.read(&ch).await {
        if let Ok(s) = String::from_utf8(v.clone()) {
            let mut devices = state.devices.lock().await;
            if let Some(d) = devices.get_mut(key) {
                d.name = Some(s.clone());
            }
            return Some(s);
        }
        return Some(to_hex(&v));
    }
    None
}

// ======================= HTTP 处理 =======================

fn device_to_json(brand: Brand, d: &DeviceInfo) -> Value {
    let empty_conn = d.connection.service.is_empty()
        && d.connection.write.is_empty()
        && d.connection.notify.is_empty();
    let mut obj = json!({
        "id": d.id,
        "name": d.name.clone().unwrap_or_default(),
        "rssi": d.rssi,
        "ready": d.ready,
        "isTarget": false,
        "services": d.services.iter().map(|s| json!({
            "uuid": s.uuid,
            "chars": s.chars.iter().map(|c| json!({"uuid": c.uuid, "props": c.props})).collect::<Vec<_>>()
        })).collect::<Vec<_>>(),
        "connection": if brand == Brand::Ycy && !empty_conn {
            json!({"service": d.connection.service, "write": d.connection.write, "notify": d.connection.notify})
        } else {
            json!({})
        },
    });
    if brand == Brand::Ycy {
        if let Some(b) = d.battery {
            obj["battery"] = json!(b);
        }
    } else {
        obj["battery"] = json!(d.battery);
    }
    obj
}

async fn get_status(State(st): State<Shared>) -> Json<Value> {
    let bluetooth_on = *st.bluetooth_on.lock().await;
    let explicit = st.explicit_addr.lock().await.clone().unwrap_or_default();
    let devices = st.devices.lock().await;
    let devs: Vec<Value> = devices.values().map(|d| device_to_json(st.brand, d)).collect();
    let notifications: HashMap<String, Vec<String>> = devices
        .iter()
        .map(|(k, d)| (k.clone(), d.notifications.iter().cloned().collect()))
        .collect();
    drop(devices);
    Json(json!({
        "bluetoothOn": bluetooth_on,
        "explicitAddr": explicit,
        "devices": devs,
        "notifications": notifications,
    }))
}

async fn get_devices(State(st): State<Shared>) -> Json<Value> {
    let devices = st.devices.lock().await;
    let devs: Vec<Value> = devices.values().map(|d| device_to_json(st.brand, d)).collect();
    drop(devices);
    Json(json!({ "devices": devs }))
}

async fn get_battery(
    State(st): State<Shared>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let addr = q.get("addr").cloned().unwrap_or_default();
    let (id, bat) = {
        let devices = st.devices.lock().await;
        find_device(&devices, &addr)
            .map(|(k, d)| (k.clone(), d.battery))
            .unwrap_or_default()
    };
    Json(json!({ "id": id, "battery": bat, "known": bat.is_some() }))
}

async fn post_rescan(State(st): State<Shared>) -> Json<Value> {
    let adapter = st.adapter.clone();
    let _ = adapter.start_scan(ScanFilter::default()).await;
    Json(json!({ "ok": true, "msg": "rescan started" }))
}

async fn post_connect(
    State(st): State<Shared>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let addr = q.get("addr").cloned().unwrap_or_default();
    let target = {
        let devices = st.devices.lock().await;
        find_target(st.brand, &devices, &addr).cloned()
    };
    match target {
        Some(key) => {
            *st.explicit_addr.lock().await = Some(key.clone());
            let _ = connect_internal(st.clone(), key.clone()).await;
            Json(json!({ "ok": true, "id": key, "msg": "connecting" }))
        }
        None => Json(json!({
            "ok": false,
            "msg": "未找到目标设备, 请确认设备已开机且在范围内"
        })),
    }
}

async fn post_disconnect(
    State(st): State<Shared>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let addr = q.get("addr").cloned().unwrap_or_default();
    let key = {
        let devices = st.devices.lock().await;
        find_target(st.brand, &devices, &addr).cloned()
    };
    match key {
        Some(k) => {
            let p = {
                let d = st.devices.lock().await;
                d.get(&k).and_then(|d| d.peripheral.clone())
            };
            if let Some(p) = p {
                let _ = p.disconnect().await;
            }
            Json(json!({ "ok": true, "msg": format!("disconnecting {}", k) }))
        }
        None => Json(json!({ "ok": false, "msg": "no device" })),
    }
}

async fn post_identify(
    State(st): State<Shared>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    if st.brand != Brand::Ycy {
        return Json(json!({ "ok": false, "msg": "not supported for this brand" }));
    }
    let id = q.get("id").cloned().unwrap_or_default();
    let key = {
        let d = st.devices.lock().await;
        find_target(st.brand, &d, &id).cloned()
    };
    let key = match key {
        Some(k) => k,
        None => return Json(json!({ "ok": false, "msg": "未找到该设备" })),
    };
    let is_ready = st
        .devices
        .lock()
        .await
        .get(&key)
        .map(|d| d.ready)
        .unwrap_or(false);
    if !is_ready {
        let _ = connect_internal(st.clone(), key.clone()).await;
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    let name = read_char_by_uuid(st.clone(), &key, DEVICE_NAME_CHAR).await;
    Json(json!({ "ok": true, "id": key, "msg": "identifying", "name": name }))
}

async fn post_send(State(st): State<Shared>, Json(body): Json<Value>) -> Json<Value> {
    // 纯 GATT 透传：YCY / 郊狼(DGLAB) 共用。帧由客户端计算（AES 等加密在客户端），
    // 桥只负责把 hex 帧写到指定写特征。写特征 UUID 由客户端经 `write` 参数指定，
    // 桥在所有已缓存服务/特征中按 UUID 查找，不绑定任何具体设备协议。
    let addr = body
        .get("addr")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let frames: Vec<String> = if let Some(f) = body.get("frame").and_then(|v| v.as_str()) {
        vec![f.to_string()]
    } else if let Some(arr) = body.get("frames").and_then(|v| v.as_array()) {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect()
    } else {
        vec![]
    };
    let write_override = body
        .get("write")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if frames.is_empty() {
        return Json(json!({ "ok": false, "msg": "no frame" }));
    }

    let (key, p, write_uuid) = {
        let devices = st.devices.lock().await;
        let key = if !addr.is_empty() {
            find_target(st.brand, &devices, &addr).cloned()
        } else {
            devices.keys().next().cloned()
        };
        let key = match key {
            Some(k) => k,
            None => return Json(json!({ "ok": false, "msg": "未连接任何设备" })),
        };
        let d = devices.get(&key).unwrap();
        let p = d.peripheral.clone();
        let wu = write_override
            .clone()
            .or_else(|| Some(d.connection.write.clone()))
            .unwrap_or_default();
        (key, p, wu)
    };

    let p = match p {
        Some(p) => p,
        None => return Json(json!({ "ok": false, "msg": "设备未就绪" })),
    };
    if write_uuid.is_empty() {
        return Json(json!({ "ok": false, "msg": "设备尚未发现写特征/未就绪" }));
    }
    let services = p.services();
    let char = match find_char_by_uuid(&services, &write_uuid) {
        Some(c) => c,
        None => return Json(json!({ "ok": false, "msg": "写特征未缓存" })),
    };

    let mut written = Vec::new();
    for fr in &frames {
        let data = match from_hex(fr) {
            Some(d) => d,
            None => return Json(json!({ "ok": false, "msg": format!("非法 hex 帧: {}", fr) })),
        };
        let wt = if char.properties.contains(CharPropFlags::WRITE) {
            WriteType::WithResponse
        } else {
            WriteType::WithoutResponse
        };
        if let Err(e) = p.write(&char, &data, wt).await {
            return Json(json!({ "ok": false, "msg": format!("写失败: {}", e) }));
        }
        written.push(to_hex(&data));
    }
    Json(json!({ "ok": true, "written": written, "id": key }))
}

fn build_router(state: Shared) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    Router::new()
        .route("/api/status", get(get_status))
        .route("/api/devices", get(get_devices))
        .route("/api/battery", get(get_battery))
        .route("/api/rescan", post(post_rescan))
        .route("/api/connect", post(post_connect))
        .route("/api/disconnect", post(post_disconnect))
        .route("/api/identify", post(post_identify))
        .route("/api/send", post(post_send))
        .layer(cors)
        .with_state(state)
}

/// 桥主入口。
pub async fn run(brand: Brand, port: u16) -> anyhow::Result<()> {
    let manager = Manager::new().await?;
    let adapters = manager.adapters().await?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("未找到蓝牙适配器"))?;

    let state = Arc::new(AppState {
        brand,
        bluetooth_on: Mutex::new(false),
        devices: Mutex::new(HashMap::new()),
        connecting: Mutex::new(HashSet::new()),
        explicit_addr: Mutex::new(None),
        adapter,
    });

    let ble_state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = ble_loop(ble_state).await {
            eprintln!("[BLE] 事件循环错误: {:?}", e);
        }
    });

    let app = build_router(state.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!(
        "[INIT] {} BLE<->HTTP 桥启动 (端口 {}). 等待蓝牙就绪…",
        brand_name(brand),
        port
    );
    axum::serve(listener, app).await?;
    Ok(())
}
