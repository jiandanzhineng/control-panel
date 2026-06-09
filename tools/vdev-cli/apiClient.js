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
      typeof data === "string"
        ? data
        : data?.message || data?.error || response.statusText;
    const error = new Error(message || "请求失败");
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function createApiClient(input = {}) {
  const envBaseUrl =
    process.env.VDEV_CLI_BASE_URL ||
    process.env.DEVICE_CLI_BASE_URL ||
    process.env.API_BASE_URL ||
    "";
  const baseUrl = normalizeBaseUrl(input.baseUrl || envBaseUrl);
  const enc = encodeURIComponent;

  return {
    baseUrl,
    getJson(path) {
      return requestJson(baseUrl, path, { method: "GET" });
    },
    postJson(path, payload) {
      return requestJson(baseUrl, path, {
        method: "POST",
        body: JSON.stringify(payload || {})
      });
    },
    putJson(path, payload) {
      return requestJson(baseUrl, path, {
        method: "PUT",
        body: JSON.stringify(payload || {})
      });
    },
    deleteJson(path) {
      return requestJson(baseUrl, path, { method: "DELETE" });
    },

    // --- 虚拟设备接口封装 ---
    create(body) {
      return this.postJson("/virtual-devices", body);
    },
    batchCreate(devices) {
      return this.postJson("/virtual-devices/batch", { devices });
    },
    list() {
      return this.getJson("/virtual-devices");
    },
    remove(id) {
      return this.deleteJson(`/virtual-devices/${enc(id)}`);
    },
    getProperties(id) {
      return this.getJson(`/virtual-devices/${enc(id)}/properties`);
    },
    setProperties(id, props) {
      return this.putJson(`/virtual-devices/${enc(id)}/properties`, props);
    },
    emit(id, msg) {
      return this.postJson(`/virtual-devices/${enc(id)}/emit`, msg);
    },
    getCommands(id) {
      return this.getJson(`/virtual-devices/${enc(id)}/commands`);
    },
    clearCommands(id) {
      return this.deleteJson(`/virtual-devices/${enc(id)}/commands`);
    },
    startTimeline(id, timeline, loop) {
      return this.postJson(`/virtual-devices/${enc(id)}/timeline`, {
        timeline,
        loop: !!loop
      });
    },
    stopTimeline(id) {
      return this.deleteJson(`/virtual-devices/${enc(id)}/timeline`);
    },
    getTimeline(id) {
      return this.getJson(`/virtual-devices/${enc(id)}/timeline`);
    }
  };
}

module.exports = {
  createApiClient,
  normalizeBaseUrl
};
