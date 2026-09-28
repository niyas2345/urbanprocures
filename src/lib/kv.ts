import type { Env, MailQueue, Project, Quotation, User } from "./types";

const parseJson = <T>(value: string | null): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const listKeysByPrefix = async (
  env: Env,
  prefix: string,
  limit = 1000,
): Promise<{ keys: string[]; count: number }> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix, limit, cursor });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && keys.length < limit);
  return { keys: keys.slice(0, limit), count: keys.length };
};

export const getKVStats = async (env: Env): Promise<{ total_keys: number; estimated_size_kb: number }> => {
  const { keys } = await listKeysByPrefix(env, "", 10000);
  let bytes = 0;
  for (const key of keys) bytes += (await env.KV.get(key))?.length ?? 0;
  return { total_keys: keys.length, estimated_size_kb: Math.ceil(bytes / 1024) };
};

export const getUser = async (env: Env, userId: string): Promise<User | null> =>
  parseJson<User>(await env.KV.get(`user:${userId}`));

export const getUserByEmail = async (env: Env, email: string): Promise<User | null> => {
  const { keys } = await listKeysByPrefix(env, "user:");
  for (const key of keys.filter((key) => !key.endsWith(":projects"))) {
    const user = parseJson<User>(await env.KV.get(key));
    if (user?.email.toLowerCase() === email.toLowerCase()) return user;
  }
  return null;
};

export const createUser = (env: Env, user: User): Promise<void> =>
  env.KV.put(`user:${user.id}`, JSON.stringify(user));

export const updateUser = async (env: Env, userId: string, partial: Partial<User>): Promise<User> => {
  const current = await getUser(env, userId);
  if (!current) throw new Error("User not found");
  const user = { ...current, ...partial, updated_at: new Date().toISOString() };
  await createUser(env, user);
  return user;
};

export const getProject = async (env: Env, userId: string, projectId: string): Promise<Project | null> =>
  parseJson<Project>(await env.KV.get(`project:${userId}:${projectId}`));

export const getProjectsByUser = async (env: Env, userId: string): Promise<Project[]> => {
  const { keys } = await listKeysByPrefix(env, `project:${userId}:`);
  const projects = await Promise.all(keys.map(async (key) => parseJson<Project>(await env.KV.get(key))));
  return projects.filter(Boolean).sort((a, b) => b!.created_at.localeCompare(a!.created_at)) as Project[];
};

export const createProject = async (env: Env, userId: string, project: Project): Promise<void> => {
  await env.KV.put(`project:${userId}:${project.id}`, JSON.stringify(project));
  const indexKey = `user:${userId}:projects`;
  const ids = parseJson<string[]>(await env.KV.get(indexKey)) ?? [];
  await env.KV.put(indexKey, JSON.stringify([...new Set([...ids, project.id])]));
};

export const updateProject = async (
  env: Env,
  userId: string,
  projectId: string,
  partial: Partial<Project>,
): Promise<Project> => {
  const current = await getProject(env, userId, projectId);
  if (!current) throw new Error("Project not found");
  const project = { ...current, ...partial, updated_at: new Date().toISOString() };
  await createProject(env, userId, project);
  return project;
};

export const deleteProject = async (env: Env, userId: string, projectId: string): Promise<void> => {
  await env.KV.delete(`project:${userId}:${projectId}`);
  const indexKey = `user:${userId}:projects`;
  const ids = parseJson<string[]>(await env.KV.get(indexKey)) ?? [];
  await env.KV.put(indexKey, JSON.stringify(ids.filter((id) => id !== projectId)));
};

export const getQuotation = async (env: Env, quotationId: string): Promise<Quotation | null> =>
  parseJson<Quotation>(await env.KV.get(`quotation:${quotationId}`));

export const getQuotationsByProject = async (env: Env, projectId: string): Promise<Quotation[]> => {
  const { keys } = await listKeysByPrefix(env, "quotation:");
  const quotes = await Promise.all(keys.map(async (key) => parseJson<Quotation>(await env.KV.get(key))));
  return quotes.filter((quote): quote is Quotation => quote?.project_id === projectId);
};

export const createQuotation = async (env: Env, quotation: Quotation): Promise<void> => {
  await env.KV.put(`quotation:${quotation.id}`, JSON.stringify(quotation));
};

export const updateQuotation = async (env: Env, quotationId: string, partial: Partial<Quotation>): Promise<Quotation> => {
  const current = await getQuotation(env, quotationId);
  if (!current) throw new Error("Quotation not found");
  const quotation = { ...current, ...partial, updated_at: new Date().toISOString() };
  await createQuotation(env, quotation);
  return quotation;
};

export const deleteQuotation = (env: Env, quotationId: string): Promise<void> => env.KV.delete(`quotation:${quotationId}`);

export const queueMail = (env: Env, mail: MailQueue): Promise<void> => env.KV.put(`mail:${mail.id}`, JSON.stringify(mail));

export const getPendingMails = async (env: Env, limit = 10): Promise<MailQueue[]> => {
  const { keys } = await listKeysByPrefix(env, "mail:");
  const mails = await Promise.all(keys.map(async (key) => parseJson<MailQueue>(await env.KV.get(key))));
  return mails.filter((mail): mail is MailQueue => mail?.status === "pending").slice(0, limit);
};

export const updateMailStatus = async (
  env: Env,
  mailId: string,
  status: "sent" | "failed",
  errorMsg?: string,
): Promise<void> => {
  const mail = parseJson<MailQueue>(await env.KV.get(`mail:${mailId}`));
  if (!mail) throw new Error("Mail not found");
  await env.KV.put(
    `mail:${mailId}`,
    JSON.stringify({ ...mail, status, sent_at: status === "sent" ? new Date().toISOString() : mail.sent_at, error_msg: errorMsg ?? null }),
  );
};

export const deleteExpiredData = async (env: Env, olderThanDays = 30): Promise<number> => {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const { keys } = await listKeysByPrefix(env, "");
  let deleted = 0;
  for (const key of keys) {
    const item = parseJson<{ created_at?: string }>(await env.KV.get(key));
    if (item?.created_at && Date.parse(item.created_at) < cutoff) {
      await env.KV.delete(key);
      deleted += 1;
    }
  }
  return deleted;
};
