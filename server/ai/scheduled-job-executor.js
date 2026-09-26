/**
 * Scheduled Job Executor
 * Runs background jobs for supplier discovery, gap analysis, follow-ups, etc.
 * Can be triggered via cron, Cloudflare Worker scheduled events, or HTTP endpoint
 */

import { createDiscoveryProvider } from './discovery-provider.js';
import { createOutreachProvider } from './outreach-provider.js';
import { createLicenseVerifier } from './license-verifier.js';
import { processDiscoveryJob, growVendorPool } from './supplier-discovery-processor.js';
import { analyzeAllActiveGaps } from './supplier-gap-detector.js';
import { updateSupplierPerformance } from './supplier-performance.js';
import { processScheduledJobs, getDeadLetters, requeueDeadLetter, getAllCircuitBreakers } from './resilience.js';

export const SCHEDULED_JOB_TYPES = Object.freeze([
  'analyze_gaps',
  'process_discovery_jobs',
  'process_outreach_followups',
  'process_scheduled_jobs',
  'process_dead_letters',
  'sync_circuit_breakers',
  'cleanup_stale_jobs',
  'update_supplier_performance'
]);

export class ScheduledJobExecutor {
  constructor(env = {}) {
    this.env = env;
    this.results = [];
  }

  async executeAll() {
    console.log('[ScheduledJobExecutor] Starting full execution cycle');
    const startTime = Date.now();

    try {
      // 1. Analyze gaps for all active RFQs
      await this.executeJob('analyze_gaps', () => analyzeAllActiveGaps({ env: this.env }));

      // 2. Process pending discovery jobs
      await this.executeJob('process_discovery_jobs', () => this.processDiscoveryJobs());

      await this.executeJob('grow_vendor_pool', () => growVendorPool({ env: this.env, outreachProvider: createOutreachProvider(this.env) }));

      // 3. Process scheduled jobs (outreach followups, etc.)
      await this.executeJob('process_scheduled_jobs', () => this.processScheduledJobs());

      // 4. Process dead letters
      await this.executeJob('process_dead_letters', () => this.processDeadLetters());

      // 5. Sync circuit breakers to database
      await this.executeJob('sync_circuit_breakers', () => this.syncCircuitBreakers());

      // 6. Cleanup stale jobs
      await this.executeJob('cleanup_stale_jobs', () => this.cleanupStaleJobs());

      await this.executeJob('update_supplier_performance', () => updateSupplierPerformance({ env: this.env }));

      const duration = Date.now() - startTime;
      console.log(`[ScheduledJobExecutor] Full cycle completed in ${duration}ms`);
      return { ok: true, duration_ms: duration, results: this.results };
    } catch (error) {
      console.error('[ScheduledJobExecutor] Execution failed:', error);
      return { ok: false, error: error.message, results: this.results };
    }
  }

  async executeJob(name, fn) {
    console.log(`[ScheduledJobExecutor] Executing: ${name}`);
    const startTime = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - startTime;
      this.results.push({ job: name, ok: true, duration_ms: duration, result });
      console.log(`[ScheduledJobExecutor] ${name} completed in ${duration}ms`);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.results.push({ job: name, ok: false, duration_ms: duration, error: error.message });
      console.error(`[ScheduledJobExecutor] ${name} failed:`, error);
      // Don't throw - continue with other jobs
      return { ok: false, error: error.message };
    }
  }

  async processDiscoveryJobs() {
    const discoveryProvider = createDiscoveryProvider(this.env);
    const outreachProvider = createOutreachProvider(this.env);

    // Get all pending discovery jobs
    const jobs = await this.getJobsByStatus('pending', ['directory_search', 'web_search', 'gap_triggered_discovery', 'verification', 'outreach_campaign']);
    let processed = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        const result = await processDiscoveryJob({ env: this.env, jobId: job.id, discoveryProvider, outreachProvider });
        if (result.ok) processed++;
        else failed++;
      } catch (error) {
        failed++;
        console.error(`Discovery job ${job.id} failed:`, error);
      }
    }

    return { processed, failed };
  }

  async processScheduledJobs() {
    // Get all due scheduled jobs
    const jobs = await this.getDueScheduledJobs();
    if (!jobs.length) return { processed: 0 };

    // Group by job type for the processor
    const jobTypes = [...new Set(jobs.map(j => j.job_type))];
    
    const mockProcessor = async (job) => {
      console.log(`Processing scheduled job: ${job.id} (${job.job_type})`);
      // The actual processing is handled by the specific job handlers
      // This is a placeholder - real implementation would dispatch to specific handlers
    };

    const results = await processScheduledJobs({ 
      env: this.env, 
      jobTypes, 
      processor: mockProcessor,
      concurrency: 3 
    });

    return { 
      processed: results.filter(r => r.ok).length, 
      failed: results.filter(r => !r.ok).length,
      dead_lettered: results.filter(r => r.dead_letter).length
    };
  }

  async processDeadLetters() {
    const deadLetters = await getDeadLetters(this.env, null, 50);
    if (!deadLetters.length) return { processed: 0 };

    let resolved = 0;
    let failed = 0;

    for (const dl of deadLetters) {
      try {
        // Try to requeue with the original job type
        const result = await requeueDeadLetter({ env: this.env, deadLetterId: dl.id, newJobType: dl.job_type });
        if (result.ok) resolved++;
        else failed++;
      } catch (error) {
        failed++;
        console.error(`Dead letter ${dl.id} processing failed:`, error);
      }
    }

    return { resolved, failed };
  }

  async syncCircuitBreakers() {
    const breakers = getAllCircuitBreakers();
    let synced = 0;

    for (const [id, state] of Object.entries(breakers)) {
      try {
        await this.upsertCircuitBreaker(id, state);
        synced++;
      } catch (error) {
        console.error(`Failed to sync circuit breaker ${id}:`, error);
      }
    }

    return { synced };
  }

  async cleanupStaleJobs() {
    // Clean up jobs stuck in 'processing' for more than 30 minutes
    const staleJobs = await this.getStaleProcessingJobs(30 * 60 * 1000);
    let reset = 0;

    for (const job of staleJobs) {
      try {
        await this.resetJobToPending(job.id);
        reset++;
      } catch (error) {
        console.error(`Failed to reset stale job ${job.id}:`, error);
      }
    }

    return { reset };
  }

  // Database helper methods
  async getJobsByStatus(status, types = []) {
    let path = `/rest/v1/supplier_discovery_jobs?status=eq.${status}&order=created_at.asc&limit=100&select=*`;
    if (types.length) path += `&job_type=in.(${types.join(',')})`;
    
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SECRET_KEY;
    const response = await fetch(`${this.env.SUPABASE_URL}${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    });
    return response.ok ? response.json() : [];
  }

  async getDueScheduledJobs() {
    const path = `/rest/v1/scheduled_jobs?status=in.(pending,processing)&scheduled_at=lte.${new Date().toISOString()}&order=scheduled_at.asc&limit=100&select=*`;
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SECRET_KEY;
    const response = await fetch(`${this.env.SUPABASE_URL}${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    });
    return response.ok ? response.json() : [];
  }

  async getStaleProcessingJobs(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const path = `/rest/v1/scheduled_jobs?status=eq.processing&lt=eq.${cutoff}&select=id`;
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SECRET_KEY;
    const response = await fetch(`${this.env.SUPABASE_URL}${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    });
    return response.ok ? response.json() : [];
  }

  async upsertCircuitBreaker(id, state) {
    const path = `/rest/v1/circuit_breakers?id=eq.${encodeURIComponent(id)}`;
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SECRET_KEY;
    const body = {
      state: state.state,
      failure_count: state.failureCount,
      success_count: state.successCount,
      last_failure_at: state.lastFailureAt,
      last_success_at: state.lastSuccessAt,
      opened_at: state.openedAt,
      threshold: state.threshold,
      timeout_seconds: state.timeoutMs / 1000,
      updated_at: new Date().toISOString()
    };
    await fetch(`${this.env.SUPABASE_URL}${path}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(body)
    });
  }

  async resetJobToPending(jobId) {
    const path = `/rest/v1/scheduled_jobs?id=eq.${encodeURIComponent(jobId)}`;
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SECRET_KEY;
    await fetch(`${this.env.SUPABASE_URL}${path}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'pending', locked_at: null, attempts: 0 })
    });
  }
}

function scheduledJobsSecret(request, env) {
  const expected = String(env.SCHEDULED_JOBS_SECRET || '').trim();
  if (!expected) return false;
  const bearer = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const supplied = request.headers.get('X-Scheduled-Jobs-Secret') || bearer;
  return supplied.length >= 32 && supplied === expected;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// HTTP endpoint handler for manual triggering
export async function handleScheduledJobsRequest(request, env) {
  if (!scheduledJobsSecret(request, env)) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  const executor = new ScheduledJobExecutor(env);
  const result = await executor.executeAll();
  return jsonResponse(result, result.ok ? 200 : 500);
}

// Cloudflare Worker scheduled handler
export async function scheduledEventHandler(event, env, ctx) {
  console.log('[ScheduledEvent] Triggered at:', new Date().toISOString());
  const executor = new ScheduledJobExecutor(env);
  const result = await executor.executeAll();
  console.log('[ScheduledEvent] Completed:', result);
  return result;
}

// Main entry point for CLI / cron execution
export async function runScheduledJobs(env) {
  const executor = new ScheduledJobExecutor(env);
  return executor.executeAll();
}

export default ScheduledJobExecutor;
