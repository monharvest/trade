'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

function newId() {
  let s = '';
  while (s.length < 6) s += crypto.randomBytes(4).readUInt32BE(0).toString(36);
  return 'alr_' + s.slice(0, 6);
}

function createStore(filePath, log = () => {}) {
  // Serializes writes. Concurrent saves sharing one temp path can interleave
  // and leave a truncated file behind, which load() would then quarantine.
  let chain = Promise.resolve();
  const state = { quarantined: false };

  async function quarantine(err) {
    const bad = `${filePath}.corrupt-${Date.now()}`;
    state.quarantined = true;
    try {
      await fs.rename(filePath, bad);
      log(`⚠️ alerts file unreadable (${err.message}) — kept as ${path.basename(bad)}, reseeding`);
    } catch (renameErr) {
      log(`⚠️ alerts file unreadable (${err.message}); could not set aside: ${renameErr.message}`);
    }
  }

  async function load() {
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err; // permissions or I/O: do not destroy the file, fail loudly
    }
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.alerts)) throw new Error('missing alerts array');
      return data;
    } catch (err) {
      await quarantine(err);
      return null;
    }
  }

  async function write(data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.rename(tmp, filePath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  function save(data) {
    chain = chain.then(() => write(data), () => write(data));
    return chain;
  }

  return { load, save, filePath, wasQuarantined: () => state.quarantined };
}

function seedAlerts(env = process.env) {
  const num = (key, fallback) => {
    const n = parseFloat(env[key]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const rows = [
    { direction: 'below', target: num('ALERT_BELOW', 3630) },
    { direction: 'above', target: num('ALERT_ABOVE', 3660) },
    { direction: 'above', target: num('ALERT_ABOVE3', 3700) },
  ];
  return {
    version: 1,
    alerts: rows.map((row) => ({
      id: newId(),
      direction: row.direction,
      target: row.target,
      enabled: true,
      repeat: 'always',
      hysteresis: 5,
      createdAt: new Date().toISOString(),
      state: { armed: null, lastTriggeredAt: null, triggerCount: 0 },
    })),
  };
}

module.exports = { createStore, newId, seedAlerts };
