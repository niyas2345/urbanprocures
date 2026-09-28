import type { Env } from "../src/lib/types";

class MemoryKV {
  private store = new Map<string, string>();

  async get<T = string>(key: string, type?: "text" | "json"): Promise<T | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return (type === "json" ? JSON.parse(value) : value) as T;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list({ prefix = "" }: { prefix?: string } = {}): Promise<{ keys: { name: string }[]; list_complete: true }> {
    return { keys: [...this.store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

class MemoryR2 {
  async put(): Promise<unknown> {
    return {};
  }

  async list(): Promise<{ objects: { key: string; uploaded: Date }[] }> {
    return { objects: [] };
  }

  async delete(): Promise<void> {}
}

export const createEnv = (): Env =>
  ({
    KV: new MemoryKV(),
    R2: new MemoryR2(),
    JWT_SECRET: "test-secret".repeat(4),
    WEBHOOK_SECRET: "webhook-secret",
    ZOHO_CLIENT_ID: "",
    ZOHO_CLIENT_SECRET: "",
    ZOHO_REFRESH_TOKEN: "",
    ZOHO_ACCOUNT_ID: "",
    ZOHO_DC: "com",
    ZOHO_SENDER_EMAIL: "noreply@urbanprocures.com",
    ZOHO_FROM_EMAIL: "desk@urbanprocures.com",
    MAILGUN_API_KEY: "key-test",
    MAILGUN_DOMAIN: "mail.urbanprocures.com",
    MAILGUN_SENDER_EMAIL: "noreply@urbanprocures.com",
  }) as unknown as Env;
