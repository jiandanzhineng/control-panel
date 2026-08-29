export function isButtonPressedPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const msg = payload as Record<string, unknown>;
  return msg.method === 'action' && msg.action === 'key_clicked';
}

export function listenDeviceButtonPress(
  deviceId: string,
  onPressed: () => void,
  options: { timeoutMs?: number; onTimeout?: () => void } = {},
): () => void {
  if (!deviceId) return () => {};
  const source = new EventSource(`/api/devices/${encodeURIComponent(deviceId)}/message-stream`);
  let closed = false;
  const timeoutMs = options.timeoutMs;
  const timer = timeoutMs && timeoutMs > 0
    ? window.setTimeout(() => {
      if (closed) return;
      options.onTimeout?.();
      close();
    }, timeoutMs)
    : 0;

  function close() {
    if (closed) return;
    closed = true;
    if (timer) window.clearTimeout(timer);
    source.close();
  }

  source.addEventListener('message', (event) => {
    if (closed) return;
    try {
      const data = JSON.parse(String((event as MessageEvent).data || '{}'));
      if (data?.deviceId === deviceId && isButtonPressedPayload(data.payload)) {
        onPressed();
        close();
      }
    } catch (_) {}
  });
  source.onerror = () => {
    // 保持连接，浏览器会自动重试；超时由 timeoutMs 兜底
  };
  return close;
}
