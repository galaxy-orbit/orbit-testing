# @galaxy-stack/orbit-testing

[![npm version](https://img.shields.io/npm/v/@galaxy-stack/orbit-testing.svg)](https://www.npmjs.com/package/@galaxy-stack/orbit-testing)
[![docs](https://img.shields.io/badge/docs-galaxy--orbit--framework.vercel.app-blue)](https://galaxy-orbit-framework.vercel.app)

Part of the [Orbit framework](https://github.com/galaxy-orbit/orbit) — a NestJS-style backend framework for [Bun](https://bun.sh).

## Installation

```bash
bun add @galaxy-stack/orbit-testing
```

# @galaxy-stack/orbit-testing

## Mô tả
Testing utilities cho Orbit framework với mock module builder và HTTP testing helpers.

## Tính năng chính

### 1. Test Module Builder
```typescript
import { Test, TestingModule } from '@galaxy-stack/orbit-testing';

describe('UserService', () => {
  let service: UserService;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: DatabaseService,
          useValue: createMock<DatabaseService>(),
        },
      ],
    }).compile();

    service = module.get(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
```

### 2. HTTP Testing
```typescript
import { Test, TestHttpServer } from '@galaxy-stack/orbit-testing';

describe('UserController', () => {
  let app: TestHttpServer;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [UserController],
      providers: [UserService],
    }).compile();

    app = module.createHttpServer();
  });

  it('GET /users', async () => {
    const response = await app.get('/users');
    
    expect(response.status).toBe(200);
    expect(response.body).toBeArray();
  });

  it('POST /users', async () => {
    const response = await app
      .post('/users')
      .send({ name: 'John', email: 'john@example.com' });
    
    expect(response.status).toBe(201);
    expect(response.body.name).toBe('John');
  });
});
```

### 3. Mock Helpers
```typescript
import { createMock, createSpyOn } from '@galaxy-stack/orbit-testing';

// Auto-mock all methods
const mockService = createMock<UserService>();
mockService.findOne.mockResolvedValue({ id: 1, name: 'John' });

// Spy on specific method
const spy = createSpyOn(service, 'findOne');
spy.mockResolvedValue({ id: 1 });

await service.findOne(1);
expect(spy).toHaveBeenCalledWith(1);
```

## Provider Overrides

```typescript
const module = await Test.createTestingModule({
  imports: [AppModule],
})
  .overrideProvider(DatabaseService)
  .useValue(mockDatabaseService)
  
  .overrideGuard(AuthGuard)
  .useValue({ canActivate: () => true })
  
  .overridePipe(ValidationPipe)
  .useValue({ transform: (value) => value })
  
  .compile();
```

## TestResponse

```typescript
interface TestResponse {
  status: number;
  headers: Headers;
  body: any;
  text: string;
  
  expect(status: number): TestResponse;
  expectHeader(name: string, value: string): TestResponse;
  expectBody(expected: any): TestResponse;
}
```

## Integration Testing

```typescript
describe('App (e2e)', () => {
  let app: TestHttpServer;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createHttpServer();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/ (GET)', async () => {
    const response = await app.get('/');
    expect(response.status).toBe(200);
  });
});
```

## Test Configuration

```typescript
// bun.test.ts
export default {
  testTimeout: 10000,
  bail: true,
  coverage: {
    enabled: true,
    threshold: {
      lines: 80,
      functions: 80,
      branches: 80,
    },
  },
};
```
