const dgram = require('dgram');
const net = require('net');
const os = require('os');
const logger = require('./logService');
const {
  HOST_NAME,
  inspectQuery,
  legacyUnicastResponse,
  multicastResponse,
} = require('./mdnsPacket');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const VIRTUAL_INTERFACE = /(?:^vEthernet|hyper-v|virtual|vmware|virtualbox|vbox|wsl|docker|vpn|wireguard|tailscale|zerotier|hamachi|\btap\b|\btun\b|bluetooth|蓝牙|loopback|pseudo-interface|local area connection\*)/i;

let currentInstance = null;
let lastError = null;
let counters = { queries: 0, responses: 0 };

function interfacePriority(name) {
  if (/(?:wi-?fi|wlan|无线)/i.test(name)) return 0;
  if (/(?:ethernet|以太网|^eth\d|^en\d)/i.test(name)) return 1;
  return 10;
}

function isUsableAddress(address) {
  return address
    && (address.family === 'IPv4' || address.family === 4)
    && !address.internal
    && net.isIPv4(address.address)
    && !address.address.startsWith('127.')
    && !address.address.startsWith('169.254.');
}

function selectBinding(interfaces = os.networkInterfaces(), env = process.env) {
  const requestedInterface = (env.MDNS_INTERFACE || '').trim().toLowerCase();
  const requestedIp = (env.MDNS_IPV4 || '').trim();
  const candidates = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    if (requestedInterface && name.toLowerCase() !== requestedInterface) continue;

    for (const address of addresses || []) {
      if (!isUsableAddress(address)) continue;
      if (requestedIp && address.address !== requestedIp) continue;
      candidates.push({ interface: name, ip: address.address });
    }
  }

  candidates.sort((left, right) => (
    interfacePriority(left.interface) - interfacePriority(right.interface)
    || left.interface.localeCompare(right.interface)
    || left.ip.localeCompare(right.ip)
  ));
  return candidates[0] || null;
}

function status() {
  if (!currentInstance) {
    return { running: false, lastError };
  }
  return {
    pid: process.pid,
    running: currentInstance.running,
    starting: !currentInstance.running,
    ip: currentInstance.binding.ip,
    interface: currentInstance.binding.interface,
    queries: counters.queries,
    responses: counters.responses,
    lastError,
  };
}

function sendPacket(instance, packet, port, address, description) {
  instance.socket.send(packet, port, address, (error) => {
    if (error) {
      logger.warn('Mdns', `${description} failed: ${error.message}`);
      return;
    }
    counters.responses += 1;
  });
}

function handleQuery(instance, packet, remote) {
  if (currentInstance !== instance || !instance.running) return;
  const query = inspectQuery(packet);
  if (!query) return;

  counters.queries += 1;
  const legacy = remote.port !== MDNS_PORT;
  const unicast = legacy || query.unicastRequested;
  const response = legacy
    ? legacyUnicastResponse(query, instance.binding.ip)
    : multicastResponse(instance.binding.ip);
  const targetAddress = unicast ? remote.address : MDNS_ADDRESS;
  const targetPort = unicast ? remote.port : MDNS_PORT;

  sendPacket(
    instance,
    response,
    targetPort,
    targetAddress,
    `mDNS response to ${remote.address}:${remote.port}`,
  );
  logger.info(
    'Mdns',
    `Answered A ${HOST_NAME}=${instance.binding.ip} to ${remote.address}:${remote.port} via ${unicast ? 'unicast' : 'multicast'} (id=${query.id})`,
  );
}

function closeSocket(instance) {
  return new Promise((resolve) => {
    if (!instance || instance.closed) return resolve();
    instance.closed = true;
    instance.running = false;

    try {
      instance.socket.close(resolve);
    } catch (_) {
      resolve();
    }
  });
}

async function publish() {
  if (currentInstance?.startPromise) return currentInstance.startPromise;
  if (currentInstance?.running) return status();

  const binding = selectBinding();
  if (!binding) {
    const requested = process.env.MDNS_IPV4 || process.env.MDNS_INTERFACE;
    const message = requested
      ? `Configured mDNS interface was not found: ${requested}`
      : 'No physical LAN IPv4 interface is available for mDNS';
    lastError = message;
    throw new Error(message);
  }

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const instance = {
    binding,
    closed: false,
    running: false,
    socket,
    startPromise: null,
  };
  currentInstance = instance;
  counters = { queries: 0, responses: 0 };
  lastError = null;

  socket.on('message', (packet, remote) => handleQuery(instance, packet, remote));
  socket.on('error', (error) => {
    lastError = error.message;
    logger.error('Mdns', `Native mDNS socket failed: ${error.message}`);
    if (currentInstance === instance) currentInstance = null;
    closeSocket(instance);
  });

  instance.startPromise = new Promise((resolve, reject) => {
    socket.once('listening', () => {
      try {
        socket.addMembership(MDNS_ADDRESS, binding.ip);
        socket.setMulticastInterface(binding.ip);
        socket.setMulticastTTL(255);
        instance.running = true;
        instance.startPromise = null;

        sendPacket(
          instance,
          multicastResponse(binding.ip),
          MDNS_PORT,
          MDNS_ADDRESS,
          'mDNS announcement',
        );
        logger.info(
          'Mdns',
          `Native mDNS started on ${binding.interface} (${binding.ip}):${MDNS_PORT}, publishing A ${HOST_NAME}`,
        );
        resolve(status());
      } catch (error) {
        lastError = error.message;
        if (currentInstance === instance) currentInstance = null;
        closeSocket(instance);
        reject(error);
      }
    });

    socket.once('error', (error) => {
      if (!instance.running) reject(error);
    });
    socket.bind({ port: MDNS_PORT, address: '0.0.0.0', exclusive: false });
  });

  return instance.startPromise;
}

async function unpublish() {
  const instance = currentInstance;
  currentInstance = null;
  if (!instance) return { running: false, lastError };

  if (instance.running) {
    try {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 100);
        instance.socket.send(
          multicastResponse(instance.binding.ip, 0),
          MDNS_PORT,
          MDNS_ADDRESS,
          () => {
            clearTimeout(timeout);
            resolve();
          },
        );
      });
    } catch (_) {}
  }

  await closeSocket(instance);
  logger.info('Mdns', 'Native mDNS stopped');
  return { running: false, lastError };
}

module.exports = {
  publish,
  unpublish,
  status,
  selectBinding,
};
