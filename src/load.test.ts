import { describe, test, expect, afterAll } from 'bun:test';
import {
  LoadTester,
  loadTest,
  formatLoadTestResult,
  LoadTestScenario,
  assertLatency,
  assertErrorRate,
  assertThroughput,
} from './load';

const servers: any[] = [];

function startServer(opts: {
  status?: number;
  delayMs?: number;
  hang?: boolean;
  failEvery?: number;
} = {}) {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      requests++;
      if (opts.hang) return new Promise(() => {}); // never resolves
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const status = opts.status ?? (opts.failEvery ? (requests % opts.failEvery === 0 ? 500 : 200) : 200);
      return new Response(JSON.stringify({ ok: status === 200, n: requests }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  servers.push(server);
  return { server, getCount: () => requests, url: `http://localhost:${server.port}` };
}

afterAll(() => {
  for (const s of servers) s.stop(true);
});

describe('LoadTester — happy path against a real server', () => {
  test('produces a complete result with sane latency statistics', async () => {
    const { url } = startServer({ delayMs: 2 });
    const result = await loadTest({
      url,
      duration: 400,
      concurrency: 3,
      timeout: 5000,
    });

    expect(result.totalRequests).toBeGreaterThan(0);
    expect(result.successfulRequests).toBe(result.totalRequests);
    expect(result.failedRequests).toBe(0);
    expect(result.statusCodes[200]).toBe(result.totalRequests);

    // latency invariants: min <= median <= p90 <= p99 <= max
    expect(result.latency.min).toBeLessThanOrEqual(result.latency.mean);
    expect(result.latency.median).toBeLessThanOrEqual(result.latency.p90);
    expect(result.latency.p90).toBeLessThanOrEqual(result.latency.p99);
    expect(result.latency.p99).toBeLessThanOrEqual(result.latency.max);
    expect(result.latency.stdDev).toBeGreaterThanOrEqual(0);

    expect(result.requestsPerSecond).toBeGreaterThan(0);
    expect(result.totalDuration).toBeGreaterThanOrEqual(350); // ~duration + scheduling slack

    // timeline buckets are 1s-sized and sorted
    expect(result.timeline.length).toBeGreaterThanOrEqual(1);
    const sorted = [...result.timeline].sort((a, b) => a.timestamp - b.timestamp);
    expect(sorted).toEqual(result.timeline);
    for (const point of result.timeline) {
      expect(point.requestsPerSecond).toBeGreaterThan(0);
      expect(point.errorRate).toBe(0);
    }
  });

  test('concurrency spreads work across workers', async () => {
    const { url, getCount } = startServer();
    const result = await loadTest({ url, duration: 300, concurrency: 8, timeout: 5000 });
    // with 8 workers we expect significantly more requests than a serial loop
    expect(result.totalRequests).toBeGreaterThan(20);
    expect(getCount()).toBe(result.totalRequests);
  });

  test('stop() halts request generation early', async () => {
    const tester = new LoadTester({ url: 'http://localhost:59999', duration: 10000, timeout: 1000 });
    const runPromise = tester.run();
    tester.stop();
    const result = await runPromise;
    // stopped quickly — far fewer results than 10s of traffic would produce
    expect(result.totalRequests).toBeLessThan(100);
  });
});

describe('LoadTester — failure accounting', () => {
  test('HTTP errors are counted per status code and in errors.http', async () => {
    const { url } = startServer({ status: 500 });
    const result = await loadTest({ url, duration: 300, timeout: 5000 });

    expect(result.totalRequests).toBeGreaterThan(0);
    expect(result.failedRequests).toBe(result.totalRequests);
    expect(result.successfulRequests).toBe(0);
    expect(result.statusCodes[500]).toBe(result.totalRequests);
    expect(result.errors.http).toBe(result.totalRequests);
    expect(result.errors.timeout).toBe(0);
    expect(result.errors.connection).toBe(0);

    // every timeline bucket records a 100% error rate
    for (const point of result.timeline) {
      expect(point.errorRate).toBe(1);
    }
  });

  test('connection errors are classified as connection (refused port)', async () => {
    // port 1 is reserved and effectively always refused
    const result = await loadTest({ url: 'http://localhost:1', duration: 250, timeout: 1000 });
    expect(result.totalRequests).toBeGreaterThan(0);
    expect(result.failedRequests).toBe(result.totalRequests);
    expect(result.errors.connection).toBe(result.totalRequests);
  });

  test('timeouts are classified as timeout with status 0', async () => {
    const { url } = startServer({ hang: true });
    const result = await loadTest({ url, duration: 250, concurrency: 2, timeout: 80 });

    expect(result.errors.timeout).toBe(result.totalRequests);
    expect(result.statusCodes[0]).toBe(result.totalRequests);
    // each timed-out request took at least the timeout duration
    expect(result.latency.min).toBeGreaterThanOrEqual(70);
  }, 15000);

  test('mixed success/failure split with failEvery', async () => {
    const { url } = startServer({ failEvery: 2 }); // alternate 200/500
    const result = await loadTest({ url, duration: 300, timeout: 5000 });

    expect(result.totalRequests).toBeGreaterThan(0);
    expect(result.successfulRequests).toBeGreaterThan(0);
    expect(result.failedRequests).toBeGreaterThan(0);
    expect(result.successfulRequests + result.failedRequests).toBe(result.totalRequests);
    expect(result.errors.http).toBe(result.failedRequests);
  });
});

describe('formatLoadTestResult', () => {
  test('renders summary, latency, status codes and error sections', () => {
    const result = {
      totalRequests: 100,
      successfulRequests: 90,
      failedRequests: 10,
      totalDuration: 10000,
      requestsPerSecond: 10,
      latency: { min: 1, max: 50, mean: 10, median: 9, p90: 20, p95: 30, p99: 45, stdDev: 5 },
      statusCodes: { 200: 90, 500: 10 },
      errors: { timeout: 2, connection: 3, http: 5 },
      timeline: [],
    };

    const output = formatLoadTestResult(result as any);
    expect(output).toContain('LOAD TEST RESULTS');
    expect(output).toContain('Total Requests:      100');
    expect(output).toContain('Successful:          90 (90.0%)');
    expect(output).toContain('P95:                 30.00');
    expect(output).toContain('200:                 90');
    expect(output).toContain('Timeout:             2');
    expect(output).toContain('Connection:          3');
    expect(output).toContain('HTTP Errors:         5');
  });

  test('omits the error section when there are no errors', () => {
    const result = {
      totalRequests: 10,
      successfulRequests: 10,
      failedRequests: 0,
      totalDuration: 1000,
      requestsPerSecond: 10,
      latency: { min: 1, max: 2, mean: 1.5, median: 1, p90: 2, p95: 2, p99: 2, stdDev: 0 },
      statusCodes: { 200: 10 },
      errors: { timeout: 0, connection: 0, http: 0 },
      timeline: [],
    };

    const output = formatLoadTestResult(result as any);
    expect(output).not.toContain('Errors:');
    expect(output).toContain('200:                 10');
  });
});

describe('assert helpers', () => {
  const result = {
    totalRequests: 100,
    successfulRequests: 95,
    failedRequests: 5,
    totalDuration: 1000,
    requestsPerSecond: 10,
    latency: { min: 1, max: 50, mean: 10, median: 9, p90: 20, p95: 30, p99: 45, stdDev: 5 },
    statusCodes: {},
    errors: { timeout: 0, connection: 0, http: 0 },
    timeline: [],
  } as any;

  test('assertLatency passes at-or-under and fails over the threshold', () => {
    expect(() => assertLatency(result, 'p95', 31)).not.toThrow();
    expect(() => assertLatency(result, 'p95', 30)).not.toThrow(); // exactly at threshold passes
    expect(() => assertLatency(result, 'p95', 29)).toThrow(/p95 \(30\.00ms\) exceeds threshold \(29ms\)/);
    expect(() => assertLatency(result, 'min', 0)).toThrow(/min/);
  });

  test('assertErrorRate compares failed/total', () => {
    expect(() => assertErrorRate(result, 0.05)).not.toThrow(); // exactly 5% allowed (rate 0.05 <= max)
    expect(() => assertErrorRate(result, 0.04)).toThrow(/Error rate \(5\.00%\) exceeds threshold \(4\.00%\)/);
  });

  test('assertThroughput requires a minimum rps', () => {
    expect(() => assertThroughput(result, 10)).not.toThrow();
    expect(() => assertThroughput(result, 11)).toThrow(/Throughput \(10\.00 rps\) below threshold \(11 rps\)/);
  });
});

describe('LoadTestScenario', () => {
  test('runs steps sequentially and collects results', async () => {
    const { url } = startServer();
    const scenario = new LoadTestScenario()
      .addStep('smoke', { url, duration: 200, timeout: 5000 })
      .addStep('sustained', { url, duration: 200, timeout: 5000 });

    const results = await scenario.run();
    expect(results.size).toBe(2);
    expect(results.get('smoke')!.totalRequests).toBeGreaterThan(0);
    expect(results.get('sustained')!.totalRequests).toBeGreaterThan(0);
  });

  test('step assertions run and failures propagate', async () => {
    const { url } = startServer();

    const passing = new LoadTestScenario().addStep('ok', { url, duration: 200, timeout: 5000 }, (r) => {
      expect(r.successfulRequests).toBeGreaterThan(0);
    });
    await expect(passing.run()).resolves.toBeDefined();

    const failing = new LoadTestScenario().addStep('strict', { url, duration: 200, timeout: 5000 }, (r) => {
      assertThroughput(r, Number.MAX_SAFE_INTEGER); // guaranteed to fail
    });
    await expect(failing.run()).rejects.toThrow(/below threshold/);
  });
});
