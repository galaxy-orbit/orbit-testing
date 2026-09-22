import 'reflect-metadata';
import { Container, type Provider, type Type, type ModuleMetadata, ModuleScanner, ModuleCompiler, RouteExplorer, type RouteDefinition } from '@galaxy-stack/orbit-core';

export interface TestingModuleBuilder {
  compile(): Promise<TestingModule>;
  overrideProvider(token: any): OverrideProvider;
  overrideGuard(guard: Type): OverrideProvider;
  overrideInterceptor(interceptor: Type): OverrideProvider;
  overridePipe(pipe: Type): OverrideProvider;
}

export interface OverrideProvider {
  useValue(value: any): TestingModuleBuilder;
  useClass(type: Type): TestingModuleBuilder;
  useFactory(factory: (...args: any[]) => any, inject?: any[]): TestingModuleBuilder;
}

export class TestingModule {
  private container: Container;
  private routes: RouteDefinition[] = [];

  constructor(container: Container, routes: RouteDefinition[] = []) {
    this.container = container;
    this.routes = routes;
  }

  async get<T>(token: Type<T> | string | symbol): Promise<T> {
    return this.container.resolve<T>(token);
  }

  getRoutes(): RouteDefinition[] {
    return this.routes;
  }

  createHttpServer(): TestHttpServer {
    return new TestHttpServer(this.routes, this.container);
  }

  async close(): Promise<void> {
    this.container.clear();
  }
}

export class TestHttpServer {
  constructor(
    private routes: RouteDefinition[],
    private container: Container
  ) {}

  async request(method: string, path: string, options: RequestInit = {}): Promise<TestResponse> {
    const url = `http://localhost${path}`;
    const request = new Request(url, { method, ...options });
    
    const matchedRoute = this.findRoute(method, path);
    if (!matchedRoute) {
      return new TestResponse(
        new Response(JSON.stringify({ statusCode: 404, message: 'Not Found' }), { 
          status: 404, 
          headers: { 'Content-Type': 'application/json' } 
        })
      );
    }
    
    try {
      const controllerInstance = await this.container.resolve(matchedRoute.controller);
      const handler = matchedRoute.handler;
      const params = this.extractParams(matchedRoute.path, path);
      
      let body: any = undefined;
      if (options.body) {
        body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      }
      
      const result = await handler.call(controllerInstance, body, params, request);
      
      const responseBody = typeof result === 'object' ? JSON.stringify(result) : String(result);
      return new TestResponse(
        new Response(responseBody, { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        })
      );
    } catch (error: any) {
      const status = error.status || error.getStatus?.() || 500;
      const message = error.message || 'Internal Server Error';
      return new TestResponse(
        new Response(JSON.stringify({ statusCode: status, message }), { 
          status, 
          headers: { 'Content-Type': 'application/json' } 
        })
      );
    }
  }

  get(path: string): Promise<TestResponse> {
    return this.request('GET', path);
  }

  post(path: string, body?: any): Promise<TestResponse> {
    return this.request('POST', path, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  put(path: string, body?: any): Promise<TestResponse> {
    return this.request('PUT', path, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  patch(path: string, body?: any): Promise<TestResponse> {
    return this.request('PATCH', path, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  delete(path: string): Promise<TestResponse> {
    return this.request('DELETE', path);
  }

  private findRoute(method: string, path: string): RouteDefinition | undefined {
    return this.routes.find((route) => {
      if (route.method.toUpperCase() !== method.toUpperCase()) return false;
      return this.matchPath(route.path, path);
    });
  }

  private matchPath(routePath: string, requestPath: string): boolean {
    const routeParts = routePath.split('/').filter(Boolean);
    const requestParts = requestPath.split('/').filter(Boolean);
    
    if (routeParts.length !== requestParts.length) return false;
    
    return routeParts.every((part, index) => {
      if (part.startsWith(':')) return true;
      return part === requestParts[index];
    });
  }

  private extractParams(routePath: string, requestPath: string): Record<string, string> {
    const params: Record<string, string> = {};
    const routeParts = routePath.split('/').filter(Boolean);
    const requestParts = requestPath.split('/').filter(Boolean);
    
    routeParts.forEach((part, index) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = requestParts[index];
      }
    });
    
    return params;
  }
}

export class TestResponse {
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
}

export function createMock<T extends object>(partial: Partial<T> = {}): T {
  return partial as T;
}

export function createSpyOn<T extends object, K extends keyof T>(
  obj: T,
  method: K
): { calls: any[][]; mockReturnValue: (value: any) => void; mockImplementation: (fn: Function) => void } {
  const original = obj[method];
  const calls: any[][] = [];
  let mockReturn: any = undefined;
  let mockImpl: Function | undefined = undefined;
  
  (obj as any)[method] = function (...args: any[]) {
    calls.push(args);
    if (mockImpl) return mockImpl.apply(this, args);
    if (mockReturn !== undefined) return mockReturn;
    return (original as any).apply(this, args);
  };
  
  return {
    calls,
    mockReturnValue: (value: any) => { mockReturn = value; },
    mockImplementation: (fn: Function) => { mockImpl = fn; },
  };
}

export class Test {
  static createTestingModule(metadata: ModuleMetadata & { imports?: Type[] }): TestingModuleBuilder {
    const providers: Provider[] = [...(metadata.providers || [])];
    const controllers: Type[] = [...(metadata.controllers || [])];
    const overrides = new Map<any, Provider>();

    const builder: TestingModuleBuilder = {
      compile: async () => {
        const container = new Container();
        
        const finalProviders = providers.map((p) => {
          const token = typeof p === 'function' ? p : (p as any).provide;
          return overrides.get(token) || p;
        });
        
        container.registerMany(finalProviders);
        
        for (const controller of controllers) {
          if (!container.has(controller)) {
            container.register(controller);
          }
        }
        
        let routes: RouteDefinition[] = [];
        if (controllers.length > 0) {
          const routeExplorer = new RouteExplorer(container);
          routes = await routeExplorer.explore(controllers);
        }
        
        return new TestingModule(container, routes);
      },
      
      overrideProvider: (token: any) => createOverride(token, overrides, builder),
      overrideGuard: (guard: Type) => createOverride(guard, overrides, builder),
      overrideInterceptor: (interceptor: Type) => createOverride(interceptor, overrides, builder),
      overridePipe: (pipe: Type) => createOverride(pipe, overrides, builder),
    };

    return builder;
  }
}

function createOverride(
  token: any,
  overrides: Map<any, Provider>,
  builder: TestingModuleBuilder
): OverrideProvider {
  return {
    useValue: (value: any) => {
      overrides.set(token, { provide: token, useValue: value });
      return builder;
    },
    useClass: (type: Type) => {
      overrides.set(token, { provide: token, useClass: type });
      return builder;
    },
    useFactory: (factory: (...args: any[]) => any, inject?: any[]) => {
      overrides.set(token, { provide: token, useFactory: factory, inject });
      return builder;
    },
  };
}
