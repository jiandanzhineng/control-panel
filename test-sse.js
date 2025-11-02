// 测试SSE连接的脚本
const EventSource = require('eventsource').default || require('eventsource');

const deviceId = 'qiya001aabbcc';
const url = `http://localhost:3000/api/devices/${deviceId}/monitor-stream`;

console.log(`建立SSE连接到: ${url}`);

const eventSource = new EventSource(url);

eventSource.onopen = () => {
  console.log('✅ SSE连接已建立');
};

eventSource.onmessage = (event) => {
  console.log('📨 收到SSE消息:', event.data);
  try {
    const data = JSON.parse(event.data);
    console.log('📊 解析后的数据:', data);
  } catch (err) {
    console.error('❌ 解析SSE数据失败:', err);
  }
};

eventSource.onerror = (error) => {
  console.error('❌ SSE连接错误:', error);
};

// 10秒后关闭连接
setTimeout(() => {
  console.log('🔌 关闭SSE连接');
  eventSource.close();
  process.exit(0);
}, 10000);

console.log('⏳ 等待SSE消息...');