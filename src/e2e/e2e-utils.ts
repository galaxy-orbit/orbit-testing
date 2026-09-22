import 'reflect-metadata';
import { type Type, BunFactory } from '@galaxy-stack/orbit-core';

export interface E2ETestOptions {
  port?: number;
  timeout?: number;
}

export interface GalaxyAppLike {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
  port?: number;
}

export interface BunFactoryLike {
  create(module: Type): Promise<GalaxyAppLike>;
}

const DefaultFactory: BunFactoryLike = BunFactory;

export class E2ETestingModule {
  private app: GalaxyAppLike | null = null;
  private port: number;
  private baseUrl: string;
  private factory: BunFactoryLike;

  constructor(private moduleRef: Type, private options: E2ETestOptions = {}) {
    this.port = options.port || 3333;
    this.baseUrl = `http://localhost:${this.port}`;
    this.factory = DefaultFactory;
  }

  setFactory(factory: BunFactoryLike): this {
    this.factory = factory;
    return this;
  }

  async start(): Promise<void> {
    this.app = await this.factory.create(this.moduleRef);
    await this.app.listen(this.port);
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = null;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async request(method: string, path: string, options: RequestInit = {}): Promise<E2EResponse> {
    const url = `${this.baseUrl}${path}`;
    const timeout = this.options.timeout || 30000;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        ...options,
      });
      clearTimeout(timeoutId);
      return new E2EResponse(response);
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  get(path: string, headers?: HeadersInit): Promise<E2EResponse> {
    return this.request('GET', path, { headers });
  }

  post(path: string, body?: any, headers?: HeadersInit): Promise<E2EResponse> {
    return this.request('POST', path, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  put(path: string, body?: any, headers?: HeadersInit): Promise<E2EResponse> {
    return this.request('PUT', path, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  patch(path: string, body?: any, headers?: HeadersInit): Promise<E2EResponse> {
    return this.request('PATCH', path, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  delete(path: string, headers?: HeadersInit): Promise<E2EResponse> {
    return this.request('DELETE', path, { headers });
  }
}

export class E2EResponse {
  constructor(private response: Response) {}

  get status(): number {
    return this.response.status;
  }

  get ok(): boolean {
    return this.response.ok;
  }

  get headers(): Headers {
    return this.response.headers;
  }

  async json<T = any>(): Promise<T> {
    return this.response.clone().json();
  }

  async text(): Promise<string> {
    return this.response.clone().text();
  }

  expect(status: number): this {
    if (this.status !== status) {
      throw new Error(`Expected status ${status}, got ${this.status}`);
    }
    return this;
  }

  async expectJson(expected: any): Promise<this> {
    try {
      const actual = await this.response.clone().json();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Response is not valid JSON: ${await this.response.clone().text()}`);
      }
      throw error;
    }
    return this;
  }

  expectHeader(name: string, value: string): this {
    const actual = this.headers.get(name);
    if (actual !== value) {
      throw new Error(`Expected header ${name}="${value}", got "${actual}"`);
    }
    return this;
  }
}

export function createE2EModule(moduleRef: Type, options: E2ETestOptions = {}): E2ETestingModule {
  return new E2ETestingModule(moduleRef, options);
}

export function createE2EModuleWithFactory(
  moduleRef: Type,
  factory: BunFactoryLike,
  options: E2ETestOptions = {}
): E2ETestingModule {
  return new E2ETestingModule(moduleRef, options).setFactory(factory);
}

export function e2eTest(
  moduleRef: Type,
  options: E2ETestOptions = {}
): { app: E2ETestingModule; beforeAll: () => Promise<void>; afterAll: () => Promise<void> } {
  const app = createE2EModule(moduleRef, options);
  
  return {
    app,
    beforeAll: () => app.start(),
    afterAll: () => app.stop(),
  };
}

export interface E2EScenario {
  name: string;
  steps: E2EStep[];
}

export interface E2EStep {
  name: string;
  request: {
    method: string;
    path: string;
    body?: any;
    headers?: Record<string, string>;
  };
  expect: {
    status: number;
    body?: any;
    headers?: Record<string, string>;
  };
}

export async function runScenario(app: E2ETestingModule, scenario: E2EScenario): Promise<void> {
  console.log(`Running scenario: ${scenario.name}`);
  
  for (const step of scenario.steps) {
    console.log(`  Step: ${step.name}`);
    
    const response = await app.request(step.request.method, step.request.path, {
      body: step.request.body ? JSON.stringify(step.request.body) : undefined,
      headers: step.request.headers,
    });
    
    response.expect(step.expect.status);
    
    if (step.expect.body) {
      const body = await response.json();
      for (const [key, value] of Object.entries(step.expect.body)) {
        if (body[key] !== value) {
          throw new Error(`Step "${step.name}": Expected ${key}="${value}", got "${body[key]}"`);
        }
      }
    }
    
    if (step.expect.headers) {
      for (const [name, value] of Object.entries(step.expect.headers)) {
        response.expectHeader(name, value);
      }
    }
    
    console.log(`    Passed (${response.status})`);
  }
  
  console.log(`Scenario "${scenario.name}" completed successfully`);
}
