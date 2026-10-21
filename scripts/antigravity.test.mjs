import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

process.env.GITBOT_DATA_DIR ??= `${process.cwd()}/.tmp-antigravity-test-data`;

const { createSession } = await import("../dist/server-common.js");
const { runAgent, setAntigravityProcessFactoryForTest } = await import("../dist/start-antigravity.js");

function fakeProcess(onInput) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    onInput?.(child, signal, true);
    return true;
  };
  child.stdin.on("data", (chunk) => onInput?.(child, chunk.toString(), false));
  return child;
}

test("Antigravity runner translates NDJSON, persists its conversation, and resumes it", async () => {
  const invocations = [];
  setAntigravityProcessFactoryForTest(((command, args) => {
    invocations.push({ command, args });
    return fakeProcess((child, value, killed) => {
      if (killed) return;
      const prompt = JSON.parse(value);
      assert.equal(prompt.event, "user");
      child.stdout.write('{"event":"init","conversation_id":"conversation-123456789012345678901234"}\n');
      child.stdout.write('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"hello"}}\n');
      child.stdout.write('{"event":"result","result":{"conversation_id":"conversation-123456789012345678901234","status":"SUCCESS"}}\n');
      queueMicrotask(() => child.emit("close", 0));
    });
  }));
  try {
    const store = createSession("antigravity-test", "antigravity", process.cwd());
    store.events.push({ seq: 1, type: "user_prompt", prompt: "say hello" });
    await runAgent(store);
    assert.equal(store.sdkSessionId, "conversation-123456789012345678901234");
    assert.deepEqual(store.events.filter((event) => event.type === "assistant").map((event) => event.content), ["hello"]);
    assert.equal(store.status, "done");
    store.events = [{ seq: 2, type: "user_prompt", prompt: "continue" }];
    await runAgent(store);
    assert.ok(invocations[1].args.includes("--conversation"));
    assert.ok(invocations[1].args.includes("conversation-123456789012345678901234"));
  } finally {
    setAntigravityProcessFactoryForTest(undefined);
  }
});

test("Antigravity runner cancels the child process on the session abort signal", async () => {
  let killed = false;
  setAntigravityProcessFactoryForTest((() => fakeProcess((child, _value, wasKilled) => {
    if (!wasKilled) return;
    killed = true;
    child.stdout.write('{"event":"result","result":{"status":"INTERRUPTED"}}\n');
    queueMicrotask(() => child.emit("close", 130));
  })));
  try {
    const store = createSession("antigravity-cancel", "antigravity", process.cwd());
    store.events.push({ seq: 1, type: "user_prompt", prompt: "wait" });
    const running = runAgent(store);
    await new Promise((resolve) => setImmediate(resolve));
    store.abortController?.abort();
    await running;
    assert.equal(killed, true);
    assert.equal(store.status, "done");
    assert.equal(store.events.some((event) => event.type === "aborted"), true);
  } finally {
    setAntigravityProcessFactoryForTest(undefined);
  }
});

test("Antigravity runner rejects GitBot Plan mode before spawning a process", async () => {
  let spawned = false;
  setAntigravityProcessFactoryForTest((() => { spawned = true; throw new Error("must not spawn"); }));
  try {
    const store = createSession("antigravity-plan", "antigravity", process.cwd(), undefined, "plan");
    store.events.push({ seq: 1, type: "user_prompt", prompt: "make a plan" });
    await runAgent(store);
    assert.equal(spawned, false);
    assert.equal(store.status, "error");
    assert.match(String(store.events.at(-1)?.message), /Plan mode/);
  } finally {
    setAntigravityProcessFactoryForTest(undefined);
  }
});

test("Antigravity runner reports spawn errors as session errors", async () => {
  setAntigravityProcessFactoryForTest((() => {
    const child = fakeProcess();
    queueMicrotask(() => child.emit("error", new Error("agy unavailable")));
    return child;
  }));
  try {
    const store = createSession("antigravity-spawn-error", "antigravity", process.cwd());
    store.events.push({ seq: 1, type: "user_prompt", prompt: "run" });
    await runAgent(store);
    assert.equal(store.status, "error");
    assert.match(String(store.events.at(-1)?.message), /agy unavailable/);
  } finally {
    setAntigravityProcessFactoryForTest(undefined);
  }
});
