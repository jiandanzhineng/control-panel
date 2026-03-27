const http = require("http");

function createInitialDevices() {
  return [
    {
      id: "dev01",
      name: "客厅设备",
      type: "esp32",
      connected: true,
      ip: "192.168.1.10",
      mac: "AA:BB:CC:DD:EE:01",
      data: { battery: 88 }
    },
    {
      id: "dev02",
      name: "卧室设备",
      type: "esp32",
      connected: false,
      ip: "192.168.1.11",
      mac: "AA:BB:CC:DD:EE:02",
      data: { battery: 45 }
    }
  ];
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    req.on("data", (chunk) => {
      buffer += chunk;
    });
    req.on("end", () => {
      if (!buffer) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(buffer));
      } catch (error) {
        reject(new Error("请求体不是合法JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function startMockService(port = 0) {
  const devices = createInitialDevices();
  const mqttMessages = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/api/devices") {
      sendJson(res, 200, devices);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/devices/")) {
      const id = decodeURIComponent(pathname.replace("/api/devices/", ""));
      const device = devices.find((item) => item.id === id);
      if (!device) {
        sendJson(res, 404, { message: "设备不存在" });
        return;
      }
      sendJson(res, 200, device);
      return;
    }

    if (req.method === "PATCH" && pathname.startsWith("/api/devices/")) {
      const id = decodeURIComponent(pathname.replace("/api/devices/", ""));
      const device = devices.find((item) => item.id === id);
      if (!device) {
        sendJson(res, 404, { message: "设备不存在" });
        return;
      }
      try {
        const patch = await readJsonBody(req);
        Object.assign(device, patch || {});
        sendJson(res, 200, device);
      } catch (error) {
        sendJson(res, 400, { message: error.message || "请求错误" });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/mqtt-client/publish") {
      try {
        const body = await readJsonBody(req);
        mqttMessages.push(body);
        sendJson(res, 200, { ok: true, accepted: true, count: mqttMessages.length });
      } catch (error) {
        sendJson(res, 400, { message: error.message || "请求错误" });
      }
      return;
    }

    sendJson(res, 404, { message: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}/api`,
        devices,
        mqttMessages,
        async close() {
          await new Promise((done, fail) => {
            server.close((error) => {
              if (error) {
                fail(error);
                return;
              }
              done();
            });
          });
        }
      });
    });
  });
}

module.exports = {
  startMockService
};
