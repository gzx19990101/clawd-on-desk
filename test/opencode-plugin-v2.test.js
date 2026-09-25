"use strict";

// The V2 entry (hooks/opencode-plugin/index.mjs) end-to-end: OpenCode V2 event
// shapes in -> Clawd /permission bodies out. Covers the V2 permission field
// mapping (tool input from source.id, patterns <- resources, always <- save),
// the reverse-bridge reply shim (client._client.post -> ctx.permission.reply),
// and the multi-instance fan-out dedup through the real default export.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, before, after } = require("node:test");
const { pathToFileURL } = require("node:url");

// Redirect HOME before the entry (and its core) is imported: the core resolves
// ~/.clawd at module-evaluation time and resets its debug log under it — the
// suite must never touch the user's real ~/.clawd.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-opencode-v2-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
fs.mkdirSync(path.join(TMP_HOME, ".clawd"), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(TMP_HOME, ".clawd", "runtime.json"),
  JSON.stringify({ app: "clawd-on-desk", port: 23333, ownerPid: process.pid }),
  { mode: 0o600 }
);

let entry;
const fetchCalls = [];
const permissionReplies = [];
let bridgeFetchHandler = null;
let bridgePortCounter = 41000;

before(async () => {
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return {
      status: 200,
      headers: {
        get(name) {
          return String(name).toLowerCase() === "x-clawd-server" ? "clawd-on-desk" : null;
        },
      },
      text: async () => "",
    };
  };
  globalThis.Bun = {
    serve(opts) {
      bridgeFetchHandler = opts.fetch;
      return { port: ++bridgePortCounter };
    },
  };
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-plugin", "index.mjs");
  entry = (await import(pathToFileURL(modulePath).href)).default;
});

after(() => {
  delete globalThis.Bun;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

async function waitUntil(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settleTail(requestId) {
  const tail = entry.__test._permissionPostTailByRequestId.get(requestId);
  if (tail) await tail;
  await Promise.resolve();
}

function makeV2Ctx(directory, sessionInfo = null) {
  const queue = [];
  let notify = null;
  return {
    directory,
    push(event) {
      queue.push(event);
      if (notify) {
        const wake = notify;
        notify = null;
        wake();
      }
    },
    ctx: {
      location: { directory },
      event: {
        subscribe() {
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  while (queue.length === 0) {
                    await new Promise((resolve) => {
                      notify = resolve;
                    });
                  }
                  return { value: queue.shift(), done: false };
                },
              };
            },
          };
        },
      },
      session: {
        async context() {
          return [];
        },
        async get() {
          return sessionInfo || {};
        },
        async update() {},
      },
      provider: {
        async list() {
          return { data: [] };
        },
      },
      model: {
        async list() {
          return { data: [] };
        },
      },
      permission: {
        async reply(input) {
          permissionReplies.push(input);
        },
      },
    },
  };
}

function bubblePosts(requestId) {
  return fetchCalls.filter((call) => (
    call.url.endsWith("/permission") && call.body && call.body.request_id === requestId
  ));
}

function titlePosts(sessionId) {
  return fetchCalls.filter((call) => (
    call.body && call.body.session_title && call.body.session_id === `opencode:${sessionId}`
  ));
}

function contextUsagePosts(sessionId) {
  return fetchCalls.filter((call) => (
    call.body && call.body.context_usage && call.body.session_id === `opencode:${sessionId}`
  ));
}

function stateEvents(sessionId, event) {
  return fetchCalls.filter((call) => (
    call.body
    && call.body.event === event
    && call.body.metadata_only !== true
    && call.body.session_id === `opencode:${sessionId}`
  ));
}

describe("opencode plugin V2 entry (permission contract)", () => {
  it("maps V2 permission.asked onto the V1 ask contract with the referenced tool input", async () => {
    const instance = makeV2Ctx("C:\\proj");
    const cleanup = await entry.setup(instance.ctx);

    instance.push({
      type: "session.tool.called",
      data: {
        sessionID: "ses_map",
        assistantMessageID: "msg_map",
        id: "call_map",
        input: { command: "echo mapped", workdir: "C:/proj" },
        executed: false,
      },
    });
    instance.push({
      type: "permission.asked",
      data: {
        id: "per_map",
        sessionID: "ses_map",
        action: "external_directory",
        resources: ["C:/outside/*"],
        save: ["C:/outside/*"],
        source: { type: "tool", messageID: "msg_map", id: "call_map" },
      },
    });

    await waitUntil(() => bubblePosts("per_map").length > 0, "bubble POST never fired");
    await settleTail("per_map");

    const body = bubblePosts("per_map")[0].body;
    assert.strictEqual(body.tool_name, "external_directory");
    assert.deepStrictEqual(body.tool_input, { command: "echo mapped", workdir: "C:/proj" });
    assert.deepStrictEqual(body.patterns, ["C:/outside/*"]);
    assert.deepStrictEqual(body.always, ["C:/outside/*"]);
    assert.strictEqual(body.session_id, "opencode:ses_map");
    await cleanup();
  });

  it("falls back to resource patterns instead of {} when no tool input exists", async () => {
    const instance = makeV2Ctx("C:\\proj");
    const cleanup = await entry.setup(instance.ctx);

    instance.push({
      type: "permission.asked",
      data: {
        id: "per_no_tool",
        sessionID: "ses_no_tool",
        action: "external_directory",
        resources: ["D:/data/*"],
      },
    });

    await waitUntil(() => bubblePosts("per_no_tool").length > 0, "bubble POST never fired");
    await settleTail("per_no_tool");

    const body = bubblePosts("per_no_tool")[0].body;
    assert.deepStrictEqual(body.tool_input, {}, "no tool input stays empty");
    assert.deepStrictEqual(body.patterns, ["D:/data/*"], "the bubble detail chain shows the patterns");
    await cleanup();
  });

  it("posts exactly one bubble when every per-directory instance receives the same ask", async () => {
    const a = makeV2Ctx("C:\\proj-a");
    const b = makeV2Ctx("C:\\proj-b");
    const cleanupA = await entry.setup(a.ctx);
    const cleanupB = await entry.setup(b.ctx);

    const ask = {
      type: "permission.asked",
      data: { id: "per_fanout_v2", sessionID: "ses_fanout_v2", action: "bash", resources: [] },
    };
    a.push(ask);
    b.push(ask);

    await waitUntil(() => bubblePosts("per_fanout_v2").length > 0, "bubble POST never fired");
    await settleTail("per_fanout_v2");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(bubblePosts("per_fanout_v2").length, 1, "fan-out must not duplicate the bubble");
    await cleanupA();
    await cleanupB();
  });

  it("routes reverse-bridge replies to ctx.permission.reply", async () => {
    const instance = makeV2Ctx("C:\\proj");
    const cleanup = await entry.setup(instance.ctx);

    instance.push({
      type: "permission.asked",
      data: { id: "per_bridge_v2", sessionID: "ses_bridge_v2", action: "bash", resources: [] },
    });
    await waitUntil(() => bubblePosts("per_bridge_v2").length > 0, "bubble POST never fired");
    await settleTail("per_bridge_v2");

    const res = await bridgeFetchHandler(
      new Request(`${entry.__test._bridgeUrl}/reply`, {
        method: "POST",
        headers: { Authorization: `Bearer ${entry.__test._bridgeTokenHex}` },
        body: JSON.stringify({ request_id: "per_bridge_v2", reply: "once" }),
      })
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.deepStrictEqual(permissionReplies, [
      { sessionID: "ses_bridge_v2", requestID: "per_bridge_v2", decision: "once", message: undefined },
    ]);
    await cleanup();
  });

  it("backfills titles for sessions created before the plugin loaded", async () => {
    const instance = makeV2Ctx("C:\\proj", {
      id: "ses_old_title",
      title: "修复插件报错",
      location: { directory: "C:\\proj" },
      time: { created: 1, updated: 2 },
    });
    const cleanup = await entry.setup(instance.ctx);

    instance.push({
      type: "session.status",
      data: { sessionID: "ses_old_title", status: { type: "busy" } },
    });

    await waitUntil(() => titlePosts("ses_old_title").length > 0, "title metadata POST never fired");
    const body = titlePosts("ses_old_title")[0].body;
    assert.strictEqual(body.session_title, "修复插件报错");
    assert.strictEqual(body.metadata_only, true, "title updates must not disturb the lifecycle state");
    await cleanup();
  });

  it("feeds context usage from step tokens and drops cumulative usage totals", async () => {
    const instance = makeV2Ctx("C:\\proj", {
      id: "ses_usage",
      title: "usage",
      model: { id: "m1", providerID: "p1" },
      location: { directory: "C:\\proj" },
    });
    const cleanup = await entry.setup(instance.ctx);

    instance.push({
      type: "session.step.ended",
      data: {
        sessionID: "ses_usage",
        assistantMessageID: "msg_step_1",
        finish: "stop",
        cost: {},
        tokens: { input: 100, output: 20, reasoning: 30, cache: { read: 500, write: 5 } },
      },
    });
    await waitUntil(() => contextUsagePosts("ses_usage").length > 0, "context usage POST never fired");
    assert.strictEqual(
      contextUsagePosts("ses_usage")[0].body.context_usage.used,
      655,
      "context usage is the step's token sum (occupancy), not session totals"
    );

    const before = contextUsagePosts("ses_usage").length;
    instance.push({
      type: "session.usage.updated",
      data: {
        sessionID: "ses_usage",
        cost: {},
        tokens: { input: 999999, output: 999999, reasoning: 999999, cache: { read: 999999, write: 0 } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(
      contextUsagePosts("ses_usage").length,
      before,
      "cumulative billing totals must never reach context usage"
    );
    await cleanup();
  });

  it("delivers one PreToolUse/PostToolUse state POST per tool call across instances", async () => {
    // The core's tool identity dedup must collapse the fan-out: every plugin
    // instance observes the same tool event, and recap counts the POSTs.
    const a = makeV2Ctx("C:\\proj");
    const b = makeV2Ctx("C:\\proj");
    const cleanupA = await entry.setup(a.ctx);
    const cleanupB = await entry.setup(b.ctx);

    for (const id of ["call_count_a", "call_count_b"]) {
      for (const instance of [a, b]) {
        instance.push({
          type: "session.tool.called",
          data: { sessionID: "ses_count", assistantMessageID: "msg_count", id, input: {}, executed: false },
        });
        instance.push({
          type: "session.tool.success",
          data: { sessionID: "ses_count", assistantMessageID: "msg_count", id, content: [], executed: false },
        });
      }
    }

    await waitUntil(() => stateEvents("ses_count", "PostToolUse").length >= 1, "tool state POSTs missing");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(
      stateEvents("ses_count", "PreToolUse").length,
      2,
      "each call posts exactly one PreToolUse no matter how many instances observe it"
    );
    assert.strictEqual(stateEvents("ses_count", "PostToolUse").length, 2);
    await cleanupA();
    await cleanupB();
  });

  it("maps every idle signal to the turn boundary and dedups duplicates", async () => {
    const instance = makeV2Ctx("C:\\proj");
    const cleanup = await entry.setup(instance.ctx);

    instance.push({
      type: "session.tool.called",
      data: { sessionID: "ses_idle", assistantMessageID: "msg_idle", id: "call_idle", input: {}, executed: false },
    });
    // V2 may deliver completion as status-idle, execution.succeeded, or
    // session.idle — all three must reach the core's turn boundary, and the
    // duplicates must collapse to a single Stop.
    instance.push({ type: "session.status", data: { sessionID: "ses_idle", status: { type: "idle" } } });
    instance.push({ type: "session.execution.succeeded", data: { sessionID: "ses_idle" } });
    instance.push({ type: "session.idle", data: { sessionID: "ses_idle" } });

    await waitUntil(() => stateEvents("ses_idle", "Stop").length > 0, "Stop never sent");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(
      stateEvents("ses_idle", "Stop").length,
      1,
      "duplicate idle signals must collapse to one turn boundary"
    );
    await cleanup();
  });

  it("keeps the V1 object entrypoint wired to the same core", async () => {
    const hooks = await entry.server({ directory: "C:\\proj", client: {} });
    assert.strictEqual(typeof hooks.event, "function");
    assert.strictEqual(typeof hooks.dispose, "function");
    await hooks.dispose();
  });
});
