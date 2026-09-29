import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { uploadRFQDocuments, validateFile } from "./rfq-documents.js";

const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  PROCUREMENT_TEST_AUTH: "1"
};

test("RFQ upload validation accepts PDF and images", () => {
  assert.equal(validateFile(file("scope.pdf", "application/pdf")).extension, "pdf");
  assert.equal(validateFile(file("scan.jpg", "image/jpeg")).extension, "jpg");
});

test("RFQ upload validation rejects oversized files before storage", async () => {
  const response = await runUpload({
    files: [file("large.pdf", "application/pdf", 26 * 1024 * 1024)],
    fetch: async (url) => {
      if (url.includes("/rest/v1/rfqs?")) return json([{ id: "RFQ-2401", client_id: "user-1" }]);
      assert.fail("storage should not be called");
    }
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /25 MB/);
});

test("RFQ upload validation rejects dangerous file types before storage", async () => {
  const response = await runUpload({
    files: [file("malware.exe", "application/x-msdownload")],
    fetch: async (url) => {
      if (url.includes("/rest/v1/rfqs?")) return json([{ id: "RFQ-2401", client_id: "user-1" }]);
      assert.fail("storage should not be called");
    }
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /unsupported file format/);
});

test("RFQ upload creates private storage object, attachment, document, and job", async () => {
  const calls = [];
  const response = await runUpload({
    files: [sample("scope.pdf", "application/pdf", "%PDF-1.7\n/Font\nBT (Scope) Tj ET\n%%EOF")],
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes("/rest/v1/rfqs?")) return json([{ id: "RFQ-2401", client_id: "user-1" }]);
      if (url.includes("/storage/v1/object/rfq-documents/") && init.method === "POST") return json({ Key: "ok" });
      if (url.includes("/rest/v1/attachments")) return json([{ id: "att-1", name: "scope.pdf", storage_path: "stored/path.pdf" }]);
      if (url.includes("/rest/v1/rfq_documents")) return json([{ id: "doc-1", rfq_id: "RFQ-2401", original_filename: "scope.pdf" }]);
      if (url.includes("/rest/v1/document_processing_jobs")) return json([{ id: "job-1" }]);
      return json({});
    }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.bucket, "rfq-documents");
  assert.equal(calls.some((call) => call.url.includes("/storage/v1/object/rfq-documents/") && call.init.method === "POST"), true);
  assert.equal(calls.some((call) => call.url.includes("/rest/v1/attachments")), true);
  assert.equal(calls.some((call) => call.url.includes("/rest/v1/rfq_documents")), true);
  assert.equal(calls.some((call) => call.url.includes("/rest/v1/document_processing_jobs")), true);
  assert.equal(JSON.stringify(body).includes("publicUrl"), false);
  assert.equal(JSON.stringify(body).includes("storage_path"), false);
});

test("RFQ upload marks spoofed content rejected without creating a processing job", async () => {
  let documentInsert = null;
  const calls = [];
  const response = await runUpload({
    files: [binary("spoof.pdf", "application/pdf", [0x4d, 0x5a, 0, 0])],
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes("/rest/v1/rfqs?")) return json([{ id: "RFQ-2401", client_id: "user-1" }]);
      if (url.includes("/storage/v1/object/rfq-documents/") && init.method === "POST") return json({ Key: "ok" });
      if (url.includes("/rest/v1/attachments")) return json([{ id: "att-1", name: "spoof.pdf", ai_status: "rejected" }]);
      if (url.includes("/rest/v1/rfq_documents")) {
        documentInsert = JSON.parse(init.body);
        return json([{ id: "doc-1", ...documentInsert }]);
      }
      if (url.includes("/rest/v1/document_processing_jobs")) assert.fail("rejected files must not create processing jobs");
      return json({});
    }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(documentInsert.processing_status, "blocked");
  assert.equal(documentInsert.requires_human_review, true);
  assert.equal(calls.some((call) => call.url.includes("/storage/v1/object/rfq-documents/") && call.init.method === "POST"), true);
  assert.equal(calls.some((call) => call.url.includes("/rest/v1/document_processing_jobs")), false);
  assert.equal(JSON.stringify(body).includes("publicUrl"), false);
});

test("RFQ upload rejects another user's RFQ", async () => {
  const response = await runUpload({
    files: [file("scope.pdf", "application/pdf")],
    fetch: async (url) => {
      if (url.includes("/rest/v1/rfqs?")) return json([{ id: "RFQ-2401", client_id: "other-user" }]);
      assert.fail("upload should stop before storage");
    }
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not permitted/);
});

test("RFQ upload removes storage object when database insert fails", async () => {
  const calls = [];
  const response = await runUpload({
    files: [file("scope.pdf", "application/pdf")],
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes("/rest/v1/rfqs?")) return json([{ id: "RFQ-2401", client_id: "user-1" }]);
      if (url.includes("/storage/v1/object/rfq-documents/") && init.method === "POST") return json({ Key: "ok" });
      if (url.includes("/rest/v1/attachments")) return json({ message: "database unavailable" }, 500);
      if (url.includes("/storage/v1/object/rfq-documents/") && init.method === "DELETE") return json({});
      return json({});
    }
  });
  assert.equal(response.status, 400);
  assert.equal(calls.some((call) => call.url.includes("/storage/v1/object/rfq-documents/") && call.init.method === "DELETE"), true);
});

test("RFQ document bucket migration keeps originals private", () => {
  const sql = readFileSync("supabase/migrations/20260828_rfq_document_upload.sql", "utf8");
  assert.match(sql, /insert into storage\.buckets \(id, name, public\)/i);
  assert.match(sql, /values \('rfq-documents', 'rfq-documents', false\)/i);
  assert.match(sql, /on conflict \(id\) do update set public = false/i);
});

test("RFQ document storage policies only allow owner folder reads", () => {
  const sql = readFileSync("supabase/migrations/20260828_rfq_document_upload.sql", "utf8");
  assert.match(sql, /create policy "rfq documents owner read" on storage\.objects/i);
  assert.match(sql, /bucket_id = 'rfq-documents'/i);
  assert.match(sql, /\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)::text\)/i);
  assert.doesNotMatch(sql, /for select to anon[\s\S]*using\s*\(\s*true\s*\)/i);
});

async function runUpload({ files, fetch }) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const form = new FormData();
    form.set("user_id", "user-1");
    form.set("rfq_id", "RFQ-2401");
    for (const item of files) form.append("files", item, item.name);
    return await uploadRFQDocuments(new Request("https://app.test/api/rfq-documents/upload", { method: "POST", body: form }), env);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function file(name, type, size = 128) {
  const blob = new Blob([new Uint8Array(size)], { type });
  blob.name = name;
  return blob;
}
function sample(name, type, content) {
  const blob = new Blob([content], { type });
  blob.name = name;
  return blob;
}
function binary(name, type, bytes) {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  blob.name = name;
  return blob;
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
