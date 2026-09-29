export interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: "user" | "admin";
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description: string;
  status: "active" | "archived" | "completed";
  created_at: string;
  updated_at: string;
  supplier_ids: string[];
  quotation_ids: string[];
}

export interface Quotation {
  id: string;
  project_id: string;
  supplier_id: string;
  amount: number;
  currency: string;
  status: "draft" | "sent" | "accepted" | "rejected";
  valid_until: string;
  created_at: string;
  updated_at: string;
}

export interface Supplier {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  category: string;
  rating: number;
  created_at: string;
}

export interface MailQueue {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  created_at: string;
  sent_at: string | null;
  error_msg: string | null;
  project_id?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface AuthPayload {
  user_id: string;
  email: string;
  iat: number;
  exp: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  ASSETS: Fetcher;
  JWT_SECRET: string;
  WEBHOOK_SECRET: string;
  ZOHO_CLIENT_ID: string;
  ZOHO_CLIENT_SECRET: string;
  ZOHO_REFRESH_TOKEN: string;
  ZOHO_ACCOUNT_ID: string;
  ZOHO_SENDER_EMAIL: string;
  MAILGUN_API_KEY: string;
  MAILGUN_DOMAIN: string;
  MAILGUN_SENDER_EMAIL: string;
}
