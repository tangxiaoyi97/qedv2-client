'use strict';

// Runs inside Electron's Node utility process, before qed2-core is loaded.
// The upstream service currently calls listen(port) and therefore defaults to
// every interface. Desktop nodes are private: force every TCP listener to
// loopback without rewriting or misrepresenting the bundled upstream commit.
const { realpathSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const configuredEntry = process.env.QED2_CORE_ENTRY;
const configuredDirectory = process.env.QED2_CORE_DIRECTORY;
if (!configuredEntry || !configuredDirectory) {
  throw new Error('QED2 core host requires explicit entry and runtime directory paths');
}
const entry = path.resolve(configuredEntry);
const coreDirectory = realpathSync(path.resolve(configuredDirectory));
const entryReal = realpathSync(entry);
if (entryReal !== coreDirectory && !entryReal.startsWith(`${coreDirectory}${path.sep}`)) {
  throw new Error('QED2 core entry escaped its bundled runtime directory');
}

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function qed2LoopbackListen(...args) {
  const first = args[0];
  const isTcpOptions = first && typeof first === 'object' && !Array.isArray(first) && 'port' in first;
  const isTcpPort = typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first));
  if (isTcpOptions) {
    // Never trust an upstream/default host value here. A desktop-local node is
    // a private implementation detail and must not become reachable from LAN.
    args[0] = { ...first, host: '127.0.0.1' };
  } else if (isTcpPort) {
    const second = args[1];
    if (typeof second === 'string') args[1] = '127.0.0.1';
    else args.splice(1, 0, '127.0.0.1');
  }
  return originalListen.apply(this, args);
};

process.env.HOST = '127.0.0.1';
require(entryReal);
