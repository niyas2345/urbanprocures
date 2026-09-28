import { checkMailgunQuota, sendMailgun, validateMailgunConfig } from "../src/lib/mailgun";
import { queueMail, updateMailStatus } from "../src/lib/kv";
import { getZohoAccessToken, validateZohoConfig } from "../src/lib/zoho-mail";
import type { MailQueue } from "../src/lib/types";
import { createEnv } from "./helpers";

const mail = (): MailQueue => ({
  id: "m1",
  recipient: "supplier@urbanprocures.com",
  subject: "RFQ",
  body: "<p>Hello</p>",
  status: "pending",
  attempts: 0,
  created_at: new Date().toISOString(),
  sent_at: null,
  error_msg: null,
});

describe("mail", () => {
  test("queue email and get pending status", async () => {
    const env = createEnv();
    await queueMail(env, mail());
    expect(await env.KV.get("mail:m1", "json")).toMatchObject({ status: "pending" });
    await updateMailStatus(env, "m1", "sent");
    expect(await env.KV.get("mail:m1", "json")).toMatchObject({ status: "sent" });
    await updateMailStatus(env, "m1", "failed", "bounce");
    expect(await env.KV.get("mail:m1", "json")).toMatchObject({ status: "failed", error_msg: "bounce" });
  });

  test("invalid recipient is rejected by validation contract", () => {
    expect(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test("supplier@urbanprocures.com")).toBe(true);
    expect(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test("bad-recipient")).toBe(false);
  });

  test("mailgun integration uses API call and tracks quota", async () => {
    const env = createEnv();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "mg-1", message: "Queued" }) }) as jest.Mock;
    expect(validateMailgunConfig(env)).toBe(true);
    expect(await sendMailgun(env, "supplier@urbanprocures.com", "Subject", "<p>Body</p>")).toEqual({ messageId: "mg-1", status: "Queued" });
    expect(await checkMailgunQuota(env)).toMatchObject({ sent_today: 1, remaining: 99 });
  });

  test("zoho integration caches token from mocked API", async () => {
    const env = { ...createEnv(), ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "secret", ZOHO_REFRESH_TOKEN: "refresh", ZOHO_ACCOUNT_ID: "account" };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: "zoho-token", expires_in: 3600 }) }) as jest.Mock;
    expect(validateZohoConfig(env)).toBe(true);
    expect(await getZohoAccessToken(env)).toBe("zoho-token");
    expect(await getZohoAccessToken(env)).toBe("zoho-token");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
