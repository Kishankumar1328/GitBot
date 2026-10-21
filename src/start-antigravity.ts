import { spawn, execFileSync, type ChildProcess } from "child_process";
import { bindSession } from "./bot-store";
import { emitEvent, notifyPermissionsChanged, scheduleCleanup, type SessionStore } from "./server-common";
import { presetSystemPrompt, recordSetupOutcomeFromEvents } from "./bot-prompt";

/** Official `agy` CLI availability check. No IDE launcher or private API is used. */
export async function initAgent(): Promise<boolean> {
  try {
    execFileSync("agy", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    console.warn("  agy CLI not found — antigravity agent unavailable");
    return false;
  }
}

type StreamEvent = {
  event?: string;
  conversation_id?: string;
  init?: { conversation_id?: string };
  step_update?: {
    step_type?: string;
    state?: string;
    text_delta?: string;
    tool_name?: string;
    tool_info?: { name?: string; parameters?: unknown; output?: string };
  };
  result?: { conversation_id?: string; status?: string; response?: string; error?: string; duration_seconds?: number; num_turns?: number; usage?: unknown };
};

let spawnAgy: typeof spawn = spawn;

/** Test seam for deterministic process-lifecycle coverage. */
export function setAntigravityProcessFactoryForTest(factory: typeof spawn | undefined): void {
  spawnAgy = factory ?? spawn;
}

function bindConversation(store: SessionStore, id: string | undefined): void {
  if (!id || store.sdkSessionId) return;
  store.sdkSessionId = id;
  if (store.threadId) bindSession(store.threadId, id);
  emitEvent(store, "system", { subtype: "init", session_id: id });
}

/** Runs one official headless `agy` turn and translates its NDJSON event stream. */
export async function runAgent(store: SessionStore): Promise<void> {
  // The official headless CLI does not offer an enforced plan/read-only flag.
  // Refuse rather than claim the generic GitBot Plan mode is safe.
  if (store.mode === "plan") {
    emitEvent(store, "error", { message: "Antigravity CLI does not support GitBot's enforced Plan mode" });
    store.status = "error";
    return;
  }
  const user = [...store.events].reverse().find((event) => event.type === "user_prompt");
  const prompt = (user?.prompt as string) ?? "";
  const attachments = user?.attachments as Array<{ url: string }> | undefined;
  if (attachments?.length) {
    emitEvent(store, "error", { message: "Antigravity CLI attachments are not supported by GitBot yet" });
    store.status = "error";
    return;
  }

  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (store.sdkSessionId) args.push("--conversation", store.sdkSessionId);
  if (store.model) args.push("--model", store.model);
  // `agy` has no per-call approval channel. Its configured, scoped permissions
  // remain effective for normal modes; only GitBot's explicit yolo mode opts in.
  if (store.permissionMode === "yolo") args.push("--dangerously-skip-permissions");

  const system = presetSystemPrompt(store.botPreset);
  const content = system ? `${system}\n\n${prompt}` : prompt;
  const command = process.platform === "win32" ? "agy.exe" : "agy";
  const child = spawnAgy(command, args, { cwd: store.repoPath, stdio: ["pipe", "pipe", "pipe"] });
  const abort = new AbortController();
  store.abortController = abort;
  let buffer = "";
  let terminal = false;
  let stderr = "";

  const onAbort = () => child.kill("SIGINT");
  abort.signal.addEventListener("abort", onAbort, { once: true });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line, store, () => { terminal = true; });
  });

  try {
    child.stdin.write(`${JSON.stringify({ event: "user", message: { content } })}\n`);
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (buffer) handleLine(buffer, store, () => { terminal = true; });
    if (!terminal) {
      const message = abort.signal.aborted
        ? "Request aborted by user"
        : stderr.trim() || `Antigravity CLI exited with code ${exitCode ?? "unknown"}`;
      emitEvent(store, abort.signal.aborted ? "aborted" : "error", { message });
      store.status = abort.signal.aborted ? "done" : "error";
    }
  } catch (err: any) {
    emitEvent(store, "error", { message: err?.message ?? "Antigravity CLI failed" });
    store.status = "error";
  } finally {
    abort.signal.removeEventListener("abort", onAbort);
    store.abortController = null;
    notifyPermissionsChanged();
  }

  if (store.status === "error") { scheduleCleanup(store); return; }
  recordSetupOutcomeFromEvents(store);
  store.status = "done";
  notifyPermissionsChanged();
  emitEvent(store, "done", {});
  scheduleCleanup(store);
}

function handleLine(line: string, store: SessionStore, markTerminal: () => void): void {
  let event: StreamEvent;
  try { event = JSON.parse(line); } catch { return; }
  if (event.event === "init") {
    bindConversation(store, event.conversation_id ?? event.init?.conversation_id);
    return;
  }
  if (event.event === "step_update") {
    const step = event.step_update;
    if (step?.step_type === "agent_response" && step.text_delta) emitEvent(store, "assistant", { content: step.text_delta });
    if (step?.step_type === "tool" && step.state === "ACTIVE") emitEvent(store, "tool_use", { tool_name: step.tool_name ?? step.tool_info?.name ?? "tool", tool_input: step.tool_info?.parameters ?? {} });
    if (step?.step_type === "tool" && step.state === "DONE") emitEvent(store, "tool_result", { tool_name: step.tool_name ?? step.tool_info?.name ?? "tool", output: step.tool_info?.output ?? "" });
    return;
  }
  if (event.event === "result") {
    const result = event.result ?? {};
    bindConversation(store, result.conversation_id);
    if (result.status === "CANCELED" || result.status === "INTERRUPTED") {
      emitEvent(store, "aborted", { message: result.error || "Request aborted by user" });
    } else if (result.status && result.status !== "SUCCESS") {
      emitEvent(store, "error", { message: result.error || `Antigravity CLI finished with ${result.status}` });
      store.status = "error";
    } else {
      emitEvent(store, "result", { subtype: "success", duration_seconds: result.duration_seconds, num_turns: result.num_turns, usage: result.usage });
    }
    markTerminal();
  }
}
