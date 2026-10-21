import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = process.cwd();
const dist = join(root, "dist", "index.js");

async function tempRepository(prefix) {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(repo, ".git"));
  await writeFile(join(repo, "README.md"), "# test\n");
  return repo;
}

async function withClient(repo, callback) {
  const dataDir = await mkdtemp(join(tmpdir(), "gitbot-mcp-data-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [dist, "mcp", "--repo", repo],
    env: { ...process.env, GITBOT_DATA_DIR: dataDir },
    stderr: "pipe",
  });
  const client = new Client({ name: "gitbot-mcp-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
  }
}

test("MCP initializes and discovers only read-only GitBot tools", async () => {
  const repo = await tempRepository("gitbot-mcp-authorized-");
  await withClient(repo, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "gitbot_get_repository_status",
      "gitbot_get_status",
      "gitbot_get_thread",
      "gitbot_list_bots",
      "gitbot_list_repositories",
      "gitbot_list_threads",
    ]);
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  });
});

test("MCP rejects repository status outside the explicit authorization list", async () => {
  const authorized = await tempRepository("gitbot-mcp-authorized-");
  const denied = await tempRepository("gitbot-mcp-denied-");
  await withClient(authorized, async (client) => {
    const result = await client.callTool({ name: "gitbot_get_repository_status", arguments: { repoPath: denied } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not authorized/i);
  });
});

test("MCP validates tool input through the protocol schema", async () => {
  const repo = await tempRepository("gitbot-mcp-validation-");
  await withClient(repo, async (client) => {
    const result = await client.callTool({ name: "gitbot_get_repository_status", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /repoPath|validation|invalid/i);
  });
});

test("MCP CLI writes startup errors to stderr, not stdout", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "gitbot-mcp-data-"));
  const child = spawn(process.execPath, [dist, "mcp", "--repo", join(tmpdir(), "gitbot-no-such-repo")], {
    cwd: root,
    env: { ...process.env, GITBOT_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /Invalid --repo path/);
});
