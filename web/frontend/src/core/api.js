// Single entry point for the JSON API.
//
// Every call site used to repeat the same four steps: fetch, check
// `response.ok`, parse the error body, then parse the payload. This module
// centralizes them so error messages come from the server (`detail`) and
// status handling stays explicit where it matters (404/409 flows use raw()).

/** Error carrying the HTTP status and the parsed error body. */
export class ApiError extends Error {
    constructor(message, { status = 0, body = null, path = '' } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
        this.path = path;
        // Server-side message, when the body carried one: callers that need a
        // localized fallback can use `error.detail || this.t('...')`.
        this.detail = body && typeof body === 'object' ? (body.detail || null) : null;
    }
}

function hasHeader(headers, name) {
    return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function buildRequestInit({ method = 'GET', json, body, headers, signal } = {}) {
    const init = { method, signal, headers: { ...(headers || {}) } };
    if (json !== undefined) {
        init.body = JSON.stringify(json);
        if (!hasHeader(init.headers, 'content-type')) {
            init.headers['Content-Type'] = 'application/json';
        }
    } else if (body !== undefined) {
        init.body = body;
    }
    return init;
}

async function errorFromResponse(response, path) {
    let body = null;
    try {
        const text = await response.clone().text();
        body = text ? JSON.parse(text) : null;
    } catch (_) {
        // Not JSON (proxy error page, empty body): keep the status message.
    }
    const fromBody = body && typeof body === 'object'
        ? (body.detail || body.error || body.message)
        : null;
    return new ApiError(fromBody || `HTTP ${response.status}`, {
        status: response.status,
        body,
        path,
    });
}

/**
 * Fetch wrapper that throws ApiError on non-2xx and leaves the body untouched.
 *
 * @param {string} path
 * @param {{ method?: string, json?: any, body?: BodyInit, headers?: Record<string,string>, signal?: AbortSignal }} [options]
 *   `json` serializes the payload and sets Content-Type; `body` passes a
 *   FormData/Blob through untouched (no Content-Type, the browser sets it).
 * @returns {Promise<Response>}
 */
export async function request(path, { method = 'GET', json, body, headers, signal } = {}) {
    const response = await fetch(path, buildRequestInit({ method, json, body, headers, signal }));
    if (!response.ok) {
        throw await errorFromResponse(response, path);
    }
    return response;
}

/** GET a JSON payload. Throws ApiError on non-2xx. */
export async function getJSON(path, options = {}) {
    const response = await request(path, { ...options, method: 'GET' });
    return response.json();
}

/** GET a text payload (theme CSS, exports). Throws ApiError on non-2xx. */
export async function getText(path, options = {}) {
    const response = await request(path, { ...options, method: 'GET' });
    return response.text();
}

/**
 * Send a payload and parse the JSON response.
 * `payload` may be a plain object (sent as JSON) or a FormData/Blob/string
 * (sent as-is).
 */
export async function sendJSON(path, method, payload, options = {}) {
    const isStructured = payload !== undefined
        && payload !== null
        && typeof payload === 'object'
        && !(payload instanceof FormData)
        && !(payload instanceof Blob)
        && !(payload instanceof ArrayBuffer);
    const response = isStructured
        ? await request(path, { ...options, method, json: payload })
        : await request(path, { ...options, method, body: payload });
    if (response.status === 204) return null;
    return response.json();
}

/** Send without parsing the response body (DELETE, fire-and-forget writes). */
export function send(path, method, payload, options = {}) {
    const isStructured = payload !== undefined
        && payload !== null
        && typeof payload === 'object'
        && !(payload instanceof FormData)
        && !(payload instanceof Blob)
        && !(payload instanceof ArrayBuffer);
    return isStructured
        ? request(path, { ...options, method, json: payload })
        : request(path, { ...options, method, body: payload });
}

/**
 * Raw fetch for flows that must inspect the status themselves
 * (404 redirects, 409 save conflicts, Content-Disposition downloads).
 * Never throws on non-2xx.
 */
export function raw(path, options = {}) {
    return fetch(path, buildRequestInit(options));
}
