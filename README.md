# @sandsoftwaresolutions/mini-router

[![CI](https://github.com/SandSoftwareSolutions/ss-mini-router/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-mini-router/actions/workflows/ci.yml)

A small router for plain `node:http`, for little services (a licence server, a webhook receiver, a Pi API) that do not need a framework. Routes with parameters, JSON bodies with a size limit, middleware, and errors that never leak. No dependencies.

## Install

```bash
npm install @sandsoftwaresolutions/mini-router
```

Works with `import` and `require()`, and ships TypeScript types for both.

## Usage

```js
import { createRouter, HttpError } from "@sandsoftwaresolutions/mini-router";

const app = createRouter({ maxBodyBytes: 100_000, onError: (error) => console.error(error) });

app.use(async (ctx, next) => {                       // runs before every handler
  if (ctx.path.startsWith("/admin") && ctx.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, "Log in first");
  return next();
});

app.get("/health", () => ({ status: "ok" }));
app.get("/users/:id", async ({ params }) => {
  const user = await db.find(params.id);
  if (!user) throw new HttpError(404, "No such user");
  return user;                                      // returned objects are sent as JSON
});
app.post("/users", async (ctx) => {
  const body = await ctx.json();                    // 415, 413 and 400 are handled for you
  ctx.send(201, await db.create(body));
});
app.get("/files/*path", ({ params }) => params.path);   // the rest of the address: "a/b/c.txt"

const server = await app.listen(3000);              // or: createServer(app.handler).listen(3000)
```

## What it does for you

- **Routing:** `:param` (decoded) and `*rest`; a fixed segment beats a parameter, compared from left to right (`/users/me` before `/users/:id`, and `/x/*rest` before `/:a/:b/:c`); an empty segment is never a parameter value (`/users//` is a 404); an address like `//host/path` is a path, not a host; trailing slashes are fine; `HEAD` works wherever `GET` does. A wrong method on a known path gives `405` with an `Allow` header; an unknown path gives `404` as JSON.
- **Answers:** a returned object or array is JSON (200), a string is text, `undefined` is `204`. `ctx.send(status, data, headers)` when you want control. Every answer has `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` unless you set your own.
- **Bodies:** `ctx.json()` needs `Content-Type: application/json` (415), refuses an empty body and broken JSON (400, a leading byte order mark is ignored), `json()` and `text()` can both be called and give the same body, and stops at `maxBodyBytes` (413), also for chunked uploads that do not say their size. `ctx.text()` reads plain text with the same limit.
- **Errors:** throw `HttpError(status, message)` and the client sees that message. Any other error becomes a plain `500 {"error":"Internal Server Error"}`, **never** the message or stack, and goes to `onError` for your log. A broken `%` sequence in the address is a `400`, not a crash, and so is an `HttpError` whose status or headers Node refuses (it becomes a plain `500`). Header names you pass to `send` or `HttpError` win over the defaults in any letter case.
- **Query:** `ctx.query` is a plain object where repeated keys become arrays (`?tag=a&tag=b`). Params and query have no prototype, so `__proto__` is just a name.

`*rest` is decoded, so it can contain `..` (`%2e%2e`) or `/` from `%2f`: never join it onto a file path without checking it.

`maxBodyBytes` must be a number of at least 0, otherwise `createRouter` throws a `TypeError`.

## Not included

No cookies, sessions, CORS or file uploads (add what you need as middleware), and no built-in rate limiting: see `@sandsoftwaresolutions/rate-limit`, `@sandsoftwaresolutions/secure-headers` and `@sandsoftwaresolutions/graceful`, which work with `app.handler`.
