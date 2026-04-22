// 设备类型映射配置
// 未来可能通过网络获取，暂时放在本地文件中

const deviceTypeMap = {
  'QTZ': '测距及脚踏传感器',
  'ZIDONGSUO': '自动锁',
  'TD01': '偏轴电机控制器',
  'OSR6': 'OSR6控制器',
  'DIANJI': '电脉冲设备',
  'QIYA': '气压传感器',
  'PJ01': '往复电机控制器',
  'DZC01': '电子秤',
  'CUNZHI01':'寸止玩法设备',
  'other': '其他'
};

// 设备类型详细配置
const deviceTypeConfig = {
    'PJ01': {
    name: '往复电机控制器',
    operations: [
      {
        key: 'start',
        name: '启动',
        mqttData: { method: 'update', power: 255 }
      },
      {
        key: 'stop',
        name: '关闭',
        mqttData: { method: 'update', power: 0 }
      }
    ]
  },
  'TD01': {
    name: '偏轴电机控制器',
    operations: [
      {
        key: 'start',
        name: '启动',
        mqttData: { method: 'update', power: 255 }
      },
      {
        key: 'stop',
        name: '关闭',
        mqttData: { method: 'update', power: 0 }
      }
    ],
    test_operations:{
      start: null,
      stop: null,
      loop:[
        { method: 'update', power: 255 },
        { method: 'update', power: 0 },
      ],
      loop_delay: 2000,
      display_keys:[]
    }
  },
  'OSR6': {
    name: 'OSR6控制器',
    operations: [
      {
        key: 'start',
        name: '启动',
        mqttData: { method: 'update', power: 255 }
      },
      {
        key: 'stop',
        name: '关闭',
        mqttData: { method: 'update', power: 0 }
      }
    ],
    test_operations:{
      start: null,
      stop: null,
      loop:[
        { method: 'update', power: 255 },
        { method: 'update', power: 0 },
      ],
      loop_delay: 2000,
      display_keys:[]
    }
  },
  'QIYA': {
    name: '气压传感器',
    monitorData: [
      {
        key: 'pressure',
        name: '气压',
        unit: 'Pa'
      },
      {
        key: 'temperature',
        name: '温度',
        unit: '°C'
      }
    ],
    operations: [],
    test_operations:{
      start: { method: 'update', report_delay_ms: 100 },
      stop: { method: 'update', report_delay_ms: 5000 },
      loop:[
      ],
      loop_delay: 2000,

    }
  },
  'DIANJI': {
    name: '电脉冲设备',
    operations: [
      {
        key: 'start',
        name: '启动',
        mqttData: { method: 'update', shock: 1, voltage: 24 }
      },
      {
        key: 'stop',
        name: '停止',
        mqttData: { method: 'update', shock: 0, voltage: 24 }
      }
    ],
    test_operations:{
      start: null,
      stop: null,
      loop:[
        { method: 'update', shock: 1, voltage: 24 },
        { method: 'update', shock: 0, voltage: 24 },
      ],
      loop_delay: 2000,
      display_keys:[]
    }
  },
  'ZIDONGSUO': {
    name: '自动锁',
    operations: [
      {
        key: 'lock',
        name: '加锁',
        mqttData: { method: 'update', open: 0 }
      },
      {
        key: 'unlock',
        name: '解锁',
        mqttData: { method: 'update', open: 1 }
      }
    ]
  },
  'QTZ': {
    name: '测距及脚踏传感器',
    monitorData: [
      {
        key: 'distance',
        name: '距离',
        unit: 'mm'
      },
      {
        key: 'button0',
        name: '脚踏1',
        unit: '状态'
      },
      {
        key: 'button1',
        name: '脚踏2',
        unit: '状态'
      },
    ],
    operations: []
  },
  'DZC01': {
    name: '电子秤',
    monitorData: [
      { key: 'weight', name: '重量', unit: 'g' },
    ],
    operations: [],
    test_operations: {
      start: { method: 'update', report_delay_ms: 100 },
      stop: { method: 'update', report_delay_ms: 5000 },
      loop: [],
      loop_delay: 2000,
      display_keys: ['weight']
    }
  },
  'CUNZHI01':{
    name: '寸止玩法设备',
    monitorData: [
      {
        key: 'pressure',
        name: '阔约压力',
        unit: 'kPa'
      },
      {
        key: 'pressure1',
        name: '踮脚压力1',
        unit: 'kPa'
      },
    ],
    operations: [
      {
        key: 'start',
        name: '启动',
        mqttData: { method: 'update', shock: 1, voltage: 24, power: 255 }
      },
      {
        key: 'stop',
        name: '停止',
        mqttData: { method: 'update', shock: 0, voltage: 24, power: 0 }
      }
    ],
    test_operations:{
      start: null,
      stop: null,
      loop:[
        { method: 'update', shock: 1, voltage: 24, power: 255 },
        { method: 'update', shock: 0, voltage: 24, power: 0 },
      ],
      loop_delay: 2000,
      display_keys:[]
    }
  },
};

const interfaceConfig = {
  strength: {
    name: '强度控制',
    spec: [
      { mqttKey: 'power', range: [0, 255] }
    ]
  },
  dianji: {
    name: '电击控制',
    spec: [
      { mqttKey: 'shock', range: [0, 1] },
      { mqttKey: 'voltage', range: [0, 80] },
      { mqttKey: 'safe', range: [0, 1] }
    ]
  },
  pressure:{
    name: '压力上报',
    spec: [
      { mqttKey: 'pressure', range: [0, 100] },
      { mqttKey: 'report_delay_ms', range: [0, 99999] }
    ]
  }
};

const typeInterfaceMap = {
  TD01: ['strength'],
  PJ01: ['strength'],
  OSR6: ['strength'],
  CUNZHI01: ['strength', 'pressure', 'dianji'],
  DIANJI: ['dianji'],
  QIYA: ['pressure'],
};

// 获取设备类型显示名称
function getDeviceTypeName(type) {
  return deviceTypeMap[type] || type;
}

// 获取所有设备类型
function getAllDeviceTypes() {
  return Object.keys(deviceTypeMap);
}

// 检查设备类型是否存在
function isValidDeviceType(type) {
  return type in deviceTypeMap;
}

// 获取设备类型的监控数据定义
function getDeviceMonitorData(type) {
  const config = deviceTypeConfig[type];
  return config ? config.monitorData : [];
}

// 获取设备类型的操作定义
function getDeviceOperations(type) {
  const config = deviceTypeConfig[type];
  return config ? config.operations : [];
}

// 检查设备是否支持数据监控
function hasMonitorData(type) {
  const monitorData = getDeviceMonitorData(type);
  return monitorData && monitorData.length > 0;
}

// 检查设备是否支持操作
function hasOperations(type) {
  const operations = getDeviceOperations(type);
  return operations && operations.length > 0;
}

// 获取完整的设备类型配置
function getDeviceTypeConfig(type) {
  return deviceTypeConfig[type] || null;
}

// 获取所有设备类型配置
function getAllDeviceTypeConfigs() {
  return deviceTypeConfig;
}

function getInterfaceName(iface) {
  const cfg = interfaceConfig[iface];
  return cfg ? cfg.name : iface;
}
function getAllInterfaces() {
  return Object.keys(interfaceConfig);
}
function getInterfaceConfig(iface) {
  return interfaceConfig[iface] || null;
}
function getTypeInterfaces(type) {
  return typeInterfaceMap[type] || [];
}
function hasInterface(type, iface) {
  const interfaces = getTypeInterfaces(type);
  return interfaces.includes(iface);
}
function getTypesByInterface(iface) {
  return Object.keys(typeInterfaceMap).filter(t => (typeInterfaceMap[t] || []).includes(iface));
}

module.exports = {
  deviceTypeMap,
  deviceTypeConfig,
  getDeviceTypeName,
  getAllDeviceTypes,
  isValidDeviceType,
  getDeviceMonitorData,
  getDeviceOperations,
  hasMonitorData,
  hasOperations,
  getDeviceTypeConfig,
  getAllDeviceTypeConfigs,
  interfaceConfig,
  typeInterfaceMap,
  getInterfaceName,
  getAllInterfaces,
  getInterfaceConfig,
  getTypeInterfaces,
  hasInterface,
  getTypesByInterface
};
