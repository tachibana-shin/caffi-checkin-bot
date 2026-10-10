import { seal, unseal } from "./crypto.ts";
import { config } from "./config.ts";
import { d1Store, kvStore, type RecordStore } from "./records.ts";
import type { Account, ChatState, StoreData } from "./types.ts";

/**
 * The whole bot state lives in **one record**, not in a file: no host the bot
 * runs on has a writable filesystem, so the platform provisions one instead
 * (Deno KV on Deno Deploy, D1 on Cloudflare Workers, a local KV file for
 * development). `records.ts` hides which.
 *
 * The payload keeps the old shape (`{"payload": ...}` when encrypted), which
 * means a `store.json` written by an earlier version migrates on first load.
 */
const STORE_KEY = ["caffi", "store"];
const META_KEY = ["caffi", "meta"];

function emptyStore(): StoreData {
  return { version: 1, chats: {} };
}

/**
 * The D1 binding, when the runtime handed us one. On workerd this is the only
 * state store available; everywhere else it is absent and `openRecords` falls
 * back to Deno KV.
 */
function workerDb(): RecordStore | undefined {
  // Set by `src/worker.ts` before anything imports the config.
  const g = globalThis as { __caffiDb?: import("./records.ts").D1Like };
  return g.__caffiDb ? d1Store(g.__caffiDb) : undefined;
}

async function openRecords(): Promise<RecordStore> {
  const db = workerDb();
  if (db) return db; // Cloudflare Workers
  if (config.runtimeMode === "webhook") return kvStore(await Deno.openKv()); // Deno Deploy
  try {
    await Deno.mkdir(config.dataDir, { recursive: true });
    return kvStore(await Deno.openKv(`${config.dataDir}/store.kv`));
  } catch {
    // Not a place where a KV file can live (e.g. a read-only working dir).
    return kvStore(await Deno.openKv());
  }
}

/** Reads the pre-KV `store.json`, if there is one. Missing on every serverless host. */
async function readLegacyFile(): Promise<string | null> {
  if (config.runtimeMode === "webhook" || config.runtimeMode === "worker") return null;
  try {
    return await Deno.readTextFile(`${config.dataDir}/store.json`);
  } catch {
    return null;
  }
}

async function decode(raw: string): Promise<StoreData | undefined> {
  try {
    const parsed = JSON.parse(raw) as StoreData & { payload?: string };
    if (typeof parsed.payload === "string") {
      return await unseal<StoreData>(parsed.payload, config.secret);
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export class Store {
  #data: StoreData = emptyStore();
  #dirty = false;
  #loaded = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #records: RecordStore | undefined;

  get encrypted(): boolean {
    return config.secret.length > 0;
  }

  get data(): StoreData {
    return this.#data;
  }

  /** Loads once; later calls (cron + HTTP in the same isolate) are a no-op. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    const records = await openRecords();
    this.#records = records;

    const stored = await records.get<string>(STORE_KEY);
    if (stored !== null) {
      this.#data = await decode(stored) ?? emptyStore();
      this.#loaded = true;
      return;
    }

    const legacy = await readLegacyFile();
    if (legacy !== null) {
      this.#data = await decode(legacy) ?? emptyStore();
      await records.set(STORE_KEY, legacy);
      console.log(`🚚 Migrated ${config.dataDir}/store.json into the store`);
    } else if (config.storeImport) {
      // One-shot hand-over for a host with no file to migrate from (Deno
      // Deploy): `store.json` arrives as an env var, byte for byte the payload
      // KV wants, still sealed with BOT_SECRET. It is written even when it
      // cannot be decrypted yet so the ciphertext survives until the secret
      // is right — `decode` runs again on every boot.
      const imported = await decode(config.storeImport);
      await records.set(STORE_KEY, config.storeImport);
      this.#data = imported ?? emptyStore();
      console.log(
        imported
          ? `🚚 Seeded the store from STORE_IMPORT — ${
            Object.keys(this.#data.chats).length
          } chat(s)`
          : "⚠️ STORE_IMPORT cannot be decrypted with BOT_SECRET — left in the store, starting empty",
      );
    } else {
      this.#data = emptyStore();
    }
    this.#loaded = true;
  }

  chat(chatId: number | string): ChatState {
    const key = String(chatId);
    this.#data.chats[key] ??= { accounts: {} };
    return this.#data.chats[key]!;
  }

  /** Every account with auto check-in enabled and a still-valid session. */
  autoAccounts(): Array<{ chatId: string; account: Account }> {
    const out: Array<{ chatId: string; account: Account }> = [];
    for (const [chatId, chat] of Object.entries(this.#data.chats)) {
      for (const account of Object.values(chat.accounts)) {
        if (account.autoCheckIn && !account.sessionInvalid) out.push({ chatId, account });
      }
    }
    return out;
  }

  /** Auto is on but the server dropped the session — needs a re-login reminder. */
  invalidAccounts(): Array<{ chatId: string; account: Account }> {
    const out: Array<{ chatId: string; account: Account }> = [];
    for (const [chatId, chat] of Object.entries(this.#data.chats)) {
      for (const account of Object.values(chat.accounts)) {
        if (account.autoCheckIn && account.sessionInvalid) out.push({ chatId, account });
      }
    }
    return out;
  }

  /** Look up an account by username in this chat, or fall back to the active one. */
  resolve(chatId: number | string, username?: string): Account | undefined {
    const chat = this.chat(chatId);
    if (username) return chat.accounts[username];
    if (chat.activeAccount) return chat.accounts[chat.activeAccount];
    const all = Object.values(chat.accounts);
    return all.length === 1 ? all[0] : undefined;
  }

  /**
   * Cross-instance coordination. Deno Deploy runs several isolated copies of
   * the app, so anything "register this once" (the webhook URL) is remembered
   * here instead of in a module variable.
   */
  async meta<T>(key: string): Promise<T | undefined> {
    if (!this.#records) return undefined;
    return (await this.#records.get<T>([...META_KEY, key])) ?? undefined;
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    if (!this.#records) return;
    await this.#records.set([...META_KEY, key], value);
  }

  /** Mark the store as changed and schedule a debounced write (500ms). */
  touch(): void {
    this.#dirty = true;
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, 500);
  }

  /**
   * Write immediately. On Deno Deploy the isolate can be suspended as soon as
   * the HTTP response goes out, so handlers must `await` this before replying —
   * a pending timer would never fire.
   */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (!this.#dirty) return;
    this.#dirty = false;
    if (!this.#records) return;

    const payload = this.encrypted
      ? JSON.stringify({ payload: await seal(this.#data, config.secret) }, null, 2)
      : JSON.stringify(this.#data, null, 2);

    await this.#records.set(STORE_KEY, payload);
  }
}

export const store = new Store();
