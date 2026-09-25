// Clawd on Desk — opencode plugin (thin family entry)
//
// All runtime logic lives in the shared family core; this entry only binds
// the opencode identity. The four params MUST match the "opencode" entry in
// agents/opencode-family.js (locked by a registry cross-check test).
//
// Export shape: OpenCode V2 loads a default-exported { id, setup } definition,
// while OpenCode V1 (>= 1.18.29 object form) calls server(). Both entrypoints
// run the same core below. #413 still applies to this module: keep exactly
// ONE export — the default — because loaders iterate this module's namespace
// and die on unexpected named exports. Test internals ride on the default as
// a non-enumerable __test property (mod.default.__test).
//
// The core is written against the OpenCode V1 plugin contract (events with the
// payload under `event.properties`, sessions as `properties.info`, and the raw
// SDK client). V2 moved events to `event.data` and exposes a different plugin
// context, so setup() rebuilds the V1 shapes the core consumes and hands it
// the same handlers it has always run.

import { createOpencodeFamilyPlugin } from "../opencode-family-plugin/core.mjs";

const plugin = createOpencodeFamilyPlugin({
  agentId: "opencode",
  hookSource: "opencode-plugin",
  logFileName: "opencode-plugin.log",
  sessionIdPrefix: "opencode:",
});

// V1 message shape used by the core's context-usage hydration: it reads
// message.info.{id,sessionID,role,time.created,tokens} only.
function legacyMessage(message, sessionID) {
  return {
    info: {
      id: message && message.id,
      sessionID,
      role: message && message.type,
      time: (message && message.time) || { created: 0 },
      tokens: message && message.tokens,
    },
    parts: [],
  };
}

// Tracks what V2 tells us about each session so synthesized V1 `info` objects
// stay complete across session.created / session.renamed / session.moved, and
// remembers tool-call inputs because permission.asked only references a call
// (source.id) instead of carrying the input like V1's ask metadata did.
function createEventAdapter() {
  const sessionInfo = new Map();
  const sessionModel = new Map();
  const permissionSessions = new Map();
  const toolInputs = new Map();
  const TRACKED_LIMIT = 256;

  function rememberBounded(map, key, value) {
    map.set(key, value);
    if (map.size > TRACKED_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest) map.delete(oldest);
    }
  }

  function remember(data) {
    const id = data.sessionID;
    if (!id) return;
    const previous = sessionInfo.get(id) || {};
    rememberBounded(sessionInfo, id, {
      directory: (data.location && data.location.directory) || previous.directory,
      title: data.title !== undefined ? data.title : previous.title,
      parentID: data.parentID !== undefined ? data.parentID : previous.parentID,
    });
    if (data.model && data.model.id) {
      rememberBounded(sessionModel, id, { providerID: data.model.providerID, modelID: data.model.id });
    }
  }

  function info(id) {
    const saved = sessionInfo.get(id) || {};
    return { id, parentID: saved.parentID, directory: saved.directory, title: saved.title };
  }

  // One V2 event -> the V1 event the core understands, or null to drop it.
  // Dropped types are the V2 streaming granularity (text/reasoning deltas,
  // step updates); the core's V1 handler ignored those too.
  function translate(event) {
    const data = event && event.data && typeof event.data === "object" ? event.data : {};
    switch (event.type) {
      case "session.created":
        remember(data);
        return { type: "session.created", properties: { sessionID: data.sessionID, info: info(data.sessionID) } };
      case "session.renamed":
        remember(data);
        return { type: "session.updated", properties: { sessionID: data.sessionID, info: info(data.sessionID) } };
      case "session.moved":
        remember(data);
        return { type: "session.updated", properties: { sessionID: data.sessionID, info: info(data.sessionID) } };
      case "session.status":
        // The core turns V1 session.idle into the turn boundary (Stop for
        // root sessions, SessionEnd for children) and ignores status-idle as
        // redundant. V2 may deliver completion only as status-idle or as
        // execution.succeeded, so surface every idle signal as session.idle;
        // the core's same-state dedup absorbs duplicates.
        if (data.status && data.status.type === "idle") {
          return { type: "session.idle", properties: { sessionID: data.sessionID } };
        }
        return { type: "session.status", properties: { sessionID: data.sessionID, status: data.status } };
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        return { type: "session.idle", properties: { sessionID: data.sessionID } };
      case "session.idle":
        return { type: "session.idle", properties: { sessionID: data.sessionID } };
      case "session.execution.failed":
        return { type: "session.error", properties: { sessionID: data.sessionID, error: data.error } };
      case "session.deleted":
        return { type: "session.deleted", properties: { sessionID: data.sessionID, info: info(data.sessionID) } };
      case "session.compaction.started":
        return { type: "session.compacted", properties: { sessionID: data.sessionID } };
      case "session.tool.called":
        rememberBounded(toolInputs, data.id, data.input);
        return {
          type: "message.part.updated",
          properties: { sessionID: data.sessionID, part: { type: "tool", state: { status: "running" } } },
        };
      case "session.tool.success":
        return {
          type: "message.part.updated",
          properties: { sessionID: data.sessionID, part: { type: "tool", state: { status: "completed" } } },
        };
      case "session.tool.failed":
        return {
          type: "message.part.updated",
          properties: { sessionID: data.sessionID, part: { type: "tool", state: { status: "error" } } },
        };
      case "session.step.ended": {
        // V2 splits usage reporting: session.step.ended carries the tokens of
        // this model request — the V1 message.updated contract the core
        // consumes (context occupancy) — while session.usage.updated carries
        // the session's CUMULATIVE billing totals and must never feed context
        // usage or the HUD pins at 100%.
        const model = sessionModel.get(data.sessionID);
        return {
          type: "message.updated",
          properties: {
            sessionID: data.sessionID,
            info: {
              role: "assistant",
              sessionID: data.sessionID,
              id: data.assistantMessageID,
              tokens: data.tokens,
              providerID: model && model.providerID,
              modelID: model && model.modelID,
            },
          },
        };
      }
      case "session.usage.updated":
        return null;
      case "permission.asked": {
        if (data.id) rememberBounded(permissionSessions, data.id, data.sessionID);
        // V1's ask folded the tool input into `metadata` and the resource
        // patterns into `patterns`/`always`; V2 keeps them apart (metadata is
        // optional, the input rides on the referenced tool call, `resources`
        // and `save` carry the patterns). The bubble detail chain
        // (filepath → command → url → familyPatterns → raw JSON) then shows
        // the real tool input, or the resource patterns instead of "{}".
        const toolInput = (data.source && data.source.id && toolInputs.get(data.source.id))
          || data.metadata
          || {};
        return {
          type: "permission.asked",
          properties: {
            ...data,
            permission: data.action,
            metadata: toolInput,
            patterns: data.resources || [],
            always: data.save || [],
          },
        };
      }
      case "permission.replied":
        if (data.requestID) permissionSessions.delete(data.requestID);
        return { type: "permission.replied", properties: { ...data } };
      case "session.model.selected":
        // Model tracking only: the core reads providerID/modelID off the
        // synthesized message.updated above to resolve context limits.
        remember(data);
        return null;
      case "tui.session.select":
        return { type: "tui.session.select", properties: { sessionID: data.sessionID } };
      default:
        return null;
    }
  }

  // Sessions created before this plugin loaded never replay their
  // session.created/updated events, so without a one-shot identity fetch the
  // core would never learn their title and the HUD falls back to the folder
  // name. Fetch once per unknown session and let the caller hand the core the
  // returned synthetic session.updated before the triggering event.
  async function seedSession(ctx, sessionID) {
    if (!sessionID || sessionInfo.has(sessionID)) return null;
    let session;
    try {
      session = await ctx.session.get({ sessionID });
    } catch (error) {
      // A session can vanish between the event and this lookup (deletes and
      // short-lived subagents race it). Surface the error but never let the
      // backfill block delivery of the event that triggered it.
      console.error("clawd-opencode-plugin: session identity backfill failed", error);
      return null;
    }
    remember({
      sessionID,
      title: session.title,
      parentID: session.parentID,
      location: session.location,
      model: session.model,
    });
    return { type: "session.updated", properties: { sessionID, info: info(sessionID) } };
  }

  return { translate, seedSession, permissionSessions };
}

// The raw V1 client surface the core calls: session.messages (context-usage
// hydration), provider.list (context limits) and client._client.post (the
// reverse permission bridge). Everything else is absent on purpose — the core
// probes for these and degrades when they are missing.
function createClientShim(ctx, adapter) {
  return {
    session: {
      async messages(input) {
        const id = input && input.path && input.path.id;
        const messages = await ctx.session.context({ sessionID: id });
        return { data: messages.map((message) => legacyMessage(message, id)) };
      },
    },
    provider: {
      async list() {
        const providerResult = await ctx.provider.list();
        const modelResult = await ctx.model.list();
        const providers = Array.isArray(providerResult) ? providerResult : (providerResult && providerResult.data) || [];
        const models = Array.isArray(modelResult) ? modelResult : (modelResult && modelResult.data) || [];
        const modelsByProvider = new Map();
        for (const model of models) {
          if (!modelsByProvider.has(model.providerID)) modelsByProvider.set(model.providerID, new Map());
          const byID = modelsByProvider.get(model.providerID);
          byID.set(model.id, model);
          if (model.modelID) byID.set(model.modelID, model);
        }
        return {
          data: {
            all: providers.map((provider) => ({
              ...provider,
              models: modelsByProvider.get(provider.id) || new Map(),
            })),
          },
        };
      },
    },
    _client: {
      // HeyApi raw POST from the reverse bridge. The core only ever posts
      // /permission/:id/reply ({ reply }); route it to the V2 permission API.
      async post(request) {
        const match = /^\/permission\/([^/]+)\/reply$/.exec((request && request.url) || "");
        if (!match) {
          throw new Error(`opencode-plugin: unsupported bridge request: ${request && request.url}`);
        }
        const requestID = decodeURIComponent(match[1]);
        const sessionID = adapter.permissionSessions.get(requestID);
        if (!sessionID) {
          throw new Error(`opencode-plugin: no session known for permission request ${requestID}`);
        }
        const body = (request && request.body) || {};
        await ctx.permission.reply({
          sessionID,
          requestID,
          decision: body.reply || body.decision,
          message: body.message,
        });
        return { data: null, error: null };
      },
    },
  };
}

const definition = {
  id: "clawd-opencode-family",

  async setup(ctx) {
    const adapter = createEventAdapter();
    const handlers = await plugin({
      directory: (ctx.location && ctx.location.directory) || "",
      client: createClientShim(ctx, adapter),
      serverUrl: "",
    });
    const controller = new AbortController();

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const legacy = adapter.translate(event);
          if (!legacy) continue;
          // Backfill identity for sessions this plugin never saw created —
          // without their titles the HUD falls back to the folder name. The
          // synthetic session.updated goes first so the core captures the
          // title/directory before the event that triggered the backfill.
          // Deletions skip it: the session may already be gone and there is
          // nothing left to capture.
          const sessionID = legacy.properties && legacy.properties.sessionID;
          if (legacy.type !== "session.deleted" && sessionID) {
            const seeded = await adapter.seedSession(ctx, sessionID);
            if (seeded) await handlers.event({ event: seeded });
          }
          await handlers.event({ event: legacy });
        } catch (error) {
          // V1 isolated hook failures per event in the host; keep that
          // property so one bad event cannot end the subscription.
          console.error("clawd-opencode-plugin: event handler failed", error);
        }
      }
    })();

    return async () => {
      controller.abort();
      await handlers.dispose();
    };
  },

  // OpenCode V1 (>= 1.18.29 object-form entrypoint) runs server() with the V1
  // plugin context and V1-shaped events, which the core consumes directly.
  async server(ctx) {
    return plugin(ctx);
  },
};

// Test internals ride on the default export (#413), non-enumerable so the
// one-export shape stays exact.
Object.defineProperty(definition, "__test", { value: plugin.__test });

export default definition;
