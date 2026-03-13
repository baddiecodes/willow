// ─── Willow onchain constants ───────────────────────────────────────────────

export const WILLOW_ADDRESS =
  "0xb72a54bf4c5fe6e4448e7fd77dcc58c130141a3eba9eed2de7066fde3479aab3";

// Module identifiers
export const MODULE_COLLECTION     = `${WILLOW_ADDRESS}::collection`;
export const MODULE_ACCESS_CONTROL = `${WILLOW_ADDRESS}::access_control`;
export const MODULE_AGENT_REGISTRY = `${WILLOW_ADDRESS}::agent_registry`;
export const MODULE_REPUTATION     = `${WILLOW_ADDRESS}::reputation`;

// Access policy values (mirror Move constants)
export const ACCESS_OPEN:       number = 0;
export const ACCESS_OWNER_ONLY: number = 1;
export const ACCESS_ALLOWLIST:  number = 2;
export const ACCESS_PAID:       number = 3;

// Distance metric values (mirror Move constants)
export const METRIC_COSINE:    number = 0;
export const METRIC_EUCLIDEAN: number = 1;
export const METRIC_DOT:       number = 2;

// Proof TTL defaults (microseconds)
export const DEFAULT_TTL_US: bigint = 300_000_000n;
export const MAX_TTL_US:     bigint = 600_000_000n;

// Chunk binary header
export const CHUNK_MAGIC = Buffer.from([0x53, 0x56, 0x45, 0x4b]); // "SVEK"
export const CHUNK_HEADER_BYTES = 16;

// Network defaults
export const SHELBYNET_RPC = "https://shelbynet.shelby.xyz"; // update when live
export const APTOS_TESTNET = "https://api.testnet.aptoslabs.com/v1";
export const APTOS_MAINNET = "https://api.mainnet.aptoslabs.com/v1";
