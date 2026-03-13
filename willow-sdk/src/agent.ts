// ─── Agent registry + reputation operations ───────────────────────────────────

import type { Aptos, Account } from "@aptos-labs/ts-sdk";
import {
  MODULE_AGENT_REGISTRY,
  MODULE_REPUTATION,
} from "./constants.js";
import { submitTx, viewFn } from "./aptos.js";
import { uploadJson } from "./shelby.js";
import type {
  RegisterAgentParams,
  RegisterAgentResult,
  AgentInfo,
  AgentMetadata,
  ScoreInfo,
} from "./types.js";

// ─── Agent registry ───────────────────────────────────────────────────────────

export async function registerAgent(
  aptos:   Aptos,
  account: Account,
  params:  RegisterAgentParams
): Promise<RegisterAgentResult> {
  const shelbyOpts = {
    privateKey: (account as unknown as { privateKey?: { toString(): string } }).privateKey?.toString(),
  };

  // Build DID stub — real DID is deterministic from address + seq, computed onchain.
  // We upload metadata first (without DID), then update after registration.
  const metaWithoutDid: AgentMetadata = {
    ...params.metadata,
    "@context": params.metadata["@context"] ?? "https://schema.org/",
    "@type":    params.metadata["@type"]    ?? "SoftwareAgent",
    identifier: "pending",
    createdAt:  params.metadata.createdAt ?? new Date().toISOString(),
  };

  const { blobId: metadataBlobId } = await uploadJson(metaWithoutDid, shelbyOpts);

  const txHash = await submitTx(aptos, account, {
    function: `${MODULE_AGENT_REGISTRY}::register_agent`,
    functionArguments: [metadataBlobId],
  });

  // Derive agent address from the tx receipt
  const agentAddr = await resolveAgentAddrFromTx(aptos, txHash);
  const did       = await getAgentDid(aptos, agentAddr);

  // Re-upload metadata with real DID
  const metaWithDid: AgentMetadata = { ...metaWithoutDid, identifier: did };
  const { blobId: finalBlobId } = await uploadJson(metaWithDid, shelbyOpts);
  await submitTx(aptos, account, {
    function: `${MODULE_AGENT_REGISTRY}::update_metadata`,
    functionArguments: [agentAddr, finalBlobId],
  });

  // Optionally link memory collection
  if (params.memoryCollectionAddr) {
    await submitTx(aptos, account, {
      function: `${MODULE_AGENT_REGISTRY}::link_memory_collection`,
      functionArguments: [agentAddr, params.memoryCollectionAddr],
    });
  }

  // Optionally initialise reputation
  if (params.initReputation) {
    const emptyHistory = { agentAddr, events: [] };
    const { blobId: histBlobId } = await uploadJson(emptyHistory, shelbyOpts);
    await submitTx(aptos, account, {
      function: `${MODULE_REPUTATION}::initialise_score`,
      functionArguments: [agentAddr, histBlobId],
    });
  }

  return { agentAddr, did, metadataBlobId: finalBlobId, txHash };
}

export async function updateAgentMetadata(
  aptos:    Aptos,
  account:  Account,
  agentAddr: string,
  metadata: AgentMetadata
): Promise<string> {
  const shelbyOpts = {
    privateKey: (account as unknown as { privateKey?: { toString(): string } }).privateKey?.toString(),
  };
  const { blobId } = await uploadJson(metadata, shelbyOpts);
  return submitTx(aptos, account, {
    function: `${MODULE_AGENT_REGISTRY}::update_metadata`,
    functionArguments: [agentAddr, blobId],
  });
}

export async function linkMemoryCollection(
  aptos:           Aptos,
  account:         Account,
  agentAddr:       string,
  collectionAddr:  string
): Promise<string> {
  return submitTx(aptos, account, {
    function: `${MODULE_AGENT_REGISTRY}::link_memory_collection`,
    functionArguments: [agentAddr, collectionAddr],
  });
}

export async function deactivateAgent(
  aptos:    Aptos,
  account:  Account,
  agentAddr: string
): Promise<string> {
  return submitTx(aptos, account, {
    function: `${MODULE_AGENT_REGISTRY}::deactivate_agent`,
    functionArguments: [agentAddr],
  });
}

// ─── Agent views ──────────────────────────────────────────────────────────────

export async function getAgentInfo(
  aptos:    Aptos,
  agentAddr: string
): Promise<AgentInfo> {
  const resource = await aptos.getAccountResource({
    accountAddress: agentAddr,
    resourceType:   `${MODULE_AGENT_REGISTRY}::AgentDID`,
  }) as Record<string, unknown>;

  return {
    did:              resource.did as string,
    owner:            resource.owner as string,
    metadataBlobId:   resource.metadata_blob_id as string,
    memoryCollection: resource.memory_collection as string,
    seq:              BigInt(resource.seq as string),
    active:           Boolean(resource.active),
    createdAt:        BigInt(resource.created_at as string),
    updatedAt:        BigInt(resource.updated_at as string),
  };
}

export async function getAgentDid(aptos: Aptos, agentAddr: string): Promise<string> {
  return viewFn<string>(aptos, `${MODULE_AGENT_REGISTRY}::get_did`, [], [agentAddr]);
}

export async function getTotalAgents(aptos: Aptos): Promise<number> {
  const n = await viewFn<string>(aptos, `${MODULE_AGENT_REGISTRY}::total_agents`, [], []);
  return Number(n);
}

export async function lookupByDid(aptos: Aptos, did: string): Promise<string> {
  return viewFn<string>(aptos, `${MODULE_AGENT_REGISTRY}::lookup_by_did`, [], [did]);
}

// ─── Reputation ───────────────────────────────────────────────────────────────

export async function getScore(aptos: Aptos, agentAddr: string): Promise<ScoreInfo> {
  const resource = await aptos.getAccountResource({
    accountAddress: agentAddr,
    resourceType:   `${MODULE_REPUTATION}::AgentScore`,
  }) as Record<string, unknown>;

  return {
    agentAddr,
    scoreBps:         BigInt(resource.score_bps as string),
    interactionCount: BigInt(resource.interaction_count as string),
    historyBlobId:    resource.history_blob_id as string,
    lastUpdated:      BigInt(resource.last_updated as string),
  };
}

export async function submitScoreUpdate(
  aptos:     Aptos,
  reporter:  Account,
  agentAddr: string,
  deltaBps:  number,
  positive:  boolean
): Promise<string> {
  return submitTx(aptos, reporter, {
    function: `${MODULE_REPUTATION}::submit_score_update`,
    functionArguments: [agentAddr, deltaBps.toString(), positive],
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function resolveAgentAddrFromTx(aptos: Aptos, txHash: string): Promise<string> {
  const tx = await aptos.getTransactionByHash({ transactionHash: txHash });
  // Events emitted by register_agent include AgentRegistered with agent_addr field
  const events = (tx as unknown as { events?: Array<{ data: Record<string, unknown> }> }).events ?? [];
  const registered = events.find(
    (e) => (e.data as Record<string, unknown>).agent_addr !== undefined
  );
  if (registered) return registered.data.agent_addr as string;
  throw new Error("AgentRegistered event not found in tx " + txHash);
}
