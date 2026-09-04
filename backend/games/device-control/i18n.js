(function (root) {
  'use strict';
  if (!root.GameI18n || typeof root.GameI18n.register !== 'function') return;
  root.GameI18n.register({
    en: {
      "串口": "Serial",
      "远程": "Remote",
      "强度": "Intensity",
      "应用": "Apply",
      "电击电压": "Shock voltage",
      "开始": "Start",
      "停止": "Stop",
      "设备锁": "Device lock",
      "加锁": "Lock",
      "解锁": "Unlock",
      "上报间隔": "Report interval",
      "近距离阈值 (mm)": "Near threshold (mm)",
      "远距离阈值 (mm)": "Far threshold (mm)",
      "控制": "Control",
      "实时数据": "Live data",
      "{n} 台在线": "{n} online",
      "{n} 台远程": "{n} remote",
      "指令已发送": "Command sent",
      "设备通道不可用": "Device channel unavailable"
    }
  });
})(typeof window !== 'undefined' ? window : this);
