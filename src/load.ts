export interface LoadTestConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  duration?: number;
  concurrency?: number;
  rampUp?: number;
  requestsPerSecond?: number;
  timeout?: number;
}

export interface LoadTestResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalDuration: number;
  requestsPerSecond: number;
  latency: LatencyStats;
  statusCodes: Record<number, number>;
  errors: ErrorStats;
  timeline: TimelinePoint[];
}

export interface LatencyStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
  p95: number;
  p99: number;
  stdDev: number;
}

export interface ErrorStats {
  timeout: number;
  connection: number;
  http: number;
}

export interface TimelinePoint {
  timestamp: number;
  requestsPerSecond: number;
  latencyMean: number;
  errorRate: number;
}

interface RequestResult {
  success: boolean;
  status: number;
  latency: number;
  error?: string;
  timestamp: number;
}

const DEFAULT_CONFIG: Required<Omit<LoadTestConfig, 'url'>> = {
  method: 'GET',
  headers: {},
  body: undefined,
  duration: 10000,
  concurrency: 10,
  rampUp: 0,
  requestsPerSecond: 0,
  timeout: 30000,
};

function calculatePercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function calculateStdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

export class LoadTester {
  private config: Required<LoadTestConfig>;
  private results: RequestResult[] = [];
  private running = false;
  private startTime = 0;

  constructor(config: LoadTestConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<LoadTestConfig>;
  }

  async run(): Promise<LoadTestResult> {
    this.results = [];
    this.running = true;
    this.startTime = Date.now();

    const endTime = this.startTime + this.config.duration;
    const workers: Promise<void>[] = [];

    const activeWorkers = this.config.concurrency;

    for (let i = 0; i < activeWorkers; i++) {
      const delay = this.config.rampUp > 0
        ? (this.config.rampUp / activeWorkers) * i
        : 0;
      
      workers.push(this.runWorker(endTime, delay));
    }

    await Promise.all(workers);
    this.running = false;

    return this.calculateResults();
  }

  private async runWorker(endTime: number, initialDelay: number): Promise<void> {
    if (initialDelay > 0) {
      await this.sleep(initialDelay);
    }

    while (Date.now() < endTime && this.running) {
      const result = await this.makeRequest();
      this.results.push(result);

      if (this.config.requestsPerSecond > 0) {
        const perWorkerRps = this.config.requestsPerSecond / this.config.concurrency;
        const interval = 1000 / perWorkerRps;
        await this.sleep(interval);
      }
    }
  }

  private async makeRequest(): Promise<RequestResult> {
    const startTime = performance.now();
    const timestamp = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(this.config.url, {
        method: this.config.method,
        headers: this.config.headers,
        body: this.config.body ? JSON.stringify(this.config.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const latency = performance.now() - startTime;

      return {
        success: response.ok,
        status: response.status,
        latency,
        timestamp,
      };
    } catch (error: any) {
      const latency = performance.now() - startTime;
      
      return {
        success: false,
        status: 0,
        latency,
        error: error.name === 'AbortError' ? 'timeout' : error.message,
        timestamp,
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculateResults(): LoadTestResult {
    const totalDuration = Date.now() - this.startTime;
    const totalRequests = this.results.length;
    const successfulRequests = this.results.filter((r) => r.success).length;
    const failedRequests = totalRequests - successfulRequests;

    const latencies = this.results.map((r) => r.latency).sort((a, b) => a - b);
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length || 0;

    const statusCodes: Record<number, number> = {};
    for (const result of this.results) {
      statusCodes[result.status] = (statusCodes[result.status] || 0) + 1;
    }

    const errors: ErrorStats = { timeout: 0, connection: 0, http: 0 };
    for (const result of this.results) {
      if (result.error === 'timeout') {
        errors.timeout++;
      } else if (result.error) {
        errors.connection++;
      } else if (!result.success) {
        errors.http++;
      }
    }

    const timeline = this.generateTimeline();

    return {
      totalRequests,
      successfulRequests,
      failedRequests,
      totalDuration,
      requestsPerSecond: (totalRequests / totalDuration) * 1000,
      latency: {
        min: latencies[0] || 0,
        max: latencies[latencies.length - 1] || 0,
        mean,
        median: calculatePercentile(latencies, 50),
        p90: calculatePercentile(latencies, 90),
        p95: calculatePercentile(latencies, 95),
        p99: calculatePercentile(latencies, 99),
        stdDev: calculateStdDev(latencies, mean),
      },
      statusCodes,
      errors,
      timeline,
    };
  }

  private generateTimeline(): TimelinePoint[] {
    const bucketSize = 1000;
    const buckets = new Map<number, RequestResult[]>();

    for (const result of this.results) {
      const bucket = Math.floor((result.timestamp - this.startTime) / bucketSize) * bucketSize;
      const existing = buckets.get(bucket) || [];
      existing.push(result);
      buckets.set(bucket, existing);
    }

    const timeline: TimelinePoint[] = [];

    for (const [timestamp, results] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
      const rps = results.length;
      const latencies = results.map((r) => r.latency);
      const latencyMean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const errors = results.filter((r) => !r.success).length;
      const errorRate = errors / results.length;

      timeline.push({
        timestamp: this.startTime + timestamp,
        requestsPerSecond: rps,
        latencyMean,
        errorRate,
      });
    }

    return timeline;
  }

  stop(): void {
    this.running = false;
  }
}

export async function loadTest(config: LoadTestConfig): Promise<LoadTestResult> {
  const tester = new LoadTester(config);
  return tester.run();
}

export function formatLoadTestResult(result: LoadTestResult): string {
  const lines: string[] = [
    '='.repeat(60),
    'LOAD TEST RESULTS',
    '='.repeat(60),
    '',
    'Summary:',
    `  Total Requests:      ${result.totalRequests}`,
    `  Successful:          ${result.successfulRequests} (${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%)`,
    `  Failed:              ${result.failedRequests}`,
    `  Duration:            ${(result.totalDuration / 1000).toFixed(2)}s`,
    `  Requests/sec:        ${result.requestsPerSecond.toFixed(2)}`,
    '',
    'Latency (ms):',
    `  Min:                 ${result.latency.min.toFixed(2)}`,
    `  Max:                 ${result.latency.max.toFixed(2)}`,
    `  Mean:                ${result.latency.mean.toFixed(2)}`,
    `  Median:              ${result.latency.median.toFixed(2)}`,
    `  P90:                 ${result.latency.p90.toFixed(2)}`,
    `  P95:                 ${result.latency.p95.toFixed(2)}`,
    `  P99:                 ${result.latency.p99.toFixed(2)}`,
    `  Std Dev:             ${result.latency.stdDev.toFixed(2)}`,
    '',
    'Status Codes:',
  ];

  for (const [code, count] of Object.entries(result.statusCodes)) {
    lines.push(`  ${code}:                 ${count}`);
  }

  if (result.errors.timeout > 0 || result.errors.connection > 0 || result.errors.http > 0) {
    lines.push('');
    lines.push('Errors:');
    if (result.errors.timeout > 0) lines.push(`  Timeout:             ${result.errors.timeout}`);
    if (result.errors.connection > 0) lines.push(`  Connection:          ${result.errors.connection}`);
    if (result.errors.http > 0) lines.push(`  HTTP Errors:         ${result.errors.http}`);
  }

  lines.push('');
  lines.push('='.repeat(60));

  return lines.join('\n');
}

export class LoadTestScenario {
  private steps: Array<{
    name: string;
    config: LoadTestConfig;
    assertions?: (result: LoadTestResult) => void;
  }> = [];

  addStep(
    name: string,
    config: LoadTestConfig,
    assertions?: (result: LoadTestResult) => void
  ): this {
    this.steps.push({ name, config, assertions });
    return this;
  }

  async run(): Promise<Map<string, LoadTestResult>> {
    const results = new Map<string, LoadTestResult>();

    for (const step of this.steps) {
      console.log(`Running step: ${step.name}`);
      
      const result = await loadTest(step.config);
      results.set(step.name, result);

      console.log(formatLoadTestResult(result));

      if (step.assertions) {
        try {
          step.assertions(result);
          console.log(`Step "${step.name}" passed assertions`);
        } catch (error: any) {
          console.error(`Step "${step.name}" failed: ${error.message}`);
          throw error;
        }
      }
    }

    return results;
  }
}

export function assertLatency(
  result: LoadTestResult,
  metric: keyof LatencyStats,
  maxMs: number
): void {
  const value = result.latency[metric];
  if (value > maxMs) {
    throw new Error(`Latency ${metric} (${value.toFixed(2)}ms) exceeds threshold (${maxMs}ms)`);
  }
}

export function assertErrorRate(result: LoadTestResult, maxRate: number): void {
  const rate = result.failedRequests / result.totalRequests;
  if (rate > maxRate) {
    throw new Error(`Error rate (${(rate * 100).toFixed(2)}%) exceeds threshold (${(maxRate * 100).toFixed(2)}%)`);
  }
}

export function assertThroughput(result: LoadTestResult, minRps: number): void {
  if (result.requestsPerSecond < minRps) {
    throw new Error(`Throughput (${result.requestsPerSecond.toFixed(2)} rps) below threshold (${minRps} rps)`);
  }
}
