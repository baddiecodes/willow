// ─── WillowClient — main SDK entry point ─────────────────────────────────────

import { Aptos, Account } from "@aptos-labs/ts-sdk";
import { buildAptosClient, buildAccount } from "./aptos.js";
import * as Collection from "./collection.js";
import * as Agent from "./agent.js";
import type {
  WillowConfig,
  CreateCollectionParams,
  AddChunkParams,
  AddChunkResult,
  BatchAddChunksParams,
  UpdateIndexParams,
  CollectionInfo,
  ConfigureAccessParams,
  RequestReadProofParams,
  ReadProofResult,
  RegisterAgentParams,
  RegisterAgentResult,
  AgentInfo,
  ScoreInfo,
} from "./types.js";

export class WillowClient {
  private aptos:   Aptos;
  private account: Account;

  constructor(private config: WillowConfig) {
    this.aptos   = buildAptosClient(config.network);
    this.account = buildAccount(config.privateKey);
    if (config.openaiApiKey) process.env.OPENAI_API_KEY = config.openaiApiKey;
    if (config.shelbyRpc)    process.env.SHELBY_RPC     = config.shelbyRpc;
  }

  get address(): string {
    return this.account.accountAddress.toString();
  }

  // ── Collection ─────────────────────────────────────────────────────────────

  /** Compute the deterministic onchain address for a collection you own */
  async collectionAddress(name: string): Promise<string> {
    return Collection.collectionAddress(this.aptos, this.address, name);
  }

  async createCollection(params: CreateCollectionParams): Promise<string> {
    return Collection.createCollection(this.aptos, this.account, params);
  }

  async getCollectionInfo(collectionAddr: string): Promise<CollectionInfo> {
    return Collection.getCollectionInfo(this.aptos, collectionAddr);
  }

  async addChunk(params: AddChunkParams): Promise<AddChunkResult> {
    return Collection.addChunk(this.aptos, this.account, params);
  }

  async addChunksBatch(params: BatchAddChunksParams) {
    return Collection.addChunksBatch(this.aptos, this.account, params);
  }

  async updateIndex(params: UpdateIndexParams) {
    return Collection.updateIndex(this.aptos, this.account, params);
  }

  async setAccessPolicy(collectionAddr: string, policy: number): Promise<string> {
    return Collection.setAccessPolicy(this.aptos, this.account, collectionAddr, policy);
  }

  async configureAccess(params: ConfigureAccessParams): Promise<string> {
    return Collection.configureAccess(this.aptos, this.account, params);
  }

  async setAllowlistEntry(collectionAddr: string, subject: string, allowed: boolean): Promise<string> {
    return Collection.setAllowlistEntry(this.aptos, this.account, collectionAddr, subject, allowed);
  }

  async requestReadProof(params: RequestReadProofParams): Promise<ReadProofResult> {
    return Collection.requestReadProof(this.aptos, this.account, params);
  }

  // ── Agent ──────────────────────────────────────────────────────────────────

  async registerAgent(params: RegisterAgentParams): Promise<RegisterAgentResult> {
    return Agent.registerAgent(this.aptos, this.account, params);
  }

  async getAgentInfo(agentAddr: string): Promise<AgentInfo> {
    return Agent.getAgentInfo(this.aptos, agentAddr);
  }

  async linkMemoryCollection(agentAddr: string, collectionAddr: string): Promise<string> {
    return Agent.linkMemoryCollection(this.aptos, this.account, agentAddr, collectionAddr);
  }

  async deactivateAgent(agentAddr: string): Promise<string> {
    return Agent.deactivateAgent(this.aptos, this.account, agentAddr);
  }

  async getTotalAgents(): Promise<number> {
    return Agent.getTotalAgents(this.aptos);
  }

  async lookupByDid(did: string): Promise<string> {
    return Agent.lookupByDid(this.aptos, did);
  }

  // ── Reputation ─────────────────────────────────────────────────────────────

  async getScore(agentAddr: string): Promise<ScoreInfo> {
    return Agent.getScore(this.aptos, agentAddr);
  }

  /** Reporter-only: submit a score delta */
  async submitScoreUpdate(agentAddr: string, deltaBps: number, positive: boolean): Promise<string> {
    return Agent.submitScoreUpdate(this.aptos, this.account, agentAddr, deltaBps, positive);
  }
}
