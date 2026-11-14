/**
 * almoner-sdk: a typed client for Almoner vaults on NEAR.
 *
 *   const vault = new AlmonerVault("vault.you.testnet", "https://rpc.testnet.fastnear.com");
 *   const agent = vault.agent(agentKey);   // a vault-issued function-call key: it can only ask
 *
 * The implementation lives in ts/src/sdk.ts and is shared with the demos, the MCP server and the CLI.
 */
export * from "../../ts/src/sdk.js";
