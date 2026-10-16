import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";

import { createRouter, HttpError } from "./src/index.js";

let server;
let base;
const logged = [];
const app = createRouter({ maxBodyBytes: 1000, onError: (e) => logged.push(e.message) });

app.use(async (ctx, next) => {
  if (ctx.path.startsWith("/private") && ctx.headers.authorization !== "Bearer ok") throw new HttpError(401, "Log in first", { headers: { "www-authenticate": "Bearer" } });
  return next();
});
app.get("/", () => "home");
app.get("/users/:id", ({ params }) => ({ id: params.id }));
app.get("/users/me", () => ({ me: true }));
app.get("/files/*path", ({ params }) => ({ path: params.path }));
app.get("/search", ({ query }) => query);
app.post("/echo", async (ctx) => ctx.json());
app.post("/text", async (ctx) => ({ length: (await ctx.text()).length }));
app.get("/nothing", () => undefined);
app.get("/boom", () => { throw new Error("secret database password is hunter2"); });
app.get("/teapot", () => { throw new HttpError(418, "I am a teapot", { details: { tea: true } }); });
app.get("/manual", ({ send }) => { send(201, { created: true }, { "x-extra": "1" }); });
app.get("/private/data", () => ({ secret: 42 }));
app.delete("/users/:id", ({ params }) => ({ deleted: params.id }));
app.get("/slow-error", async () => { await new Promise((r) => setTimeout(r, 5)); throw new HttpError(409, "Conflict now"); });

before(async () => {
  server = await app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

const call = async (path, init = {}) => {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, headers: res.headers, body, text };
};
const json = (data, extra = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(data) });

test("routes, parameters, text and JSON answers", async () => {
  assert.deepEqual(await call("/").then((r) => [r.status, r.body, r.headers.get("content-type")]), [200, "home", "text/plain; charset=utf-8"]);
  const user = await call("/users/42");
  assert.deepEqual([user.status, user.body, user.headers.get("content-type")], [200, { id: "42" }, "application/json; charset=utf-8"]);
  assert.deepEqual((await call("/users/me")).body, { me: true }); // the fixed path beats the parameter
  assert.deepEqual((await call("/users/a%20b%2Fc")).body, { id: "a b/c" });
  assert.deepEqual((await call("/files/a/b/c.txt")).body, { path: "a/b/c.txt" });
  assert.equal((await call("/users/42/")).status, 200); // a trailing slash is fine
  assert.deepEqual((await call("/search?q=x&tag=a&tag=b&empty=")).body, { q: "x", tag: ["a", "b"], empty: "" });
  assert.equal((await call("/nothing")).status, 204);
  const manual = await call("/manual");
  assert.deepEqual([manual.status, manual.body, manual.headers.get("x-extra")], [201, { created: true }, "1"]);
  assert.equal((await call("/", { method: "HEAD" })).text, "");
  assert.equal((await call("/", { method: "HEAD" })).status, 200);
});

test("404, 405 with Allow, and bad addresses", async () => {
  const missing = await call("/nope");
  assert.deepEqual([missing.status, missing.body], [404, { error: "Not found" }]);
  const wrong = await call("/users/1", { method: "POST" });
  assert.equal(wrong.status, 405);
  assert.match(wrong.headers.get("allow"), /GET/);
  assert.match(wrong.headers.get("allow"), /DELETE/);
  assert.equal((await call("/users/%E0%A4%A")).status, 400);
});

test("bodies: JSON, type check, size limit, broken JSON", async () => {
  assert.deepEqual((await call("/echo", json({ a: [1, 2], b: { c: true } }))).body, { a: [1, 2], b: { c: true } });
  assert.equal((await call("/echo", { method: "POST", body: "{}" })).status, 415);
  assert.equal((await call("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: "" })).status, 400);
  const broken = await call("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: "{broken" });
  assert.deepEqual([broken.status, broken.body.error], [400, "The body is not valid JSON"]);
  assert.equal((await call("/echo", { method: "POST", headers: { "content-type": "application/vnd.api+json" }, body: "[1]" })).body[0], 1);
  const big = await call("/echo", json({ blob: "x".repeat(5000) }));
  assert.equal(big.status, 413);
  assert.equal((await call("/text", { method: "POST", body: "hello" })).body.length, 5);
});

test("a body that lies about its size or streams too much is stopped", async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request(base + "/text", { method: "POST", headers: { "transfer-encoding": "chunked" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    for (let i = 0; i < 20; i++) req.write("y".repeat(200));
    req.end();
  });
  assert.equal(status, 413);
});

test("errors: HttpError is shown, anything else is a plain 500 and logged", async () => {
  const teapot = await call("/teapot");
  assert.deepEqual([teapot.status, teapot.body], [418, { error: "I am a teapot", details: { tea: true } }]);
  const boom = await call("/boom");
  assert.deepEqual([boom.status, boom.body], [500, { error: "Internal Server Error" }]);
  assert.ok(!boom.text.includes("hunter2"));
  assert.deepEqual(logged, ["secret database password is hunter2"]);
  assert.equal((await call("/slow-error")).status, 409);
});

test("middleware can stop a request or let it through", async () => {
  const denied = await call("/private/data");
  assert.deepEqual([denied.status, denied.headers.get("www-authenticate")], [401, "Bearer"]);
  assert.deepEqual((await call("/private/data", { headers: { authorization: "Bearer ok" } })).body, { secret: 42 });
  assert.equal((await call("/", { headers: { authorization: "nonsense" } })).status, 200);
});

test("answers carry safe headers and are not cached", async () => {
  const r = await call("/users/1");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("params and query have no prototype to abuse", async () => {
  assert.deepEqual((await call("/users/__proto__")).body, { id: "__proto__" });
  assert.deepEqual((await call("/search?__proto__=x&constructor=y")).body, { ["__proto__"]: "x", constructor: "y" });
  assert.equal({}.x, undefined);
});

test("bad route definitions fail when you write them", () => {
  const r = createRouter();
  assert.throws(() => r.get("users", () => {}), TypeError);
  assert.throws(() => r.get("/a/:id/:id", () => {}), TypeError);
  assert.throws(() => r.get("/a/*rest/b", () => {}), TypeError);
  assert.throws(() => r.get("/a/:1", () => {}), TypeError);
  assert.throws(() => r.get("/a", "not a function"), TypeError);
  assert.throws(() => r.use(5), TypeError);
  assert.deepEqual(r.get("/a", () => {}).routes(), ["GET /a"]);
});
