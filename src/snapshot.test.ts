import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SnapshotManager,
  createSnapshotMatcher,
  withSnapshots,
  ApiSnapshotTester,
} from './snapshot';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmpTestFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-snap-'));
  roots.push(dir);
  return join(dir, 'example.test.ts');
}

describe('SnapshotManager — match semantics', () => {
  test('first match creates a new snapshot and passes', async () => {
    const manager = new SnapshotManager(tmpTestFile());
    const result = await manager.match('first', { hello: 'world' });

    expect(result.passed).toBe(true);
    expect(result.isNew).toBe(true);
    expect(result.actual).toBe('{\n  "hello": "world"\n}');
  });

  test('repeated call with same name creates a numbered sibling, not a re-compare', async () => {
    const manager = new SnapshotManager(tmpTestFile());
    await manager.match('multi', 'first');

    const result = await manager.match('multi', 'second');
    expect(result.isNew).toBe(true); // stored under "multi 2"

    await manager.save();
    const content = readFileSync(manager['getSnapshotPath'](), 'utf-8');
    expect(content).toContain('exports[`multi`] = `first`;');
    expect(content).toContain('exports[`multi 2`] = `second`;');
  });

  test('changed value fails with expected/actual/diff across managers on the same file', async () => {
    const file = tmpTestFile();
    const writer = new SnapshotManager(file);
    await writer.match('drift', { version: 1 });
    await writer.save();

    const reader = new SnapshotManager(file);
    const result = await reader.match('drift', { version: 2 });

    expect(result.passed).toBe(false);
    expect(result.isNew).toBe(false);
    expect(result.expected).toContain('"version": 1');
    expect(result.actual).toContain('"version": 2');
    expect(result.diff).toContain('-   "version": 1');
    expect(result.diff).toContain('+   "version": 2');
  });

  test('reset() clears counters so the next match reuses the base name', async () => {
    const file = tmpTestFile();
    const manager = new SnapshotManager(file);
    await manager.match('again', 'one');
    manager.reset();

    // base name again; value matches the stored snapshot
    const result = await manager.match('again', 'one');
    expect(result.passed).toBe(true);
    expect(result.isNew).toBe(false);
  });

  test('updateSnapshots rewrites existing values and still passes', async () => {
    const file = tmpTestFile();
    const old = new SnapshotManager(file);
    await old.match('update-me', 'old-value');
    await old.save();

    const updated = new SnapshotManager(file, { updateSnapshots: true });
    const result = await updated.match('update-me', 'new-value');
    expect(result.passed).toBe(true);
    expect(result.isNew).toBe(false);
    await updated.save();

    // persisted snapshot now holds the new value
    const reader = new SnapshotManager(file);
    const check = await reader.match('update-me', 'new-value');
    expect(check.passed).toBe(true);
  });

  test('custom serializer is respected', async () => {
    const manager = new SnapshotManager(tmpTestFile(), {
      serializer: (v) => `upper:${String(v).toUpperCase()}`,
    });
    const result = await manager.match('custom', 'orbit');
    expect(result.actual).toBe('upper:ORBIT');
  });
});

describe('SnapshotManager — persistence', () => {
  test('save() writes snapshots to __snapshots__/<file-without-ext>.snap', async () => {
    const file = tmpTestFile();
    const manager = new SnapshotManager(file);
    await manager.match('persisted', 'line1\nline2');
    await manager.save();

    // example.test.ts -> example.test.snap
    const snapPath = join(file, '..', '__snapshots__', 'example.test.snap');
    expect(existsSync(snapPath)).toBe(true);

    const content = readFileSync(snapPath, 'utf-8');
    // multiline values are stored with real newlines inside the template literal
    expect(content).toContain('exports[`persisted`] = `line1\nline2`;');
  });

  test('backticks in values are escaped and parsed back', async () => {
    const file = tmpTestFile();
    const value = 'has `backticks` inside';
    const writer = new SnapshotManager(file);
    await writer.match('ticks', value);
    await writer.save();

    const reader = new SnapshotManager(file);
    const result = await reader.match('ticks', value);
    expect(result.passed).toBe(true);
    expect(result.isNew).toBe(false);
  });

  test('loadSnapshots reads previously saved file (roundtrip)', async () => {
    const file = tmpTestFile();
    const writer = new SnapshotManager(file);
    await writer.match('roundtrip', { nested: [1, 2, 3] });
    await writer.save();

    const reader = new SnapshotManager(file);
    const result = await reader.match('roundtrip', { nested: [1, 2, 3] });
    expect(result.passed).toBe(true);
    expect(result.isNew).toBe(false);
  });

  test('save() is a no-op when nothing changed', async () => {
    const file = tmpTestFile();
    const manager = new SnapshotManager(file);
    await manager.save(); // nothing matched yet — dirty=false
    expect(existsSync(join(file, '..', '__snapshots__'))).toBe(false);
  });
});

describe('createSnapshotMatcher', () => {
  test('toMatchSnapshot throws on mismatch with diff included', async () => {
    const file = tmpTestFile();
    const writer = createSnapshotMatcher(file);
    await writer.toMatchSnapshot('mismatch-case', 'v1');
    await writer.saveSnapshots();

    const reader = createSnapshotMatcher(file);
    await expect(reader.toMatchSnapshot('mismatch-case', 'v2')).rejects.toThrow(
      /Snapshot mismatch for "mismatch-case"/,
    );
  });

  test('toMatchInlineSnapshot compares against the provided string', async () => {
    const matcher = createSnapshotMatcher(tmpTestFile());
    await matcher.toMatchInlineSnapshot('inline', 'orbit', 'orbit');
    await expect(
      matcher.toMatchInlineSnapshot('inline-bad', 'orbit', 'other'),
    ).rejects.toThrow(/Inline snapshot mismatch/);
  });

  test('withSnapshots saves even when the callback throws', async () => {
    const file = tmpTestFile();
    await expect(
      withSnapshots(file, undefined, async (matcher) => {
        await matcher.toMatchSnapshot('save-on-error', 'value');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(existsSync(join(file, '..', '__snapshots__', 'example.test.snap'))).toBe(true);
  });
});

describe('ApiSnapshotTester', () => {
  const servers: any[] = [];
  afterAll(() => {
    for (const s of servers) s.stop(true);
  });

  test('normalizes and snapshots a real JSON response', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ id: 1, name: 'orbit' }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        }),
    });
    servers.push(server);

    const tester = new ApiSnapshotTester(tmpTestFile(), `http://localhost:${server.port}`);

    const first = await tester.get('get-user', '/users/1');
    expect(first.passed).toBe(true);
    expect(first.isNew).toBe(true);

    // same-name repeat stores a numbered sibling (framework design: one
    // snapshot per call), still passes
    const second = await tester.get('get-user', '/users/1');
    expect(second.passed).toBe(true);
    expect(second.isNew).toBe(true);

    await tester.save();
  });

  test('post sends a JSON body', async () => {
    let received: any = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received = await req.json();
        return new Response('created', { status: 201 });
      },
    });
    servers.push(server);

    const tester = new ApiSnapshotTester(tmpTestFile(), `http://localhost:${server.port}`);
    const result = await tester.post('create', '/users', { name: 'orbit' });

    expect(result.passed).toBe(true);
    expect(received).toEqual({ name: 'orbit' });
  });

  test('trailing slash in baseUrl is normalized', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    servers.push(server);

    const tester = new ApiSnapshotTester(tmpTestFile(), `http://localhost:${server.port}/`);
    const result = await tester.get('ping', '/ping');
    expect(result.passed).toBe(true);
  });
});
