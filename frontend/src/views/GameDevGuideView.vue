<template>
  <div class="page dev-guide">
    <div class="header-row">
      <div>
        <h1>游戏开发指南</h1>
        <p class="muted">本页说明如何制作、调试本平台的游戏，供开发者与 Agent 阅读。内容以当前实现为准。</p>
      </div>
      <el-button :icon="Back" @click="$router.push('/plays')">返回本地游戏</el-button>
    </div>

    <el-alert
      class="inline-alert"
      type="info"
      :closable="false"
      show-icon
      title="给 Agent：本页为纯文本说明，可直接整段读取。参考链接指向仓库内更详细的文档。"
    />

    <section class="guide-card">
      <pre class="guide-text">{{ guideText }}</pre>
    </section>

    <section class="guide-card">
      <h2>参考链接</h2>
      <ul class="ref-list">
        <li v-for="r in refs" :key="r.path">
          <code>{{ r.path }}</code>
          <span class="muted"> — {{ r.desc }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Back } from '@element-plus/icons-vue';

const refs = [
  { path: 'backend/games/drink-pee-unlock/', desc: '当前内置游戏，完整可参考实现（index.html + game.js）' },
  { path: 'backend/public/device-api-bridge.js', desc: 'DeviceAPI 全部方法的实现来源' },
  { path: 'docs/device/capabilities.md', desc: '设备能力、动作、属性、语义值清单' },
  { path: 'docs/guides/GAME_TESTING.md', desc: 'TESTING.md 编写规范（每个游戏必须提供）' },
  { path: 'docs/guides/ELECTRON_DEBUG.md', desc: 'Electron 内调试游戏页面的方法' },
  { path: 'tools/vdev-cli/README.md', desc: '虚拟设备命令行工具，无实机也能测试' },
];

const guideText = `一、游戏是什么
游戏是一个独立的网页，放在 backend/games/<game-id>/ 目录下。它通过全局对象
DeviceAPI 与本机设备通信，不需要自己建立连接、不需要授权。运行时可以在客户端
「本地游戏」里启动，也可以在开发者模式下用浏览器直接打开调试。

二、目录与文件
backend/games/<game-id>/
  index.html   必需。含内联 manifest、页面结构、样式，并引入 bridge 与 game.js
  game.js      必需。游戏逻辑，使用 DeviceAPI 操作设备
  TESTING.md   必需。测试文档，规范见 docs/guides/GAME_TESTING.md
  voices/      可选。语音等静态资源，用相对路径引用

三、index.html 必需的两段引用
1) 在 <head> 里放内联 manifest（类型必须是 application/json，id 必须是 game-manifest）：
   <script type="application/json" id="game-manifest"> { ... } <\/script>
2) 在 manifest 之后引入 bridge 脚本（绝对路径，由后台提供）：
   <script src="/bridge-api/device-api-bridge.js"><\/script>
3) 在 <body> 末尾引入自己的逻辑：
   <script src="game.js"><\/script>

四、manifest 字段（以当前游戏为准）
{
  "id": "游戏唯一标识，与目录名一致",
  "title": "显示名",
  "description": "一句话说明",
  "version": "语义化版本，如 2.2.0",
  "devices": [
    { "id": "scale", "capabilities": ["weight", "reporting"], "required": true },
    { "id": "punish", "capabilities": ["shock"], "required": false }
  ],
  "params": [
    { "key": "durationSec", "type": "number",  "default": 1800, "label": "时长(秒)" },
    { "key": "mode",        "type": "enum",    "default": "drink", "enum": ["drink","pee"], "label": "模式" },
    { "key": "voiceEnabled","type": "boolean", "default": true, "label": "启用语音" }
  ]
}
- devices[].id 是「逻辑设备名」，游戏里用它引用设备；启动时由用户映射到物理设备。
- capabilities 是该逻辑设备要求的能力集合；只有满足全部能力的物理设备才能被映射。
- required=true 的设备未映射则无法启动；false 的设备可缺省，代码里要用 isMapped() 判断。
- params 支持 number / enum / boolean / string，default 会作为初始值注入 DeviceAPI.params。

五、DeviceAPI（来自 bridge 脚本，游戏可直接用）
全局对象 window.DeviceAPI：
- DeviceAPI.ready            Promise，设备通道就绪后 resolve，游戏应 await 它再开始
- DeviceAPI.params           当前参数对象（已合并 manifest 默认值与用户填写值）
- DeviceAPI.deviceMap        逻辑设备 → 物理设备 的映射
- DeviceAPI.getDevices()     取当前在线设备列表
- DeviceAPI.log(level, msg)  写系统日志（level: info/warn/error）
- DeviceAPI.device(logicalId) 取某逻辑设备的操作句柄，句柄方法：
    .isMapped()                     是否已映射到物理设备（可选设备必须先判断）
    .invoke(cap, action, params)    调用能力动作，返回 Promise
                                    如 device('punish').invoke('shock','start',{voltage:24})
                                       device('vibe').invoke('strength','set',{value:200})
    .onValue(cap, cb)               订阅能力语义值变化，如 weight / tiptoePressure
    .readValue(cap)                 读一次当前语义值，返回 Promise
    .onProperty(prop, cb)/.read(prop) 订阅/读原始属性
    .onMessage(cb)                  订阅设备上报的原始消息
    .writeProps(props)              写设备属性
- 能力 / 动作 / 语义值的完整清单见 docs/device/capabilities.md。

六、游戏生命周期（当前实现的写法）
game.js 通常这样组织（参考 drink-pee-unlock/game.js）：
  async function boot() {
    await DeviceAPI.ready;                       // 等通道就绪
    const p = DeviceAPI.params || {};            // 读参数
    const scale = DeviceAPI.device('scale');
    scale.onValue('weight', (v) => onWeight(v));  // 订阅输入
    if (scale.isMapped()) scale.invoke('reporting','setReportDelay',{ms:1000});
    start();                                      // 进入游戏状态
    setInterval(loop, 1000);                      // 主循环
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', boot);
  else boot();
- 结束或停止时，务必把所有设备输出归零（如 shock.stop、strength.set 0）。
- 可选设备的每次调用前都要 isMapped() 判断，避免未映射时报错。

七、调试（开发者本地试玩）
方式 A（推荐，独立端口开发）：
  1. 客户端「网络设置」打开「允许外部本地游戏连接」。
  2. 游戏页面引用后台的 bridge：
     <script src="http://127.0.0.1:5278/bridge-api/device-api-bridge.js"><\/script>
  3. 用任意本地端口（如 http://localhost:8080）打开页面，即可用 DeviceAPI 试玩。
     脚本会自动连回后台，不受页面端口影响。
方式 B（放进内置目录）：
  把游戏放到 backend/games/<id>/，在客户端「本地游戏」里启动运行。
无实机时：用 tools/vdev-cli 起虚拟设备，注入输入并检查设备命令记录。
Electron 内调试页面：见 docs/guides/ELECTRON_DEBUG.md。

八、发布前检查
- manifest 的 id / version 与目录、TESTING.md 一致。
- required 设备缺失能给出提示，可选设备缺失不报错。
- 结束与手动停止后所有设备输出归零。
- 目录内有 TESTING.md，且已按规范执行过测试。

`;
</script>

<style scoped>
.page { max-width: 960px; margin: 40px auto; padding: 0 24px 80px; text-align: left; }
.header-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.muted { color: #6b7280; }
.inline-alert { margin: 16px 0; }
.guide-card { margin-top: 20px; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fafafa; }
.guide-text { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; line-height: 1.7; margin: 0; color: #1f2937; }
.ref-list { list-style: none; padding: 0; margin: 0; }
.ref-list li { padding: 6px 0; border-bottom: 1px solid #f1f5f9; }
.ref-list code { background: #eef2ff; color: #3730a3; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
h2 { font-size: 16px; margin: 0 0 12px; }
</style>
