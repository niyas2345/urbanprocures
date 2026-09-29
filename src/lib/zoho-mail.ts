import type { Env } from "./types";

export const validateZohoConfig = (env: Env): boolean =>
  Boolean(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN && env.ZOHO_ACCOUNT_ID && env.ZOHO_SENDER_EMAIL);

export const getZohoAccessToken = async (env: Env): Promise<string> => {
  const cached = await env.KV.get("zoho:access_token");
  if (cached) return cached;
  if (!validateZohoConfig(env)) throw new Error("Zoho configuration missing");

  const body = new URLSearchParams({
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://accounts.zoho.com/oauth/v2/token", { method: "POST", body });
  if (!response.ok) throw new Error(`Zoho token request failed: ${response.status}`);
  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Zoho token response missing access_token");
  await env.KV.put("zoho:access_token", data.access_token, { expirationTtl: Math.max((data.expires_in ?? 3600) - 60, 60) });
  return data.access_token;
};

export const sendZohoMail = async (
  env: Env,
  recipient: string,
  subject: string,
  body: string,
  isHtml = true,
): Promise<{ messageId: string; status: string }> => {
  const token = await getZohoAccessToken(env);
  const response = await fetch(`https://mail.zoho.com/api/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fromAddress: env.ZOHO_SENDER_EMAIL,
      toAddress: [recipient],
      ccAddress: [],
      bccAddress: [],
      subject,
      content: body,
      isHtml,
    }),
  });
  if (!response.ok) throw new Error(`Zoho mail failed: ${response.status}`);
  const data = (await response.json()) as { data?: { messageId?: string; id?: string }; id?: string; status?: string };
  return { messageId: data.data?.messageId ?? data.data?.id ?? data.id ?? crypto.randomUUID(), status: data.status ?? "sent" };
};
