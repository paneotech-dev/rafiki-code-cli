// A stand-in for graphify's MCP server (graphify-mcp): the same ten tool names.
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const names = [
  "query_graph",
  "get_node",
  "get_neighbors",
  "get_community",
  "god_nodes",
  "graph_stats",
  "shortest_path",
  "list_prs",
  "get_pr_impact",
  "triage_prs",
]

const server = new Server({ name: "graphify", version: "0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: names.map((name) => ({
      name,
      description: `graphify ${name}`,
      inputSchema: { type: "object", properties: { question: { type: "string" }, demote_docs: { type: "boolean" } } },
    })),
  }),
)
await server.connect(new StdioServerTransport())
