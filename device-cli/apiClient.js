function normalizeBaseUrl(baseUrl) {
  const raw = (baseUrl || "").trim();
  if (!raw) {
    return "http://127.0.0.1:3000/api";
  }
  const noTrailing = raw.replace(/\/+$/, "");
  if (noTrailing.endsWith("/api")) {
    return noTrailing;
  }
  return `${noTrailing}/api`;
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      typeof data === "string" ? data : data?.message || response.statusText;
    const error = new Error(message || "请求失败");
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function createApiClient(input = {}) {
  const envBaseUrl = process.env.DEVICE_CLI_BASE_URL || process.env.API_BASE_URL || "";
  const baseUrl = normalizeBaseUrl(input.baseUrl || envBaseUrl);

  return {
    baseUrl,
    getJson(path) {
      return requestJson(baseUrl, path, { method: "GET" });
    },
    patchJson(path, payload) {
      return requestJson(baseUrl, path, {
        method: "PATCH",
        body: JSON.stringify(payload || {})
      });
    },
    postJson(path, payload) {
      return requestJson(baseUrl, path, {
        method: "POST",
        body: JSON.stringify(payload || {})
      });
    },
    listDevices() {
      return this.getJson("/devices");
    },
    getDevice(id) {
      return this.getJson(`/devices/${encodeURIComponent(id)}`);
    },
    updateDevice(id, patch) {
      return this.patchJson(`/devices/${encodeURIComponent(id)}`, patch);
    },
    publishMqtt(topic, message) {
      return this.postJson("/mqtt-client/publish", { topic, message });
    }
  };
}

module.exports = {
  createApiClient,
  normalizeBaseUrl
};
