import { createProject, createUser, deleteProject, getProject, getProjectsByUser, getUser, updateProject, updateUser } from "../src/lib/kv";
import type { Project, User } from "../src/lib/types";
import { createEnv } from "./helpers";

const now = () => new Date().toISOString();

describe("kv operations", () => {
  test("user CRUD", async () => {
    const env = createEnv();
    const user: User = { id: "u1", email: "u1@test.com", name: "U1", password_hash: "hash", role: "user", created_at: now(), updated_at: now() };
    await createUser(env, user);
    expect(await getUser(env, "u1")).toMatchObject({ email: "u1@test.com" });
    expect(await updateUser(env, "u1", { name: "Updated" })).toMatchObject({ name: "Updated" });
  });

  test("project CRUD and list by prefix", async () => {
    const env = createEnv();
    const project: Project = {
      id: "p1",
      user_id: "u1",
      name: "Tower RFQ",
      description: "Concrete package",
      status: "active",
      supplier_ids: [],
      quotation_ids: [],
      created_at: now(),
      updated_at: now(),
    };
    await createProject(env, "u1", project);
    expect(await getProject(env, "u1", "p1")).toMatchObject({ name: "Tower RFQ" });
    expect(await getProjectsByUser(env, "u1")).toHaveLength(1);
    expect(await updateProject(env, "u1", "p1", { status: "completed" })).toMatchObject({ status: "completed" });
    await deleteProject(env, "u1", "p1");
    expect(await getProject(env, "u1", "p1")).toBeNull();
  });

  test("error cases for missing records", async () => {
    const env = createEnv();
    await expect(updateUser(env, "missing", { name: "Nope" })).rejects.toThrow("User not found");
    await expect(updateProject(env, "u1", "missing", { name: "Nope" })).rejects.toThrow("Project not found");
  });
});
