// Shop owns WeChat identity; only its one-time desktop QR endpoint may return a center session.
const { UpstreamError } = require('./accountService');
const base = (process.env.SHOP_API_URL || 'https://shop.undersilicon.cn').replace(/\/+$/, '');
async function call(path, body) {
  let response;
  try {
    response = await fetch(`${base}/api/auth/qr/desktop/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000), redirect: 'error',
    });
  } catch {
    throw new UpstreamError(502, 'UPSTREAM_UNREACHABLE', '微信登录服务暂时不可用，请重试或使用其他方式');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new UpstreamError(response.ok ? 502 : response.status, 'QR_FAILED', typeof data?.error === 'string' ? data.error : '微信登录失败，请刷新二维码');
  return data;
}
module.exports = { start: () => call('start'), status: body => call('status', body) };
