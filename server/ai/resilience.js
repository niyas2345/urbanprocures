/**
 * Resilience Patterns: Retry, Circuit Breaker, Dead Letter Queue
 * Production-grade fault tolerance for async job processing
 */

export const RETRY_POLICIES = Object.freeze({
  DEFAULT: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2, jitter: true },
  FAST: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2, jitter: true },
  SLOW: { maxAttempts: 5, baseDelayMs: 5000, maxDelayMs: 300000, backoffMultiplier: 1.5, jitter: true },
  CRITICAL: { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 600000, backoffMultiplier: 2, jitter: true }
});

export const CIRCUIT_BREAKER_STATES = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open'
});

export class CircuitBreaker {
  constructor(id, options = {}) {
    this.id = id;
    this.state = CIRCUIT_BREAKER_STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.openedAt = null;
    this.threshold = options.threshold || 5;
    this.timeoutMs = (options.timeoutSeconds || 60) * 1000;
    this.halfOpenRequests = 0;
    this.maxHalfOpenRequests = options.maxHalfOpenRequests || 3;
    this.env = options.env || null;
    this.persistEnabled = !!options.env;
    this._persistDebounce = null;
  }

  async loadState() {
    if (!this.persistEnabled) return;
    try {
      const key = this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SECRET_KEY;
      const response = await fetch(`${this.env.SUPABASE_URL}/rest/v1/circuit_breakers?id=eq.${encodeURIComponent(this.id)}&select=*`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        const rows = await response.json();
        if (rows[0]) {
          const row = rows[0];
          this.state = row.state;
          this.failureCount = row.failure_count || 0;
          this.successCount = row.success_count || 0;
          this.lastFailureAt = row.last_failure_at ? new Date(row.last_failure_at).getTime() : null;
          this.lastSuccessAt = row.last_success_at ? new Date(row.last_success_at).getTime() : null;
          this.openedAt = row.opened_at ? new Date(row.opened_at).getTime() : null;
          this.threshold = row.threshold || this.threshold;
          this.timeoutMs = (row.timeout_seconds || 60) * 1000;
        }
      }
    } catch (error) {
      console.warn(`Failed to load circuit breaker state for ${this.id}:`, error.message);
    }
  }

  async persistState() {
    if (!this.persistEnabled) return;
    if (this._persistDebounce) clearTimeout(this._persistDebounce);
    this._persistDebounce = setTimeout(async () => {
      try {
        const path = `/rest/v1/circuit_breakers?id=eq.${encodeURIComponent(this.id)}`;
        const key = this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SECRET_KEY;
        const body = {
          state: this.state,
          failure_count: this.failureCount,
          success_count: this.successCount,
          last_failure_at: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
          last_success_at: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
          opened_at: this.openedAt ? new Date(this.openedAt).toISOString() : null,
          threshold: this.threshold,
          timeout_seconds: this.timeoutMs / 1000,
          updated_at: new Date().toISOString()
        };
        await fetch(`${this.env.SUPABASE_URL}/rest/v1/circuit_breakers?id=eq.${encodeURIComponent(this.id)}`, {
          method: 'PATCH',
          headers: { apikey: this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(body)
        });
      } catch (error) {
        console.warn(`Failed to persist circuit breaker state for ${this.id}:`, error.message);
      }
    }, 100);
  }

  async execute(operation) {
    if (this.state === CIRCUIT_BREAKER_STATES.OPEN) {
      if (Date.now() - this.openedAt >= this.timeoutMs) {
        this.transitionToHalfOpen();
      } else {
        throw new Error(`Circuit breaker ${this.id} is OPEN`);
      }
    }

    if (this.state === CIRCUIT_BREAKER_STATES.HALF_OPEN) {
      if (this.halfOpenRequests >= this.maxHalfOpenRequests) {
        throw new Error(`Circuit breaker ${this.id} half-open limit reached`);
      }
      this.halfOpenRequests++;
    }

    try {
      const result = await operation();
      await this.onSuccess();
      return result;
    } catch (error) {
      await this.onFailure();
      throw error;
    }
  }

  async onSuccess() {
    this.failureCount = 0;
    this.successCount++;
    this.lastSuccessAt = Date.now();

    if (this.state === CIRCUIT_BREAKER_STATES.HALF_OPEN) {
      this.halfOpenRequests = Math.max(0, this.halfOpenRequests - 1);
      if (this.successCount >= 2) {
        this.transitionToClosed();
      }
    }
    await this.persistState();
  }

  async onFailure() {
    this.failureCount++;
    this.successCount = 0;
    this.lastFailureAt = Date.now();

    if (this.state === CIRCUIT_BREAKER_STATES.HALF_OPEN) {
      this.transitionToOpen();
    } else if (this.state === CIRCUIT_BREAKER_STATES.CLOSED && this.failureCount >= this.threshold) {
      this.transitionToOpen();
    }
    await this.persistState();
  }

  transitionToOpen() {
    this.state = CIRCUIT_BREAKER_STATES.OPEN;
    this.openedAt = Date.now();
    this.halfOpenRequests = 0;
  }

  transitionToHalfOpen() {
    this.state = CIRCUIT_BREAKER_STATES.HALF_OPEN;
    this.halfOpenRequests = 0;
    this.successCount = 0;
  }

  transitionToClosed() {
    this.state = CIRCUIT_BREAKER_STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.openedAt = null;
    this.halfOpenRequests = 0;
  }

  getState() {
    return {
      id: this.id,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      openedAt: this.openedAt
    };
  }

  reset() {
    this.transitionToClosed();
  }
}

const circuitBreakers = new Map();

export async function getCircuitBreaker(id, options = {}) {
  if (!circuitBreakers.has(id)) {
    const breaker = new CircuitBreaker(id, { ...options, env: options.env });
    if (options.env) {
      await breaker.loadState();
    }
    circuitBreakers.set(id, breaker);
  }
  return circuitBreakers.get(id);
}

export function getAllCircuitBreakers() {
  const result = {};
  for (const [id, breaker] of circuitBreakers.entries()) {
    result[id] = breaker.getState();
  }
  return result;
}

export async function withRetry(operation, policy = RETRY_POLICIES.DEFAULT) {
  let lastError;
  const { maxAttempts, baseDelayMs, maxDelayMs, backoffMultiplier, jitter } = policy;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = Math.min(
          baseDelayMs * Math.pow(backoffMultiplier, attempt - 1),
          maxDelayMs
        );
        const finalDelay = jitter ? delay * (0.5 + Math.random() * 0.5) : delay;
        await sleep(finalDelay);
      }
    }
  }
  throw lastError;
}

export async function withCircuitBreaker(serviceId, operation, options = {}) {
  const breaker = getCircuitBreaker(serviceId, options);
  return breaker.execute(operation);
}

export async function withResilience(serviceId, operation, retryPolicy = RETRY_POLICIES.DEFAULT, breakerOptions = {}) {
  return withRetry(
    () => withCircuitBreaker(serviceId, operation, breakerOptions),
    retryPolicy
  );
}

// Dead Letter Queue
export async function enqueueDeadLetter({ env, jobType, payload, error, attempts, originalJobId }) {
  const dlqEntry = {
    job_type: jobType,
    payload,
    error: error?.message || String(error),
    attempts,
    original_job_id: originalJobId,
    failed_at: new Date().toISOString(),
    status: 'dead_letter'
  };

  return insertDeadLetter(env, dlqEntry);
}

export async function processDeadLetters({ env, jobType, processor, maxItems = 10 }) {
  const deadLetters = await getDeadLetters(env, jobType, maxItems);
  const results = [];

  for (const dl of deadLetters) {
    try {
      await processor(dl.payload);
      await markDeadLetterResolved(env, dl.id);
      results.push({ id: dl.id, resolved: true });
    } catch (error) {
      await updateDeadLetterAttempt(env, dl.id, error);
      results.push({ id: dl.id, resolved: false, error: error.message });
    }
  }

  return results;
}

export async function requeueDeadLetter({ env, deadLetterId, newJobType }) {
  const dl = await getDeadLetter(env, deadLetterId);
  if (!dl) return { ok: false, error: 'Not found' };

  const newJob = {
    job_type: newJobType || dl.job_type,
    payload: dl.payload,
    status: 'pending',
    scheduled_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  };

  await insertScheduledJob(env, newJob);
  await markDeadLetterResolved(env, deadLetterId);

  return { ok: true, job_id: newJob.id };
}

// Scheduled Job Processor with resilience
export async function processScheduledJobs({ env, jobTypes, processor, concurrency = 3 }) {
  const jobs = await getDueJobs(env, jobTypes);
  const results = [];

  // Process with concurrency limit
  const queue = [...jobs];
  const workers = Array(Math.min(concurrency, queue.length)).fill(null).map(async () => {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;

      const claimed = await claimScheduledJob(env, job.id);
      if (!claimed) continue;

      try {
        await processor(job);
        await completeScheduledJob(env, job.id, { status: 'completed' });
        results.push({ job_id: job.id, ok: true });
      } catch (error) {
        const attempts = (job.attempts || 0) + 1;
        if (attempts >= (job.max_attempts || 3)) {
          await completeScheduledJob(env, job.id, { status: 'dead_letter', error_message: error.message });
          await enqueueDeadLetter({ env, jobType: job.job_type, payload: job.payload, error, attempts, originalJobId: job.id });
          results.push({ job_id: job.id, ok: false, dead_letter: true, error: error.message });
        } else {
          await completeScheduledJob(env, job.id, {
            status: 'pending',
            attempts,
            scheduled_at: calculateBackoffSchedule(attempts)
          });
          results.push({ job_id: job.id, ok: false, retry: true, error: error.message });
        }
      }
    }
  });

  await Promise.all(workers);
  return results;
}

function calculateBackoffSchedule(attempt) {
  const baseDelay = Math.min(1000 * Math.pow(2, attempt), 3600000); // Max 1 hour
  return new Date(Date.now() + baseDelay).toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Database helpers
async function insertDeadLetter(env, entry) {
  return insert(env, 'dead_letters', entry);
}

export async function getDeadLetters(env, jobType, limit) {
  let path = `/rest/v1/dead_letters?status=eq.dead_letter&order=failed_at.asc&limit=${limit}&select=*`;
  if (jobType) path += `&job_type=eq.${jobType}`;
  return rest(env, path);
}

export async function getDeadLetter(env, id) {
  return one(env, `/rest/v1/dead_letters?id=eq.${encodeURIComponent(id)}&select=*`);
}

async function markDeadLetterResolved(env, id) {
  return patch(env, 'dead_letters', `id=eq.${encodeURIComponent(id)}`, { status: 'resolved', resolved_at: new Date().toISOString() });
}

async function updateDeadLetterAttempt(env, id, error) {
  return patch(env, 'dead_letters', `id=eq.${encodeURIComponent(id)}`, {
    error: error.message,
    attempts: 1 // increment in DB would be better
  });
}

async function getDueJobs(env, jobTypes) {
  let path = `/rest/v1/scheduled_jobs?status=in.(pending,processing)&scheduled_at=lte.${new Date().toISOString()}&order=scheduled_at.asc&limit=100&select=*`;
  if (jobTypes?.length) path += `&job_type=in.(${jobTypes.join(',')})`;
  return rest(env, path);
}

async function claimScheduledJob(env, id) {
  const now = new Date().toISOString();
  const updated = await patch(env, 'scheduled_jobs', `id=eq.${encodeURIComponent(id)}&status=eq.pending`, { status: 'processing', locked_at: now, attempts: 1 });
  return !!updated;
}

async function completeScheduledJob(env, id, changes) {
  return patch(env, 'scheduled_jobs', `id=eq.${encodeURIComponent(id)}`, {
    ...changes,
    completed_at: changes.status === 'processing' ? null : new Date().toISOString(),
    locked_at: null
  });
}

async function insertScheduledJob(env, job) {
  return insert(env, 'scheduled_jobs', job);
}

async function one(env, path) {
  const rows = await rest(env, path);
  return rows[0] || null;
}

async function rest(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Supabase request failed (${response.status})`);
  return text ? JSON.parse(text) : [];
}

async function insert(env, table, row) {
  const rows = await rest(env, `/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  return rows[0] || row;
}

async function patch(env, table, filter, body) {
  const rows = await rest(env, `/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
  return rows[0] || body;
}