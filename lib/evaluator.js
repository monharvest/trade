'use strict';

function needsPrime(alert) {
  return alert.state.armed !== true && alert.state.armed !== false;
}

function isPastTarget(alert, price) {
  return alert.direction === 'above' ? price >= alert.target : price <= alert.target;
}

function prime(alert, price) {
  alert.state.armed = !isPastTarget(alert, price);
  return alert;
}

function hysteresisOf(alert) {
  const h = Number(alert.hysteresis);
  return Number.isFinite(h) && h >= 0 ? h : 5;
}

// Mutates alert. Returns { fire, changed }.
function step(alert, price, now = new Date()) {
  if (!alert.enabled) return { fire: false, changed: false };

  if (needsPrime(alert)) {
    prime(alert, price);
    return { fire: false, changed: true };
  }

  const T = alert.target;
  const H = hysteresisOf(alert);
  let changed = false;

  if (alert.direction === 'above') {
    if (alert.state.armed && price >= T) {
      applyFire(alert, now);
      return { fire: true, changed: true };
    }
    if (!alert.state.armed && alert.repeat === 'always' && price <= T - H) {
      alert.state.armed = true;
      changed = true;
    }
  } else {
    if (alert.state.armed && price <= T) {
      applyFire(alert, now);
      return { fire: true, changed: true };
    }
    if (!alert.state.armed && alert.repeat === 'always' && price >= T + H) {
      alert.state.armed = true;
      changed = true;
    }
  }

  return { fire: false, changed };
}

function applyFire(alert, now) {
  alert.state.armed = false;
  alert.state.lastTriggeredAt = now.toISOString();
  alert.state.triggerCount = (alert.state.triggerCount || 0) + 1;
  if (alert.repeat === 'once') alert.enabled = false;
}

function evaluateAll(alerts, price, now = new Date()) {
  const fires = [];
  let changed = false;
  for (const alert of alerts) {
    const result = step(alert, price, now);
    if (result.changed) changed = true;
    if (result.fire) fires.push(alert);
  }
  return { fires, changed };
}

function formatTelegram(alert, price) {
  const arrow = alert.direction === 'above' ? '📈' : '📉';
  const word = alert.direction === 'above' ? 'ABOVE' : 'BELOW';
  return [
    '🔔 *PRICE ALERT!*',
    '',
    `${arrow} USDT/MNT is *${word}* ${alert.target.toLocaleString()} MNT!`,
    '',
    `💰 Current Price: *${price.toLocaleString()} MNT*`,
    `🎯 Alert Threshold: *${alert.target.toLocaleString()} MNT*`,
    '',
    `⏰ Time: ${new Date().toISOString()}`,
    '',
    '[Open Trade.mn →](https://trade.mn/exchange/USDT/MNT/)',
  ].join('\n');
}

module.exports = { needsPrime, prime, step, evaluateAll, formatTelegram, isPastTarget };

if (require.main === module) {
  const now = new Date('2026-08-22T12:00:00.000Z');
  const blank = () => ({
    enabled: true,
    repeat: 'always',
    hysteresis: 5,
    state: { armed: null, lastTriggeredAt: null, triggerCount: 0 },
  });

  const a = { ...blank(), direction: 'above', target: 3700 };
  prime(a, 3750);
  console.assert(a.state.armed === false, 'prime above already-met');

  const b = { ...blank(), direction: 'above', target: 3700 };
  prime(b, 3650);
  console.assert(b.state.armed === true, 'prime above not-met');

  const c = { ...blank(), direction: 'below', target: 3630 };
  prime(c, 3600);
  console.assert(c.state.armed === false, 'prime below already-met');

  const d = { ...blank(), direction: 'above', target: 3660, state: { armed: true, lastTriggeredAt: null, triggerCount: 0 } };
  const dFire = step(d, 3660, now);
  console.assert(dFire.fire === true && d.state.armed === false && d.state.triggerCount === 1, 'fire above on touch');

  const e = { ...blank(), direction: 'above', target: 3660, state: { armed: false, lastTriggeredAt: now.toISOString(), triggerCount: 1 } };
  console.assert(step(e, 3661, now).fire === false, 'no refire while still above');
  console.assert(step(e, 3656, now).fire === false && e.state.armed === false, 'no re-arm until hysteresis');
  console.assert(step(e, 3655, now).fire === false && e.state.armed === true, 're-arm after hysteresis');
  console.assert(step(e, 3660, now).fire === true, 'second fire after re-arm');

  const f = { ...blank(), direction: 'above', target: 3700, repeat: 'once', state: { armed: true, lastTriggeredAt: null, triggerCount: 0 } };
  step(f, 3700, now);
  console.assert(f.enabled === false && f.state.armed === false, 'once disables');
  console.assert(step(f, 3800, now).fire === false, 'disabled never fires');

  const g = { ...blank(), direction: 'below', target: 3630, state: { armed: true, lastTriggeredAt: null, triggerCount: 0 } };
  console.assert(step(g, 3630, now).fire === true, 'fire below on touch');
  console.assert(step(g, 3634, now).fire === false && g.state.armed === false, 'no re-arm until hysteresis');
  console.assert(step(g, 3635, now).fire === false && g.state.armed === true, 're-arm below after hysteresis');

  const h = { ...blank(), direction: 'above', target: 3665, state: { armed: null, lastTriggeredAt: null, triggerCount: 0 } };
  const primed = step(h, 3750, now);
  console.assert(primed.fire === false && h.state.armed === false, 'first step primes, does not fire');

  console.log('evaluator self-check ok');
}
