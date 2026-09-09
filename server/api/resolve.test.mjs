/* Handler tests for api/resolve.js — no network, no key, no Vercel.
 *
 *   node server/api/resolve.test.mjs
 *
 * Everything here is the input contract: what the endpoint refuses. That
 * matters more than the happy path, because without strict id validation this
 * is an open proxy — anything in `ids` would be forwarded to googleapis.com on
 * the key's behalf. Run by tests/pipeline.spec.js so it cannot rot. */
const { default: handler } = await import(new URL("./resolve.js", import.meta.url));

function fakeRes() {
  const r = { code: 0, body: null, headers: {}, ended: false };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}
const call = async (query, opts = {}) => {
  const res = fakeRes();
  await handler({ method: opts.method || "GET", query, headers: { origin: opts.origin } }, res);
  return res;
};

const results = [];
const t = (name, got, want) => results.push([name, JSON.stringify(got) === JSON.stringify(want) ? "PASS" : `FAIL got ${JSON.stringify(got)} want ${JSON.stringify(want)}`]);

// input validation — the open-proxy guard
t("no ids -> 400", (await call({})).code, 400);
t("junk id -> 400", (await call({ ids: "../../etc/passwd" })).code, 400);
t("short id -> 400", (await call({ ids: "abc" })).code, 400);
// genuinely distinct ids: the first version cycled i%10 and the Set deduped
// 51 down to 10, so the count check was never reached
const uniq = (n) => Array.from({ length: n }, (_, i) => ("id" + String(i).padStart(9, "0")));
t("51 ids -> 400", (await call({ ids: uniq(51).join(",") })).code, 400);
t("50 ids ok past validation", (await call({ ids: uniq(50).join(",") })).code, 503);
t("duplicates collapse below the cap", (await call({ ids: Array(60).fill("dQw4w9WgXcQ").join(",") })).code, 503);
t("valid id, no key -> 503", (await call({ ids: "dQw4w9WgXcQ" })).code, 503);
t("POST -> 405", (await call({ ids: "dQw4w9WgXcQ" }, { method: "POST" })).code, 405);

// CORS
const allowed = await call({ ids: "dQw4w9WgXcQ" }, { origin: "https://ryzzuh.github.io" });
t("allowed origin echoed", allowed.headers["Access-Control-Allow-Origin"], "https://ryzzuh.github.io");
const denied = await call({ ids: "dQw4w9WgXcQ" }, { origin: "https://evil.example" });
t("other origin not echoed", denied.headers["Access-Control-Allow-Origin"], undefined);
const pre = await call({}, { method: "OPTIONS", origin: "https://ryzzuh.github.io" });
t("preflight -> 204", pre.code, 204);

for (const [n, r] of results) console.log(r.padEnd(6), n);
const ok = results.every(([, r]) => r === "PASS");
console.log(ok ? "\nALL PASS" : "\nFAILURES");
process.exit(ok ? 0 : 1);
