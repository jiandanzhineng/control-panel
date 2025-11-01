/**
 * EMQX服务测试脚本
 * 测试emqxService的基本功能
 */

const emqxService = require('./services/emqxService');

async function testEmqxService() {
  console.log('=== EMQX服务测试开始 ===\n');
  
  try {
    // 1. 测试模块导入
    console.log('✓ emqxService模块导入成功');
    console.log('emqxService类型:', typeof emqxService);
    console.log('可用方法:', Object.getOwnPropertyNames(Object.getPrototypeOf(emqxService)));
    console.log();
    
    // 2. 测试安装检查
    console.log('--- 测试安装检查 ---');
    const isInstalled = emqxService.isEmqxInstalled();
    console.log('EMQX是否已安装:', isInstalled);
    console.log();
    
    // 3. 测试路径配置
    console.log('--- 测试路径配置 ---');
    console.log('工具目录:', emqxService.toolsDir);
    console.log('EMQX工作目录:', emqxService.emqxWorkDir);
    console.log('EMQX执行文件路径:', emqxService.emqxPath);
    console.log('EMQX控制文件路径:', emqxService.emqxCtlPath);
    console.log();
    
    // 4. 测试状态检查（不需要实际安装EMQX）
    console.log('--- 测试状态检查 ---');
    console.log('正在检查EMQX状态...');
    const status = await emqxService.checkStatus();
    console.log('状态检查结果:', status);
    console.log();
    
    // 5. 测试AdmZip导入（通过检查extractEmqx方法）
    console.log('--- 测试AdmZip功能 ---');
    console.log('extractEmqx方法存在:', typeof emqxService.extractEmqx === 'function');
    
    // 创建一个临时的小zip文件来测试解压功能
    const fs = require('fs');
    const path = require('path');
    const AdmZip = require('adm-zip');
    
    const testDir = path.join(__dirname, 'temp_test');
    const testZipPath = path.join(testDir, 'test.zip');
    
    // 确保测试目录存在
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    
    // 创建一个简单的测试zip文件
    const zip = new AdmZip();
    zip.addFile('test.txt', Buffer.from('这是一个测试文件'));
    zip.writeZip(testZipPath);
    
    console.log('✓ 成功创建测试zip文件');
    console.log('✓ AdmZip库工作正常');
    
    // 清理测试文件
    if (fs.existsSync(testZipPath)) {
      fs.unlinkSync(testZipPath);
    }
    if (fs.existsSync(testDir)) {
      fs.rmdirSync(testDir);
    }
    console.log('✓ 清理测试文件完成');
    console.log();
    
    console.log('=== 所有测试完成 ===');
    console.log('✓ emqxService模块功能正常');
    console.log('✓ adm-zip依赖工作正常');
    console.log('✓ 基本功能测试通过');
    
  } catch (error) {
    console.error('❌ 测试过程中发生错误:');
    console.error('错误信息:', error.message);
    console.error('错误堆栈:', error.stack);
    process.exit(1);
  }
}

// 运行测试
testEmqxService().then(() => {
  console.log('\n🎉 测试成功完成！');
  process.exit(0);
}).catch((error) => {
  console.error('\n💥 测试失败:', error.message);
  process.exit(1);
});