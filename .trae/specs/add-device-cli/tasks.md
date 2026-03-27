# Tasks
- [x] Task 1: 初始化独立 CLI 项目骨架
  - [x] 在仓库根目录创建独立文件夹并初始化运行入口
  - [x] 建立命令注册结构与基础参数解析
  - [x] 配置统一输出格式（表格/JSON）

- [x] Task 2: 实现后端 API 访问层
  - [x] 封装基础请求客户端与 API 基地址配置
  - [x] 实现设备列表、设备详情、设备更新的请求方法
  - [x] 实现 MQTT 发布请求方法并统一响应处理

- [x] Task 3: 实现四个用户命令
  - [x] 实现“获取在线设备列表”命令
  - [x] 实现“获取设备属性值”命令
  - [x] 实现“更新设备属性值”命令
  - [x] 实现“向某个设备发送 MQTT 指令”命令

- [x] Task 4: 提供使用文档与示例
  - [x] 编写 CLI 命令说明与参数示例
  - [x] 补充常见调用场景与输出示例

- [x] Task 5: 完成功能验证
  - [x] 逐条验证四项命令能力
  - [x] 校验无状态特性（多次独立执行一致）
  - [x] 完成基础自测并记录结果

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
- Task 5 depends on Task 3
