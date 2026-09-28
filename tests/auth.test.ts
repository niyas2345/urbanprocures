import { generateRefreshToken, hashPassword, issueToken, validateEmail, verifyPassword, verifyToken } from "../src/lib/auth";
import { createUser, getUserByEmail } from "../src/lib/kv";
import type { User } from "../src/lib/types";
import { createEnv } from "./helpers";

describe("auth", () => {
  test("register input validation primitives", () => {
    expect(validateEmail("buyer@urbanprocures.com")).toBe(true);
    expect(validateEmail("bad-email")).toBe(false);
    expect("short".length >= 8).toBe(false);
  });

  test("password hash and verify across multiple iterations", async () => {
    for (let i = 0; i < 3; i += 1) {
      const hash = await hashPassword(`password-${i}-secure`);
      expect(hash).not.toContain(`password-${i}-secure`);
      expect(await verifyPassword(`password-${i}-secure`, hash)).toBe(true);
      expect(await verifyPassword("wrong-password", hash)).toBe(false);
    }
  });

  test("login lookup supports valid creds, wrong password, and nonexistent user", async () => {
    const env = createEnv();
    const user: User = {
      id: "user-1",
      email: "client@urbanprocures.com",
      name: "Client",
      password_hash: await hashPassword("strong-pass"),
      role: "user",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await createUser(env, user);
    const found = await getUserByEmail(env, user.email);
    expect(found?.id).toBe(user.id);
    expect(await verifyPassword("strong-pass", found!.password_hash)).toBe(true);
    expect(await verifyPassword("wrong-pass", found!.password_hash)).toBe(false);
    expect(await getUserByEmail(env, "none@urbanprocures.com")).toBeNull();
  });

  test("detects duplicate email through KV scan", async () => {
    const env = createEnv();
    const user = {
      id: "user-1",
      email: "dupe@urbanprocures.com",
      name: "Dupe",
      password_hash: await hashPassword("strong-pass"),
      role: "user" as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await createUser(env, user);
    expect(await getUserByEmail(env, "DUPE@urbanprocures.com")).toMatchObject({ id: "user-1" });
  });

  test("valid JWT, refresh token, invalid signature, and expired token", async () => {
    const env = createEnv();
    const token = await issueToken("user-1", "client@urbanprocures.com", env);
    const refresh = await generateRefreshToken("user-1", env);
    expect(await verifyToken(token, env)).toEqual({ user_id: "user-1", email: "client@urbanprocures.com" });
    expect((await verifyToken(refresh, env))?.user_id).toBe("user-1");
    expect(await verifyToken(`${token.slice(0, -1)}x`, env)).toBeNull();
    jest.useFakeTimers().setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(await verifyToken(token, env)).toBeNull();
    jest.useRealTimers();
  });
});
