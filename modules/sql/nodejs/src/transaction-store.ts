import { AsyncLocalStorage } from "async_hooks";

export interface TxEntry {
  client: unknown;
  driver: "postgres" | "sqlite";
}

const txMap = new Map<string, TxEntry>();
export const txStorage = new AsyncLocalStorage<string>();

export const setTx = (id: string, entry: TxEntry): void => {
  txMap.set(id, entry);
};

export const getTx = (id: string): TxEntry | undefined => txMap.get(id);

export const deleteTx = (id: string): void => {
  txMap.delete(id);
};

export const currentTxId = (): string | undefined => txStorage.getStore();
