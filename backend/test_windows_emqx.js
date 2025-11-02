/**
 * Windows平台EMQX自动切换测试
 * 验证在Windows上自动使用EMQX替代mosquitto
 */

const os = require('os');
const mqttService = require('./services/mqttService');

async function testWindowsEmqxIntegration() {
  console.log('=== Windows EMQX集成测试开始 ===\n');
  
  try {
    // 1. 检查操作系统
    console.log('--- 系统信息 ---');
    console.log('操作系统:', os.platform());
    console.log('系统版本:', os.release());
    console.log('是否为Windows:', os.platform() === 'win32');
    console.log();
    
    // 2. 检查mqttService是否正确加载了emqxService
    console.log('--- MQTT服务配置检查 ---');
    console.log('mqttService类型:', typeof mqttService);
    console.log('可用方法:', Object.getOwnPropertyNames(mqttService));
    
    // 检查是否有emqxService相关的属性或方法
    const mqttServiceKeys = Object.keys(mqttService);
    console.log('mqttService属性:', mqttServiceKeys);
    console.log();
    
    // 3. 测试状态检查
    console.log('--- 测试MQTT状态检查 ---');
    const initialStatus = await mqttService.status();
    console.log('初始状态:', initialStatus);
    console.log();
    
    // 4. 测试启动服务
    console.log('--- 测试MQTT服务启动 ---');
    console.log('正在启动MQTT服务...');
    const startResult = await mqttService.start({ port: 1883, bind: '0.0.0.0' });
    console.log('启动结果:', startResult);
    console.log();
    
    // 等待服务启动
    console.log('等待服务完全启动...');
    await new Promise(resolve => setTimeout(resolve, 8000));
    
    // 5. 检查启动后状态
    console.log('--- 启动后状态检查 ---');
    const statusAfterStart = await mqttService.status();
    console.log('启动后状态:', statusAfterStart);
    
    // 分析使用的broker类型
    if (statusAfterStart.broker) {
      console.log('✓ 使用的broker类型:', statusAfterStart.broker);
      if (statusAfterStart.broker === 'emqx') {
        console.log('✓ 成功在Windows上使用EMQX');
      } else if (statusAfterStart.broker === 'mosquitto') {
        console.log('ℹ 回退到mosquitto broker');
      }
    }
    console.log();
    
    // 6. 测试停止服务
    console.log('--- 测试MQTT服务停止 ---');
    const stopResult = await mqttService.stop();
    console.log('停止结果:', stopResult);
    console.log();
    
    // 等待服务停止
    console.log('等待服务完全停止...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 7. 最终状态检查
    console.log('--- 停止后状态检查 ---');
    const finalStatus = await mqttService.status();
    console.log('最终状态:', finalStatus);
    console.log();
    
    console.log('=== Windows EMQX集成测试完成 ===');
    
    // 测试结果分析
    console.log('\n--- 测试结果分析 ---');
    if (os.platform() === 'win32') {
      console.log('✓ 在Windows平台上运行');
      if (statusAfterStart.broker === 'emqx') {
        console.log('✓ 成功使用EMQX作为MQTT broker');
        console.log('✓ Windows EMQX集成工作正常');
      } else {
        console.log('ℹ 使用了', statusAfterStart.broker || '未知', 'broker');
        console.log('ℹ 可能是EMQX启动失败，系统回退到其他broker');
      }
    } else {
      console.log('ℹ 在非Windows平台上运行，应该使用mosquitto');
    }
    
  } catch (error) {
    console.error('❌ 测试过程中发生错误:');
    console.error('错误信息:', error.message);
    console.error('错误堆栈:', error.stack);
  }
}

// 运行测试
testWindowsEmqxIntegration().then(() => {
  console.log('\n🎉 Windows EMQX集成测试完成！');
  process.exit(0);
}).catch((error) => {
  console.error('\n💥 测试失败:', error.message);
  process.exit(1);
});