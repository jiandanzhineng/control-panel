/**
 * EMQX API集成测试脚本
 * 测试通过MQTT API接口使用EMQX服务
 */

const http = require('http');

// 测试配置
const API_BASE = 'http://localhost:3000/api/mqtt';

function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const result = {
            statusCode: res.statusCode,
            data: body ? JSON.parse(body) : null
          };
          resolve(result);
        } catch (error) {
          resolve({
            statusCode: res.statusCode,
            data: body,
            error: error.message
          });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function testMqttApi() {
  console.log('=== MQTT API集成测试开始 ===\n');
  
  try {
    // 1. 测试状态检查
    console.log('--- 测试MQTT状态检查 ---');
    const statusResult = await makeRequest('GET', '/status');
    console.log('状态码:', statusResult.statusCode);
    console.log('响应数据:', statusResult.data);
    console.log();
    
    // 2. 测试启动MQTT服务
    console.log('--- 测试MQTT服务启动 ---');
    const startResult = await makeRequest('POST', '/start', {
      port: 1883,
      bind: '0.0.0.0'
    });
    console.log('状态码:', startResult.statusCode);
    console.log('响应数据:', startResult.data);
    console.log();
    
    // 等待服务启动
    console.log('等待服务启动...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 3. 再次检查状态
    console.log('--- 启动后状态检查 ---');
    const statusAfterStart = await makeRequest('GET', '/status');
    console.log('状态码:', statusAfterStart.statusCode);
    console.log('响应数据:', statusAfterStart.data);
    console.log();
    
    // 4. 测试停止服务
    console.log('--- 测试MQTT服务停止 ---');
    const stopResult = await makeRequest('POST', '/stop');
    console.log('状态码:', stopResult.statusCode);
    console.log('响应数据:', stopResult.data);
    console.log();
    
    // 等待服务停止
    console.log('等待服务停止...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 5. 最终状态检查
    console.log('--- 停止后状态检查 ---');
    const statusAfterStop = await makeRequest('GET', '/status');
    console.log('状态码:', statusAfterStop.statusCode);
    console.log('响应数据:', statusAfterStop.data);
    console.log();
    
    console.log('=== API集成测试完成 ===');
    
    // 分析测试结果
    const allSuccessful = [statusResult, startResult, statusAfterStart, stopResult, statusAfterStop]
      .every(result => result.statusCode === 200);
    
    if (allSuccessful) {
      console.log('✓ 所有API调用成功');
      
      // 检查broker类型
      if (statusAfterStart.data && statusAfterStart.data.broker) {
        console.log('✓ 使用的broker类型:', statusAfterStart.data.broker);
        if (statusAfterStart.data.broker === 'emqx') {
          console.log('✓ EMQX集成工作正常');
        } else {
          console.log('ℹ 当前使用的是', statusAfterStart.data.broker, 'broker');
        }
      }
    } else {
      console.log('❌ 部分API调用失败');
    }
    
  } catch (error) {
    console.error('❌ API测试过程中发生错误:');
    console.error('错误信息:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('提示: 请确保后端服务正在运行 (npm start)');
    }
  }
}

// 运行测试
testMqttApi().then(() => {
  console.log('\n🎉 API集成测试完成！');
  process.exit(0);
}).catch((error) => {
  console.error('\n💥 API测试失败:', error.message);
  process.exit(1);
});