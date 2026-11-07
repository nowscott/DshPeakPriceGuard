// Behaviour check for the peak-price guard Client module.
//
// `client.js` is a browser bundle body, so this test supplies the two globals
// it needs (`window.__ModuleLoader__` and `require('react')`), evaluates the
// file, and then drives the calendar helpers, the preference parsing, and the
// composer send gate.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

/** Evaluate client.js and return its plugin exports. */
/** Stand-in browser cookie jar, so persistence can be exercised. */
const cookieJar = new Map();

function loadPlugin() {
  let registration;
  const window = { __ModuleLoader__: { load: (entry) => { registration = entry; } }, innerWidth: 1200 };
  globalThis.document = {
    body: { kind: 'body' },
    get cookie() {
      return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    set cookie(raw) {
      const pair = String(raw).split(';')[0];
      const separator = pair.indexOf('=');
      if (separator === -1) return;
      cookieJar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    },
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
  const requireShim = (name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal: (node) => node };
    throw new Error(`unexpected require: ${name}`);
  };
  new Function('window', 'require', source)(window, requireShim);
  assert.equal(registration.id, 'dsh-peak-price-guard');
  return registration.factory(requireShim);
}

/** Collect the plain strings of a rendered (shimmed) element tree. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.type === 'function') return textOf(node.type({ ...node.props, children: node.children }));
  return (node.children ?? []).map(textOf).join('');
}

const plugin = loadPlugin();
const {
  isPeak,
  peakWindowEnd,
  offPeakStart,
  nextPeakStart,
  beijingParts,
  parseWindows,
  normalizeConfig,
  buildRule,
  DEFAULT_CONFIG,
  isHolidayDate,
  refreshHolidays,
  calendarStore,
  holidayYears,
  queueStore,
  settingsStore,
  clockStore,
  gateStore,
  updateConfig,
} = plugin.__test;

const RULE = buildRule(DEFAULT_CONFIG);

/** Beijing wall clock -> epoch milliseconds. */
function beijing(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}

/**
 * Run `body` with `Date.now()` frozen at one instant.
 * @param {number} atMs - the frozen instant.
 * @param {Function} body - the assertions to run.
 */
async function atTime(atMs, body) {
  const real = Date.now;
  Date.now = () => atMs;
  try {
    await body();
  } finally {
    Date.now = real;
  }
}

/**
 * Apply the plugin to a stub Client context owning one fake conversation
 * service.
 * @param {Function} serviceFactory - builds the fake conversation service.
 */
function mountClient(serviceFactory, options = {}) {
  if (options.keepStorage !== true) cookieJar.clear();
  const effects = [];
  const slots = [];
  const components = {};
  const dictionaries = [];
  const disposers = [];
  const service = serviceFactory();
  const ctx = {
    effect: (fn, label) => {
      effects.push(label);
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    get: (name) => (name === 'conversation' ? service : undefined),
    locale: {
      register: (ns, dict) => {
        dictionaries.push([ns, dict]);
        return () => {};
      },
      bind: () => (key) => key,
    },
    sessions: { scope: () => undefined },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        slots.push(options);
        components[options.id] = component;
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  return {
    effects,
    slots,
    components,
    dictionaries,
    service,
    dispose: () => disposers.reverse().forEach((fn) => fn()),
  };
}

test('weekday peak windows are 09:00-12:00 and 14:00-18:00 Beijing', () => {
  // 2026-11-04 is a Wednesday.
  assert.equal(isPeak(beijing(2026, 11, 4, 8, 59), RULE), false);
  assert.equal(isPeak(beijing(2026, 11, 4, 9, 0), RULE), true);
  assert.equal(isPeak(beijing(2026, 11, 4, 11, 59), RULE), true);
  assert.equal(isPeak(beijing(2026, 11, 4, 12, 0), RULE), false);
  assert.equal(isPeak(beijing(2026, 11, 4, 13, 30), RULE), false);
  assert.equal(isPeak(beijing(2026, 11, 4, 14, 0), RULE), true);
  assert.equal(isPeak(beijing(2026, 11, 4, 17, 59), RULE), true);
  assert.equal(isPeak(beijing(2026, 11, 4, 18, 0), RULE), false);
  assert.equal(isPeak(beijing(2026, 11, 4, 23, 30), RULE), false);
});

test('weekends are off-peak all day', () => {
  assert.equal(beijingParts(beijing(2026, 11, 7, 10)).weekday, 6);
  assert.equal(isPeak(beijing(2026, 11, 7, 10), RULE), false);
  assert.equal(isPeak(beijing(2026, 11, 8, 15), RULE), false);
});

test('a Chinese public holiday is off-peak even on a weekday', () => {
  // 2026-10-01 is a Thursday and a public holiday.
  assert.equal(beijingParts(beijing(2026, 10, 1, 10)).weekday, 4);
  assert.equal(isPeak(beijing(2026, 10, 1, 10), RULE), false);
  assert.equal(isPeak(beijing(2026, 10, 8, 10), RULE), true);
  assert.equal(isPeak(beijing(2026, 10, 1, 10), buildRule({ ...DEFAULT_CONFIG, holidaysOffPeak: false })), true);
});

test('the reminder points at the end of the current peak window', () => {
  const beforeNoon = beijing(2026, 11, 4, 10, 30);
  assert.equal(peakWindowEnd(beforeNoon, RULE), beijing(2026, 11, 4, 12));
  assert.deepEqual(offPeakStart(beforeNoon, RULE), { hour: '12', minute: '00', dayOffset: 0, date: '11-04' });

  const afternoon = beijing(2026, 11, 4, 15, 5);
  assert.equal(peakWindowEnd(afternoon, RULE), beijing(2026, 11, 4, 18));
  assert.deepEqual(offPeakStart(afternoon, RULE), { hour: '18', minute: '00', dayOffset: 0, date: '11-04' });
});

test('the next peak window is reported for the off-peak copy', () => {
  const describeNext = (at) => {
    const next = nextPeakStart(at, RULE);
    assert.notEqual(next, undefined);
    return `${next.date} ${next.hour}:${next.minute} +${next.dayOffset}`;
  };
  // Wednesday before the morning window.
  assert.equal(describeNext(beijing(2026, 11, 4, 8, 0)), '11-04 09:00 +0');
  // Wednesday lunch break: the afternoon window is next.
  assert.equal(describeNext(beijing(2026, 11, 4, 12, 30)), '11-04 14:00 +0');
  // Wednesday evening: tomorrow morning.
  assert.equal(describeNext(beijing(2026, 11, 4, 18, 30)), '11-05 09:00 +1');
  // Friday evening: Monday morning.
  assert.equal(describeNext(beijing(2026, 11, 6, 19, 0)), '11-09 09:00 +3');
  // A Thursday inside the National Day holiday: the first window after it.
  assert.equal(describeNext(beijing(2026, 10, 1, 8, 0)), '10-08 09:00 +7');
  // No configured windows means no next peak at all.
  assert.equal(nextPeakStart(beijing(2026, 11, 4, 8, 0), buildRule({ ...DEFAULT_CONFIG, windows: '' })), undefined);
});

test('an invalid instant is never treated as peak', () => {
  assert.equal(isPeak(Number.NaN, RULE), false);
  assert.equal(isPeak(undefined, RULE), false);
});

test('the peak-window spec parses, and a broken spec falls back to the default', () => {
  assert.deepEqual(parseWindows('09:00-12:00, 14:00-18:00'), [[9, 12], [14, 18]]);
  assert.deepEqual(parseWindows('00:00-24:00'), [[0, 24]]);
  assert.deepEqual(parseWindows('9-12'), [[9, 12]]);
  assert.deepEqual(parseWindows(''), []);
  assert.equal(parseWindows('09:00'), null);
  assert.equal(parseWindows('12:00-09:00'), null);
  assert.equal(parseWindows('09:00-25:00'), null);
  assert.equal(parseWindows('nonsense'), null);
  assert.equal(buildRule({ ...DEFAULT_CONFIG, windows: 'bad' }).valid, false);
  assert.deepEqual(buildRule({ ...DEFAULT_CONFIG, windows: 'bad' }).windows, [[9, 12], [14, 18]]);
  assert.deepEqual(buildRule({ ...DEFAULT_CONFIG, windows: '' }).windows, []);
});

test('stored preferences are normalized and clamped', () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ muteMinutes: '45', enabled: 'yes' }), { ...DEFAULT_CONFIG, muteMinutes: 45 });
  assert.equal(normalizeConfig({ muteMinutes: 9999 }).muteMinutes, DEFAULT_CONFIG.muteMinutes);
  assert.equal(normalizeConfig({ muteMinutes: -5 }).muteMinutes, DEFAULT_CONFIG.muteMinutes);
});

test('the plugin registers the dot, the dialog, the settings page, and the send gate', () => {
  class FakeConversation {
    async sendSession() {
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new FakeConversation());
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sessions', 'conversation']);
  assert.deepEqual(
    mounted.slots.map((entry) => `${entry.name}#${entry.id}`),
    [
      'conversation.composer.dock#peak-price-guard.status',
      'shell.overlay#peak-price-guard.confirm',
      'settings.section#peak-price-guard',
    ],
  );
  assert.ok(mounted.slots.every((entry) => entry.locale === 'peak-price-guard'));
  assert.equal(mounted.dictionaries[0][1].zh['settings.title'], '高峰价格提醒');
  assert.ok(mounted.dictionaries[0][1].en['dialog.confirm']);
  assert.ok(mounted.effects.includes('peak-price-guard: send gate'));
  assert.equal(gateStore.getSnapshot().active, true);
  assert.equal(FakeConversation.prototype.sendSession[Symbol.for('dsh.peak-price-guard.patched')], true);
  mounted.dispose();
  assert.equal(FakeConversation.prototype.sendSession[Symbol.for('dsh.peak-price-guard.patched')], undefined);
});

test('a peak-hour send waits for the answer, then reaches the sink', async () => {
  const calls = [];
  class Sink {
    async sendSession(...args) {
      calls.push(args);
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  try {
    await atTime(beijing(2026, 11, 4, 10, 0), async () => {
      const pending = mounted.service.sendSession({ sessionId: 's1' }, 'hi there', [], 'queue', undefined);
      assert.deepEqual(calls, [], 'nothing may reach the sink before the answer');
      const queue = queueStore.getSnapshot();
      assert.equal(queue.length, 1);
      assert.equal(queue[0].text, 'hi there');
      queue[0].settle(true, { mute: false });
      assert.deepEqual(await pending, { kind: 'success' });
      assert.equal(calls.length, 1);
      assert.deepEqual(queueStore.getSnapshot(), []);
    });
  } finally {
    mounted.dispose();
  }
});

test('cancelling the reminder sends nothing and reports the composer failure outcome', async () => {
  const calls = [];
  class Sink {
    async sendSession(...args) {
      calls.push(args);
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  try {
    await atTime(beijing(2026, 11, 4, 15, 0), async () => {
      const pending = mounted.service.sendSession({ sessionId: 's1' }, 'hi there', [], 'queue', undefined);
      queueStore.getSnapshot()[0].settle(false);
      assert.deepEqual(await pending, { kind: 'error' });
      assert.deepEqual(calls, []);
      assert.deepEqual(queueStore.getSnapshot(), []);
    });
  } finally {
    mounted.dispose();
  }
});

test('an off-peak send goes straight through', async () => {
  const calls = [];
  class Sink {
    async sendSession(...args) {
      calls.push(args);
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  try {
    await atTime(beijing(2026, 11, 4, 20, 0), async () => {
      const outcome = await mounted.service.sendSession({ sessionId: 's1' }, 'evening', [], 'queue', undefined);
      assert.deepEqual(outcome, { kind: 'success' });
      assert.equal(calls.length, 1);
      assert.deepEqual(queueStore.getSnapshot(), []);
    });
  } finally {
    mounted.dispose();
  }
});

test('two pending sends are asked one at a time, oldest first', async () => {
  const calls = [];
  class Sink {
    async sendSession(...args) {
      calls.push(args);
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  try {
    await atTime(beijing(2026, 11, 4, 10, 0), async () => {
      const first = mounted.service.sendSession({ sessionId: 's1' }, 'one', [], 'queue', undefined);
      const second = mounted.service.sendSession({ sessionId: 's1' }, 'two', [], 'queue', undefined);
      const queue = queueStore.getSnapshot();
      assert.deepEqual(queue.map((item) => item.text), ['one', 'two']);
      queue[0].settle(true, { mute: false });
      assert.deepEqual(await first, { kind: 'success' });
      assert.equal(calls.length, 1);
      assert.deepEqual(queueStore.getSnapshot().map((item) => item.text), ['two']);
      queueStore.getSnapshot()[0].settle(false);
      assert.deepEqual(await second, { kind: 'error' });
      assert.equal(calls.length, 1);
    });
  } finally {
    mounted.dispose();
  }
});

test('a muted session stops asking for the configured window', async () => {
  const calls = [];
  class Sink {
    async sendSession(...args) {
      calls.push(args);
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  try {
    await atTime(beijing(2026, 11, 4, 10, 0), async () => {
      updateConfig({ muteMinutes: 30 });
      const first = mounted.service.sendSession({ sessionId: 's1' }, 'first', [], 'queue', undefined);
      assert.equal(queueStore.getSnapshot().length, 1);
      queueStore.getSnapshot()[0].settle(true, { mute: true });
      assert.deepEqual(await first, { kind: 'success' });
      const second = mounted.service.sendSession({ sessionId: 's1' }, 'second', [], 'queue', undefined);
      assert.deepEqual(queueStore.getSnapshot(), [], 'a muted session asks nothing');
      assert.deepEqual(await second, { kind: 'success' });
      assert.equal(calls.length, 2);
      // Another session still asks.
      const other = mounted.service.sendSession({ sessionId: 's2' }, 'other', [], 'queue', undefined);
      assert.equal(queueStore.getSnapshot().length, 1);
      queueStore.getSnapshot()[0].settle(false);
      assert.deepEqual(await other, { kind: 'error' });
    });
  } finally {
    mounted.dispose();
  }
});

test('the edited peak windows decide when the guard applies', async () => {
  const calls = [];
  class Sink {
    async sendSession(...args) {
      calls.push(args);
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  try {
    await atTime(beijing(2026, 11, 4, 3, 0), async () => {
      // 03:00 is off-peak under the default rule.
      const before = mounted.service.sendSession({ sessionId: 's1' }, 'late night', [], 'queue', undefined);
      assert.deepEqual(await before, { kind: 'success' });
      assert.deepEqual(queueStore.getSnapshot(), []);
      // Widening the windows to the whole day turns the same instant into peak.
      updateConfig({ windows: '00:00-24:00' });
      const after = mounted.service.sendSession({ sessionId: 's1' }, 'late night', [], 'queue', undefined);
      assert.equal(queueStore.getSnapshot().length, 1);
      queueStore.getSnapshot()[0].settle(false);
      assert.deepEqual(await after, { kind: 'error' });
      assert.equal(calls.length, 1);
      assert.equal(settingsStore.getSnapshot().rule.windows.length, 1);
    });
  } finally {
    mounted.dispose();
  }
});

test('disabling the preference turns the gate off', async () => {
  const calls = [];
  class Sink {
    async sendSession(...args) {
      calls.push(args);
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  try {
    await atTime(beijing(2026, 11, 4, 10, 0), async () => {
      updateConfig({ enabled: false });
      const outcome = await mounted.service.sendSession({ sessionId: 's1' }, 'hi', [], 'queue', undefined);
      assert.deepEqual(outcome, { kind: 'success' });
      assert.deepEqual(queueStore.getSnapshot(), []);
      assert.equal(calls.length, 1);
    });
  } finally {
    mounted.dispose();
  }
});

test('the dialog host keeps its hook order when a request arrives', () => {
  class Sink {
    async sendSession() {
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  const dialog = mounted.components['peak-price-guard.confirm'];
  assert.equal(typeof dialog, 'function');
  let hookCalls = 0;
  const useSessions = () => {
    hookCalls += 1;
    return undefined;
  };
  const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`);
  queueStore.set([]);
  assert.equal(dialog({ t, useSessions }), null);
  assert.equal(hookCalls, 1, 'the session hook must run even with nothing pending');
  // A pending request must render the card, not a blank slot entry.
  queueStore.set([{ id: 9001, text: 'hello', sessionId: 's1', muteMinutes: 30, createdAt: Date.now(), settle: () => {} }]);
  const element = dialog({ t, useSessions });
  assert.notEqual(element, null);
  assert.equal(hookCalls, 2, 'exactly one session-hook call per render');
  const markup = textOf(element);
  assert.match(markup, /dialog\.title/);
  assert.match(markup, /dialog\.cancel/);
  assert.match(markup, /dialog\.confirm/);
  assert.match(markup, /hello/);
  queueStore.set([]);
  mounted.dispose();
});

test('the composer pill reports peak, off-peak, pending, and a broken gate', () => {
  class Sink {
    async sendSession() {
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  const pill = mounted.components['peak-price-guard.status'];
  const t = (key) => key;
  const stateOf = (node) => (node === null ? null : node.props['data-state']);
  const peakAt = beijing(2026, 11, 4, 10, 0);
  const offPeakAt = beijing(2026, 11, 4, 22, 0);
  try {
    clockStore.set({ now: peakAt, peak: true });
    gateStore.set({ active: true, reason: '' });
    const peak = pill({ t });
    assert.equal(stateOf(peak), 'peak');
    assert.match(textOf(peak), /badge\.peak\.label/);
    assert.match(textOf(peak), /badge\.peak\.value/);

    clockStore.set({ now: offPeakAt, peak: false });
    const offPeak = pill({ t });
    assert.equal(stateOf(offPeak), 'offpeak');
    assert.match(textOf(offPeak), /badge\.offpeak\.value/);

    queueStore.set([{ id: 1, text: 'held', sessionId: 's1', muteMinutes: 30, createdAt: offPeakAt, settle: () => {} }]);
    const pending = pill({ t });
    assert.equal(stateOf(pending), 'pending');
    assert.match(textOf(pending), /badge\.pending\.label/);
    queueStore.set([]);

    gateStore.set({ active: false, reason: 'missing sink' });
    assert.equal(stateOf(pill({ t })), 'broken');
  } finally {
    gateStore.set({ active: true, reason: '' });
    clockStore.set({ now: 0, peak: false });
    mounted.dispose();
  }
});

test('preferences survive a remount through the cookie jar', () => {
  class Sink {
    async sendSession() {
      return { kind: 'success' };
    }
  }
  const first = mountClient(() => new Sink());
  updateConfig({ windows: '00:00-24:00', muteMinutes: 5, enabled: false });
  first.dispose();
  assert.ok([...cookieJar.values()].some((value) => value.includes('00%3A00-24%3A00')));
  const second = mountClient(() => new Sink(), { keepStorage: true });
  const restored = settingsStore.getSnapshot().config;
  assert.equal(restored.windows, '00:00-24:00');
  assert.equal(restored.muteMinutes, 5);
  assert.equal(restored.enabled, false);
  second.dispose();
});

test('an already-aborted submission is refused without asking', async () => {
  const calls = [];
  class Sink {
    async sendSession(...args) {
      calls.push(args);
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  try {
    await atTime(beijing(2026, 11, 4, 10, 0), async () => {
      const controller = new AbortController();
      controller.abort();
      const outcome = await mounted.service.sendSession({ sessionId: 's1' }, 'stale', [], 'queue', controller.signal);
      assert.deepEqual(outcome, { kind: 'error' });
      assert.deepEqual(calls, []);
      assert.deepEqual(queueStore.getSnapshot(), [], 'no dialog is left behind');
    });
  } finally {
    mounted.dispose();
  }
});

test('aborting while the dialog is open closes it and sends nothing', async () => {
  const calls = [];
  class Sink {
    async sendSession(...args) {
      calls.push(args);
      return { kind: 'success' };
    }
  }
  const mounted = mountClient(() => new Sink());
  try {
    await atTime(beijing(2026, 11, 4, 10, 0), async () => {
      const controller = new AbortController();
      const pending = mounted.service.sendSession({ sessionId: 's1' }, 'later', [], 'queue', controller.signal);
      assert.equal(queueStore.getSnapshot().length, 1);
      controller.abort();
      assert.deepEqual(await pending, { kind: 'error' });
      assert.deepEqual(queueStore.getSnapshot(), []);
      assert.deepEqual(calls, []);
    });
  } finally {
    mounted.dispose();
  }
});

// #region holiday feed
//
// The built-in table is only a fallback. These cases pin the two properties
// that matter: a delivered year follows the feed exactly (including the days a
// makeup-workday notice removed), and a broken feed never invents a holiday
// that would hide a real peak window.

test('the holiday feed adds days the built-in table does not know', async () => {
  const feed = async (url) => {
    if (!url.endsWith('/2027.json')) throw new Error('offline');
    return {
      ok: true,
      json: async () => ({
        year: 2027,
        days: [
          { name: 'fixture holiday', date: '2027-06-15', isOffDay: true },
          { name: 'fixture makeup workday', date: '2027-06-12', isOffDay: false },
        ],
      }),
    };
  };
  const state = await refreshHolidays(beijing(2027, 1, 5, 10, 0), feed);
  assert.equal(state, 'synced');
  assert.equal(calendarStore.getSnapshot().state, 'synced');
  assert.deepEqual(calendarStore.getSnapshot().years, [2027]);
  assert.equal(isHolidayDate('2027-06-15'), true);
  assert.equal(isHolidayDate('2027-06-12'), false, 'a makeup workday is not a day off');
  // 2027-06-15 is a Tuesday, so the window would be peak without the feed.
  assert.equal(isPeak(beijing(2027, 6, 15, 10, 0), RULE), false);
});

test('the fetched table is written to a cookie for the next launch', () => {
  const raw = cookieJar.get('dsh_peak_price_guard_holidays');
  assert.ok(raw, 'the cache cookie was written');
  const parsed = JSON.parse(decodeURIComponent(raw));
  assert.deepEqual(parsed.years['2027'], ['2027-06-15']);
});

test('an unreachable feed keeps the previous table instead of inventing holidays', async () => {
  const before = new Map(holidayYears);
  const state = await refreshHolidays(beijing(2025, 10, 1, 10, 0), async () => {
    throw new Error('offline');
  });
  assert.equal(state, 'synced', 'the table survives, the failed fetch does not reset it');
  assert.deepEqual(new Map(holidayYears), before);
  assert.equal(isHolidayDate('2025-10-01'), true, 'a year without feed data still uses the built-in table');
});

test('a malformed feed response changes nothing', async () => {
  const before = holidayYears.get(2027);
  await refreshHolidays(beijing(2027, 1, 5, 10, 0), async () => ({
    ok: true,
    json: async () => ({ days: 'not-an-array' }),
  }));
  assert.equal(holidayYears.get(2027), before);
});

test('a covered year follows the feed, not the built-in table', async () => {
  const feed = async (url) => (url.endsWith('/2026.json')
    ? { ok: true, json: async () => ({ days: [{ date: '2026-01-01', isOffDay: true }] }) }
    : { ok: false, json: async () => ({}) });
  await refreshHolidays(beijing(2026, 1, 5, 10, 0), feed);
  assert.equal(isHolidayDate('2026-01-01'), true);
  assert.equal(isHolidayDate('2026-02-17'), false, 'the feed is authoritative for a year it delivered');
  assert.equal(isPeak(beijing(2026, 2, 17, 10, 0), RULE), true);
});
// #endregion
