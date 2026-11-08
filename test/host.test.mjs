// Contract check for the Host half (`index.js`).
//
// The Host half has two jobs: publish the config-file preferences into the page
// as a boot global, and accept the settings page's writes on a same-origin route
// that persists through `configEditor`. Neither needs a Harness to test: the
// module only touches the context object it is handed, so the test supplies one.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { apply } from '../index.js';

/** A request body carrying `document`, with the fields the handler reads. */
function request(method, body, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { host: '127.0.0.1:3080', ...headers };
  req.destroy = () => {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

/** A response that records the status and parsed JSON body it was given. */
function response() {
  const res = {
    headersSent: false,
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
      res.headersSent = true;
    },
    end(raw) {
      res.body = raw === undefined ? undefined : JSON.parse(raw);
    },
  };
  return res;
}

/**
 * Mount the Host half against a stub context.
 * @param {{ config?: object, editor?: object | undefined, webServer?: boolean }} options
 */
function mount({ config, editor = {}, webServer = true } = {}) {
  const mounted = { injections: [], routes: [], effects: [], warnings: [] };
  const ctx = {
    fiber: { entry: { options: { config } } },
    on(event, listener) {
      mounted.injections.push([event, listener]);
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      mounted.effects.push(dispose);
      return () => {};
    },
    get: (name) => (name === 'configEditor' && editor !== null ? editor : undefined),
    inject(names, callback) {
      mounted.injected = names;
      if (webServer) callback(ctx);
    },
    webServer: {
      register(route) {
        mounted.routes.push(route);
        return () => {};
      },
    },
  };
  apply(ctx, config);
  // Execute the index-inject listeners the way the web server collects rows.
  const table = [];
  for (const [event, listener] of mounted.injections) {
    if (event === 'webserver/index-inject') listener(table, {});
  }
  mounted.table = table;
  return mounted;
}

test('the Host publishes the row config as a boot global', () => {
  const mounted = mount({ config: { enabled: false, windows: '10:00-11:00', muteMinutes: 12, showBadge: false, holidaysOffPeak: false } });
  assert.deepEqual(mounted.injected, ['webServer']);
  const row = mounted.table.find((entry) => entry.name === '__DSH_PEAK_PRICE_GUARD__');
  assert.equal(row.kind, 'global');
  assert.deepEqual(row.value.config, {
    enabled: false,
    windows: '10:00-11:00',
    holidaysOffPeak: false,
    muteMinutes: 12,
    showBadge: false,
  });
});

test('a row with no config (or junk) still seeds a complete, valid set', () => {
  const mounted = mount({ config: { muteMinutes: 'lots', windows: 42 } });
  const row = mounted.table.find((entry) => entry.name === '__DSH_PEAK_PRICE_GUARD__');
  assert.deepEqual(row.value.config, {
    enabled: true,
    windows: '09:00-12:00, 14:00-18:00',
    holidaysOffPeak: true,
    muteMinutes: 30,
    showBadge: true,
  });
});

test('the config route accepts a same-origin write and persists it through configEditor', async () => {
  const edits = [];
  const mounted = mount({
    config: { enabled: true },
    editor: {
      async edit(entry, change) {
        edits.push([entry, change({ enabled: true, extra: 'kept' })]);
      },
    },
  });
  const route = mounted.routes[0];
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, '/dsh-peak-price-guard/config');

  const res = response();
  await route.handler(request('POST', JSON.stringify({ config: { enabled: false, showBadge: false } }), {
    'content-type': 'application/json',
    'x-dsh-peak-price-guard': '1',
    origin: 'http://127.0.0.1:3080',
  }), res);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    config: { enabled: false, windows: '09:00-12:00, 14:00-18:00', holidaysOffPeak: true, muteMinutes: 30, showBadge: false },
    persisted: true,
    changed: true,
  });
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0][1], {
    enabled: false,
    extra: 'kept',
    windows: '09:00-12:00, 14:00-18:00',
    holidaysOffPeak: true,
    muteMinutes: 30,
    showBadge: false,
  }, 'the written config keeps unknown keys and carries every known one');
});

test('a write without the private header, or from another origin, is refused', async () => {
  const mounted = mount({ config: {} });
  const route = mounted.routes[0];

  const anonymous = response();
  await route.handler(request('POST', JSON.stringify({ config: {} })), anonymous);
  assert.equal(anonymous.status, 403);
  assert.equal(anonymous.body.error, 'forbidden');

  const crossSite = response();
  await route.handler(request('POST', JSON.stringify({ config: {} }), {
    'x-dsh-peak-price-guard': '1',
    origin: 'http://evil.example',
  }), crossSite);
  assert.equal(crossSite.status, 403, 'a cross-site origin is refused even with the header');
});

test('the route answers GET with 405, and an oversized body with 400', async () => {
  const mounted = mount({ config: {} });
  const route = mounted.routes[0];

  const get = response();
  await route.handler(request('GET'), get);
  assert.equal(get.status, 405);

  const huge = response();
  await route.handler(request('POST', JSON.stringify({ config: { windows: 'x'.repeat(20_000) } }), {
    'x-dsh-peak-price-guard': '1',
  }), huge);
  assert.equal(huge.status, 400);
});

test('a profile without a config editor, and an unchanged write, both answer cleanly', async () => {
  const noEditor = mount({ config: { enabled: true }, editor: null });
  const unavailable = response();
  await noEditor.routes[0].handler(request('POST', JSON.stringify({ config: { enabled: false } }), {
    'x-dsh-peak-price-guard': '1',
  }), unavailable);
  assert.equal(unavailable.status, 501);
  assert.equal(unavailable.body.error, 'config-unavailable');
  assert.equal(unavailable.body.config.enabled, false, 'the client still learns the value it tried to save');

  let edited = 0;
  const unchanged = mount({
    config: { enabled: true },
    editor: { async edit() { edited += 1; } },
  });
  const res = response();
  await unchanged.routes[0].handler(request('POST', JSON.stringify({ config: { enabled: true } }), {
    'x-dsh-peak-price-guard': '1',
  }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, false);
  assert.equal(edited, 0, 'an identical write does not touch the profile patch');
});

test('a refused edit surfaces as 409 instead of claiming success', async () => {
  const mounted = mount({
    config: { enabled: true },
    editor: { async edit() { throw new Error('overridden by a higher-priority layer'); } },
  });
  const res = response();
  await mounted.routes[0].handler(request('POST', JSON.stringify({ config: { enabled: false } }), {
    'x-dsh-peak-price-guard': '1',
  }), res);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'rejected');
  assert.match(res.body.message, /higher-priority/);
});

test('a restart that overlaps the old route does not fail the Host half', () => {
  const mounted = mount({ config: { enabled: true }, webServer: false });
  // Simulate the old activation's route still being live when the new one
  // registers: the web server refuses duplicates, and the Host must survive it.
  globalThis.__warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => { globalThis.__warned.push(args.join(' ')); };
  try {
    const ctx = {
      fiber: { entry: { options: { config: { enabled: true } } } },
      on: () => () => {},
      effect: (fn) => fn(),
      get: () => ({}),
      inject: (names, callback) => callback(ctx),
      webServer: {
        register() {
          throw new Error('webserver: duplicate exact route "/dsh-peak-price-guard/config"');
        },
      },
    };
    assert.doesNotThrow(() => apply(ctx, { enabled: true }));
    assert.match(globalThis.__warned.join('\n'), /already registered/);
  } finally {
    console.warn = realWarn;
    delete globalThis.__warned;
    mounted.dispose?.();
  }
});

test('a profile without a web server loads the Host half and registers nothing', () => {
  const mounted = mount({ config: { enabled: true }, webServer: false });
  assert.deepEqual(mounted.routes, []);
  assert.deepEqual(mounted.table, []);
});
