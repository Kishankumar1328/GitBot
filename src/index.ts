#!/usr/bin/env node

process.on("SIGINT", () => {
  // stdout is the JSON-RPC wire when `gitbot mcp` is running.
  console.error();
  process.exit(0);
});

import { Command } from "commander";
import { start } from "./server";
import { startMcpServer } from "./mcp";

const program = new Command();

program
  .name("gitbot")
  .description("gitbot — build and run AI bots on top of Claude Code and other coding agents")
  .version(require("../package.json").version);

program
  .command("start")
  .description("Start the bot hub — create bots, pick a repo, and run them in threads")
  .option("-c, --caffeinate", "run caffeinate for 8 hours to prevent sleep")
  .option("-p, --port <port>", "bind this local port and serve the UI at http://localhost:<port>", "3000")
  // The server is always local now; the flag stays so existing scripts keep working.
  .option("-l, --local", "bind a local port (the default)")
  .action(async (opts) => {
    const port = Number(opts.port);
    if (!(Number.isInteger(port) && port > 0 && port < 65536)) {
      console.error("  --port must be a number between 1 and 65535");
      process.exit(1);
    }
    await start("local", port, opts.caffeinate ?? false);
  });

program
  .command("mcp")
  .description("Run a read-only GitBot MCP server over stdio")
  .requiredOption("--repo <path...>", "repository root authorized for MCP access; repeat or pass multiple paths")
  .action(async (opts) => {
    try {
      await startMcpServer(opts.repo);
    } catch (err: any) {
      console.error(`gitbot mcp: ${err?.message ?? err}`);
      process.exitCode = 1;
    }
  });

program.parse();
