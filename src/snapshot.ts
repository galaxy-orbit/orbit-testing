import { join, dirname } from 'path';
import { mkdir } from 'fs/promises';

export interface SnapshotOptions {
  snapshotDir?: string;
  updateSnapshots?: boolean;
  serializer?: (value: unknown) => string;
}

export interface SnapshotResult {
  passed: boolean;
  isNew: boolean;
  expected?: string;
  actual?: string;
  diff?: string;
}

const DEFAULT_OPTIONS: Required<SnapshotOptions> = {
  snapshotDir: '__snapshots__',
  updateSnapshots: process.env.UPDATE_SNAPSHOTS === 'true',
  serializer: defaultSerializer,
};

function defaultSerializer(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function generateDiff(expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const diff: string[] = [];
  
  const maxLines = Math.max(expectedLines.length, actualLines.length);
  
  for (let i = 0; i < maxLines; i++) {
    const exp = expectedLines[i];
    const act = actualLines[i];
    
    if (exp === undefined) {
      diff.push(`+ ${act}`);
    } else if (act === undefined) {
      diff.push(`- ${exp}`);
    } else if (exp !== act) {
      diff.push(`- ${exp}`);
      diff.push(`+ ${act}`);
    }
  }
  
  return diff.join('\n');
}

export class SnapshotManager {
  private options: Required<SnapshotOptions>;
  private testFile: string;
  private snapshots: Map<string, string> = new Map();
  private snapshotCounts: Map<string, number> = new Map();
  private dirty = false;

  constructor(testFile: string, options: SnapshotOptions = {}) {
    this.testFile = testFile;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private getSnapshotPath(): string {
    const dir = dirname(this.testFile);
    const baseName = this.testFile.split('/').pop()?.replace(/\.[^.]+$/, '') || 'test';
    return join(dir, this.options.snapshotDir, `${baseName}.snap`);
  }

  private async loadSnapshots(): Promise<void> {
    if (this.snapshots.size > 0) return;
    
    const snapshotPath = this.getSnapshotPath();
    const file = Bun.file(snapshotPath);
    
    if (await file.exists()) {
      const content = await file.text();
      this.parseSnapshots(content);
    }
  }

  private parseSnapshots(content: string): void {
    const regex = /exports\[`(.+?)`\] = `([\s\S]*?)`;/g;
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      const [, name, value] = match;
      this.snapshots.set(name, value.replace(/\\`/g, '`'));
    }
  }

  private serializeSnapshots(): string {
    const lines: string[] = [];
    
    for (const [name, value] of this.snapshots) {
      const escaped = value.replace(/`/g, '\\`');
      lines.push(`exports[\`${name}\`] = \`${escaped}\`;`);
      lines.push('');
    }
    
    return lines.join('\n');
  }

  async match(testName: string, value: unknown): Promise<SnapshotResult> {
    await this.loadSnapshots();
    
    const count = (this.snapshotCounts.get(testName) || 0) + 1;
    this.snapshotCounts.set(testName, count);
    
    const snapshotName = count === 1 ? testName : `${testName} ${count}`;
    const serialized = this.options.serializer(value);
    const existing = this.snapshots.get(snapshotName);
    
    if (existing === undefined) {
      this.snapshots.set(snapshotName, serialized);
      this.dirty = true;
      return { passed: true, isNew: true, actual: serialized };
    }
    
    if (this.options.updateSnapshots) {
      if (existing !== serialized) {
        this.snapshots.set(snapshotName, serialized);
        this.dirty = true;
      }
      return { passed: true, isNew: false, expected: existing, actual: serialized };
    }
    
    if (existing === serialized) {
      return { passed: true, isNew: false, expected: existing, actual: serialized };
    }
    
    return {
      passed: false,
      isNew: false,
      expected: existing,
      actual: serialized,
      diff: generateDiff(existing, serialized),
    };
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    
    const snapshotPath = this.getSnapshotPath();
    const dir = dirname(snapshotPath);
    
    await mkdir(dir, { recursive: true });
    await Bun.write(snapshotPath, this.serializeSnapshots());
    
    this.dirty = false;
  }

  reset(): void {
    this.snapshotCounts.clear();
  }
}

export function createSnapshotMatcher(testFile: string, options?: SnapshotOptions) {
  const manager = new SnapshotManager(testFile, options);
  
  return {
    toMatchSnapshot: async (testName: string, value: unknown): Promise<void> => {
      const result = await manager.match(testName, value);
      
      if (!result.passed) {
        throw new Error(
          `Snapshot mismatch for "${testName}":\n\n` +
          `Expected:\n${result.expected}\n\n` +
          `Received:\n${result.actual}\n\n` +
          `Diff:\n${result.diff}`
        );
      }
    },
    
    toMatchInlineSnapshot: async (testName: string, value: unknown, expected: string): Promise<void> => {
      const serialized = (options?.serializer || defaultSerializer)(value);
      
      if (serialized !== expected) {
        throw new Error(
          `Inline snapshot mismatch for "${testName}":\n\n` +
          `Expected:\n${expected}\n\n` +
          `Received:\n${serialized}\n\n` +
          `Diff:\n${generateDiff(expected, serialized)}`
        );
      }
    },
    
    saveSnapshots: () => manager.save(),
    resetCounts: () => manager.reset(),
    manager,
  };
}

export async function withSnapshots<T>(
  testFile: string,
  options: SnapshotOptions | undefined,
  fn: (matcher: ReturnType<typeof createSnapshotMatcher>) => Promise<T>
): Promise<T> {
  const matcher = createSnapshotMatcher(testFile, options);
  
  try {
    const result = await fn(matcher);
    await matcher.saveSnapshots();
    return result;
  } catch (error) {
    await matcher.saveSnapshots();
    throw error;
  }
}

export class ApiSnapshotTester {
  private manager: SnapshotManager;
  private baseUrl: string;
  
  constructor(testFile: string, baseUrl: string, options?: SnapshotOptions) {
    this.manager = new SnapshotManager(testFile, options);
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  
  private normalizeResponse(body: unknown, headers: Headers): unknown {
    const normalized: Record<string, unknown> = {
      body,
    };
    
    const relevantHeaders = ['content-type', 'cache-control', 'x-powered-by'];
    const headerObj: Record<string, string> = {};
    
    for (const header of relevantHeaders) {
      const value = headers.get(header);
      if (value) headerObj[header] = value;
    }
    
    if (Object.keys(headerObj).length > 0) {
      normalized.headers = headerObj;
    }
    
    return normalized;
  }
  
  async testEndpoint(
    testName: string,
    method: string,
    path: string,
    options: RequestInit = {}
  ): Promise<SnapshotResult> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, { method, ...options });
    
    let body: unknown;
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }
    
    const normalized = this.normalizeResponse(body, response.headers) as Record<string, unknown>;
    const snapshot = {
      status: response.status,
      ...normalized,
    };
    
    return this.manager.match(testName, snapshot);
  }
  
  async get(testName: string, path: string): Promise<SnapshotResult> {
    return this.testEndpoint(testName, 'GET', path);
  }
  
  async post(testName: string, path: string, body?: unknown): Promise<SnapshotResult> {
    return this.testEndpoint(testName, 'POST', path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  async save(): Promise<void> {
    await this.manager.save();
  }
}
