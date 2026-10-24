import { dpopKeyOf, generateDpopKeyPair, type DpopKey, type DpopKeyPair } from "./dpop-proof";

/**
 * The DPoP key of each signed-in subject on this installation, kept in the
 * page origin's IndexedDB (database `telo-studio`, store `runner-dpop-key`,
 * one record per subject). A runner grant's refresh token is bound to the key
 * its tokens were issued for, so the key lives as long as the grants it
 * constrains: it survives reloads and is deleted when its subject signs out or
 * another signs in. IndexedDB keeps the `CryptoKey` itself, still
 * non-extractable — no script ever sees the private half.
 */

export const DPOP_KEY_DATABASE = "telo-studio";
export const DPOP_KEY_STORE = "runner-dpop-key";
const DATABASE_VERSION = 1;

interface DpopKeyRecord extends DpopKeyPair {
  subject: string;
}

export interface DpopKeyStore {
  /** The subject's key, made and kept on first use. */
  key(subject: string): Promise<DpopKey>;
  /** Deletes every subject's key but `keep`'s (all of them for null). */
  forgetAllBut(keep: string | null): Promise<void>;
}

export function indexedDbDpopKeyStore(factory: () => IDBFactory = () => globalThis.indexedDB): DpopKeyStore {
  let database: Promise<IDBDatabase> | null = null;
  const keys = new Map<string, Promise<DpopKey>>();

  const open = (): Promise<IDBDatabase> => {
    database ??= openDatabase(factory).then(
      (db) => {
        // A newer Studio in another tab upgrading the store, or the browser
        // closing it: the next use opens it again.
        db.onversionchange = () => {
          db.close();
          database = null;
        };
        db.onclose = () => {
          database = null;
        };
        return db;
      },
      (err: unknown) => {
        database = null;
        throw err;
      },
    );
    return database;
  };

  const load = async (subject: string): Promise<DpopKey> => {
    const db = await open();
    const stored = await request<DpopKeyRecord | undefined>(
      db.transaction(DPOP_KEY_STORE, "readonly").objectStore(DPOP_KEY_STORE).get(subject),
    );
    if (stored) return dpopKeyOf(checkedRecord(stored));
    const made = await generateDpopKeyPair();
    // Another tab may have made one meanwhile: the first kept wins.
    const kept = await new Promise<DpopKeyRecord>((resolve, reject) => {
      const transaction = db.transaction(DPOP_KEY_STORE, "readwrite");
      const store = transaction.objectStore(DPOP_KEY_STORE);
      let record: DpopKeyRecord = { subject, ...made };
      const read = store.get(subject);
      read.onsuccess = () => {
        const existing = read.result as DpopKeyRecord | undefined;
        if (existing) record = existing;
        else store.add(record);
      };
      transaction.oncomplete = () => resolve(record);
      transaction.onerror = () => reject(storeError("keep", transaction.error));
      transaction.onabort = () => reject(storeError("keep", transaction.error));
    });
    return dpopKeyOf(checkedRecord(kept));
  };

  return {
    key(subject) {
      let key = keys.get(subject);
      if (!key) {
        key = load(subject);
        keys.set(subject, key);
        key.catch(() => {
          if (keys.get(subject) === key) keys.delete(subject);
        });
      }
      return key;
    },
    async forgetAllBut(keep) {
      for (const subject of [...keys.keys()]) if (subject !== keep) keys.delete(subject);
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(DPOP_KEY_STORE, "readwrite");
        const store = transaction.objectStore(DPOP_KEY_STORE);
        const listing = store.getAllKeys();
        listing.onsuccess = () => {
          for (const subject of listing.result) if (subject !== keep) store.delete(subject);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(storeError("delete", transaction.error));
        transaction.onabort = () => reject(storeError("delete", transaction.error));
      });
    },
  };
}

function openDatabase(factory: () => IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let opening: IDBOpenDBRequest;
    try {
      const idb = factory();
      if (!idb) throw new Error("this browser offers no IndexedDB");
      opening = idb.open(DPOP_KEY_DATABASE, DATABASE_VERSION);
    } catch (err) {
      reject(storeError("open", err));
      return;
    }
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(DPOP_KEY_STORE)) {
        opening.result.createObjectStore(DPOP_KEY_STORE, { keyPath: "subject" });
      }
    };
    opening.onblocked = () => reject(storeError("open", new Error("another Studio tab holds an older key store open")));
    opening.onerror = () => reject(storeError("open", opening.error));
    opening.onsuccess = () => resolve(opening.result);
  });
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(storeError("read", req.error));
    req.onsuccess = () => resolve(req.result as T);
  });
}

/** A record some other code wrote, or one a browser could not keep whole, is
 *  refused rather than signed with. */
function checkedRecord(record: DpopKeyRecord): DpopKeyPair {
  const { privateKey, publicJwk } = record;
  if (
    !(privateKey instanceof CryptoKey) ||
    privateKey.type !== "private" ||
    privateKey.extractable ||
    typeof publicJwk?.x !== "string" ||
    typeof publicJwk?.y !== "string"
  ) {
    throw new Error("The runner sign-in key kept in this browser is not one Studio made; clear the site's data and sign in again.");
  }
  return { privateKey, publicJwk };
}

function storeError(action: "open" | "read" | "keep" | "delete", cause: unknown): Error {
  const reason = cause instanceof Error || cause instanceof DOMException ? cause.message : String(cause);
  return new Error(`Studio could not ${action} its runner sign-in key in this browser's storage (IndexedDB): ${reason}`, {
    cause,
  });
}
