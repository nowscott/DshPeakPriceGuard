/**
 * Host half of the peak-price guard bundle.
 *
 * The guard itself is a browser behaviour: it wraps the Conversation composer's
 * send sink, so the reminder and the confirmation live in the Client module
 * (`./client.js`). This Host entry exists so the preferences can live in the
 * profile's configuration file instead of only in one browser:
 *
 * 1. It seeds the page. `dsh.client` entries never carry row config, so the
 *    Client cannot read `cordis.patch.yml` itself; the Host publishes the
 *    effective config as one boot global through the web server's index
 *    injection, which the Client reads before its first paint.
 * 2. It accepts the settings page's writes on a small same-origin route and
 *    persists them through `configEditor`, which keeps the rest of the profile
 *    patch intact and applies the new values via the normal Loader path.
 *
 * Every piece is optional: a profile without a web server or without the config
 * editor still loads the bundle, and the Client then falls back to its cookie.
 */

/** The global the Client module reads at apply time. */
const CONFIG_GLOBAL = '__DSH_PEAK_PRICE_GUARD__';
/** Same-origin endpoint the settings page posts its preferences to. */
const CONFIG_ROUTE = '/dsh-peak-price-guard/config';
/** A write must carry this header, so a cross-site form post cannot reach it. */
const CONFIG_HEADER = 'x-dsh-peak-price-guard';
/** Peers send a small JSON document; anything larger is not a preferences write. */
const MAX_BODY_BYTES = 8 * 1024;
/** Header value the settings page sends. */
const CONFIG_HEADER_VALUE = '1';

/** Built-in preferences; kept in step with `client.js`. */
const DEFAULT_CONFIG = {
	enabled: true,
	windows: '09:00-12:00, 14:00-18:00',
	holidaysOffPeak: true,
	muteMinutes: 30,
	showBadge: true,
};

/**
 * Coerce a config-file value into a complete, valid preference set.
 * The Client normalizes again; this copy only decides what the page is seeded
 * with and what a write persists, so a malformed row cannot poison either.
 * @param {unknown} raw - the row config or a request body.
 * @returns {typeof DEFAULT_CONFIG} the normalized preferences.
 */
function normalizeConfig(raw) {
	const source = raw !== null && typeof raw === 'object' ? raw : {};
	const config = { ...DEFAULT_CONFIG };
	if (typeof source.enabled === 'boolean') config.enabled = source.enabled;
	if (typeof source.windows === 'string') config.windows = source.windows;
	if (typeof source.holidaysOffPeak === 'boolean') config.holidaysOffPeak = source.holidaysOffPeak;
	if (typeof source.showBadge === 'boolean') config.showBadge = source.showBadge;
	const minutes = Number(source.muteMinutes);
	if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) config.muteMinutes = Math.round(minutes);
	return config;
}

/**
 * Whether two preferences are the same four fields and nothing else.
 * @param {object} left - one normalized set.
 * @param {object} right - the other normalized set.
 */
function sameConfig(left, right) {
	return Object.keys(DEFAULT_CONFIG).every((key) => left[key] === right[key]);
}

/**
 * Read a JSON request body, refusing anything past {@link MAX_BODY_BYTES}.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<unknown>} the parsed body.
 */
function readJsonBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('body too large'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (error) {
				reject(error);
			}
		});
		request.on('error', reject);
	});
}

/**
 * Answer one request with JSON, closing it.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 */
function sendJson(response, status, body) {
	if (response.headersSent) return;
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	});
	response.end(JSON.stringify(body));
}

/** Whether a browser request came from this very page. */
function sameOrigin(request) {
	const origin = request.headers.origin;
	if (typeof origin !== 'string' || origin === '') {
		// Non-browser peers and same-origin navigations may omit it; the custom
		// header below is then the only gate, which is enough for a local file.
		return true;
	}
	try {
		return new URL(origin).host === request.headers.host;
	} catch (_error) {
		return false;
	}
}

/**
 * Host plugin body.
 * @param {object} ctx - the plugin context.
 * @param {object} [config] - the row config from the profile patch.
 */
export function apply(ctx, config) {
	const seed = normalizeConfig(config);
	/** The Loader entry an edit addresses; captured before any child context. */
	const entry = ctx.fiber === undefined ? undefined : ctx.fiber.entry;

	ctx.inject(['webServer'], (ctx) => {
		ctx.on('webserver/index-inject', (table) => {
			table.push({ kind: 'global', name: CONFIG_GLOBAL, value: { version: 1, config: seed } });
		});

		ctx.effect(() => registerRoute(ctx, entry), 'peak-price-guard: config route');
	});
}

/**
 * Register the preferences route, tolerating a route the previous activation
 * left behind. A config edit restarts this plugin; if that restart overlaps the
 * old fiber's teardown, the old route is still the live one and already closes
 * over the same file, so skipping the duplicate is correct rather than fatal.
 * @param {object} ctx - the context owning the web server service.
 * @param {object | undefined} entry - the Loader entry an edit addresses.
 * @returns {Function} the disposer for this registration.
 */
function registerRoute(ctx, entry) {
	try {
		return ctx.webServer.register({
			kind: 'exact',
			path: CONFIG_ROUTE,
			async handler(request, response) {
				if (request.method !== 'POST') {
					sendJson(response, 405, { error: 'method-not-allowed' });
					return;
				}
				if (request.headers[CONFIG_HEADER] !== CONFIG_HEADER_VALUE || !sameOrigin(request)) {
					sendJson(response, 403, { error: 'forbidden' });
					return;
				}
				let body;
				try {
					body = await readJsonBody(request);
				} catch (error) {
					sendJson(response, 400, { error: 'bad-request', message: String(error.message ?? error) });
					return;
				}
				const next = normalizeConfig(body === null || typeof body !== 'object' ? undefined : body.config);
				const editor = ctx.get('configEditor');
				if (entry === undefined || editor === undefined) {
					// No profile config to write: the Client keeps the value in its cookie.
					sendJson(response, 501, { error: 'config-unavailable', config: next });
					return;
				}
				const current = normalizeConfig(entry.options?.config);
				if (sameConfig(current, next)) {
					sendJson(response, 200, { config: next, persisted: true, changed: false });
					return;
				}
				try {
					await editor.edit(entry, (raw) => ({ ...(raw ?? {}), ...next }));
					sendJson(response, 200, { config: next, persisted: true, changed: true });
				} catch (error) {
					sendJson(response, 409, { error: 'rejected', message: String(error.message ?? error) });
				}
			},
		});
	} catch (error) {
		console.warn('[peak-price-guard] config route already registered:', error);
		return () => {};
	}
}
