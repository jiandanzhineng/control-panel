# mDNS服务整合方案文档

## 分析总结

### 现有文件差异分析

**mdnsService.js (Linux版本)**:

- 使用Python脚本 (`mdns_register_ip.py`)
- 调用虚拟环境中的Python解释器
- 函数式编程风格，导出 `{publish, unpublish, status}` 方法
- 使用项目统一的logger系统

**mdnsServiceWindows.js (Windows版本)**:

- 使用Windows可执行文件 (`mdns_tool.exe`)
- 面向对象编程风格，使用类和单例模式
- 包含Electron主窗口通信功能 (`mainWindow.webContents.send`)
- 使用console.log而非统一logger
- 有IP地址自动获取功能

### 不兼容问题识别

1. **架构差异**: 函数式 vs 面向对象
2. **依赖差异**: Python脚本 vs Windows可执行文件
3. **日志系统**: 统一logger vs console.log
4. **Electron依赖**: Windows版本包含不适用的Electron通信代码
5. **API接口**: 方法名和参数不一致

## 整合方案

### 修改目标

将 `mdnsServiceWindows.js` 的Windows功能整合到 `mdnsService.js` 中，保持统一的API接口。

### 具体修改内容

1. **添加操作系统检测**

   - 引入 `os` 模块检测平台类型
   - 根据 `os.platform() === 'win32'` 选择执行路径
2. **统一API接口**

   - 保持现有的 `publish({ip})`, `unpublish()`, `status()` 方法签名
   - Windows实现适配到相同的接口规范
3. **移除不兼容代码**

   - 删除Electron相关的 `mainWindow` 通信代码
   - 统一使用项目的logger系统替换console.log
4. **Windows路径处理**

   - 修改 `mdns_tool.exe` 路径逻辑，移除生产环境的 `process.resourcesPath` 依赖
   - 统一使用开发环境路径结构
5. **参数适配**

   - Windows版本的 `runMDNSTool(port)` 需要适配为 `publish({ip})` 接口 任何ip都调用相同的runMDNSTool(port) port为8080
6. **错误处理统一**

   - 统一返回格式和错误处理机制
   - 保持与现有Linux版本一致的行为

## 实现步骤

1. 在 `mdnsService.js` 中添加 `os` 模块导入
2. 创建操作系统检测逻辑
3. 为Windows平台实现对应的 `publish`, `unpublish`, `status` 方法
4. 整合Windows版本的进程管理逻辑
5. 统一日志输出和错误处理
6. 测试跨平台兼容性

## 注意事项

- 保持现有API接口不变，确保调用方代码无需修改
- 移除所有Electron相关依赖，使服务可以在纯Node.js环境运行
- 确保Windows可执行文件路径正确解析
- 统一使用项目logger系统进行日志记录
