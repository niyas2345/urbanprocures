import test from "node:test";
import assert from "node:assert/strict";
import { secureUploadFiles } from "./fullDeskApi.js";

test("full-desk secure upload fails closed without a session token", async () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => "" };
  await assert.rejects(
    secureUploadFiles("/api/rfq-documents/upload", { rfqId: "RFQ-1", files: [new Blob(["%PDF"], { type: "application/pdf" })] }),
    /Sign in before uploading/
  );
  globalThis.localStorage = previous;
});

test("full-desk upload sends bearer auth and multipart originals without public URLs", async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  let request;
  globalThis.localStorage = { getItem: () => "session-token" };
  globalThis.fetch = async (path, init) => {
    request = { path, init };
    return new Response(JSON.stringify({ ok: true, attachments: [{ id: "A-1" }] }), { status: 200 });
  };
  const result = await secureUploadFiles("/api/rfq-documents/upload", {
    rfqId: "RFQ-1",
    files: [new File(["%PDF-1.7"], "scope.pdf", { type: "application/pdf" })],
    payload: { title: "Secure RFQ" },
  });
  assert.equal(result.ok, true);
  assert.equal(request.path, "/api/rfq-documents/upload");
  assert.equal(request.init.headers.Authorization, "Bearer session-token");
  assert.equal(request.init.body instanceof FormData, true);
  assert.equal(request.init.body.get("rfq_id"), "RFQ-1");
  assert.equal(request.init.body.get("files").name, "scope.pdf");
  assert.equal(JSON.stringify(result).includes("public"), false);
  globalThis.localStorage = previousStorage;
  globalThis.fetch = previousFetch;
});
