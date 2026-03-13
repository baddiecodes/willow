// ─── Aptos client helpers — willow-sdk ───────────────────────────────────────
// Zero TypeScript errors verified against @aptos-labs/ts-sdk ^1.33.1

import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  Ed25519PrivateKey,
  type MoveFunctionId,
  type MoveStructId,
  type InputGenerateTransactionPayloadData,
  type InputViewFunctionData,
  type SimpleEntryFunctionArgumentTypes,
  type AptosSettings,
  type MoveValue,
} from "@aptos-labs/ts-sdk";

// ─── Network resolution ───────────────────────────────────────────────────────

function resolveNetworkConfig(network?: string): AptosSettings {
  if (!network || network === "testnet") return { network: Network.TESTNET };
  if (network === "mainnet")             return { network: Network.MAINNET };
  if (network === "devnet")              return { network: Network.DEVNET };
  return { fullnode: network, network: Network.CUSTOM };
}

// ─── Client factory ───────────────────────────────────────────────────────────

export function buildAptosClient(network?: string): Aptos {
  return new Aptos(new AptosConfig(resolveNetworkConfig(network)));
}

export function buildAccount(privateKeyHex: string): Account {
  const hex = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex;
  return Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(hex) });
}

// ─── Transaction helper ───────────────────────────────────────────────────────

export async function submitTx(
  aptos:   Aptos,
  account: Account,
  data:    InputGenerateTransactionPayloadData,
  opts?:   { maxGas?: number; gasPrice?: number }
): Promise<string> {
  const tx = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data,
    options: {
      ...(opts?.maxGas   ? { maxGasAmount: opts.maxGas   } : {}),
      ...(opts?.gasPrice ? { gasUnitPrice: opts.gasPrice } : {}),
    },
  });
  const senderAuthenticator = aptos.transaction.sign({ signer: account, transaction: tx });
  const { hash } = await aptos.transaction.submit.simple({
    transaction: tx,
    senderAuthenticator,
  });
  await aptos.waitForTransaction({ transactionHash: hash });
  return hash;
}

// ─── View (read-only) call ────────────────────────────────────────────────────
//
// functionArguments accepts SimpleEntryFunctionArgumentTypes which covers
// string | number | bigint | boolean | Uint8Array | null | undefined | Array<...>
// This is the correct SDK type for serialised Move call args.

export type ViewArg = SimpleEntryFunctionArgumentTypes;

export async function viewFn<T>(
  aptos:    Aptos,
  fn:       string,
  typeArgs: string[],
  args:     ViewArg[]
): Promise<T> {
  if (fn.split("::").length !== 3) {
    throw new Error(`viewFn: invalid function id "${fn}" — expected "addr::module::fn"`);
  }
  const payload: InputViewFunctionData = {
    function:          fn as MoveFunctionId,
    typeArguments:     typeArgs,
    functionArguments: args,
  };
  const result = await aptos.view({ payload });
  return result[0] as T;
}

// Returns all values (for view functions with multiple return values)
export async function viewFnMulti(
  aptos:    Aptos,
  fn:       string,
  typeArgs: string[],
  args:     ViewArg[]
): Promise<MoveValue[]> {
  if (fn.split("::").length !== 3) {
    throw new Error(`viewFnMulti: invalid function id "${fn}"`);
  }
  const payload: InputViewFunctionData = {
    function:          fn as MoveFunctionId,
    typeArguments:     typeArgs,
    functionArguments: args,
  };
  return aptos.view({ payload });
}

// ─── Event fetcher ────────────────────────────────────────────────────────────
// eventType must be a MoveStructId: "addr::module::EventStruct"

export async function getEventsByType<T>(
  aptos:     Aptos,
  eventType: string,
  limit      = 25,
  offset?:   number
): Promise<T[]> {
  const events = await aptos.getModuleEventsByEventType({
    eventType: eventType as MoveStructId,
    options: {
      limit,
      ...(offset !== undefined ? { offset } : {}),
    },
  });
  return events.map((e) => e.data as T);
}

// ─── Resource fetcher ─────────────────────────────────────────────────────────
// resourceType must be a MoveStructId: "addr::module::StructName"

export async function getResource<T>(
  aptos:        Aptos,
  accountAddr:  string,
  resourceType: string
): Promise<T> {
  return aptos.getAccountResource({
    accountAddress: accountAddr,
    resourceType:   resourceType as MoveStructId,
  }) as Promise<T>;
}

// ─── Transaction events ───────────────────────────────────────────────────────

export interface TxEvent {
  type: string;
  data: Record<string, unknown>;
}

export async function getTxEvents(aptos: Aptos, txHash: string): Promise<TxEvent[]> {
  const tx = await aptos.getTransactionByHash({ transactionHash: txHash });
  return ((tx as unknown as { events?: TxEvent[] }).events) ?? [];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Zero-pad an Aptos address to the full 32-byte 0x-prefixed form */
export function normaliseAddress(addr: string): string {
  const hex = addr.startsWith("0x") ? addr.slice(2) : addr;
  return "0x" + hex.padStart(64, "0");
}

/** Current Aptos epoch number */
export async function getCurrentEpoch(aptos: Aptos): Promise<number> {
  const info = await aptos.getLedgerInfo();
  return Number(info.epoch);
}
