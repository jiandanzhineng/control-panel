<template>
  <div class="devices-page">

    <el-tabs v-model="activeTab" class="devices-tabs">
      <el-tab-pane label="设备列表" name="devices">
    <el-card class="stats-card" shadow="never">
      <div class="stats-header">
        <div class="stats-info">
          <el-statistic title="总设备数" :value="devices.length" />
          <el-statistic title="在线设备" :value="connectedCount" class="online-stat" />
          <el-statistic title="离线设备" :value="disconnectedCount" class="offline-stat" />
        </div>
        <div class="actions">
          <el-button
            :icon="Connection"
            :disabled="!bleSupported || bleBusy"
            :loading="bleBusy"
            @click="startBleConnect"
          >
            {{ bleBusy ? '蓝牙连接中' : '蓝牙连接' }}
          </el-button>
          <el-button
            :icon="Link"
            :loading="serialBusy"
            @click="openSerialDialog"
          >
            {{ serialBusy ? '串口探测中' : '串口连接' }}
          </el-button>
          <el-button 
            type="primary" 
            :icon="Refresh" 
            :loading="loading"
            @click="refreshDevices"
          >
            {{ loading ? '刷新中...' : '刷新列表' }}
          </el-button>
          <el-button
            type="success"
            :icon="Upload"
            @click="$router.push('/devices/firmware')"
          >
            固件更新
          </el-button>
          <el-button 
            type="danger" 
            :icon="Delete"
            :disabled="loading || devices.length === 0"
            @click="clearAllDevices"
          >
            清空设备
          </el-button>
          <el-checkbox v-model="autoRefreshEnabled" style="margin-left: 12px;">
            自动刷新(3秒)
          </el-checkbox>
          <div class="serial-auto-control">
            <span>串口自动连接</span>
            <el-switch
              v-model="serialAutoConnect"
              :loading="serialSettingsBusy"
              @change="updateSerialAutoConnect"
            />
          </div>
        </div>
      </div>
    </el-card>

    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      style="margin: 10px 0"
    />

    <el-card shadow="never">
      <template #header>
        <span>设备列表</span>
      </template>
      
      <!-- 桌面端：在线设备表格 -->
      <h4 style="margin: 8px 0 12px">在线设备（{{ connectedCount }}）</h4>
      <el-table 
        :data="onlineDevices" 
        style="width: 100%"
        highlight-current-row
        @current-change="handleCurrentChange"
        v-loading="loading"
        empty-text="暂无在线设备"
        class="desktop-table"
      >
        <el-table-column prop="type" label="类型" width="120">
          <template #default="{ row }">
            {{ deviceTypeMap[row.type] || row.type }}
          </template>
        </el-table-column>
        
        <el-table-column label="设备" min-width="150">
          <template #default="{ row }">
            <span v-if="row.nickname">{{ row.nickname }}-{{ String(row.id).slice(-4) }}</span>
            <span v-else>{{ row.name || row.id }}</span>
          </template>
        </el-table-column>
        
        <el-table-column prop="connected" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.connected ? 'success' : 'danger'" size="small">
              {{ row.connected ? '在线' : '离线' }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="连接" min-width="190">
          <template #default="{ row }">
            <div class="connection-tags">
              <el-tag
                v-for="connection in row.connections"
                :key="connection.type"
                :type="getConnectionTagType(connection.type)"
                :effect="connection.type === row.controlConnection ? 'dark' : 'plain'"
                size="small"
              >
                {{ getConnectionLabel(connection.type) }}{{ connection.legacyIdentity ? ' 旧版' : '' }}{{ connection.type === row.controlConnection ? ' 控制' : '' }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        
        <el-table-column prop="battery" label="电量" width="120">
          <template #default="{ row }">
            <el-tag 
              :type="getBatteryTagType(row.data?.battery)" 
              size="small"
            >
              {{ formatBattery(row.data?.battery) }}
            </el-tag>
          </template>
        </el-table-column>
        
        <el-table-column prop="lastReport" label="最后上报" width="150">
          <template #default="{ row }">
            {{ formatLastReport(row.lastReport) }}
          </template>
        </el-table-column>
        
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button
                v-if="hasMonitorData(row.type)"
                type="primary" 
                size="small"
                @click="openMonitorModal(row)"
              >
                数据监控
              </el-button>
              <el-dropdown 
                v-if="hasOperations(row.type)"
                @command="(command: any) => executeDeviceOperation(row, command)"
                trigger="click"
              >
                <el-button type="success" size="small">
                   操作 <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                 </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item 
                      v-for="operation in getDeviceOperations(row.type)" 
                      :key="operation.key"
                      :command="operation"
                    >
                      {{ operation.name }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button 
                type="danger" 
                size="small"
                :icon="Delete"
                @click="removeDevice(row.id)"
              >
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <!-- 桌面端：离线设备折叠表格 -->
      <el-collapse v-model="offlineCollapseActive" class="desktop-table">
        <el-collapse-item :name="'offline'">
          <template #title>
            <span>离线设备（{{ disconnectedCount }}）</span>
          </template>
          <el-table 
            :data="offlineDevices" 
            style="width: 100%"
            highlight-current-row
            @current-change="handleCurrentChange"
            empty-text="暂无离线设备"
          >
            <el-table-column prop="type" label="类型" width="120">
              <template #default="{ row }">
                {{ deviceTypeMap[row.type] || row.type }}
              </template>
            </el-table-column>
            <el-table-column label="设备" min-width="150">
              <template #default="{ row }">
                <span v-if="row.nickname">{{ row.nickname }}-{{ String(row.id).slice(-4) }}</span>
                <span v-else>{{ row.name || row.id }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="connected" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.connected ? 'success' : 'danger'" size="small">
                  {{ row.connected ? '在线' : '离线' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="连接" min-width="190">
              <template #default="{ row }">
                <div class="connection-tags">
                  <el-tag
                    v-for="connection in row.connections"
                    :key="connection.type"
                    :type="getConnectionTagType(connection.type)"
                    :effect="connection.type === row.controlConnection ? 'dark' : 'plain'"
                    size="small"
                  >
                    {{ getConnectionLabel(connection.type) }}{{ connection.legacyIdentity ? ' 旧版' : '' }}{{ connection.type === row.controlConnection ? ' 控制' : '' }}
                  </el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="battery" label="电量" width="120">
              <template #default="{ row }">
                <el-tag 
                  :type="getBatteryTagType(row.data?.battery)" 
                  size="small"
                >
                  {{ formatBattery(row.data?.battery) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="lastReport" label="最后上报" width="150">
              <template #default="{ row }">
                {{ formatLastReport(row.lastReport) }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="240" fixed="right">
              <template #default="{ row }">
                <div class="table-actions">
                  <el-button 
                    v-if="hasMonitorData(row.type)"
                    type="primary" 
                    size="small"
                    @click="openMonitorModal(row)"
                  >
                    数据监控
                  </el-button>
                  <el-dropdown 
                    v-if="hasOperations(row.type)"
                    @command="(command: any) => executeDeviceOperation(row, command)"
                    trigger="click"
                  >
                    <el-button type="success" size="small">
                       操作 <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                     </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item 
                          v-for="operation in getDeviceOperations(row.type)" 
                          :key="operation.key"
                          :command="operation"
                        >
                          {{ operation.name }}
                        </el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                  <el-button 
                    type="danger" 
                    size="small"
                    :icon="Delete"
                    @click="removeDevice(row.id)"
                  >
                    删除
                  </el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>

      <!-- 移动端：在线设备卡片 -->
      <h4 class="mobile-device-list" style="margin: 8px 0 12px">在线设备（{{ connectedCount }}）</h4>
      <div class="mobile-device-list">
        <div 
          v-for="device in onlineDevices" 
          :key="device.id" 
          class="mobile-device-card"
          @click="selectDevice(device)"
        >
          <div class="device-card-header">
            <div class="device-type">
              {{ deviceTypeMap[device.type] || device.type }}
            </div>
            <el-tag :type="device.connected ? 'success' : 'danger'" size="small">
              {{ device.connected ? '在线' : '离线' }}
            </el-tag>
            <div class="connection-tags">
              <el-tag
                v-for="connection in device.connections"
                :key="connection.type"
                :type="getConnectionTagType(connection.type)"
                :effect="connection.type === device.controlConnection ? 'dark' : 'plain'"
                size="small"
              >
                {{ getConnectionLabel(connection.type) }}{{ connection.legacyIdentity ? ' 旧版' : '' }}
              </el-tag>
            </div>
          </div>
          
          <div class="device-card-content">
            <div class="device-info-row">
              <span class="info-label">设备:</span>
              <span class="info-value">
                <template v-if="device.nickname">{{ device.nickname }}-{{ String(device.id).slice(-4) }}</template>
                <template v-else>{{ device.name || device.id }}</template>
              </span>
            </div>
            
            <div class="device-info-row">
              <span class="info-label">电量:</span>
              <el-tag 
                :type="getBatteryTagType(device.data?.battery)" 
                size="small"
              >
                {{ formatBattery(device.data?.battery) }}
              </el-tag>
            </div>
            
            <div class="device-info-row">
              <span class="info-label">最后上报:</span>
              <span class="info-value">{{ formatLastReport(device.lastReport) }}</span>
            </div>
          </div>
          
          <div class="device-card-actions">
            <el-button 
              v-if="hasMonitorData(device.type)"
              type="primary" 
              size="small"
              @click.stop="openMonitorModal(device)"
            >
              数据监控
            </el-button>
            <el-dropdown 
              v-if="hasOperations(device.type)"
              @command="(command: any) => executeDeviceOperation(device, command)"
              trigger="click"
            >
              <el-button type="success" size="small" @click.stop>
                 操作 <el-icon class="el-icon--right"><ArrowDown /></el-icon>
               </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item 
                    v-for="operation in getDeviceOperations(device.type)" 
                    :key="operation.key"
                    :command="operation"
                  >
                    {{ operation.name }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button 
              type="danger" 
              size="small"
              :icon="Delete"
              @click.stop="removeDevice(device.id)"
            >
              删除
            </el-button>
          </div>
        </div>
      </div>

      <!-- 移动端：离线设备折叠卡片 -->
      <el-collapse v-model="offlineCollapseActive" class="mobile-device-list">
        <el-collapse-item :name="'offline'">
          <template #title>
            <span>离线设备（{{ disconnectedCount }}）</span>
          </template>
          <div class="mobile-device-list">
            <div 
              v-for="device in offlineDevices" 
              :key="device.id" 
              class="mobile-device-card"
              @click="selectDevice(device)"
            >
              <div class="device-card-header">
                <div class="device-type">
                  {{ deviceTypeMap[device.type] || device.type }}
                </div>
                <el-tag :type="device.connected ? 'success' : 'danger'" size="small">
                  {{ device.connected ? '在线' : '离线' }}
                </el-tag>
              </div>
              <div class="device-card-content">
                <div class="device-info-row">
                  <span class="info-label">设备:</span>
                  <span class="info-value">
                    <template v-if="device.nickname">{{ device.nickname }}-{{ String(device.id).slice(-4) }}</template>
                    <template v-else>{{ device.name || device.id }}</template>
                  </span>
                </div>
                <div class="device-info-row">
                  <span class="info-label">电量:</span>
                  <el-tag 
                    :type="getBatteryTagType(device.data?.battery)" 
                    size="small"
                  >
                    {{ formatBattery(device.data?.battery) }}
                  </el-tag>
                </div>
                <div class="device-info-row">
                  <span class="info-label">最后上报:</span>
                  <span class="info-value">{{ formatLastReport(device.lastReport) }}</span>
                </div>
              </div>
              <div class="device-card-actions">
                <el-button 
                  v-if="hasMonitorData(device.type)"
                  type="primary" 
                  size="small"
                  @click.stop="openMonitorModal(device)"
                >
                  数据监控
                </el-button>
                <el-dropdown 
                  v-if="hasOperations(device.type)"
                  @command="(command: any) => executeDeviceOperation(device, command)"
                  trigger="click"
                >
                  <el-button type="success" size="small" @click.stop>
                     操作 <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                   </el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item 
                        v-for="operation in getDeviceOperations(device.type)" 
                        :key="operation.key"
                        :command="operation"
                      >
                        {{ operation.name }}
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
                <el-button 
                  type="danger" 
                  size="small"
                  :icon="Delete"
                  @click.stop="removeDevice(device.id)"
                >
                  删除
                </el-button>
              </div>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </el-card>

    <el-card v-if="selectedDevice" shadow="never" style="margin-top: 10px">
      <template #header>
        <div class="device-detail-header">
          <span>设备详情</span>
          <el-button-group v-if="selectedDevice.data && Object.keys(selectedDevice.data).length > 0">
            <el-button 
              v-if="!isEditing" 
              type="primary" 
              size="small"
              :icon="Edit"
              @click="startEdit"
            >
              编辑
            </el-button>
            <template v-else>
              <el-button 
                type="success" 
                size="small"
                :icon="Check"
                @click="saveChanges"
              >
                保存
              </el-button>
              <el-button 
                size="small"
                :icon="Close"
                @click="cancelEdit"
              >
                取消
              </el-button>
            </template>
          </el-button-group>
        </div>
      </template>

      <el-row :gutter="20">
        <el-col :xs="24" :sm="12" :md="8">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="设备昵称">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <span>{{ selectedDevice.nickname || '未设置' }}</span>
                <el-button link type="primary" :icon="Edit" @click="editNickname">修改</el-button>
              </div>
            </el-descriptions-item>
            <el-descriptions-item label="设备名称">{{ selectedDevice.name }}</el-descriptions-item>
            <el-descriptions-item label="设备ID">{{ selectedDevice.id }}</el-descriptions-item>
            <el-descriptions-item label="设备类型">{{ deviceTypeMap[selectedDevice.type] || selectedDevice.type }}</el-descriptions-item>
            <el-descriptions-item label="固件版本">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <span>{{ currentFirmwareVersion }}</span>
                <el-button link type="primary" @click="showFirmwareDialog = true">固件升级</el-button>
              </div>
            </el-descriptions-item>
            <el-descriptions-item label="连接状态">
              <el-tag :type="selectedDevice.connected ? 'success' : 'danger'" size="small">
                {{ selectedDevice.connected ? '在线' : '离线' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="连接方式">
              <div class="connection-control">
                <el-radio-group
                  :model-value="selectedDevice.controlConnection"
                  size="small"
                  @change="(type: TransportType) => setControlConnection(selectedDevice!, type)"
                >
                  <el-radio-button
                    v-for="connection in selectedDevice.connections"
                    :key="connection.type"
                    :value="connection.type"
                  >
                    {{ getConnectionLabel(connection.type) }}{{ connection.legacyIdentity ? ' 旧版' : '' }}
                  </el-radio-button>
                </el-radio-group>
                <div
                  v-for="connection in selectedDevice.connections"
                  :key="`${connection.type}-details`"
                  class="connection-meta"
                >
                  <span>{{ getConnectionLabel(connection.type) }}</span>
                  <span v-if="connection.portPath">{{ connection.portPath }}</span>
                  <span v-if="connection.firmwareVersion">{{ connection.firmwareVersion }}</span>
                  <el-tag v-if="connection.legacyIdentity" type="warning" size="small">旧版身份</el-tag>
                </div>
                <div class="connection-actions">
                  <el-button
                    v-if="hasConnection(selectedDevice, 'serial')"
                    link
                    type="warning"
                    @click="disconnectSerialDevice(selectedDevice)"
                  >
                    断开串口
                  </el-button>
                  <el-button
                    v-if="hasConnection(selectedDevice, 'ble')"
                    link
                    type="warning"
                    @click="disconnectBleDevice(selectedDevice)"
                  >
                    断开 BLE
                  </el-button>
                </div>
              </div>
            </el-descriptions-item>
            <el-descriptions-item label="最后上报">{{ formatLastReport(selectedDevice.lastReport) }}</el-descriptions-item>
            <el-descriptions-item label="电量">
              <el-tag :type="getBatteryTagType(selectedDevice.data?.battery)" size="small">
                {{ formatBattery(selectedDevice.data?.battery) }}
              </el-tag>
            </el-descriptions-item>
          </el-descriptions>
        </el-col>
        
        <el-col :xs="24" :sm="12" :md="16" v-if="selectedDevice.data && Object.keys(selectedDevice.data).length > 0">
          <h4>设备数据</h4>
          <el-descriptions border size="small" :column="2" class="device-data-table">
            <el-descriptions-item v-for="(value, key) in selectedDevice.data" :key="key" :label="key">
              <template v-if="!isEditing">
                {{ value }}
              </template>
              <template v-else>
                <el-input-number 
                  v-if="getInputType(value) === 'number'" 
                  v-model="editData[key]"
                  size="small"
                  style="width: 100%; max-width: 200px;"
                />
                <el-switch 
                  v-else-if="getInputType(value) === 'checkbox'" 
                  v-model="editData[key]"
                  size="small"
                />
                <el-input 
                  v-else 
                  v-model="editData[key]"
                  size="small"
                  style="width: 100%; max-width: 200px;"
                />
              </template>
            </el-descriptions-item>
          </el-descriptions>
        </el-col>

        <!-- 设备操作 -->
        <el-col :xs="24" :sm="12" :md="8" v-if="deviceOperations.length > 0">
          <h4>设备操作</h4>
          <div class="device-operations">
            <el-button 
              v-for="operation in deviceOperations" 
              :key="operation.key"
              :type="operation.type || 'primary'"
              :loading="operationLoading[operation.key]"
              @click="executeOperation(operation)"
              style="margin-bottom: 8px; width: 100%;"
            >
              {{ operation.name }}
            </el-button>
          </div>
        </el-col>

        <!-- 监控数据 -->
        <el-col :xs="24" :sm="12" :md="8" v-if="monitorData && Object.keys(monitorData).length > 0">
          <h4>监控数据 
            <el-tag :type="monitorConnected ? 'success' : 'danger'" size="small">
              {{ monitorConnected ? '实时' : '离线' }}
            </el-tag>
          </h4>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item 
              v-for="(config, key) in deviceMonitorConfig" 
              :key="key" 
              :label="config.name"
            >
              <span :style="{ color: getMonitorValueColor(String(key), monitorData[key]) }">
                {{ formatMonitorValue(String(key), monitorData[key]) }}
              </span>
            </el-descriptions-item>
          </el-descriptions>
        </el-col>
      </el-row>
    </el-card>

    <el-empty v-else description="请选择一个设备查看详情" style="margin-top: 20px" />

    <el-dialog
      v-model="serialDialogVisible"
      title="选择串口"
      width="min(560px, calc(100vw - 24px))"
      @open="loadSerialPorts"
    >
      <div class="serial-port-content" v-loading="serialPortsLoading">
        <el-table v-if="serialPorts.length > 0" class="serial-port-table" :data="serialPorts" size="small">
          <el-table-column prop="path" label="端口" width="100" />
          <el-table-column prop="manufacturer" label="设备" min-width="190">
            <template #default="{ row }">{{ row.manufacturer || row.friendlyName || '未知串口设备' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">{{ getSerialPortStatus(row.status) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="90">
            <template #default="{ row }">
              <el-button
                type="primary"
                size="small"
                :disabled="row.status === 'connected' || row.status === 'probing'"
                @click="connectSerialPort(row.path)"
              >
                连接
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="serialPorts.length > 0" class="serial-port-list">
          <div v-for="port in serialPorts" :key="port.path" class="serial-port-item">
            <div class="serial-port-summary">
              <strong>{{ port.path }}</strong>
              <el-tag size="small" effect="plain">{{ getSerialPortStatus(port.status) }}</el-tag>
            </div>
            <div class="serial-port-name">
              {{ port.manufacturer || port.friendlyName || '未知串口设备' }}
            </div>
            <el-button
              type="primary"
              size="small"
              :disabled="port.status === 'connected' || port.status === 'probing'"
              @click="connectSerialPort(port.path)"
            >
              连接
            </el-button>
          </div>
        </div>
        <el-empty v-if="!serialPortsLoading && serialPorts.length === 0" description="未发现串口" />
      </div>
    </el-dialog>

    <el-dialog
      v-model="bleDialogVisible"
      title="选择蓝牙设备"
      width="420px"
      :before-close="closeBleDialog"
    >
      <el-table
        v-if="bleCandidates.length > 0"
        :data="bleCandidates"
        size="small"
        @row-click="selectBleCandidate"
      >
        <el-table-column prop="name" label="设备" min-width="180" />
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button type="primary" size="small" @click.stop="selectBleCandidate(row)">连接</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="正在扫描附近设备" />
    </el-dialog>

    <div style="margin-top: 30px; text-align: center;">
      <el-button link type="info" @click="$router.push('/test')" style="opacity: 0.3;">自动化测试</el-button>
    </div>

    <!-- 固件升级弹窗 -->
    <el-dialog
      v-model="showFirmwareDialog"
      title="固件升级"
      width="400px"
    >
      <div class="firmware-panel" v-loading="firmwareLoading">
        <div class="section-title-row" style="margin-bottom: 12px;">
          <span>OTA 状态</span>
          <el-tag :type="getOtaStatusTagType(otaStatus?.status)" size="small">
            {{ getOtaStatusLabel(otaStatus?.status) }}
          </el-tag>
        </div>

        <el-alert
          v-if="firmwareError"
          :title="firmwareError"
          type="error"
          :closable="false"
          show-icon
          class="firmware-alert"
        />

        <template v-else>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="当前版本">
              {{ currentFirmwareVersion }}
            </el-descriptions-item>
            <el-descriptions-item label="最新版本">
              {{ firmwareInfo?.latestVersion || '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="固件支持">
              <el-tag :type="firmwareInfo?.supported ? 'success' : 'info'" size="small">
                {{ firmwareInfo?.supported ? '支持' : '不支持' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="固件文件">
              <span class="firmware-filename">{{ firmwareInfo?.firmware?.filename || '-' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="文件大小">
              {{ formatBytes(firmwareInfo?.firmware?.sizeBytes) }}
            </el-descriptions-item>
            <el-descriptions-item label="SHA256">
              {{ formatShortHash(firmwareInfo?.firmware?.sha256) }}
            </el-descriptions-item>
          </el-descriptions>

          <el-progress
            v-if="showOtaProgress"
            :percentage="otaProgressPercentage"
            :status="getOtaProgressStatus(otaStatus?.status)"
            class="firmware-progress"
          />

          <div class="firmware-status-message">
            {{ firmwareStatusMessage }}
          </div>

          <el-button
            type="primary"
            :icon="Refresh"
            :loading="firmwareUpdating"
            :disabled="!canUpdateFirmware"
            @click="updateFirmwareLatest"
            class="firmware-update-button"
          >
            {{ firmwareActionText }}
          </el-button>
        </template>
      </div>
    </el-dialog>

    <!-- 数据监控弹窗 -->
    <DeviceMonitorModal
      :visible="monitorModalVisible"
      :device-info="monitorDevice"
      @close="closeMonitorModal"
    />
      </el-tab-pane>

      <el-tab-pane label="远程连接" name="remote">
        <RemoteProjectionPanel />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Refresh, Delete, Edit, Check, Close, ArrowDown, Upload, Connection, Link } from '@element-plus/icons-vue'
import DeviceMonitorModal from '../components/DeviceMonitorModal.vue'
import RemoteProjectionPanel from '../components/RemoteProjectionPanel.vue'
import { track } from '../analytics'

interface DeviceData { [key: string]: any }
type TransportType = 'mqtt' | 'serial' | 'ble' | 'remote';
interface DeviceConnection {
  type: TransportType;
  connected: boolean;
  connectedAt?: string;
  lastActivity?: string;
  firmwareVersion?: string;
  portPath?: string;
  legacyIdentity?: boolean;
}
interface Device {
  id: string;
  name: string;
  nickname?: string;
  type: string;
  connected: boolean;
  controlConnection: TransportType | null;
  connections: DeviceConnection[];
  lastReport: string | null;
  data: DeviceData;
}

interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  friendlyName?: string;
  status: 'idle' | 'probing' | 'connected' | 'backoff';
}

interface FirmwareInfo {
  supported: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  manifestGeneratedAt: string | null;
  commit: string | null;
  firmware: null | {
    device: string;
    kind: string;
    filename: string;
    objectKey: string;
    url: string;
    sizeBytes: number;
    sha256: string;
  };
}

interface OtaStatus {
  deviceId: string;
  status: string;
  progress: number | null;
  msg: string;
  updatedAt: string | null;
  firmwareVersion: string | null;
  filename: string | null;
  url: string | null;
}

const activeTab = ref<'devices' | 'remote'>('devices');
const devices = ref<Device[]>([]);
const deviceTypeMap = ref<Record<string, string>>({});
const deviceTypeConfigs = ref<Record<string, any>>({});
const loading = ref(false);
const loadError = ref('');
const selectedDeviceId = ref('');
const autoRefreshEnabled = ref(true);
const autoRefreshTimer = ref<number | null>(null);
const bleSupported = ref(false);
const bleBusy = ref(false);
const bleDialogVisible = ref(false);
const bleCandidates = ref<Array<{ id: string; name: string }>>([]);
let disposeBleScanResults: (() => void) | null = null;
const serialBusy = ref(false);
const serialDialogVisible = ref(false);
const serialPortsLoading = ref(false);
const serialPorts = ref<SerialPortInfo[]>([]);
const serialAutoConnect = ref(false);
const serialSettingsBusy = ref(false);

// 设备操作相关
const operationLoading = ref<Record<string, boolean>>({});

// 监控数据相关
const monitorData = ref<Record<string, any>>({});
const monitorConnected = ref(false);
const monitorEventSource = ref<EventSource | null>(null);
const firmwareInfo = ref<FirmwareInfo | null>(null);
const firmwareLoading = ref(false);
const firmwareUpdating = ref(false);
const firmwareError = ref('');
const otaStatus = ref<OtaStatus | null>(null);
const otaStatusEventSource = ref<EventSource | null>(null);
const otaStatusNow = ref(Date.now());
const otaStatusTimer = ref<number | null>(null);

// 监控弹窗相关
const monitorModalVisible = ref(false);
const monitorDevice = ref<Device | null>(null);

// 固件升级弹窗相关
const showFirmwareDialog = ref(false);

const selectedDevice = computed<Device | null>(() => {
  return devices.value.find(d => d.id === selectedDeviceId.value) || null;
});
const connectedCount = computed(() => devices.value.filter(d => d.connected).length);
const disconnectedCount = computed(() => devices.value.filter(d => !d.connected).length);
// 已上报 device_connect 的在线设备 id 集合，用于检测离线→在线边沿
let connectedDeviceIds = new Set<string>();
const onlineDevices = computed(() => devices.value.filter(d => d.connected));
const offlineDevices = computed(() => devices.value.filter(d => !d.connected));
const offlineCollapseActive = ref<string[]>([]);
const OTA_PROGRESS_TIMEOUT_MS = 20000;

// 当前设备的操作配置
const deviceOperations = computed(() => {
  if (!selectedDevice.value) return [];
  const config = deviceTypeConfigs.value[selectedDevice.value.type];
  return config?.operations || [];
});

// 当前设备的监控数据配置
const deviceMonitorConfig = computed(() => {
  if (!selectedDevice.value) return {};
  const config = deviceTypeConfigs.value[selectedDevice.value.type];
  return config?.monitorData || {};
});

const currentFirmwareVersion = computed(() => {
  const control = selectedDevice.value?.connections.find(
    connection => connection.type === selectedDevice.value?.controlConnection,
  );
  return selectedDevice.value?.data?.ver
    || control?.firmwareVersion
    || firmwareInfo.value?.currentVersion
    || '未知';
});

const otaProgressPercentage = computed(() => {
  if (typeof otaStatus.value?.progress === 'number') return otaStatus.value.progress;
  return ['requested', 'start'].includes(otaStatus.value?.status || '') ? 0 : 0;
});

const showOtaProgress = computed(() => {
  return ['requested', 'start', 'downloading', 'success', 'failed'].includes(otaStatus.value?.status || '');
});

const isFirmwareBusy = computed(() => {
  return isActiveOtaStatus(otaStatus.value);
});

const canUpdateFirmware = computed(() => {
  return !!selectedDevice.value?.connected
    && selectedDevice.value?.controlConnection !== 'ble'
    && !!firmwareInfo.value?.supported
    && !!firmwareInfo.value?.updateAvailable
    && !firmwareLoading.value
    && !firmwareUpdating.value
    && !isFirmwareBusy.value;
});

const firmwareActionText = computed(() => {
  if (!selectedDevice.value?.connected) return '设备离线';
  if (selectedDevice.value?.controlConnection === 'ble') return 'BLE 连接不可升级';
  if (firmwareLoading.value) return '检查中';
  if (!firmwareInfo.value?.supported) return '暂无固件';
  if (!firmwareInfo.value?.updateAvailable) return '已是最新';
  if (isFirmwareBusy.value) return '升级中';
  if (isTimedOutOtaStatus(otaStatus.value)) return '重新开始升级';
  return '更新到最新版本';
});

const firmwareSummaryText = computed(() => {
  if (isTimedOutOtaStatus(otaStatus.value)) return '20秒内未收到升级进度，可重新开始升级';
  if (!firmwareInfo.value) return '正在检查固件版本';
  if (!firmwareInfo.value.supported) return '该设备类型没有可用 OTA 应用固件';
  if (firmwareInfo.value.updateAvailable) return `可更新到 ${firmwareInfo.value.latestVersion}`;
  return '当前设备固件已是最新版本';
});

const firmwareStatusMessage = computed(() => {
  if (isTimedOutOtaStatus(otaStatus.value)) return '20秒内未收到升级进度，可重新开始升级';
  return otaStatus.value?.msg || firmwareSummaryText.value;
});

// 编辑状态
const isEditing = ref(false);
const editData = ref<DeviceData>({});
const originalData = ref<DeviceData>({});

onMounted(async () => {
  bleSupported.value = !!window.bleApi?.isSupported();
  disposeBleScanResults = window.bleApi?.onScanResults((candidates) => {
    bleCandidates.value = candidates;
  }) || null;
  await init();
  if (autoRefreshEnabled.value) startAutoRefresh();
  startOtaStatusTimer();
});

onUnmounted(() => {
  if (bleBusy.value) window.bleApi?.cancelSelection().catch(() => {});
  disposeBleScanResults?.();
  disposeBleScanResults = null;
  closeMonitorConnection();
  closeOtaStatusConnection();
  stopAutoRefresh();
  stopOtaStatusTimer();
});

async function init() {
  loading.value = true;
  loadError.value = '';
  try {
    await Promise.all([
      loadDeviceTypes(),
      loadDeviceTypeConfigs(),
      refreshDevices(),
      loadSerialSettings(),
    ]);
  } catch (e: any) {
    loadError.value = e?.message || '数据加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadDeviceTypes() {
  const res = await fetch('/api/device-types');
  if (!res.ok) throw new Error('设备类型获取失败');
  deviceTypeMap.value = await res.json();
}

async function loadDeviceTypeConfigs() {
  const res = await fetch('/api/device-types/configs');
  if (!res.ok) throw new Error('设备类型配置获取失败');
  deviceTypeConfigs.value = await res.json();
}

async function refreshDevices() {
  const res = await fetch('/api/devices');
  if (!res.ok) throw new Error('设备列表获取失败');
  const rawList: Device[] = await res.json();
  const list = rawList.map(normalizeDevice);
  // 检测离线→在线的边沿，仅对新上线设备上报 device_connect（避免轮询重复上报）
  for (const d of list) {
    if (d.connected && !connectedDeviceIds.has(d.id)) {
      track('device_connect', { device_type: d.type });
    }
  }
  connectedDeviceIds = new Set(list.filter(d => d.connected).map(d => d.id));
  devices.value = list;
  // 刷新后保留原选中设备；若设备已不存在则清空并关闭监控
  if (selectedDeviceId.value) {
    const exists = list.some(d => d.id === selectedDeviceId.value);
    if (!exists) {
      selectedDeviceId.value = '';
      closeMonitorConnection();
      closeOtaStatusConnection();
    }
  }
}

function normalizeDevice(device: Device & { connectionType?: TransportType }): Device {
  const fallbackType = device.connectionType;
  const connections = Array.isArray(device.connections)
    ? device.connections
    : (fallbackType && device.connected ? [{ type: fallbackType, connected: true }] : []);
  return {
    ...device,
    connections,
    controlConnection: device.controlConnection || connections[0]?.type || null,
  };
}

async function readJsonResponse(res: Response, fallback: string) {
  let data: any = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok || data?.error) {
    throw new Error(data?.message || data?.error?.message || fallback);
  }
  return data;
}

async function loadSerialSettings() {
  const res = await fetch('/api/serial/settings');
  const data = await readJsonResponse(res, '串口自动连接设置获取失败');
  serialAutoConnect.value = data.autoConnect === true;
}

async function updateSerialAutoConnect(value: boolean | string | number) {
  const enabled = value === true;
  serialSettingsBusy.value = true;
  try {
    const res = await fetch('/api/serial/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoConnect: enabled }),
    });
    const data = await readJsonResponse(res, '串口自动连接设置失败');
    serialAutoConnect.value = data.autoConnect === true;
  } catch (error: any) {
    serialAutoConnect.value = !enabled;
    ElMessage.error(error?.message || '串口自动连接设置失败');
  } finally {
    serialSettingsBusy.value = false;
  }
}

async function openSerialDialog() {
  serialDialogVisible.value = true;
  await loadSerialPorts();
}

async function loadSerialPorts() {
  serialPortsLoading.value = true;
  try {
    const res = await fetch('/api/serial/ports');
    const data = await readJsonResponse(res, '串口列表获取失败');
    serialPorts.value = Array.isArray(data) ? data : (data.ports || []);
  } catch (error: any) {
    ElMessage.error(error?.message || '串口列表获取失败');
  } finally {
    serialPortsLoading.value = false;
  }
}

async function connectSerialPort(path: string) {
  serialBusy.value = true;
  try {
    const res = await fetch('/api/serial/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await readJsonResponse(res, '串口连接失败');
    await refreshDevices();
    serialDialogVisible.value = false;
    selectedDeviceId.value = data.device?.id || data.id || selectedDeviceId.value;
    ElMessage.success(`${path} 已连接`);
  } catch (error: any) {
    ElMessage.error(error?.message || '串口连接失败');
    await loadSerialPorts();
  } finally {
    serialBusy.value = false;
  }
}

async function disconnectSerialDevice(device: Device) {
  try {
    const res = await fetch(`/api/serial/connections/${encodeURIComponent(device.id)}`, {
      method: 'DELETE',
    });
    await readJsonResponse(res, '串口断开失败');
    await refreshDevices();
    ElMessage.success('串口已断开');
  } catch (error: any) {
    ElMessage.error(error?.message || '串口断开失败');
  }
}

async function setControlConnection(device: Device, type: TransportType) {
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(device.id)}/control-connection`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    });
    await readJsonResponse(res, '控制连接切换失败');
    await refreshDevices();
  } catch (error: any) {
    ElMessage.error(error?.message || '控制连接切换失败');
  }
}

function hasConnection(device: Device, type: TransportType) {
  return device.connections.some(connection => connection.type === type && connection.connected);
}

function getConnectionLabel(type: TransportType) {
  return { mqtt: 'MQTT', serial: '串口', ble: 'BLE', remote: '远程' }[type];
}

function getConnectionTagType(type: TransportType): 'success' | 'primary' | 'warning' | 'info' {
  return { mqtt: 'info', serial: 'success', ble: 'primary', remote: 'warning' }[type] as 'success' | 'primary' | 'warning' | 'info';
}

function getSerialPortStatus(status: SerialPortInfo['status']) {
  return { idle: '可连接', probing: '探测中', connected: '已连接', backoff: '等待重试' }[status] || status;
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer.value = window.setInterval(() => {
    refreshDevices();
  }, 3000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer.value) {
    clearInterval(autoRefreshTimer.value);
    autoRefreshTimer.value = null;
  }
}

function startOtaStatusTimer() {
  stopOtaStatusTimer();
  otaStatusTimer.value = window.setInterval(() => {
    otaStatusNow.value = Date.now();
  }, 1000);
}

function stopOtaStatusTimer() {
  if (otaStatusTimer.value) {
    clearInterval(otaStatusTimer.value);
    otaStatusTimer.value = null;
  }
}

watch(autoRefreshEnabled, (enabled) => {
  if (enabled) startAutoRefresh();
  else stopAutoRefresh();
});

watch(selectedDeviceId, (deviceId) => {
  showFirmwareDialog.value = false;
  closeOtaStatusConnection();
  firmwareInfo.value = null;
  firmwareError.value = '';
  otaStatus.value = null;

  if (deviceId) {
    loadFirmwareInfo(deviceId);
    setupOtaStatusConnection(deviceId);
  }
});

function handleCurrentChange(currentRow: Device | null) {
  // 仅在明确选中新的行时才切换设备与监控连接
  if (currentRow) {
    closeMonitorConnection();
    selectedDeviceId.value = currentRow.id;
  }
}

function selectDevice(device: Device) {
  closeMonitorConnection();
  selectedDeviceId.value = device.id;
}

async function startBleConnect() {
  const api = window.bleApi;
  if (!api?.isSupported()) {
    ElMessage.error('当前电脑或运行环境不支持 BLE');
    return;
  }
  bleCandidates.value = [];
  bleDialogVisible.value = true;
  bleBusy.value = true;
  try {
    const device = await api.connect();
    bleDialogVisible.value = false;
    await refreshDevices();
    selectedDeviceId.value = device.id;
    ElMessage.success(`${device.name || device.type} 已通过 BLE 连接`);
  } catch (error: any) {
    if (error?.name !== 'NotFoundError' && !String(error?.message || '').toLowerCase().includes('cancel')) {
      ElMessage.error(error?.message || 'BLE 连接失败');
    }
  } finally {
    bleBusy.value = false;
  }
}

async function selectBleCandidate(candidate: { id: string; name: string }) {
  try {
    await window.bleApi?.selectDevice(candidate.id);
  } catch (error: any) {
    ElMessage.error(error?.message || '选择蓝牙设备失败');
  }
}

function closeBleDialog(done: () => void) {
  window.bleApi?.cancelSelection().catch(() => {});
  done();
}

async function disconnectBleDevice(device: Device) {
  try {
    await window.bleApi?.disconnect(device.id);
    await refreshDevices();
    ElMessage.success('BLE 设备已安全断开');
  } catch (error: any) {
    ElMessage.error(error?.message || 'BLE 断开失败');
  }
}

async function clearAllDevices() {
  try {
    await ElMessageBox.confirm(
      '确定要删除所有设备吗？此操作不可恢复！',
      '警告',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );
    
    await window.bleApi?.disconnectAll();
    const res = await fetch('/api/devices/all', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '清空设备失败');
    devices.value = [];
    selectedDeviceId.value = '';
    ElMessage.success('设备清空成功');
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(error?.message || '清空设备失败');
    }
  }
}

async function removeDevice(id: string) {
  try {
    await ElMessageBox.confirm(
      '确定要删除这个设备吗？',
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );
    
    const device = devices.value.find((item) => item.id === id);
    if (device && hasConnection(device, 'ble')) await window.bleApi?.disconnect(id);
    const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '删除设备失败');
    devices.value = devices.value.filter(d => d.id !== id);
    if (selectedDeviceId.value === id) selectedDeviceId.value = '';
    ElMessage.success('设备删除成功');
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(error?.message || '删除设备失败');
    }
  }
}

function startEdit() {
  if (!selectedDevice.value || !selectedDevice.value.data) return;
  isEditing.value = true;
  originalData.value = JSON.parse(JSON.stringify(selectedDevice.value.data));
  editData.value = JSON.parse(JSON.stringify(selectedDevice.value.data));
}

function cancelEdit() {
  isEditing.value = false;
  editData.value = {};
  originalData.value = {};
}

async function editNickname() {
  if (!selectedDevice.value) return;
  try {
    const { value } = await ElMessageBox.prompt('请输入设备昵称，留空则清除昵称', '设置昵称', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: selectedDevice.value.nickname || '',
    });
    
    const res = await fetch(`/api/devices/${encodeURIComponent(selectedDevice.value.id)}/nickname`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: value })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '设置失败');
    
    // 更新本地数据
    const index = devices.value.findIndex(d => d.id === selectedDevice.value!.id);
    if (index !== -1) {
      devices.value[index] = data;
    }
    ElMessage.success('昵称设置成功');
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(error?.message || '设置失败');
    }
  }
}

async function saveChanges() {
  if (!selectedDevice.value) return;
  try {
    const updateData: Record<string, any> = { method: 'update' };
    for (const key in editData.value) {
      if (editData.value[key] !== originalData.value[key]) {
        const originalValue = originalData.value[key];
        let newValue = editData.value[key];
        if (typeof originalValue === 'number') {
          newValue = Number(newValue);
        } else if (typeof originalValue === 'boolean') {
          newValue = newValue === 'true' || newValue === true;
        }
        updateData[key] = newValue;
      }
    }
    if (Object.keys(updateData).length === 1) { // 没有变更
      cancelEdit();
      return;
    }
    if (isSafeModeDisabled(updateData.safe)) {
      try {
        await ElMessageBox.confirm(
          '关闭安全模式需要您自己承担全部风险，是否确认？',
          '确认关闭安全模式',
          {
            confirmButtonText: '确认',
            cancelButtonText: '取消',
            type: 'warning',
          }
        );
      } catch (error) {
        if (error === 'cancel' || error === 'close') return;
        throw error;
      }
    }
    const ok = await publishMessage(selectedDevice.value.id, updateData);
    if (!ok) throw new Error('消息下发失败');
    // 更新本地数据与状态
    devices.value = devices.value.map(d => {
      if (d.id === selectedDevice!.value!.id) {
        const merged = { ...d.data };
        for (const k in updateData) {
          if (k !== 'method') merged[k] = updateData[k];
        }
        return { ...d, data: merged, connected: true, lastReport: new Date().toISOString() };
      }
      return d;
    });
    cancelEdit();
    ElMessage.success('设备数据更新成功');
  } catch (e: any) {
    ElMessage.error(e?.message || '保存失败');
  }
}

function isSafeModeDisabled(value: any) {
  return value === 0 || (typeof value === 'string' && value.trim() === '0');
}

async function publishMessage(deviceId: string, message: any) {
  const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  const data = await res.json();
  if (!res.ok || data.error) return false;
  return true;
}

// 执行设备操作
async function executeOperation(operation: any) {
  if (!selectedDevice.value) return;
  
  const operationKey = operation.key;
  operationLoading.value[operationKey] = true;
  
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(selectedDevice.value.id)}/operations/${operationKey}`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '操作执行失败');
    ElMessage.success(`${operation.name} 执行成功`);
  } catch (error: any) {
    ElMessage.error(error?.message || `${operation.name} 执行失败`);
  } finally {
    operationLoading.value[operationKey] = false;
  }
}

async function loadFirmwareInfo(deviceId: string) {
  firmwareLoading.value = true;
  firmwareError.value = '';
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/firmware/latest`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || data.message || '固件信息获取失败');
    if (selectedDeviceId.value === deviceId) {
      firmwareInfo.value = data;
    }
  } catch (error: any) {
    if (selectedDeviceId.value === deviceId) {
      firmwareError.value = error?.message || '固件信息获取失败';
    }
  } finally {
    if (selectedDeviceId.value === deviceId) {
      firmwareLoading.value = false;
    }
  }
}

function setupOtaStatusConnection(deviceId: string) {
  closeOtaStatusConnection();
  try {
    const eventSource = new EventSource(`/api/devices/${encodeURIComponent(deviceId)}/firmware/status-stream`);

    const handleStatus = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.deviceId === selectedDeviceId.value) {
          otaStatus.value = data;
        }
      } catch (error) {
        console.error('解析 OTA 状态失败:', error);
      }
    };

    eventSource.addEventListener('status', handleStatus);
    eventSource.onmessage = handleStatus;
    eventSource.onerror = () => {
      if (otaStatus.value?.status && !['success', 'failed'].includes(otaStatus.value.status)) {
        otaStatus.value = {
          ...otaStatus.value,
          msg: 'OTA 状态连接已断开，正在等待浏览器重连',
        };
      }
    };

    otaStatusEventSource.value = eventSource;
  } catch (error) {
    console.error('建立 OTA 状态连接失败:', error);
  }
}

function closeOtaStatusConnection() {
  if (otaStatusEventSource.value) {
    otaStatusEventSource.value.close();
    otaStatusEventSource.value = null;
  }
}

async function updateFirmwareLatest() {
  if (!selectedDevice.value || !firmwareInfo.value) return;

  try {
    await ElMessageBox.confirm(
      `确认将 ${selectedDevice.value.name || selectedDevice.value.id} 更新到 ${firmwareInfo.value.latestVersion}？升级完成后设备会自动重启。`,
      '确认固件升级',
      {
        confirmButtonText: '开始升级',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );

    firmwareUpdating.value = true;
    const res = await fetch(`/api/devices/${encodeURIComponent(selectedDevice.value.id)}/firmware/update-latest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || data.message || 'OTA 指令下发失败');

    if (data.status) otaStatus.value = data.status;
    ElMessage.success('OTA 指令已下发');
  } catch (error: any) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error?.message || 'OTA 指令下发失败');
    }
  } finally {
    firmwareUpdating.value = false;
  }
}

function formatBytes(value: any) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatShortHash(value: any) {
  if (!value) return '-';
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 12)}...` : text;
}

function getOtaStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    idle: '空闲',
    requested: '已下发',
    start: '开始',
    downloading: '下载中',
    success: '成功',
    failed: '失败',
    unknown: '未知',
  };
  return labels[status || 'idle'] || status || '空闲';
}

function getOtaStatusTagType(status?: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'requested' || status === 'start' || status === 'downloading') return 'warning';
  return 'info';
}

function getOtaProgressStatus(status?: string): 'success' | 'exception' | 'warning' | undefined {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'exception';
  if (status === 'requested' || status === 'start') return 'warning';
  return undefined;
}

function isOtaProgressStatus(status?: string) {
  return ['requested', 'start', 'downloading'].includes(status || '');
}

function isTimedOutOtaStatus(status: OtaStatus | null | undefined) {
  if (!status || !isOtaProgressStatus(status.status)) return false;
  if (!status.updatedAt) return true;
  const updatedAt = new Date(status.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return true;
  return otaStatusNow.value - updatedAt > OTA_PROGRESS_TIMEOUT_MS;
}

function isActiveOtaStatus(status: OtaStatus | null | undefined) {
  return !!status && isOtaProgressStatus(status.status) && !isTimedOutOtaStatus(status);
}

function getInputType(value: any): 'number' | 'checkbox' | 'text' {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'checkbox';
  return 'text';
}

function formatBattery(battery: any) {
  if (battery === undefined || battery === null) return '未知';
  if (typeof battery === 'number') return `${Math.round(battery)}%`;
  const num = Number(battery);
  if (!isNaN(num)) return `${Math.round(num)}%`;
  return String(battery);
}



function getBatteryTagType(battery: any): 'success' | 'warning' | 'danger' | 'info' {
  if (battery === undefined || battery === null) return 'info';
  const level = typeof battery === 'number' ? battery : parseFloat(String(battery));
  if (isNaN(level)) return 'info';
  if (level <= 20) return 'danger';
  if (level <= 50) return 'warning';
  return 'success';
}

function formatLastReport(timestamp: string | null) {
  if (!timestamp) return '从未上报';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

// 建立监控数据连接
async function setupMonitorConnection(deviceId: string, deviceType: string) {
  const config = deviceTypeConfigs.value[deviceType];
  if (!config?.monitorData || Object.keys(config.monitorData).length === 0) {
    return;
  }

  try {
    // 先获取当前监控数据
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/monitor-data`);
    if (res.ok) {
      const data = await res.json();
      if (!data.error) {
        monitorData.value = data;
      }
    }

    // 建立SSE连接获取实时数据
    const eventSource = new EventSource(`/api/devices/${encodeURIComponent(deviceId)}/monitor-stream`);
    
    eventSource.onopen = () => {
      monitorConnected.value = true;
    };
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        monitorData.value = { ...monitorData.value, ...data };
      } catch (e) {
        console.error('解析监控数据失败:', e);
      }
    };
    
    eventSource.onerror = () => {
      monitorConnected.value = false;
    };
    
    monitorEventSource.value = eventSource;
  } catch (error) {
    console.error('建立监控连接失败:', error);
  }
}

// 关闭监控数据连接
function closeMonitorConnection() {
  if (monitorEventSource.value) {
    monitorEventSource.value.close();
    monitorEventSource.value = null;
  }
  monitorConnected.value = false;
  monitorData.value = {};
}

// 格式化监控数据值
function formatMonitorValue(key: string, value: any) {
  const config = deviceMonitorConfig.value[key];
  if (!config) return String(value || '-');
  
  if (value === undefined || value === null) return '-';
  
  if (config.unit) {
    return `${value}${config.unit}`;
  }
  
  return String(value);
}

// 获取监控数据值的颜色
function getMonitorValueColor(key: string, value: any) {
  const config = deviceMonitorConfig.value[key];
  if (!config || !config.thresholds || value === undefined || value === null) {
    return 'var(--text-secondary)';
  }
  
  const numValue = Number(value);
  if (isNaN(numValue)) return 'var(--text-secondary)';
  
  const { warning, danger } = config.thresholds;
  
  if (danger && numValue >= danger) return '#f56c6c';
  if (warning && numValue >= warning) return '#e6a23c';
  return '#67c23a';
}

// 检查设备是否支持监控数据
function hasMonitorData(deviceType: string) {
  const config = deviceTypeConfigs.value[deviceType];
  return config?.monitorData && Object.keys(config.monitorData).length > 0;
}

// 检查设备是否支持操作
function hasOperations(deviceType: string) {
  const config = deviceTypeConfigs.value[deviceType];
  return config?.operations && config.operations.length > 0;
}

// 获取设备操作列表
function getDeviceOperations(deviceType: string) {
  const config = deviceTypeConfigs.value[deviceType];
  return config?.operations || [];
}

// 打开监控弹窗
function openMonitorModal(device: Device) {
  monitorDevice.value = device;
  if (selectedDeviceId.value !== device.id) {
    selectedDeviceId.value = device.id;
  }
  closeMonitorConnection();
  setupMonitorConnection(device.id, device.type);
  monitorModalVisible.value = true;
}

// 关闭监控弹窗
function closeMonitorModal() {
  monitorModalVisible.value = false;
  monitorDevice.value = null;
  closeMonitorConnection();
}

// 执行设备操作（从表格/卡片操作按钮）
async function executeDeviceOperation(device: Device, operation: any) {
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(device.id)}/operations/${operation.key}`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '操作执行失败');
    ElMessage.success(`${operation.name} 执行成功`);
  } catch (error: any) {
    ElMessage.error(error?.message || `${operation.name} 执行失败`);
  }
}
</script>

<style scoped>
.devices-page {
  padding: 20px;
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  box-sizing: border-box;
}

.devices-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}

.stats-card {
  margin-bottom: 20px;
}

.stats-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 20px;
}

.stats-info {
  display: flex;
  gap: 40px;
  flex-wrap: wrap;
}

.online-stat :deep(.el-statistic__number) {
  color: #67c23a;
}

.offline-stat :deep(.el-statistic__number) {
  color: #f56c6c;
}

.actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.serial-auto-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.connection-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.connection-control {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.connection-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.connection-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
}

.device-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.section-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.section-title-row h4 {
  margin: 0 0 12px;
}

.firmware-panel {
  min-height: 280px;
}

.firmware-alert {
  margin-bottom: 12px;
}

.firmware-filename {
  word-break: break-all;
}

.firmware-progress {
  margin-top: 14px;
}

.firmware-status-message {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
  min-height: 20px;
  margin: 10px 0;
}

.firmware-update-button {
  width: 100%;
}

.table-actions {
  display: flex;
  gap: 8px;
  flex-wrap: nowrap;
}

.serial-port-content {
  min-height: 120px;
}

.serial-port-list {
  display: none;
}

/* 移动端卡片样式 */
.mobile-device-list {
  display: none;
}

.mobile-device-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  margin-bottom: 12px;
  padding: 16px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.device-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
}

.device-type {
  font-weight: 600;
  font-size: 16px;
  color: var(--text-primary);
}

.device-card-content {
  margin-bottom: 12px;
}

.device-info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 14px;
}

.device-info-row:last-child {
  margin-bottom: 0;
}

.info-label {
  color: var(--text-secondary);
  font-weight: 500;
  min-width: 80px;
}

.info-value {
  color: var(--text-primary);
  flex: 1;
  text-align: right;
  word-break: break-all;
}

.device-card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px solid #f0f0f0;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .devices-page {
    padding: 12px;
  }
  
  .stats-card {
    margin-bottom: 16px;
  }
  
  .stats-header {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
  }
  
  .stats-info {
    justify-content: space-around;
    gap: 20px;
  }
  
  .actions {
    justify-content: center;
  }
  
  .device-detail-header {
    flex-direction: column;
    align-items: stretch;
  }
  
  .device-detail-header .el-button-group {
    align-self: center;
  }
  
  /* 隐藏桌面端表格，显示移动端卡片 */
  .desktop-table {
    display: none;
    width: 100%;
    overflow-x: auto;
  }
  
  .mobile-device-list {
    display: block;
  }
}

@media (max-width: 480px) {
  .devices-page {
    padding: 8px;
  }
  
  .stats-card {
    margin-bottom: 12px;
  }
  
  .stats-info {
    flex-direction: column;
    gap: 12px;
    text-align: center;
  }
  
  .actions {
    flex-direction: column;
    gap: 8px;
  }
  
  .actions .el-button {
    width: 100%;
  }

  .serial-port-table {
    display: none;
  }

  .serial-port-list {
    display: grid;
    gap: 10px;
  }

  .serial-port-item {
    display: grid;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
  }

  .serial-port-summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  .serial-port-name {
    min-width: 0;
    color: var(--text-secondary);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .serial-port-item .el-button {
    width: 100%;
    margin: 0;
  }
  
  .mobile-device-card {
    padding: 12px;
    margin-bottom: 8px;
  }
  
  .device-type {
    font-size: 15px;
  }
  
  .device-info-row {
    font-size: 13px;
    margin-bottom: 6px;
  }
  
  .info-label {
    min-width: 70px;
  }
}
</style>
