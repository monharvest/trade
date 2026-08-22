'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

function newId() {
  let s = '';
  while (s.length < 6) s += crypto.randomBytes(4).readUInt32BE(0).toString(36);
  return 'alr_' + s.slice(0, 6);
}

function createStore(filePath) {
  async function load() {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.alerts)) return null;
      return data;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function save(data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, filePath);
  }

  return { load, save, filePath };
}

function seedAlerts(env = process.env) {
  const num = (key, fallback) => {
    const n = parseFloat(env[key]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const rows = [
    { direction: 'below', target: num('ALERT_BELOW', 3630) },
    { direction: 'above', target: num('ALERT_ABOVE', 3660) },
    { direction: 'above', target: 3665 }, // ponytail: keep live 3665; delete in UI if unwanted
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
