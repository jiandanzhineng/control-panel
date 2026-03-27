const { execFile } = require("child_process");
const path = require("path");
const { startMockService } = require("./mockService");

function runCli(baseUrl, ...args) {
  const cliPath = path.resolve(__dirname, "../cli.js");
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [cliPath, ...args, "--format=json", `--base-url=${baseUrl}`],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`CLI执行失败: ${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`CLI输出不是合法JSON: ${stdout}`));
        }
      }
    );
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const mock = await startMockService(0);
  try {
    const listResult = await runCli(mock.baseUrl, "devices:list");
    assert(Array.isArray(listResult.rows), "devices:list 返回 rows 应为数组");
    assert(listResult.rows.length === 2, "devices:list 应返回2个设备");
    const listFirst = listResult.rows.find((item) => item.id === "dev01");
    assert(Boolean(listFirst), "devices:list 未返回 dev01");
    assert(listFirst.online === "true", "devices:list online 字段映射错误");

    const getResult = await runCli(mock.baseUrl, "devices:get", "--id=dev01", "--key=name");
    assert(getResult.value === "客厅设备", "devices:get 返回值错误");

    const setResult = await runCli(
      mock.baseUrl,
      "devices:set",
      "--id=dev01",
      "--key=name",
      "--value=主卧设备"
    );
    assert(setResult.accepted === true, "devices:set 未成功");
    assert(setResult.updated === "主卧设备", "devices:set 更新值错误");

    const publishResult = await runCli(
      mock.baseUrl,
      "mqtt:publish",
      "--deviceId=dev01",
      "--payload={\"method\":\"heartbeat\"}"
    );
    assert(publishResult.accepted === true, "mqtt:publish 未成功");
    assert(mock.mqttMessages.length === 1, "mqtt:publish 未命中mock服务");
    assert(mock.mqttMessages[0].topic === "/drecv/dev01", "mqtt:publish 默认topic错误");

    process.stdout.write("mock自测通过：devices:list / devices:get / devices:set / mqtt:publish\n");
  } finally {
    await mock.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
});
