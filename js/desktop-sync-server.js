// DesktopSyncServer — Electron-side LAN sync server for the iOS Focus Companion.
//
// This module is intentionally free of Electron imports so its pure logic
// (one-time pairing-token validation and distractionBatch ack id-mirroring)
// can be unit-/property-tested with node:test without booting Electron
// (see task 8.4 / Property 8: "Ack mirrors batch ids").
//
// Responsibilities (design: Algorithm DesktopSyncServer):
//   - Start a WebSocket server (ws) on a chosen port.
//   - Advertise a `_focusflow._tcp` Bonjour service carrying deviceId/fingerprint
//     TXT records (bonjour-service).
//   - Accept a single paired phone socket.
//   - Handle inbound `pairRequest` and `distractionBatch` messages.
//
// Session-lifecycle emission (sessionStarted/sessionStopped) is deliberately
// NOT wired here — that is task 8.3.

const crypto = require('crypto');
const os = require('os');

// ---------------------------------------------------------------------------
// Pure logic (no I/O) — exported for unit/property tests
// ---------------------------------------------------------------------------

/**
 * Pick the best LAN IPv4 host for the pairing payload from a set of network
 * interfaces (as returned by os.networkInterfaces()). Keeping this pure — the
 * interfaces are passed in — makes host selection unit-testable without
 * depending on the machine's real network configuration.
 *
 * Selection rules (in order):
 *   - only IPv4 addresses that are not internal (loopback) are considered;
 *   - private LAN ranges (192.168/16, 10/8, 172.16–31) are preferred so we
 *     advertise a reachable local address rather than, say, a VPN or public IP;
 *   - if no private address is found, the first non-internal IPv4 is used;
 *   - if nothing qualifies, falls back to '127.0.0.1' (still returns a usable
 *     payload — the phone can override via manual host:port entry).
 *
 * @param {object} [interfaces] - shape of os.networkInterfaces()
 * @returns {string} an IPv4 host string
 */
function pickLanHost(interfaces) {
    const ifaces = interfaces || {};
    const candidates = [];

    for (const name of Object.keys(ifaces)) {
        const addrs = ifaces[name];
        if (!Array.isArray(addrs)) continue;
        for (const addr of addrs) {
            if (!addr) continue;
            // Node >=18 reports family as the number 4; older/string form is 'IPv4'.
            const isIPv4 = addr.family === 'IPv4' || addr.family === 4;
            if (!isIPv4) continue;
            if (addr.internal) continue;
            if (typeof addr.address !== 'string' || addr.address.length === 0) continue;
            candidates.push(addr.address);
        }
    }

    const isPrivate = (ip) => {
        if (ip.startsWith('192.168.')) return true;
        if (ip.startsWith('10.')) return true;
        const m = /^172\.(\d+)\./.exec(ip);
        if (m) {
            const second = Number(m[1]);
            return second >= 16 && second <= 31;
        }
        return false;
    };

    const priv = candidates.find(isPrivate);
    if (priv) return priv;
    if (candidates.length > 0) return candidates[0];
    return '127.0.0.1';
}

/**
 * Resolve the LAN host using the live OS network interfaces. Thin wrapper over
 * pickLanHost so callers don't have to touch `os` directly.
 * @returns {string}
 */
function getLanHost() {
    return pickLanHost(os.networkInterfaces());
}

/**
 * Build the pairing payload embedded in the QR code. Pure function so it can
 * be unit-tested (Property 9: pairing QR round trip — all required fields
 * present). Missing/invalid inputs are coerced so the result is always a
 * complete, well-shaped payload.
 *
 * @param {object} args
 * @param {string} args.host
 * @param {number} args.port
 * @param {string} args.deviceId
 * @param {string} args.pairingToken
 * @param {string} args.fingerprint
 * @returns {{host: string, port: number, deviceId: string, pairingToken: string, fingerprint: string}}
 */
function buildPairingPayload({ host, port, deviceId, pairingToken, fingerprint } = {}) {
    return {
        host: typeof host === 'string' && host.length > 0 ? host : '127.0.0.1',
        port: Number.isInteger(port) ? port : 0,
        deviceId: typeof deviceId === 'string' ? deviceId : '',
        pairingToken: typeof pairingToken === 'string' ? pairingToken : '',
        fingerprint: typeof fingerprint === 'string' ? fingerprint : ''
    };
}

/**
 * Validate a one-time pairing token against the currently-issued token.
 * A token is valid only when it is a non-empty string that matches the
 * expected token exactly. Once consumed, the caller should clear the
 * expected token so it cannot be reused.
 *
 * @param {string} received - token supplied by the phone in pairRequest
 * @param {string|null|undefined} expected - the current one-time token
 * @returns {boolean}
 */
function isValidPairingToken(received, expected) {
    if (typeof received !== 'string' || received.length === 0) return false;
    if (typeof expected !== 'string' || expected.length === 0) return false;
    // Constant-time comparison to avoid leaking token length/content by timing.
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Extract the exact set of event ids from a distractionBatch, preserving
 * order. The returned array mirrors `msg.events.map(e => e.id)` — this is the
 * contract the ack must satisfy (Property 8: ack mirrors batch ids).
 *
 * @param {{ events?: Array<{id: any}> }} msg
 * @returns {Array} the event ids in batch order
 */
function batchEventIds(msg) {
    if (!msg || !Array.isArray(msg.events)) return [];
    return msg.events.map(e => (e ? e.id : undefined));
}

/**
 * Build the ack message the desktop returns for a received distractionBatch.
 * The ack contains exactly the event ids present in the batch.
 *
 * @param {object} msg - the received distractionBatch
 * @returns {{ type: 'ack', eventIds: Array }}
 */
function buildAck(msg) {
    return { type: 'ack', eventIds: batchEventIds(msg) };
}

/**
 * Build a `sessionStarted` wire message for the paired phone from the session
 * info the renderer supplies when a work timer starts.
 *
 * Wire format (design "Wire format (desktop -> phone)"):
 *   { type, sessionId, dateKey, mode, startedAt, plannedDuration }
 *
 * Pure function (no I/O) so it stays unit-testable. Missing/invalid fields are
 * normalized: `startedAt` defaults to now (ISO), `plannedDuration` coerces to a
 * non-negative integer, and `mode` falls back to "work".
 *
 * @param {object} [info]
 * @param {string} [info.sessionId]
 * @param {string} [info.dateKey]      - "YYYY-MM-DD"
 * @param {string} [info.mode]         - "work" | "shortBreak" | "longBreak"
 * @param {string|number|Date} [info.startedAt]
 * @param {number} [info.plannedDuration] - seconds
 * @returns {{ type: 'sessionStarted', sessionId: string, dateKey: string, mode: string, startedAt: string, plannedDuration: number }}
 */
function buildSessionStarted(info = {}) {
    const startedAt = toIsoString(info.startedAt);
    let plannedDuration = Number(info.plannedDuration);
    if (!Number.isFinite(plannedDuration) || plannedDuration < 0) {
        plannedDuration = 0;
    }
    plannedDuration = Math.round(plannedDuration);
    return {
        type: 'sessionStarted',
        sessionId: typeof info.sessionId === 'string' ? info.sessionId : '',
        dateKey: typeof info.dateKey === 'string' ? info.dateKey : '',
        mode: typeof info.mode === 'string' && info.mode.length > 0 ? info.mode : 'work',
        startedAt,
        plannedDuration
    };
}

/**
 * Build a `sessionStopped` wire message for the paired phone.
 *
 * Wire format: { type, sessionId, reason }
 *
 * @param {object} [info]
 * @param {string} [info.sessionId]
 * @param {string} [info.reason] - defaults to "stopped"
 * @returns {{ type: 'sessionStopped', sessionId: string, reason: string }}
 */
function buildSessionStopped(info = {}) {
    return {
        type: 'sessionStopped',
        sessionId: typeof info.sessionId === 'string' ? info.sessionId : '',
        reason: typeof info.reason === 'string' && info.reason.length > 0 ? info.reason : 'stopped'
    };
}

/** Normalize a Date/number/ISO-string into an ISO-8601 string; defaults to now. */
function toIsoString(value) {
    if (value instanceof Date && !isNaN(value.getTime())) {
        return value.toISOString();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value).toISOString();
    }
    if (typeof value === 'string' && value.length > 0) {
        const d = new Date(value);
        if (!isNaN(d.getTime())) return d.toISOString();
    }
    return new Date().toISOString();
}

/** Generate a fresh, short one-time pairing token. */
function generatePairingToken() {
    return crypto.randomBytes(16).toString('hex');
}

/** Generate a durable session key handed to a paired phone. */
function generateSessionKey() {
    return crypto.randomBytes(32).toString('hex');
}

/** Generate a stable per-install device id (hex). */
function generateDeviceId() {
    return crypto.randomBytes(8).toString('hex');
}

/** Generate a desktop fingerprint the phone can verify against the QR payload. */
function generateFingerprint() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Decide how to respond to an inbound message. Pure function: given the
 * message and the current server identity/state, return the reply object(s)
 * and any state transition the caller should apply. Keeping this pure makes
 * the pair/ack branching directly testable.
 *
 * @param {object} msg - parsed inbound message
 * @param {object} ctx
 * @param {string} ctx.fingerprint - desktop fingerprint
 * @param {string|null} ctx.pairingToken - current one-time token (or null)
 * @returns {{
 *   reply?: object,
 *   forwardToRenderer?: object,
 *   pair?: boolean,
 *   sessionKey?: string,
 *   consumeToken?: boolean
 * }}
 */
function handleMessage(msg, ctx) {
    if (!msg || typeof msg.type !== 'string') {
        return {};
    }

    switch (msg.type) {
        case 'pairRequest': {
            if (isValidPairingToken(msg.pairingToken, ctx.pairingToken)) {
                const sessionKey = generateSessionKey();
                return {
                    reply: { type: 'pairAck', sessionKey, fingerprint: ctx.fingerprint },
                    pair: true,
                    sessionKey,
                    consumeToken: true
                };
            }
            return { reply: { type: 'pairError' } };
        }
        case 'distractionBatch': {
            return {
                reply: buildAck(msg),
                forwardToRenderer: msg
            };
        }
        default:
            return {};
    }
}

// ---------------------------------------------------------------------------
// DesktopSyncServer — thin I/O shell around the pure logic above
// ---------------------------------------------------------------------------

class DesktopSyncServer {
    /**
     * @param {object} [options]
     * @param {number} [options.port=0] - WS port; 0 lets the OS pick a free port.
     * @param {() => (object|null)} [options.getMainWindow] - returns the Electron
     *   BrowserWindow used to forward phone-distractions to the renderer.
     * @param {string} [options.deviceId]
     * @param {string} [options.fingerprint]
     */
    constructor(options = {}) {
        this.port = typeof options.port === 'number' ? options.port : 0;
        this.getMainWindow = options.getMainWindow || (() => null);
        this.deviceId = options.deviceId || generateDeviceId();
        this.fingerprint = options.fingerprint || generateFingerprint();

        this.pairingToken = null;   // set when a pairing QR is (re)generated
        this.sessionKey = null;     // set once a phone pairs successfully
        this.pairedSocket = null;   // the single accepted paired socket

        this.wss = null;
        this.bonjour = null;
        this.service = null;
        this.actualPort = null;
        this._listeningPromise = null;   // resolves once bound (see start())
        this._resolveListening = null;
    }

    /**
     * Resolve once the WebSocket server has bound and `actualPort` is known.
     * If the server is already listening (or was never started) this resolves
     * immediately with the current `actualPort`.
     * @returns {Promise<number|null>}
     */
    whenListening() {
        if (this.actualPort != null) return Promise.resolve(this.actualPort);
        if (this._listeningPromise) return this._listeningPromise;
        return Promise.resolve(this.actualPort);
    }

    /**
     * Issue (or re-issue) a fresh one-time pairing token, returning it so the
     * QR generator (task 9.2) can embed it in the pairing payload.
     */
    issuePairingToken() {
        this.pairingToken = generatePairingToken();
        return this.pairingToken;
    }

    /** Start the WebSocket server and publish the Bonjour service. */
    start() {
        const { WebSocketServer } = require('ws');

        this.wss = new WebSocketServer({ port: this.port });

        // Resolves once the server is bound and `actualPort` is known. QR
        // generation (task 9.2) awaits this so it never embeds a null port.
        this._listeningPromise = new Promise((resolve) => {
            this._resolveListening = resolve;
        });

        this.wss.on('connection', (socket) => this._onConnection(socket));
        this.wss.on('listening', () => {
            const addr = this.wss.address();
            this.actualPort = addr && typeof addr === 'object' ? addr.port : this.port;
            this._publishBonjour(this.actualPort);
            if (this._resolveListening) {
                this._resolveListening(this.actualPort);
                this._resolveListening = null;
            }
        });
        this.wss.on('error', (err) => {
            console.error('DesktopSyncServer WebSocket error:', err);
        });

        return this;
    }

    _publishBonjour(port) {
        try {
            const { Bonjour } = require('bonjour-service');
            this.bonjour = new Bonjour();
            this.service = this.bonjour.publish({
                name: 'Intention',
                type: 'focusflow',
                port,
                txt: { deviceId: this.deviceId, fingerprint: this.fingerprint }
            });
        } catch (e) {
            console.error('DesktopSyncServer Bonjour publish failed:', e);
        }
    }

    _onConnection(socket) {
        socket.on('message', (raw) => this._onSocketMessage(socket, raw));
        socket.on('close', () => {
            if (this.pairedSocket === socket) {
                this.pairedSocket = null;
            }
        });
        socket.on('error', (err) => {
            console.error('DesktopSyncServer socket error:', err);
        });
    }

    _onSocketMessage(socket, raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            return; // ignore malformed frames
        }

        const result = handleMessage(msg, {
            fingerprint: this.fingerprint,
            pairingToken: this.pairingToken
        });

        if (result.forwardToRenderer) {
            const win = this.getMainWindow();
            if (win && win.webContents && !(win.isDestroyed && win.isDestroyed())) {
                win.webContents.send('phone-distractions', result.forwardToRenderer);
            }
        }

        if (result.pair) {
            // Single-paired-socket policy: the latest successful pairing wins.
            this.pairedSocket = socket;
            this.sessionKey = result.sessionKey;
        }

        if (result.consumeToken) {
            // One-time token: clear so it cannot be replayed.
            this.pairingToken = null;
        }

        if (result.reply) {
            this._send(socket, result.reply);
        }
    }

    _send(socket, obj) {
        try {
            socket.send(JSON.stringify(obj));
        } catch (e) {
            console.error('DesktopSyncServer failed to send:', e);
        }
    }

    /**
     * Build a fresh pairing payload for QR generation (task 9.2). Issues a new
     * one-time pairing token (invalidating any previous one), resolves the LAN
     * host, and uses the server's actual listening port. If the server has not
     * finished binding yet, `actualPort` may be null; the caller should start
     * the server first, but a payload is still returned (port defaults to 0)
     * so the phone can fall back to manual host:port entry.
     *
     * @returns {{host: string, port: number, deviceId: string, pairingToken: string, fingerprint: string}}
     */
    buildPairingPayload() {
        const pairingToken = this.issuePairingToken();
        return buildPairingPayload({
            host: getLanHost(),
            port: this.actualPort,
            deviceId: this.deviceId,
            pairingToken,
            fingerprint: this.fingerprint
        });
    }

    /** Send an arbitrary message to the paired phone, if any (used by task 8.3). */
    sendToPaired(obj) {
        if (this.pairedSocket) {
            this._send(this.pairedSocket, obj);
            return true;
        }
        return false;
    }

    /** Tear down the WebSocket server and Bonjour advertisement. */
    stop() {
        if (this.service && typeof this.service.stop === 'function') {
            try { this.service.stop(); } catch (e) {}
        }
        if (this.bonjour) {
            try { this.bonjour.unpublishAll(); } catch (e) {}
            try { this.bonjour.destroy(); } catch (e) {}
            this.bonjour = null;
        }
        if (this.wss) {
            try { this.wss.close(); } catch (e) {}
            this.wss = null;
        }
        this.pairedSocket = null;
    }
}

module.exports = {
    DesktopSyncServer,
    // Pure logic exported for unit/property tests (task 8.4)
    isValidPairingToken,
    batchEventIds,
    buildAck,
    handleMessage,
    // Session lifecycle wire-message builders (task 8.3)
    buildSessionStarted,
    buildSessionStopped,
    generatePairingToken,
    generateSessionKey,
    generateDeviceId,
    generateFingerprint,
    // Pairing-payload/host-detection helpers exported for unit tests (task 9.2)
    pickLanHost,
    getLanHost,
    buildPairingPayload
};
