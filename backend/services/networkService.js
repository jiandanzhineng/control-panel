const os = require('os');
const logger = require('../utils/logger');

function netmaskToCidr(mask) {
  const parts = (mask || '').split('.').map((n) => parseInt(n, 10));
  let count = 0;
  for (const n of parts) {
    count += ((n & 0xff).toString(2).match(/1/g) || []).length;
  }
  return count || 24;
}

function collectInterfaces() {
  const ifs = os.networkInterfaces();
  const rows = [];
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal && a.address !== '127.0.0.1') {
        rows.push({ interface: name, ip: a.address, cidr: netmaskToCidr(a.netmask) });
      }
    }
  }
  return rows;
}

async function getIps() {
  const rows = collectInterfaces();
  logger.info('networkInterfaces 解析到 IP 数量', rows.length);
  return rows;
}

module.exports = { getIps };