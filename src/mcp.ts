import { statSync } from "fs";
import { resolve } from "path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { listBots, getThread, listThreads } from "./bot-store";
import { getRepoDetails } from "./workspace";

export interface McpOptions {
  /** Absolute repository roots the MCP process is permitted to disclose. */
  repositories: string[];
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const readOnly = { readOnlyHint: true } as const;

/**
 * Returns only explicitly configured repository roots. Paths are compared as
 * canonical absolute paths rather than prefixes, so a sibling such as
 * `/work/repo-copy` cannot inherit access to `/work/repo`.
 */
export function authorizedRepositories(repositories: string[]): string[] {
  return [...new Set(repositories.map(canonicalPath))];
}

export function isAuthorizedRepository(repoPath: string, repositories: string[]): boolean {
  return authorizedRepositories(repositories).includes(canonicalPath(repoPath));
}

function botSummary(bot: ReturnType<typeof listBots>[number]) {
  // Bot instructions and setup commands can contain sensitive local context.
  // MCP only exposes operational metadata in this initial read-only surface.
  const { instructions: _instructions, setupInstructions: _setupInstructions, ...summary } = bot;
  return summary;
}

export function createGitBotMcpServer(options: McpOptions): McpServer {
  const repositories = authorizedRepositories(options.repositories);
  if (repositories.length === 0) throw new Error("At least one --repo path is required");

  const server = new McpServer({ name: "gitbot", version: require("../package.json").version });

  server.registerTool(
    "gitbot_list_repositories",
    { description: "List the repository roots explicitly authorized for this GitBot MCP server.", inputSchema: z.object({}), annotations: readOnly },
    async () => text(repositories.map((repoPath) => ({ repoPath, ...getRepoDetails(repoPath) }))),
  );

  server.registerTool(
    "gitbot_get_repository_status",
    {
      description: "Read GitBot's repository details for one authorized repository.",
      inputSchema: z.object({ repoPath: z.string().min(1).describe("An authorized repository root returned by gitbot_list_repositories.") }),
      annotations: readOnly,
    },
    async ({ repoPath }) => {
      if (!isAuthorizedRepository(repoPath, repositories)) return toolError("Repository is not authorized for this GitBot MCP server");
      return text({ repoPath: canonicalPath(repoPath), ...getRepoDetails(repoPath) });
    },
  );

  server.registerTool(
    "gitbot_list_bots",
    { description: "List GitBot bot metadata. Instructions and setup commands are intentionally excluded.", inputSchema: z.object({}), annotations: readOnly },
    async () => text(listBots()
      .filter((bot) => !bot.repoPath || isAuthorizedRepository(bot.repoPath, repositories))
      .map(botSummary)),
  );

  server.registerTool(
    "gitbot_list_threads",
    {
      description: "List persisted GitBot threads for authorized repositories. Optionally filter by bot ID.",
      inputSchema: z.object({ botId: z.string().min(1).optional() }),
      annotations: readOnly,
    },
    async ({ botId }) => text(listThreads(botId).filter((thread) => isAuthorizedRepository(thread.repoPath, repositories))),
  );

  server.registerTool(
    "gitbot_get_thread",
    {
      description: "Get one persisted GitBot thread if its repository is authorized.",
      inputSchema: z.object({ threadId: z.string().min(1) }),
      annotations: readOnly,
    },
    async ({ threadId }) => {
      const thread = getThread(threadId);
      if (!thread) return toolError("Thread not found");
      if (!isAuthorizedRepository(thread.repoPath, repositories)) return toolError("Thread repository is not authorized for this GitBot MCP server");
      return text(thread);
    },
  );

  server.registerTool(
    "gitbot_get_status",
    { description: "Read persisted GitBot status counts for the authorized repositories.", inputSchema: z.object({}), annotations: readOnly },
    async () => {
      const bots = listBots().filter((bot) => !bot.repoPath || isAuthorizedRepository(bot.repoPath, repositories));
      const threads = listThreads().filter((thread) => isAuthorizedRepository(thread.repoPath, repositories));
      return text({
        repositories,
        botCount: bots.length,
        threadCount: threads.length,
        setup: bots.reduce((counts, bot) => {
          const status = bot.setupStatus ?? "not_required";
          counts[status] = (counts[status] ?? 0) + 1;
          return counts;
        }, {} as Record<string, number>),
      });
    },
  );

  return server;
}

export async function startMcpServer(repositories: string[]): Promise<void> {
  const authorized = authorizedRepositories(repositories);
  for (const repoPath of authorized) {
    try {
      if (!statSync(repoPath).isDirectory()) throw new Error("not a directory");
    } catch (err: any) {
      throw new Error(`Invalid --repo path '${repoPath}': ${err?.message ?? "not a directory"}`);
    }
  }

  const server = createGitBotMcpServer({ repositories: authorized });
  const transport = new StdioServerTransport();
  transport.onerror = (err) => console.error(`[gitbot-mcp] transport error: ${err.message}`);
  await server.connect(transport);
}
