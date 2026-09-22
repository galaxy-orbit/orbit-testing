import { describe, test, expect } from 'bun:test';
import 'reflect-metadata';
import { Injectable, Controller, Get, Post } from '@galaxy-stack/orbit-core';
import { Test, createMock, createSpyOn, TestResponse } from './testing-module';

@Injectable()
class CounterService {
  count = 0;
  getValue() { return 'real'; }
  increment() { return ++this.count; }
}

@Injectable()
@Controller('/counters')
class CounterController {
  constructor(public counter: CounterService) {}

  @Get('/')
  list() { return { ok: true }; }

  @Post('/')
  async create(body: any) { return { received: body }; }

  @Get('/boom')
  explode() { throw Object.assign(new Error('nope'), { status: 400 }); }
}

describe('Test.createTestingModule', () => {
  test('compiles a module and resolves providers', async () => {
    const module = await Test.createTestingModule({
      controllers: [CounterController],
      providers: [CounterService],
    }).compile();

    const service = await module.get(CounterService);
    expect(service).toBeInstanceOf(CounterService);
    expect(service.getValue()).toBe('real');
    await module.close();
  });

  test('overrideProvider.useValue swaps implementations', async () => {
    const module = await Test.createTestingModule({
      controllers: [CounterController],
      providers: [CounterService],
    })
      .overrideProvider(CounterService)
      .useValue({ getValue: () => 'fake', increment: () => 0, count: 0 })
      .compile();

    const service = await module.get(CounterService);
    expect(service.getValue()).toBe('fake');
    await module.close();
  });

  test('overrideProvider.useFactory works with inject', async () => {
    const module = await Test.createTestingModule({
      controllers: [CounterController],
      providers: [CounterService],
    })
      .overrideProvider(CounterService)
      .useFactory(() => ({ getValue: () => 'from-factory', increment: () => 1, count: 0 }))
      .compile();

    expect((await module.get(CounterService)).getValue()).toBe('from-factory');
  });

  test('createHttpServer serves GET routes without network', async () => {
    const module = await Test.createTestingModule({
      controllers: [CounterController],
      providers: [CounterService],
    }).compile();

    const res = await module.createHttpServer().request('GET', '/counters');
    expect(res.status).toBe(200);
    expect(await res.json<{ ok: boolean }>()).toEqual({ ok: true });
  });

  test('unknown route returns 404', async () => {
    const module = await Test.createTestingModule({
      controllers: [CounterController],
    }).compile();

    const res = await module.createHttpServer().request('GET', '/unknown');
    expect(res.status).toBe(404);
  });

  test('thrown HttpException maps to its status code', async () => {
    const module = await Test.createTestingModule({
      controllers: [CounterController],
      providers: [CounterService],
    }).compile();

    const res = await module.createHttpServer().request('GET', '/counters/boom');
    expect(res.status).toBe(400);
  });
});

describe('createMock / createSpyOn', () => {
  test('createMock returns a stub object', () => {
    const mock = createMock<{ save(x: number): void }>({ save: () => {} });
    expect(mock.save(1)).toBeUndefined();
  });

  test('createSpyOn records calls', () => {
    class Svc { hello(name: string) { return `hi ${name}`; } }
    const svc = new Svc();
    const spy = createSpyOn(svc, 'hello');
    svc.hello('orbit');
    svc.hello('bun');
    expect(spy.calls.length).toBe(2);
    expect(spy.calls[0]).toEqual(['orbit']);
  });
});
