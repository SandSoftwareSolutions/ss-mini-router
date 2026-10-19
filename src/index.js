import { createServer } from "node:http";

/** Throw this from a handler to answer with a status: `throw new HttpError(404, "No such user")`. The message is shown to the client, so keep secrets out of it. */
export class HttpError extends Error {
  constructor(status, message, { headers, details } = {}) {
    super(message ?? STATUS_TEXT[status] ?? "Error");
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
    this.details = details;
  }
}

const STATUS_TEXT = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error" };

function compilePattern(pattern) {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) throw new TypeError(`mini-router: a path must start with / (got ${JSON.stringify(pattern)})`);
  const segments = pattern.split("/").slice(1).filter((s, i, all) => s !== "" || i < all.length - 1);
  const names = new Set();
  const parts = segments.map((segment, index) => {
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!/^[A-Za-z_]\w*$/.test(name) || names.has(name)) throw new TypeError(`mini-router: bad or repeated parameter "${segment}" in ${pattern}`);
      names.add(name);
      return { type: "param", name };
    }
    if (segment.startsWith("*")) {
      const name = segment.slice(1) || "rest";
      if (index !== segments.length - 1 || names.has(name)) throw new TypeError(`mini-router: "${segment}" must be the last part of ${pattern}`);
      names.add(name);
      return { type: "rest", name };
    }
    return { type: "static", value: segment };
  });
  // Compared left to right: a fixed first segment beats a parameter there, whatever follows.
  return { pattern, parts, rank: parts.map((p) => (p.type === "static" ? 3 : p.type === "param" ? 2 : 1)) };
}

function moreSpecific(a, b) {
  for (let i = 0; i < Math.min(a.rank.length, b.rank.length); i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] > b.rank[i];
  return false;
}

function match(route, pathParts) {
  const params = Object.create(null);
  for (let i = 0; i < route.parts.length; i++) {
    const part = route.parts[i];
    if (part.type === "rest") {
      const rest = pathParts.slice(i).join("/");
      if (rest === "") return null;
      params[part.name] = rest;
      return params;
    }
    if (i >= pathParts.length) return null;
    if (part.type === "static" ? part.value !== pathParts[i] : false) return null;
    if (part.type === "param") {
      if (pathParts[i] === "") return null;
      params[part.name] = pathParts[i];
    }
  }
  return route.parts.length === pathParts.length ? params : null;
}

function decodeSegments(pathname) {
  try {
    return pathname.split("/").slice(1).filter((s, i, all) => s !== "" || i < all.length - 1).map((s) => decodeURIComponent(s));
  } catch {
    throw new HttpError(400, "The address contains an invalid % sequence");
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) return reject(new HttpError(413, `The body is larger than ${limit} bytes`));
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(new HttpError(413, `The body is larger than ${limit} bytes`));
        return; // keep draining so the answer can be sent
      }
      chunks.push(chunk);
    });
    req.on("end", () => !done && resolve(Buffer.concat(chunks)));
    req.on("error", (error) => !done && reject(error));
  });
}

function queryObject(searchParams) {
  const out = Object.create(null);
  for (const [key, value] of searchParams) {
    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

/**
 * A small router for plain `node:http`, for services that do not need a framework.
 * `const app = createRouter(); app.get("/users/:id", ({ params }) => loadUser(params.id)); createServer(app.handler).listen(3000)`
 * Options: `maxBodyBytes` (default 1 MB), `onError(error, ctx)` (called for unexpected errors, to log them).
 *
 * A handler gets `ctx`: `req`, `res`, `method`, `path`, `params` (decoded), `query` (repeated keys become arrays), `headers`,
 * `json()` / `text()` (read the body with the size limit; `json()` demands `application/json` and gives 400 for broken JSON), and
 * `send(status, data, headers)`. What it returns is sent as JSON with status 200 (a string as text, `undefined` as 204), unless
 * it already answered. Throw `HttpError` for a specific status. Anything else becomes a plain `500` without details.
 */
export function createRouter({ maxBodyBytes = 1_000_000, onError } = {}) {
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes < 0) throw new TypeError("mini-router: maxBodyBytes must be a number of at least 0");
  const routes = [];
  const middleware = [];

  function add(method, pattern, handler) {
    if (typeof handler !== "function") throw new TypeError("mini-router: the handler must be a function");
    routes.push({ method, ...compilePattern(pattern), handler });
    return app;
  }

  async function dispatch(req, res) {
    let ctx;
    try {
      const url = parseTarget(req.url ?? "/");
      const method = (req.method ?? "GET").toUpperCase();
      const pathParts = decodeSegments(url.pathname);
      let bodyPromise;
      const body = () => (bodyPromise ??= readBody(req, maxBodyBytes)); // the stream can only be read once
      ctx = {
        req, res, method, path: url.pathname, query: queryObject(url.searchParams), headers: req.headers, params: Object.create(null),
        send: (status, data, headers) => sendResponse(res, status, data, headers, method),
        async text() {
          return (await body()).toString("utf8");
        },
        async json() {
          const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          if (type !== "application/json" && !type.endsWith("+json")) throw new HttpError(415, "Send the body as application/json");
          const raw = await body();
          if (raw.length === 0) throw new HttpError(400, "The body is empty");
          try {
            const text = raw.toString("utf8");
            return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
          } catch {
            throw new HttpError(400, "The body is not valid JSON");
          }
        }
      };
      const candidates = routes.filter((r) => r.method === method || (method === "HEAD" && r.method === "GET"));
      let chosen = null;
      for (const route of candidates) {
        const params = match(route, pathParts);
        if (params && (!chosen || moreSpecific(route, chosen.route))) chosen = { route, params };
      }
      if (!chosen) {
        const allowed = [...new Set(routes.filter((r) => match(r, pathParts)).map((r) => r.method))];
        if (allowed.length > 0) throw new HttpError(405, "Method not allowed", { headers: { allow: [...allowed, ...(allowed.includes("GET") ? ["HEAD"] : [])].join(", ") } });
        throw new HttpError(404, "Not found");
      }
      ctx.params = chosen.params;
      const run = async (index) => {
        if (index < middleware.length) return middleware[index](ctx, () => run(index + 1));
        return chosen.route.handler(ctx);
      };
      const result = await run(0);
      if (res.headersSent || res.writableEnded) return;
      if (result === undefined) sendResponse(res, 204, undefined, undefined, method);
      else sendResponse(res, 200, result, undefined, method);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendSafely(res, error.status, { error: error.message, ...(error.details ? { details: error.details } : {}) }, error.headers, req.method);
        return;
      }
      try {
        onError?.(error, ctx);
      } catch {
        // A failing logger must not break the answer.
      }
      sendSafely(res, 500, { error: STATUS_TEXT[500] }, undefined, req.method);
    }
  }

  const app = {
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    put: (p, h) => add("PUT", p, h),
    patch: (p, h) => add("PATCH", p, h),
    delete: (p, h) => add("DELETE", p, h),
    options: (p, h) => add("OPTIONS", p, h),
    /** Runs `fn(ctx, next)` before every handler (login checks, logging). Call `await next()` to continue; throw or answer to stop. */
    use(fn) {
      if (typeof fn !== "function") throw new TypeError("mini-router: middleware must be a function");
      middleware.push(fn);
      return app;
    },
    /** For `createServer(app.handler)`. */
    handler: (req, res) => {
      dispatch(req, res).catch(() => res.destroy());
    },
    /** A server that is already listening: `await app.listen(3000)`. */
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        const server = createServer(app.handler);
        server.once("error", reject);
        server.listen(port, host, () => resolve(server));
      });
    },
    routes: () => routes.map((r) => `${r.method} ${r.pattern}`)
  };
  return app;
}

/** Like sendResponse, but a status or header that Node refuses (HttpError(99), a newline in a header) becomes a plain 500. */
function sendSafely(res, status, data, headers, method) {
  try {
    sendResponse(res, status, data, headers, method);
  } catch {
    try {
      sendResponse(res, 500, { error: STATUS_TEXT[500] }, undefined, method);
    } catch {
      res.destroy();
    }
  }
}

/** The request target as a URL. Only `/path` (and the `http://host/path` form proxies use) counts: `//x/y` is a path, not a host. */
function parseTarget(target) {
  try {
    if (target.startsWith("/")) return new URL(`http://localhost${target}`);
    if (/^https?:\/\//i.test(target)) return new URL(target);
  } catch {
    // falls through to the 400
  }
  throw new HttpError(400, "The address is not valid");
}

function sendResponse(res, status, data, headers = {}, method = "GET") {
  if (res.headersSent) return;
  let body;
  const out = { "x-content-type-options": "nosniff" };
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value; // one spelling, so the defaults below cannot override the caller
  if (data === undefined || status === 204 || status === 304) {
    body = "";
  } else if (typeof data === "string") {
    body = data;
    out["content-type"] ??= "text/plain; charset=utf-8";
  } else if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    body = data;
    out["content-type"] ??= "application/octet-stream";
  } else {
    body = JSON.stringify(data);
    out["content-type"] ??= "application/json; charset=utf-8";
  }
  out["content-length"] = Buffer.byteLength(body);
  out["cache-control"] ??= "no-store";
  res.writeHead(status, out);
  res.end(String(method).toUpperCase() === "HEAD" ? undefined : body);
}
