// Library entry point: build an MCP server for any set of credentials.
export { createServer } from "./server.js";
export { credentialsFromEnv, clientsFromEnv, optionsFromEnv } from "./env.js";
export { enabledPlatforms, type EnabledPlatforms } from "./platforms/enabled.js";
export { findClient, fuzzyMatch, parseClients } from "./clients.js";
export { VERSION } from "./version.js";
export type * from "./types.js";
