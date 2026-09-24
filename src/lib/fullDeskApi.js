const ACCESS_TOKEN_KEY = "urban-procure-access-token";

function accessToken() {
  try {
    return localStorage.getItem(ACCESS_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export async function deskRequest(path, { method = "GET", body } = {}) {
  const token = accessToken();
  if (!token) throw new Error("Sign in to use the live procurement desk.");
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || `Desk request failed (${response.status})`);
  return data;
}

export function loadDesk() {
  return deskRequest("/api/desk/bootstrap");
}

export async function downloadPrivateDocument(kind, id, filename = "document") {
  const token = accessToken();
  if (!token) throw new Error("Sign in before opening private documents.");
  const response = await fetch(`/api/desk/documents/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Private document access denied.");
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.rel = "noopener"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Uploads original files only to the authenticated server ingestion routes.
 * The full-desk UI may stage files locally before submit, but it never treats
 * local state or a public URL as a successful server upload.
 */
export async function secureUploadFiles(path, { rfqId, files, payload = {} } = {}) {
  const token = accessToken();
  if (!token) throw new Error("Sign in before uploading procurement documents.");
  if (!rfqId) throw new Error("An RFQ is required.");

  const form = new FormData();
  form.set("rfq_id", rfqId);
  if (Object.keys(payload).length) form.set("rfq", JSON.stringify(payload));
  if (files && files.length) {
    for (const file of files) form.append("files", file, file.name);
  }

  const response = await fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || `Secure upload failed (${response.status})`);
  return data;
}
