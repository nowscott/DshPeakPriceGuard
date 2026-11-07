window.__ModuleLoader__.load({
	id: 'dsh-peak-price-guard',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		/** `react-dom` is a platform seed; it lets the hover tip escape the dock's clipping. */
		let createPortal = null;
		try {
			const ReactDOM = require('react-dom');
			if (typeof ReactDOM.createPortal === 'function') createPortal = ReactDOM.createPortal;
		} catch (_error) {
			createPortal = null;
		}

		const NS = 'peak-price-guard';

		// #region DeepSeek peak-price calendar
		//
		// DeepSeek bills two list prices. 高峰时段 (peak, full price):
		//   Beijing time, Monday–Friday, 09:00–12:00 and 14:00–18:00,
		//   excluding Chinese public holidays (which bill off-peak all day).
		// Everything else — evenings, nights, weekends, holidays — is 特价 /
		// off-peak. `Asia/Shanghai` is a fixed UTC+8 offset with no DST, so
		// reading epoch milliseconds shifted by +8h through the `getUTC*`
		// accessors *is* Beijing wall-clock time; no time-zone database is used.
		const HOUR = 3_600_000;
		const DAY = 86_400_000;
		const BEIJING_OFFSET = 8 * HOUR;
		/**
		 * Offline fallback: Chinese public holidays (`isOffDay = true`) for
		 * 2025–2026, transcribed from the official State Council notices.
		 *
		 * The plugin does not rely on this list alone — `refreshHolidays` pulls
		 * the same data from `holiday-cn` (MIT, regenerated from the notices and
		 * published daily) and the feed wins for every year it covers. This table
		 * only answers for a year the feed could not deliver, which is still far
		 * better than treating a statutory day off as a billable workday.
		 */
		const BUILTIN_HOLIDAYS = new Set([
			'2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
			'2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04', '2025-04-04',
			'2025-04-05', '2025-04-06', '2025-05-01', '2025-05-02', '2025-05-03',
			'2025-05-04', '2025-05-05', '2025-05-31', '2025-06-01', '2025-06-02',
			'2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05',
			'2025-10-06', '2025-10-07', '2025-10-08', '2026-01-01', '2026-01-02',
			'2026-01-03', '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18',
			'2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
			'2026-04-04', '2026-04-05', '2026-04-06', '2026-05-01', '2026-05-02',
			'2026-05-03', '2026-05-04', '2026-05-05', '2026-06-19', '2026-06-20',
			'2026-06-21', '2026-09-25', '2026-09-26', '2026-09-27', '2026-10-01',
			'2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06',
			'2026-10-07',
		]);

		/** Zero-pad one clock/date field. */
		function pad2(value) {
			return value < 10 ? `0${value}` : String(value);
		}

		/**
		 * Beijing wall-clock parts of an instant.
		 * @param {number} atMs - epoch milliseconds.
		 * @returns {{ year: number, month: number, day: number, weekday: number, hour: number, minute: number, date: string }}
		 *   `weekday` is 0 = Sunday … 6 = Saturday; `date` is `YYYY-MM-DD`.
		 */
		function beijingParts(atMs) {
			const d = new Date(atMs + BEIJING_OFFSET);
			const year = d.getUTCFullYear();
			const month = d.getUTCMonth() + 1;
			const day = d.getUTCDate();
			return {
				year,
				month,
				day,
				weekday: d.getUTCDay(),
				hour: d.getUTCHours(),
				minute: d.getUTCMinutes(),
				date: `${year}-${pad2(month)}-${pad2(day)}`,
			};
		}

		/** The instant of Beijing midnight that starts the instant's Beijing day. */
		function beijingDayStart(atMs) {
			return Math.floor((atMs + BEIJING_OFFSET) / DAY) * DAY - BEIJING_OFFSET;
		}
		// #endregion

		// #region holiday feed
		//
		// The State Council publishes next year's holiday arrangement in November
		// or December, so a table baked into a release is wrong every January.
		// `NateScarlet/holiday-cn` (MIT) re-scrapes the notice daily and publishes
		// one JSON file per year; jsDelivr serves it with permissive CORS, so the
		// Client half can read it directly. We fetch the current Beijing year and
		// the next one, keep them in a cookie for offline launches, and let the
		// built-in table answer only when neither source has the year.
		const HOLIDAY_FEED = 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master';
		const HOLIDAY_CACHE_COOKIE = 'dsh_peak_price_guard_holidays';
		const HOLIDAY_CACHE_VERSION = 2;
		const HOLIDAY_CACHE_MAX_AGE = 45 * 24 * 3600;
		const HOLIDAY_FETCH_TIMEOUT = 6000;
		const HOLIDAY_REFRESH_INTERVAL = 12 * 3600 * 1000;
		const HOLIDAY_RETRY_DELAY = 30 * 60 * 1000;

		/** year → `Set<YYYY-MM-DD>` of off days delivered by the feed. */
		const holidayYears = new Map();
		/**
		 * Last holiday-table state.
		 * `state` is `builtin` (fallback table), `cached` (from the cookie) or
		 * `synced` (delivered by the feed during this page's life). `error` is
		 * `network` when every fetch failed and `partial` when only one year did.
		 */
		const calendarStore = createStore({ state: 'builtin', years: [], fetchedAt: 0, attemptedAt: 0, error: null, busy: false });
		/** Guards against overlapping refreshes (startup + interval + the settings button). */
		let holidayRefreshing = false;

		/** Read one cookie by name, or `undefined` when absent or blocked. */
		function readCookie(name) {
			try {
				for (const part of String(document.cookie || '').split(';')) {
					const separator = part.indexOf('=');
					if (separator === -1) continue;
					if (part.slice(0, separator).trim() !== name) continue;
					return decodeURIComponent(part.slice(separator + 1).trim());
				}
			} catch (_error) {
				/* no document (tests) or cookies blocked */
			}
			return undefined;
		}

		/** Write one cookie; failures are not fatal. */
		function writeCookie(name, value, maxAgeSeconds) {
			try {
				document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
			} catch (_error) {
				/* cookies blocked: the in-memory table still applies */
			}
		}

		/**
		 * Whether one `YYYY-MM-DD` is a statutory day off.
		 * A year the feed delivered is authoritative for that whole year, so a
		 * corrected notice also removes a day the built-in table once listed.
		 * @param {string} date - `YYYY-MM-DD` in Beijing time.
		 */
		function isHolidayDate(date) {
			const fetched = holidayYears.get(Number(date.slice(0, 4)));
			if (fetched !== undefined) return fetched.has(date);
			return BUILTIN_HOLIDAYS.has(date);
		}

		/**
		 * Restore the last fetched table, so the first paint is already correct offline.
		 * Accepts both the compact layout and the original one: cookies written by
		 * 0.3.x stay readable.
		 */
		function readHolidayCache() {
			const raw = readCookie(HOLIDAY_CACHE_COOKIE);
			if (raw === undefined) return;
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch (_error) {
				return;
			}
			if (parsed === null || typeof parsed !== 'object') return;
			const compact = parsed.y;
			if (compact !== null && typeof compact === 'object') {
				for (const [year, text] of Object.entries(compact)) {
					if (typeof text !== 'string') continue;
					const set = new Set();
					for (const suffix of text.split(',')) {
						if (/^\d{2}-\d{2}$/.test(suffix) === false) continue;
						set.add(`${year}-${suffix}`);
					}
					if (set.size > 0) holidayYears.set(Number(year), set);
				}
			} else if (parsed.years !== null && typeof parsed.years === 'object') {
				for (const [year, dates] of Object.entries(parsed.years)) {
					if (!Array.isArray(dates)) continue;
					const set = new Set(dates.filter((date) => typeof date === 'string'));
					if (set.size > 0) holidayYears.set(Number(year), set);
				}
			}
			if (holidayYears.size === 0) return;
			calendarStore.set({
				state: 'cached',
				years: [...holidayYears.keys()].sort(),
				fetchedAt: Number(parsed.savedAt ?? parsed.s) || 0,
				attemptedAt: 0,
				error: null,
				busy: false,
			});
		}

		/**
		 * Persist the fetched table.
		 * Dates are stored as `MM-DD` and joined, because a cookie is capped at
		 * roughly 4 KB and the naive `["2026-01-01", …]` shape wastes half of it on
		 * a year prefix that is identical for every entry in the group.
		 */
		function writeHolidayCache() {
			const years = {};
			for (const [year, dates] of holidayYears) {
				years[year] = [...dates].map((date) => date.slice(5)).sort().join(',');
			}
			writeCookie(
				HOLIDAY_CACHE_COOKIE,
				JSON.stringify({ v: HOLIDAY_CACHE_VERSION, s: Date.now(), y: years }),
				HOLIDAY_CACHE_MAX_AGE,
			);
		}

		/**
		 * Fetch one year of the feed.
		 * @returns {Promise<Set<string> | undefined>} off days, or `undefined` on any failure.
		 */
		async function fetchHolidayYear(year, fetcher) {
			const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
			const timer = controller === undefined
				? undefined
				: setTimeout(() => controller.abort(), HOLIDAY_FETCH_TIMEOUT);
			try {
				const response = await fetcher(`${HOLIDAY_FEED}/${year}.json`, {
					signal: controller === undefined ? undefined : controller.signal,
					cache: 'no-cache',
				});
				if (response === undefined || response.ok !== true) return undefined;
				const body = await response.json();
				const days = body === null || typeof body !== 'object' ? undefined : body.days;
				if (!Array.isArray(days)) return undefined;
				const offDays = new Set();
				for (const day of days) {
					if (day === null || typeof day !== 'object') continue;
					// `isOffDay: false` marks a makeup workday (调休补班). Weekends are
					// already off-peak, so those days need no entry here.
					if (day.isOffDay === false) continue;
					if (typeof day.date !== 'string') continue;
					offDays.add(day.date);
				}
				return offDays.size === 0 ? undefined : offDays;
			} catch (_error) {
				return undefined;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		}

		/**
		 * Refresh the current Beijing year and the next one from the feed.
		 * Missing or broken responses leave the previous table in place, so a
		 * flaky network never turns a holiday into a billable day.
		 * @param {number} [atMs] - instant whose Beijing year to start from.
		 * @param {Function} [fetcher] - injectable for tests.
		 * @returns {Promise<string>} the resulting state (`builtin` / `cached` / `synced`).
		 */
		async function refreshHolidays(atMs = Date.now(), fetcher = (url, init) => window.fetch(url, init)) {
			// `window.fetch` must be called on `window`: extracting the method first
			// throws "Illegal invocation" in Chromium.
			if (typeof fetcher !== 'function') return calendarStore.getSnapshot().state;
			if (holidayRefreshing) return calendarStore.getSnapshot().state;
			holidayRefreshing = true;
			const current = calendarStore.getSnapshot();
			calendarStore.set({ ...current, busy: true, attemptedAt: Date.now() });
			try {
				const { year } = beijingParts(atMs);
				let changed = false;
				let delivered = 0;
				for (const target of [year, year + 1]) {
					const offDays = await fetchHolidayYear(target, fetcher);
					if (offDays === undefined) continue;
					delivered += 1;
					const previous = holidayYears.get(target);
					if (previous === undefined || previous.size !== offDays.size) changed = true;
					holidayYears.set(target, offDays);
				}
				const years = [...holidayYears.keys()].sort();
				const state = delivered > 0 ? 'synced' : years.length > 0 ? 'cached' : 'builtin';
				const error = delivered === 2 ? null : delivered === 0 ? 'network' : 'partial';
				calendarStore.set({ state, years, fetchedAt: delivered > 0 ? Date.now() : current.fetchedAt, attemptedAt: Date.now(), error, busy: false });
				if (delivered > 0) writeHolidayCache();
				if (changed) refreshClock();
				return state;
			} finally {
				holidayRefreshing = false;
			}
		}

		// #endregion

		// #region peak rules
		/**
		 * Parse a peak-window spec: `HH:MM-HH:MM`, comma separated.
		 * An empty string means "no peak windows at all".
		 * @param {string} text - the configured spec.
		 * @returns {Array<[number, number]> | null} hour pairs, or null when malformed.
		 */
		function parseWindows(text) {
			if (typeof text !== 'string') return null;
			const trimmed = text.trim();
			if (trimmed === '') return [];
			const parts = trimmed.split(/[,;，；]/).map((part) => part.trim()).filter((part) => part !== '');
			if (parts.length === 0) return [];
			const windows = [];
			for (const part of parts) {
				const match = /^(\d{1,2})(?::(\d{2}))?\s*[-–—~至]\s*(\d{1,2})(?::(\d{2}))?$/.exec(part);
				if (match === null) return null;
				const start = Number(match[1]) * 60 + Number(match[2] ?? '0');
				const end = Number(match[3]) * 60 + Number(match[4] ?? '0');
				if (start < 0 || end > 24 * 60 || end <= start) return null;
				if (Number(match[1]) > 24 || Number(match[3]) > 24) return null;
				if (Number(match[2] ?? '0') > 59 || Number(match[4] ?? '0') > 59) return null;
				windows.push([start / 60, end / 60]);
			}
			windows.sort((left, right) => left[0] - right[0]);
			return windows;
		}

		/** The default price rule, also the fallback for a malformed spec. */
		const DEFAULT_WINDOWS = '09:00-12:00, 14:00-18:00';

		/** Built-in preferences; `normalizeConfig` fills anything missing. */
		const DEFAULT_CONFIG = {
			enabled: true,
			windows: DEFAULT_WINDOWS,
			holidaysOffPeak: true,
			muteMinutes: 30,
			showBadge: true,
		};

		/** Coerce a stored or edited value into a complete, valid preference set. */
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
		 * Turn preferences into the calendar rule the gate evaluates.
		 * @param {object} config - normalized preferences.
		 * @returns {{ windows: Array<[number, number]>, valid: boolean, holidaysOffPeak: boolean }}
		 */
		function buildRule(config) {
			const parsed = parseWindows(config.windows);
			return {
				windows: parsed === null ? parseWindows(DEFAULT_WINDOWS) : parsed,
				valid: parsed !== null,
				holidaysOffPeak: config.holidaysOffPeak !== false,
			};
		}

		/** Whether one instant bills at DeepSeek's peak (non-discount) rate. */
		function isPeak(atMs, rule) {
			if (typeof atMs !== 'number' || !Number.isFinite(atMs) || rule === undefined) return false;
			if (rule.windows.length === 0) return false;
			const parts = beijingParts(atMs);
			if (parts.weekday === 0 || parts.weekday === 6) return false;
			if (rule.holidaysOffPeak && isHolidayDate(parts.date)) return false;
			const clock = parts.hour + parts.minute / 60;
			return rule.windows.some(([start, end]) => clock >= start && clock < end);
		}

		/**
		 * The instant the current peak window ends (off-peak pricing resumes).
		 * Only meaningful while `isPeak(atMs, rule)`; otherwise it returns `atMs`.
		 */
		function peakWindowEnd(atMs, rule) {
			if (rule === undefined) return atMs;
			const parts = beijingParts(atMs);
			const clock = parts.hour + parts.minute / 60;
			const window = rule.windows.find(([start, end]) => clock >= start && clock < end);
			if (window === undefined) return atMs;
			return beijingDayStart(atMs) + window[1] * HOUR;
		}

		/**
		 * Describe when off-peak pricing resumes, for the reminder copy.
		 * @returns {{ hour: string, minute: string, dayOffset: number, date: string }}
		 */
		function offPeakStart(atMs, rule) {
			const end = peakWindowEnd(atMs, rule);
			const parts = beijingParts(end);
			return {
				hour: pad2(parts.hour),
				minute: pad2(parts.minute),
				dayOffset: Math.round((beijingDayStart(end) - beijingDayStart(atMs)) / DAY),
				date: `${pad2(parts.month)}-${pad2(parts.day)}`,
			};
		}

		/**
		 * Describe when the next peak window starts, for the off-peak copy.
		 * @returns {{ hour: string, minute: string, dayOffset: number, date: string } | undefined}
		 */
		function nextPeakStart(atMs, rule) {
			if (rule === undefined || rule.windows.length === 0) return undefined;
			const base = beijingDayStart(atMs);
			for (let day = 0; day <= 14; day += 1) {
				const dayStart = base + day * DAY;
				const parts = beijingParts(dayStart + 12 * HOUR);
				if (parts.weekday === 0 || parts.weekday === 6) continue;
				if (rule.holidaysOffPeak && isHolidayDate(parts.date)) continue;
				for (const [start] of rule.windows) {
					const at = dayStart + start * HOUR;
					if (at > atMs) {
						const clock = beijingParts(at);
						return {
							hour: pad2(clock.hour),
							minute: pad2(clock.minute),
							dayOffset: Math.round((dayStart - base) / DAY),
							date: `${pad2(clock.month)}-${pad2(clock.day)}`,
						};
					}
				}
			}
			return undefined;
		}

		/** Format a clock value as `HH:mm`. */
		function clockLabel(parts) {
			return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
		}

		/**
		 * One line describing where the holiday table came from and how old it is.
		 * @param {{ state: string, years: number[], fetchedAt: number, error: string | null }} calendar - the snapshot.
		 * @param {Function} t - localized copy.
		 */
		function holidayStatusText(calendar, t) {
			const years = calendar.years.join(' / ');
			if (calendar.state !== 'synced' && calendar.state !== 'cached') return t('settings.holidays.builtin');
			const updated = calendar.fetchedAt === 0 ? '' : clockLabel(beijingParts(calendar.fetchedAt));
			const base = calendar.state === 'synced'
				? t('settings.holidays.synced', { years, time: updated })
				: t('settings.holidays.cached', { years });
			return calendar.error === null ? base : `${base}${t('settings.holidays.retry')}`;
		}

		/** Localized "today 18:00" / "tomorrow 09:00" / "10-08 09:00". */
		function whenLabel(start, t) {
			const time = `${start.hour}:${start.minute}`;
			if (start.dayOffset === 0) return t('when.today', { time });
			if (start.dayOffset === 1) return t('when.tomorrow', { time });
			return t('when.later', { date: start.date, time });
		}
		// #endregion

		// #region preferences (browser-local)
		//
		// A Client half receives no row config: the boot manifest creates client
		// plugin entries without one, so `cordis.patch.yml` values cannot reach
		// this module. The settings document (`configForms`) would only list a row
		// that declares a Host Config schema, which needs `@deepseek-ai/schemastery`
		// — unavailable to a directory-linked bundle. The preferences therefore
		// live in this browser, edited from the settings page registered below.
		//
		// The cookie is the primary store, not `localStorage`: the Desktop app
		// serves the page on an ephemeral port (`http://127.0.0.1:<port>`), and an
		// origin includes its port, so `localStorage` and IndexedDB would reset on
		// every launch. Cookies are scoped by host only, so they survive restarts.
		const CONFIG_KEY = 'dsh.peak-price-guard.config.v1';
		const CONFIG_COOKIE = 'dsh_peak_price_guard';
		const CONFIG_COOKIE_MAX_AGE = 365 * 24 * 3600;

		/** Read the preference cookie, or `undefined`. */
		function readConfigCookie() {
			return readCookie(CONFIG_COOKIE);
		}

		/** Write the preference cookie; failures are not fatal. */
		function writeConfigCookie(value) {
			writeCookie(CONFIG_COOKIE, value, CONFIG_COOKIE_MAX_AGE);
		}

		/** Read the stored preferences, falling back to the built-ins. */
		function readStoredConfig() {
			let raw = readConfigCookie();
			if (raw === undefined) {
				try {
					raw = window.localStorage.getItem(CONFIG_KEY) ?? undefined;
				} catch (_error) {
					raw = undefined;
				}
			}
			if (raw === undefined) return { ...DEFAULT_CONFIG };
			try {
				return normalizeConfig(JSON.parse(raw));
			} catch (_error) {
				return { ...DEFAULT_CONFIG };
			}
		}

		/** Persist the preferences to both stores; a browser without them works in memory. */
		function writeStoredConfig(config) {
			const raw = JSON.stringify(config);
			writeConfigCookie(raw);
			try {
				window.localStorage.setItem(CONFIG_KEY, raw);
			} catch (_error) {
				/* private mode or a full quota: the cookie still carries the value */
			}
		}
		// #endregion

		// #region stores
		/** Stand-in for the slot's `useSessions` when the owner does not provide one. */
		const NO_SESSIONS = () => undefined;

		/** Minimal snapshot store for `useSyncExternalStore`. */
		function createStore(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				getSnapshot() {
					return value;
				},
				set(next) {
					if (next === value) return;
					value = next;
					for (const listener of [...listeners]) listener();
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			};
		}

		const useSyncExternalStore =
			typeof React.useSyncExternalStore === 'function'
				? React.useSyncExternalStore
				: (subscribe, getSnapshot) => {
						const [value, setValue] = React.useState(getSnapshot);
						React.useEffect(() => {
							setValue(getSnapshot());
							return subscribe(() => setValue(getSnapshot()));
						}, [subscribe]);
						return value;
				  };

		/** Preferences plus the rule derived from them. */
		const settingsStore = createStore({ config: { ...DEFAULT_CONFIG }, rule: buildRule(DEFAULT_CONFIG) });
		/** Live price state; refreshed on a short interval so the dot flips at a boundary. */
		const clockStore = createStore({ now: 0, peak: false });
		/** Whether the composer send gate is actually installed (`null` until checked). */
		const gateStore = createStore({ active: null });
		/** Sends waiting for an explicit answer, oldest first; the first one is on screen. */
		const queueStore = createStore([]);
		/** sessionId → epoch milliseconds until which that session asks nothing. */
		const silence = new Map();

		/** Re-read the clock with the current rule and publish only a real change. */
		function refreshClock() {
			const at = Date.now();
			const { config, rule } = settingsStore.getSnapshot();
			const peak = config.enabled && isPeak(at, rule);
			const current = clockStore.getSnapshot();
			if (current.peak === peak && Math.floor(current.now / 60_000) === Math.floor(at / 60_000)) return;
			clockStore.set({ now: at, peak });
		}

		/**
		 * Merge one preference patch: publish, persist, and re-evaluate the clock.
		 * @param {Partial<typeof DEFAULT_CONFIG>} patch - changed fields.
		 * @returns {object} the normalized preferences now in effect.
		 */
		function updateConfig(patch) {
			const current = settingsStore.getSnapshot().config;
			const config = normalizeConfig({ ...current, ...patch });
			settingsStore.set({ config, rule: buildRule(config) });
			writeStoredConfig(config);
			refreshClock();
			return config;
		}

		/** Whether one session is inside its "ask nothing for a while" window. */
		function isSilenced(sessionId) {
			if (sessionId === undefined || sessionId === null) return false;
			const until = silence.get(sessionId);
			if (until === undefined) return false;
			if (until <= Date.now()) {
				silence.delete(sessionId);
				return false;
			}
			return true;
		}
		// #endregion

		// #region send gate
		const PATCH_MARK = Symbol.for('dsh.peak-price-guard.patched');
		let requestSeq = 0;

		/**
		 * Ask the user to confirm one send.
		 * @param {{ text: string, sessionId?: string, muteMinutes: number, signal?: AbortSignal }} input
		 * @returns {Promise<{ approved: boolean, mute: boolean }>}
		 */
		function requestConfirmation(input) {
			return new Promise((resolve) => {
				requestSeq += 1;
				let settled = false;
				const request = {
					id: requestSeq,
					text: input.text,
					sessionId: input.sessionId,
					muteMinutes: input.muteMinutes,
					createdAt: Date.now(),
					settle(approved, options) {
						if (settled) return;
						settled = true;
						if (onAbort !== undefined) input.signal.removeEventListener('abort', onAbort);
						const queue = queueStore.getSnapshot();
						const index = queue.indexOf(request);
						if (index !== -1) queueStore.set([...queue.slice(0, index), ...queue.slice(index + 1)]);
						resolve({ approved: approved === true, mute: options !== undefined && options.mute === true });
					},
				};
				const onAbort = input.signal === undefined ? undefined : () => request.settle(false);
				if (onAbort !== undefined) input.signal.addEventListener('abort', onAbort, { once: true });
				queueStore.set([...queueStore.getSnapshot(), request]);
			});
		}

		/**
		 * Wrap one composer submission: during peak hours nothing leaves the
		 * composer until the reminder has been answered; an unconfirmed or
		 * cancelled send resolves to the composer's ordinary failure outcome,
		 * which restores the draft and keeps the attachments.
		 */
		async function gate(original, receiver, args) {
			const [session, text, attachmentIds, , signal] = args;
			const hasText = typeof text === 'string' && text.trim() !== '';
			const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;
			if (!hasText && !hasAttachments) return original.apply(receiver, args);
			const { config, rule } = settingsStore.getSnapshot();
			if (!config.enabled || !isPeak(Date.now(), rule)) return original.apply(receiver, args);
			const sessionId = session === undefined || session === null ? undefined : session.sessionId;
			if (isSilenced(sessionId)) return original.apply(receiver, args);
			if (signal !== undefined && signal.aborted === true) return { kind: 'error' };
			const outcome = await requestConfirmation({
				text: hasText ? text : '',
				sessionId,
				muteMinutes: config.muteMinutes,
				signal,
			});
			if (!outcome.approved) return { kind: 'error' };
			if (signal !== undefined && signal.aborted === true) return { kind: 'error' };
			if (outcome.mute && config.muteMinutes > 0 && sessionId !== undefined) {
				silence.set(sessionId, Date.now() + config.muteMinutes * 60_000);
			}
			return original.apply(receiver, args);
		}

		/**
		 * Replace `sendSession` on the conversation service prototype.
		 *
		 * `ctx.get()` hands back a traceable proxy, so the instance-level write
		 * cannot be relied on; the shared prototype is the one place every
		 * `conversation().sendSession(...)` lookup resolves through. The original
		 * method is captured first and restored on unload. The check below reads
		 * the method back through the proxy, so a renamed upstream method turns the
		 * status dot red instead of failing silently.
		 */
		/** How long to keep looking for the sink before declaring the gate broken. */
		const GATE_RETRY_DELAYS = [400, 800, 1600, 3200, 6400];

		function installGate(ctx, service) {
			ctx.effect(() => {
				let disposed = false;
				let timer;
				let attempt = 0;
				let holder = null;
				let original = null;
				let patched = null;
				const install = () => {
					if (disposed) return;
					const proto = Object.getPrototypeOf(service);
					const current = proto === null ? undefined : proto.sendSession;
					if (typeof current !== 'function') {
						// The conversation service may still be composing when this plugin
						// mounts, so keep looking for a moment instead of staying off for
						// the rest of the session.
						if (attempt < GATE_RETRY_DELAYS.length) {
							const delay = GATE_RETRY_DELAYS[attempt];
							attempt += 1;
							timer = setTimeout(install, delay);
							return;
						}
						console.warn('[peak-price-guard] conversation composer sink not found; the send gate is inactive');
						gateStore.set({ active: false, reason: 'missing sink' });
						return;
					}
					if (current[PATCH_MARK] === true) {
						let attached = false;
						try {
							attached = service.sendSession[PATCH_MARK] === true;
						} catch (_error) {
							attached = false;
						}
						gateStore.set({ active: attached, reason: attached ? '' : 'sink lookup bypassed the patch' });
						return;
					}
					const wrapped = function sendSession(...args) {
						return gate(current, this, args);
					};
					wrapped[PATCH_MARK] = true;
					proto.sendSession = wrapped;
					holder = proto;
					original = current;
					patched = wrapped;
					let reachable = false;
					try {
						reachable = service.sendSession[PATCH_MARK] === true;
					} catch (_error) {
						reachable = false;
					}
					gateStore.set({ active: reachable, reason: reachable ? '' : 'sink lookup bypassed the patch' });
				};
				install();
				return () => {
					disposed = true;
					clearTimeout(timer);
					if (holder !== null && holder.sendSession === patched) holder.sendSession = original;
					gateStore.set({ active: null, reason: '' });
				};
			}, 'peak-price-guard: send gate');
		}
		// #endregion

		// #region components
		const BADGE_CSS = [
			'.dsh-ppg-badge{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default;user-select:none}',
			'.dsh-ppg-badge:hover{background:var(--dsw-alias-bg-layer-1)}',
			'.dsh-ppg-badge:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
			'.dsh-ppg-badge-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}',
			'.dsh-ppg-badge[data-state="peak"] .dsh-ppg-badge-dot{background:var(--dsw-alias-state-error-primary)}',
			'.dsh-ppg-badge[data-state="offpeak"] .dsh-ppg-badge-dot{background:var(--dsw-alias-state-success-primary)}',
			'.dsh-ppg-badge[data-state="pending"] .dsh-ppg-badge-dot{background:var(--dsw-alias-state-warn-primary)}',
			'.dsh-ppg-badge[data-state="broken"] .dsh-ppg-badge-dot{background:var(--dsw-alias-state-error-primary)}',
			'.dsh-ppg-badge-value{font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.dsh-ppg-badge[data-state="peak"] .dsh-ppg-badge-value{color:var(--dsw-alias-state-error-primary)}',
			'.dsh-ppg-badge[data-state="offpeak"] .dsh-ppg-badge-value{color:var(--dsw-alias-state-success-primary)}',
			'.dsh-ppg-badge[data-state="broken"] .dsh-ppg-badge-value{color:var(--dsw-alias-state-error-primary)}',
			'.dsh-ppg-tip{position:fixed;z-index:3000;box-sizing:border-box;width:max-content;max-width:320px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:pre-line;box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:none}',
		].join('');

		const DIALOG_CSS = [
			'.dsh-ppg-overlay{position:fixed;inset:0;z-index:1000;pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:24px}',
			'.dsh-ppg-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.32))}',
			'.dsh-ppg-panel{position:relative;z-index:1;box-sizing:border-box;width:min(440px,100%);max-height:calc(100vh - 48px);overflow:auto;display:flex;flex-direction:column;gap:10px;padding:20px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 16px 48px rgba(0,0,0,.18)}',
			'.dsh-ppg-title{margin:0;font-size:15px;font-weight:600;line-height:22px}',
			'.dsh-ppg-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
			'.dsh-ppg-session{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dsh-ppg-preview-label{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
			'.dsh-ppg-preview{margin:0;box-sizing:border-box;max-height:132px;overflow:auto;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word}',
			'.dsh-ppg-check{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
			'.dsh-ppg-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary)}',
			'.dsh-ppg-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}',
			'.dsh-ppg-btn{font:inherit;font-size:13px;line-height:20px;padding:6px 14px;border-radius:8px;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}',
			'.dsh-ppg-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
			'.dsh-ppg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
			'.dsh-ppg-btn[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
		].join('');

		const SETTINGS_CSS = [
			'.dsh-ppg-page{display:flex;flex-direction:column;max-width:720px}',
			'.dsh-ppg-page-title{margin:0;font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.dsh-ppg-page-desc{margin:4px 0 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
			'.dsh-ppg-alert{margin:8px 0;padding:8px 10px;border:0.5px solid var(--dsw-alias-state-error-primary);border-radius:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
			'.dsh-ppg-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l1)}',
			'.dsh-ppg-row:first-of-type{border-top:none}',
			'.dsh-ppg-row-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
			'.dsh-ppg-row-title{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
			'.dsh-ppg-row-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
			'.dsh-ppg-row-control{display:flex;align-items:center;gap:8px;flex:none}',
			'.dsh-ppg-input{box-sizing:border-box;width:250px;font:inherit;font-size:13px;line-height:20px;padding:5px 8px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
			'.dsh-ppg-input[data-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}',
			'.dsh-ppg-input[data-size="short"]{width:84px}',
			'.dsh-ppg-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
			'.dsh-ppg-hint-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:6px}',
			'.dsh-ppg-hint[data-tone="error"]{color:var(--dsw-alias-state-warn-primary)}',
			'.dsh-ppg-btn[disabled]{opacity:.55;cursor:default}',
			'.dsh-ppg-hint[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
			'.dsh-ppg-switch{position:relative;width:34px;height:20px;padding:0;border:none;border-radius:999px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);transition:background .15s}',
			'.dsh-ppg-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
			'.dsh-ppg-switch[data-on="true"]{background:var(--dsw-alias-brand-primary)}',
			'.dsh-ppg-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-overlay);transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
			'.dsh-ppg-switch[data-on="true"] .dsh-ppg-knob{transform:translateX(14px)}',
			'.dsh-ppg-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l1)}',
			'.dsh-ppg-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
		].join('');

		/** Mount a frame-level node on `document.body`, escaping every clipping ancestor. */
		function portal(node) {
			if (createPortal === null) return node;
			if (typeof document === 'undefined' || document.body === null || document.body === undefined) return node;
			return createPortal(node, document.body);
		}

		/** Inject component-local styles as a React element, so unmounting removes them. */
		function styleTag(css) {
			return h('style', { 'data-dsh-peak-price-guard': '' }, css);
		}

		/** A switch that follows the host's `role="switch"` + `aria-checked` contract. */
		function Toggle(props) {
			return h('button', {
				type: 'button',
				role: 'switch',
				'aria-checked': props.checked ? 'true' : 'false',
				'aria-label': props.label,
				className: 'dsh-ppg-switch',
				'data-on': props.checked ? 'true' : 'false',
				onClick: () => {
					props.onChange(!props.checked);
				},
			}, h('span', { className: 'dsh-ppg-knob', 'aria-hidden': 'true' }));
		}

		/** One settings line: copy on the left, control on the right. */
		function Row(props) {
			return h('div', { className: 'dsh-ppg-row' },
				h('div', { className: 'dsh-ppg-row-text' },
					h('div', { className: 'dsh-ppg-row-title' }, props.title),
					props.description === undefined ? null : h('div', { className: 'dsh-ppg-row-desc' }, props.description)),
				h('div', { className: 'dsh-ppg-row-control' }, props.children));
		}

		/**
		 * Ambient composer pill: which price tier the next send bills at, plus a
		 * hover/focus tip that spells out what the pill means. Red when the gate
		 * could not be installed, so a Harness update that renames the sink is
		 * visible instead of silent.
		 * @param {{ t: Function }} props - localized copy from the slot.
		 */
		function PriceBadge(props) {
			const t = props.t;
			const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getSnapshot);
			const clock = useSyncExternalStore(clockStore.subscribe, clockStore.getSnapshot, clockStore.getSnapshot);
			const gateState = useSyncExternalStore(gateStore.subscribe, gateStore.getSnapshot, gateStore.getSnapshot);
			const queue = useSyncExternalStore(queueStore.subscribe, queueStore.getSnapshot, queueStore.getSnapshot);
			// Subscribed for its effect only: when the holiday feed lands, the tip's
			// "next peak window" must be recomputed against the new table.
			useSyncExternalStore(calendarStore.subscribe, calendarStore.getSnapshot, calendarStore.getSnapshot);
			const [anchor, setAnchor] = React.useState(null);
			if (settings.config.showBadge !== true) return null;
			const pending = queue.length > 0;
			const state = gateState.active === false ? 'broken' : pending ? 'pending' : clock.peak ? 'peak' : 'offpeak';
			const label = state === 'broken' ? t('badge.broken.label')
				: state === 'pending' ? t('badge.pending.label')
					: state === 'peak' ? t('badge.peak.label')
						: t('badge.offpeak.label');
			const value = state === 'broken' ? t('badge.broken.value')
				: state === 'pending' ? ''
					: state === 'peak' ? t('badge.peak.value')
						: t('badge.offpeak.value');
			const lines = [];
			if (state === 'broken') {
				lines.push(t('tip.broken.line1'), t('tip.broken.line2'));
			} else if (state === 'pending') {
				lines.push(t('tip.pending.line1'), t('tip.pending.line2'));
			} else if (state === 'peak') {
				lines.push(t('tip.peak.line1'), t('tip.peak.line2'));
				lines.push(t('tip.peak.next', { when: whenLabel(offPeakStart(clock.now, settings.rule), t) }));
				lines.push('', t('tip.where', { section: t('settings.title') }));
			} else {
				lines.push(t('tip.offpeak.line1'));
				const next = nextPeakStart(clock.now, settings.rule);
				if (next !== undefined) lines.push(t('tip.offpeak.next', { when: whenLabel(next, t) }));
				lines.push('', t('tip.where', { section: t('settings.title') }));
			}
			const tipText = lines.join('\n');
			const showTip = (event) => {
				const rect = event.currentTarget.getBoundingClientRect();
				const half = Math.min(160, Math.max(80, (window.innerWidth - 16) / 2));
				setAnchor({
					x: Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8),
					y: rect.top,
				});
			};
			const hideTip = () => setAnchor(null);
			const tip = anchor === null
				? null
				: h('span', {
						className: 'dsh-ppg-tip',
						role: 'tooltip',
						style: { left: `${anchor.x}px`, top: `${anchor.y}px`, transform: 'translate(-50%, calc(-100% - 8px))' },
				  }, tipText);
			return h('span', {
				className: 'dsh-ppg-badge',
				'data-state': state,
				role: 'status',
				tabIndex: 0,
				'aria-label': tipText,
				onMouseEnter: showTip,
				onMouseLeave: hideTip,
				onFocus: showTip,
				onBlur: hideTip,
			},
				styleTag(BADGE_CSS),
				h('span', { className: 'dsh-ppg-badge-dot', 'aria-hidden': 'true' }),
				h('span', { className: 'dsh-ppg-badge-label' }, label),
				value === '' ? null : h('span', { className: 'dsh-ppg-badge-value' }, value),
				tip === null ? null : portal(tip));
		}

		/**
		 * Where Tab should go inside the dialog.
		 * Returns `undefined` when the browser's own tab order is already right,
		 * so the handler only intervenes at the wrap-around points.
		 * @param {object} root - the panel element.
		 * @param {object | null} active - `document.activeElement`.
		 * @param {boolean} backwards - Shift+Tab.
		 */
		function nextFocusTarget(root, active, backwards) {
			if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return undefined;
			const items = [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
				.filter((item) => item.disabled !== true);
			if (items.length === 0) return undefined;
			const first = items[0];
			const last = items[items.length - 1];
			const inside = active !== null && active !== undefined && (typeof root.contains !== 'function' || root.contains(active));
			if (backwards) return active === first || !inside ? last : undefined;
			return active === last || !inside ? first : undefined;
		}

		/**
		 * The reminder dialog: nothing while no send waits for an answer,
		 * otherwise the oldest pending send.
		 * @param {object} props - slot props, including the `useSessions` hook.
		 */
		function ConfirmDialog(props) {
			const queue = useSyncExternalStore(queueStore.subscribe, queueStore.getSnapshot, queueStore.getSnapshot);
			const request = queue[0];
			// Every hook runs before the early return, and the session lookup below is
			// unconditional: a hook that appears only once a request exists changes the
			// hook count between renders, which makes React throw and blanks the entry.
			const useSessions = props.useSessions === undefined ? NO_SESSIONS : props.useSessions;
			const sessionId = request === undefined ? undefined : request.sessionId;
			const title = useSessions((state) => (sessionId === undefined ? undefined : state?.byId?.[sessionId]?.title));
			if (request === undefined) return null;
			const card = h(ConfirmCard, { key: request.id, request, title, t: props.t, focusComposer: props.focusComposer });
			return portal(card);
		}

		/**
		 * One pending send's dialog; its local state dies with it.
		 * @param {{ request: object, title: string | undefined, t: Function, focusComposer: Function }} props
		 */
		function ConfirmCard(props) {
			const { request, title, t, focusComposer } = props;
			const [mute, setMute] = React.useState(false);
			const cancelRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const onPanelKeyDown = (event) => {
				if (event.key !== 'Tab') return;
				const target = nextFocusTarget(panelRef.current, document.activeElement, event.shiftKey === true);
				if (target === undefined) return;
				event.preventDefault();
				if (typeof target.focus === 'function') target.focus();
			};
			const settle = React.useCallback((approved, options) => {
				request.settle(approved, options);
				if (!approved && typeof focusComposer === 'function') focusComposer(request.sessionId);
			}, [request, focusComposer]);
			React.useEffect(() => {
				if (cancelRef.current !== null) cancelRef.current.focus();
			}, []);
			React.useEffect(() => {
				const onKeyDown = (event) => {
					if (event.key !== 'Escape') return;
					event.preventDefault();
					settle(false);
				};
				document.addEventListener('keydown', onKeyDown, true);
				return () => {
					document.removeEventListener('keydown', onKeyDown, true);
				};
			}, [settle]);
			const now = beijingParts(Date.now());
			const { rule } = settingsStore.getSnapshot();
			const peakNow = isPeak(Date.now(), rule);
			const next = offPeakStart(Date.now(), rule);
			const preview = request.text.trim();
			const muteMinutes = request.muteMinutes;
			return h('div', { className: 'dsh-ppg-overlay' },
				styleTag(DIALOG_CSS),
				h('div', { className: 'dsh-ppg-mask', onClick: () => settle(false) }),
				h('div', {
					className: 'dsh-ppg-panel',
					ref: panelRef,
					role: 'dialog',
					'aria-modal': 'true',
					'aria-labelledby': 'dsh-ppg-title',
					'aria-describedby': 'dsh-ppg-desc',
					onKeyDown: onPanelKeyDown,
				},
					h('h2', { className: 'dsh-ppg-title', id: 'dsh-ppg-title' }, t('dialog.title')),
					title === undefined || title === '' ? null : h('p', { className: 'dsh-ppg-session' }, t('dialog.session', { title })),
					h('p', { className: 'dsh-ppg-desc', id: 'dsh-ppg-desc' }, t('dialog.desc', { time: clockLabel(now) })),
					peakNow ? h('p', { className: 'dsh-ppg-desc' }, t('dialog.next', { when: whenLabel(next, t) })) : null,
					preview === '' ? null : h('div', null,
						h('p', { className: 'dsh-ppg-preview-label' }, t('dialog.preview')),
						h('p', { className: 'dsh-ppg-preview' }, preview.length > 400 ? `${preview.slice(0, 400)}…` : preview)),
					muteMinutes > 0 && request.sessionId !== undefined
						? h('label', { className: 'dsh-ppg-check' },
								h('input', {
									type: 'checkbox',
									checked: mute,
									onChange: (event) => setMute(event.target.checked === true),
								}),
								h('span', null, t('dialog.mute', { minutes: muteMinutes })))
						: null,
					h('div', { className: 'dsh-ppg-actions' },
						h('button', { type: 'button', ref: cancelRef, className: 'dsh-ppg-btn', onClick: () => settle(false) }, t('dialog.cancel')),
						h('button', {
							type: 'button',
							className: 'dsh-ppg-btn',
							'data-tone': 'warn',
							onClick: () => settle(true, { mute }),
						}, t('dialog.confirm')))));
		}

		/**
		 * Settings → 高峰价格提醒: the preference page for the guard.
		 * @param {{ t: Function }} props - localized copy from the slot.
		 */
		function SettingsPage(props) {
			const t = props.t;
			const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getSnapshot);
			const clock = useSyncExternalStore(clockStore.subscribe, clockStore.getSnapshot, clockStore.getSnapshot);
			const gateState = useSyncExternalStore(gateStore.subscribe, gateStore.getSnapshot, gateStore.getSnapshot);
			const calendar = useSyncExternalStore(calendarStore.subscribe, calendarStore.getSnapshot, calendarStore.getSnapshot);
			const config = settings.config;
			const [windowsDraft, setWindowsDraft] = React.useState(config.windows);
			const [muteDraft, setMuteDraft] = React.useState(String(config.muteMinutes));
			React.useEffect(() => {
				setWindowsDraft(config.windows);
			}, [config.windows]);
			React.useEffect(() => {
				setMuteDraft(String(config.muteMinutes));
			}, [config.muteMinutes]);
			const windowsValid = parseWindows(windowsDraft) !== null;
			const onWindowsChange = (value) => {
				setWindowsDraft(value);
				if (parseWindows(value) !== null) updateConfig({ windows: value });
			};
			const onMuteChange = (value) => {
				setMuteDraft(value);
				if (value.trim() === '') return;
				const minutes = Number(value);
				if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) updateConfig({ muteMinutes: minutes });
			};
			const statusText = config.enabled !== true
				? t('settings.status.off')
				: clock.peak
					? t('settings.status.peak', { when: whenLabel(offPeakStart(clock.now, settings.rule), t) })
					: t('settings.status.offpeak');
			return h('div', { className: 'dsh-ppg-page' },
				styleTag(SETTINGS_CSS),
				h('h2', { className: 'dsh-ppg-page-title' }, t('settings.title')),
				h('p', { className: 'dsh-ppg-page-desc' }, t('settings.desc')),
				gateState.active === false
					? h('div', { className: 'dsh-ppg-alert', role: 'alert' }, t('settings.gateBroken'))
					: null,
				h(Row, { title: t('settings.enabled.label'), description: t('settings.enabled.desc') },
					h(Toggle, {
						checked: config.enabled === true,
						label: t('settings.enabled.label'),
						onChange: (next) => updateConfig({ enabled: next }),
					})),
				h(Row, { title: t('settings.windows.label'), description: t('settings.windows.desc') },
					h('input', {
						className: 'dsh-ppg-input',
						type: 'text',
						value: windowsDraft,
						spellCheck: false,
						autoComplete: 'off',
						'data-invalid': windowsValid ? 'false' : 'true',
						'aria-label': t('settings.windows.label'),
						onChange: (event) => onWindowsChange(event.target.value),
					})),
				h('p', { className: 'dsh-ppg-hint', 'data-tone': windowsValid ? undefined : 'error' },
					windowsValid ? t('settings.windows.hint') : t('settings.windows.invalid')),
				h(Row, { title: t('settings.holidays.label'), description: t('settings.holidays.desc') },
					h(Toggle, {
						checked: config.holidaysOffPeak === true,
						label: t('settings.holidays.label'),
						onChange: (next) => updateConfig({ holidaysOffPeak: next }),
					})),
				h('div', { className: 'dsh-ppg-hint-row' },
					h('span', { className: 'dsh-ppg-hint', 'data-tone': calendar.error === null ? undefined : 'error' },
						holidayStatusText(calendar, t)),
					h('button', {
						type: 'button',
						className: 'dsh-ppg-btn',
						disabled: calendar.busy,
						onClick: () => {
							void refreshHolidays();
						},
					}, calendar.busy ? t('settings.holidays.refreshing') : t('settings.holidays.refresh'))),
				h(Row, { title: t('settings.mute.label'), description: t('settings.mute.desc') },
					h('input', {
						className: 'dsh-ppg-input',
						'data-size': 'short',
						type: 'number',
						min: 0,
						max: 1440,
						step: 5,
						value: muteDraft,
						'aria-label': t('settings.mute.label'),
						onChange: (event) => onMuteChange(event.target.value),
					})),
				h(Row, { title: t('settings.badge.label'), description: t('settings.badge.desc') },
					h(Toggle, {
						checked: config.showBadge === true,
						label: t('settings.badge.label'),
						onChange: (next) => updateConfig({ showBadge: next }),
					})),
				h('div', { className: 'dsh-ppg-footer' },
					h('span', { className: 'dsh-ppg-status', role: 'status' }, statusText),
					h('button', {
						type: 'button',
						className: 'dsh-ppg-btn',
						onClick: () => {
							updateConfig({ ...DEFAULT_CONFIG });
						},
					}, t('settings.reset'))));
		}
		// #endregion

		// #region dictionaries
		const zh = {
			'badge.peak.label': '高峰时段',
			'badge.peak.value': '标准价',
			'badge.offpeak.label': '特价时段',
			'badge.offpeak.value': '优惠价',
			'badge.pending.label': '等待确认',
			'badge.broken.label': '提醒',
			'badge.broken.value': '未生效',
			'tip.peak.line1': '现在是 DeepSeek 高峰时段，本会话按标准价计费。',
			'tip.peak.line2': '每次发送前都会先弹确认，确认后才真正发出。',
			'tip.peak.next': '{when} 起恢复特价（优惠价）。',
			'tip.offpeak.line1': '现在是 DeepSeek 特价时段，发送按优惠价计费，不会弹确认。',
			'tip.offpeak.next': '下一个高峰时段：{when}。',
			'tip.pending.line1': '已拦下一条消息，正在等你确认。',
			'tip.pending.line2': '在确认提示里选「仍要发送」才会发出，选「先不发」则消息退回输入框。',
			'tip.broken.line1': '发送闸门未生效：Harness 的发送接口可能已变更，高峰时段不会弹确认。',
			'tip.broken.line2': '请更新这个插件，或到设置页查看详情。',
			'tip.where': '可以在「设置 → {section}」里调整时段、静音和这个提示。',
			'dialog.title': '非特价时段提醒',
			'dialog.session': '会话：{title}',
			'dialog.desc': '现在是北京时间 {time}，属于高峰时段，这条消息会按标准价格计费。',
			'dialog.next': '{when} 起恢复特价。',
			'dialog.preview': '即将发送',
			'dialog.mute': '本次会话 {minutes} 分钟内不再提醒',
			'dialog.cancel': '先不发',
			'dialog.confirm': '仍要发送',
			'when.today': '今天 {time}',
			'when.tomorrow': '明天 {time}',
			'when.later': '{date} {time}',
			'settings.title': '高峰价格提醒',
			'settings.desc': '非特价（高峰）时段发送消息前先提醒，只有你确认后才会真正发出。时段与开关保存在本机浏览器。',
			'settings.gateBroken': '发送闸门未生效：Harness 的发送接口可能已变更，提醒不会出现。请更新本插件。',
			'settings.enabled.label': '启用提醒',
			'settings.enabled.desc': '关闭后任何时段都直接发送，不再弹确认框。',
			'settings.windows.label': '高峰时段',
			'settings.windows.desc': '北京时间，仅工作日生效；格式 09:00-12:00，逗号分隔多段。',
			'settings.windows.hint': '留空表示从不提醒；自测可填 00:00-24:00。',
			'settings.windows.invalid': '格式无法识别，暂时沿用上一组时段。',
			'settings.holidays.label': '法定节假日按特价',
			'settings.holidays.desc': '中国法定节假日全天按特价计费，不提醒。',
			'settings.holidays.synced': '节假日数据：已同步 {years} 年（{time} 更新）。',
			'settings.holidays.cached': '节假日数据：本地缓存 {years} 年，正在后台更新。',
			'settings.holidays.retry': '上次更新失败，稍后自动重试。',
			'settings.holidays.refresh': '立即更新',
			'settings.holidays.refreshing': '更新中…',
			'settings.holidays.builtin': '节假日数据：使用内置表（2025–2026），联网后自动更新。',
			'settings.mute.label': '会话静默时长（分钟）',
			'settings.mute.desc': '确认框里“本次会话不再提醒”的有效期；填 0 则不提供该选项。',
			'settings.badge.label': '显示价格档位提示',
			'settings.badge.desc': '输入框下方显示「高峰时段 标准价」（红）/「特价时段 优惠价」（绿），悬停或聚焦可看说明。',
			'settings.reset': '恢复默认',
			'settings.status.off': '提醒已关闭',
			'settings.status.peak': '当前为高峰时段（标准价），{when} 恢复特价。',
			'settings.status.offpeak': '当前为特价时段（优惠价），发送无需确认。',
		};
		const en = {
			'badge.peak.label': 'Peak',
			'badge.peak.value': 'standard price',
			'badge.offpeak.label': 'Off-peak',
			'badge.offpeak.value': 'discounted price',
			'badge.pending.label': 'Waiting',
			'badge.broken.label': 'Guard',
			'badge.broken.value': 'inactive',
			'tip.peak.line1': 'DeepSeek peak hours: this session bills at the standard price.',
			'tip.peak.line2': 'Every send asks first and goes out only after you approve it.',
			'tip.peak.next': 'Off-peak (discounted) pricing resumes {when}.',
			'tip.offpeak.line1': 'Off-peak hours: sends bill at the discounted price and ask nothing.',
			'tip.offpeak.next': 'Next peak window: {when}.',
			'tip.pending.line1': 'One message is held, waiting for your answer.',
			'tip.pending.line2': 'It goes out only if you pick "Send anyway"; "Don\'t send" returns it to the composer.',
			'tip.broken.line1': 'The send gate is inactive: the Harness send entry point may have changed, so peak-hour sends will not ask.',
			'tip.broken.line2': 'Please update this plugin, or check the settings page.',
			'tip.where': 'Adjust the windows, the silence window and this pill in Settings → {section}.',
			'dialog.title': 'Not a discounted period',
			'dialog.session': 'Session: {title}',
			'dialog.desc': 'It is {time} Beijing time — a peak window, so this message bills at the standard price.',
			'dialog.next': 'Off-peak pricing resumes {when}.',
			'dialog.preview': 'About to send',
			'dialog.mute': "Don't ask again in this session for {minutes} minutes",
			'dialog.cancel': "Don't send",
			'dialog.confirm': 'Send anyway',
			'when.today': 'today at {time}',
			'when.tomorrow': 'tomorrow at {time}',
			'when.later': '{date} at {time}',
			'settings.title': 'Peak-price guard',
			'settings.desc': 'Asks before sending during DeepSeek peak (non-discount) hours; a message leaves only after you confirm. Times and switches are stored in this browser.',
			'settings.gateBroken': 'The send gate is inactive: the Harness send entry point may have changed, so the reminder will not appear. Please update this plugin.',
			'settings.enabled.label': 'Ask before sending',
			'settings.enabled.desc': 'When off, messages are sent immediately at any hour.',
			'settings.windows.label': 'Peak windows',
			'settings.windows.desc': 'Beijing time, weekdays only; format 09:00-12:00, comma separated.',
			'settings.windows.hint': 'Empty means never ask; use 00:00-24:00 to test the reminder.',
			'settings.windows.invalid': 'Unrecognized format — the previous windows stay in effect.',
			'settings.holidays.label': 'Chinese holidays bill off-peak',
			'settings.holidays.desc': 'Public holidays are off-peak all day and never ask.',
			'settings.holidays.synced': 'Holiday data: synced for {years} (updated {time}).',
			'settings.holidays.cached': 'Holiday data: cached for {years}; refreshing in the background.',
			'settings.holidays.retry': ' The last refresh failed; retrying automatically.',
			'settings.holidays.refresh': 'Refresh now',
			'settings.holidays.refreshing': 'Refreshing…',
			'settings.holidays.builtin': 'Holiday data: built-in table (2025–2026); it refreshes automatically when online.',
			'settings.mute.label': 'Session silence (minutes)',
			'settings.mute.desc': 'How long "don\'t ask again in this session" lasts; 0 hides that option.',
			'settings.badge.label': 'Show the price-tier pill',
			'settings.badge.desc': 'Shows a red “Peak · standard price” or a green “Off-peak · discounted” pill under the composer; hover or focus for details.',
			'settings.reset': 'Reset to defaults',
			'settings.status.off': 'Reminders are off',
			'settings.status.peak': 'Peak hours now (standard price); off-peak resumes {when}.',
			'settings.status.offpeak': 'Off-peak now (discounted price); sending needs no confirmation.',
		};
		// #endregion

		/** Required services: the slot registry, the locale registry, sessions, and the conversation service. */
		const inject = ['slots', 'locale', 'sessions', 'conversation'];

		/**
		 * Client plugin body: preferences, the price dot, the reminder dialog, the
		 * settings page, and the composer send gate.
		 * @param ctx - the Client root context.
		 */
		function apply(ctx) {
			// A fresh mount starts with no pending dialog and no session-silence
			// windows: both are live state, never carried across a reload.
			queueStore.set([]);
			silence.clear();
			const config = readStoredConfig();
			settingsStore.set({ config, rule: buildRule(config) });
			// The cached holiday table lands before the first paint, so a launch
			// without a network still shows the right tier.
			readHolidayCache();
			refreshClock();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'peak-price-guard: dictionaries');
			ctx.effect(() => {
				refreshClock();
				const timer = setInterval(refreshClock, 20_000);
				return () => clearInterval(timer);
			}, 'peak-price-guard: price clock');
			ctx.effect(() => {
				let timer;
				let disposed = false;
				const tick = async () => {
					await refreshHolidays();
					if (disposed) return;
					// A failed refresh retries soon; a good one waits half a day.
					const delay = calendarStore.getSnapshot().error === null ? HOLIDAY_REFRESH_INTERVAL : HOLIDAY_RETRY_DELAY;
					timer = setTimeout(tick, delay);
				};
				void tick();
				return () => {
					disposed = true;
					clearTimeout(timer);
				};
			}, 'peak-price-guard: holiday feed');
			/** Return focus to a session's composer after a cancelled send. */
			const focusComposer = (sessionId) => {
				if (sessionId === undefined) return;
				try {
					const scope = ctx.sessions.scope(sessionId);
					const conversation = scope === undefined ? undefined : scope.get('conversation');
					if (conversation !== undefined) conversation.input.for(scope).focus();
				} catch (_error) {
					/* the session may be gone; focus is a courtesy */
				}
			};
			ctx.slots.inject('conversation.composer.dock', () =>
				ctx.slots.register({ name: 'conversation.composer.dock', id: 'peak-price-guard.status', order: 60, locale: NS }, PriceBadge));
			ctx.slots.inject('shell.overlay', () =>
				ctx.slots.register({ name: 'shell.overlay', id: 'peak-price-guard.confirm', order: 60, locale: NS, inject: () => ({ focusComposer }) }, ConfirmDialog));
			ctx.slots.inject('settings.section', () =>
				ctx.slots.register({ name: 'settings.section', id: 'peak-price-guard', order: 30, label: () => ctx.locale.bind(NS)('settings.title'), locale: NS }, SettingsPage));
			const service = ctx.get('conversation');
			if (service !== undefined) installGate(ctx, service);
		}

		return {
			inject,
			apply,
			// Exposed for the Node-side behaviour check in `test/peak.test.mjs`.
			__test: {
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
				nextFocusTarget,
				refreshHolidays,
				readHolidayCache,
				calendarStore,
				holidayYears,
				queueStore,
				settingsStore,
				clockStore,
				gateStore,
				silence,
				updateConfig,
			},
		};
	},
});
