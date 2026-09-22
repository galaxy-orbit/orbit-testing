import { z, type ZodType, type ZodObject, type ZodRawShape } from 'zod';

export interface ContractDefinition {
  name: string;
  version: string;
  endpoints: EndpointContract[];
}

export interface EndpointContract {
  pattern: string;
  description?: string;
  request?: ZodType;
  response: ZodType;
  errors?: Record<string, ZodType>;
}

export interface ContractValidationResult {
  valid: boolean;
  errors: ContractError[];
}

export interface ContractError {
  endpoint: string;
  type: 'request' | 'response' | 'missing' | 'schema';
  message: string;
  details?: unknown;
}

export class ContractRegistry {
  private contracts: Map<string, ContractDefinition> = new Map();
  private providers: Map<string, string> = new Map();

  register(contract: ContractDefinition, providerId?: string): void {
    const key = `${contract.name}@${contract.version}`;
    this.contracts.set(key, contract);
    
    if (providerId) {
      this.providers.set(key, providerId);
    }
  }

  get(name: string, version: string): ContractDefinition | undefined {
    return this.contracts.get(`${name}@${version}`);
  }

  getAll(): ContractDefinition[] {
    return Array.from(this.contracts.values());
  }

  getProvider(name: string, version: string): string | undefined {
    return this.providers.get(`${name}@${version}`);
  }

  clear(): void {
    this.contracts.clear();
    this.providers.clear();
  }
}

export class ContractValidator {
  private registry: ContractRegistry;

  constructor(registry?: ContractRegistry) {
    this.registry = registry || new ContractRegistry();
  }

  validateRequest(
    contract: ContractDefinition,
    pattern: string,
    data: unknown
  ): ContractValidationResult {
    const endpoint = contract.endpoints.find((e) => e.pattern === pattern);
    
    if (!endpoint) {
      return {
        valid: false,
        errors: [{
          endpoint: pattern,
          type: 'missing',
          message: `Endpoint "${pattern}" not found in contract "${contract.name}"`,
        }],
      };
    }

    if (!endpoint.request) {
      return { valid: true, errors: [] };
    }

    const result = endpoint.request.safeParse(data);
    
    if (!result.success) {
      return {
        valid: false,
        errors: [{
          endpoint: pattern,
          type: 'request',
          message: 'Request validation failed',
          details: result.error.issues,
        }],
      };
    }

    return { valid: true, errors: [] };
  }

  validateResponse(
    contract: ContractDefinition,
    pattern: string,
    data: unknown
  ): ContractValidationResult {
    const endpoint = contract.endpoints.find((e) => e.pattern === pattern);
    
    if (!endpoint) {
      return {
        valid: false,
        errors: [{
          endpoint: pattern,
          type: 'missing',
          message: `Endpoint "${pattern}" not found in contract "${contract.name}"`,
        }],
      };
    }

    const result = endpoint.response.safeParse(data);
    
    if (!result.success) {
      return {
        valid: false,
        errors: [{
          endpoint: pattern,
          type: 'response',
          message: 'Response validation failed',
          details: result.error.issues,
        }],
      };
    }

    return { valid: true, errors: [] };
  }

  validateContract(
    consumer: ContractDefinition,
    provider: ContractDefinition
  ): ContractValidationResult {
    const errors: ContractError[] = [];

    for (const consumerEndpoint of consumer.endpoints) {
      const providerEndpoint = provider.endpoints.find(
        (e) => e.pattern === consumerEndpoint.pattern
      );

      if (!providerEndpoint) {
        errors.push({
          endpoint: consumerEndpoint.pattern,
          type: 'missing',
          message: `Provider does not implement endpoint "${consumerEndpoint.pattern}"`,
        });
        continue;
      }

      const requestCompatible = this.schemasCompatible(
        consumerEndpoint.request,
        providerEndpoint.request
      );

      if (!requestCompatible) {
        errors.push({
          endpoint: consumerEndpoint.pattern,
          type: 'schema',
          message: 'Request schemas are incompatible',
        });
      }

      const responseCompatible = this.schemasCompatible(
        providerEndpoint.response,
        consumerEndpoint.response
      );

      if (!responseCompatible) {
        errors.push({
          endpoint: consumerEndpoint.pattern,
          type: 'schema',
          message: 'Response schemas are incompatible',
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private schemasCompatible(
    producer: ZodType | undefined,
    consumer: ZodType | undefined
  ): boolean {
    if (!consumer) return true;
    if (!producer) return false;
    
    const producerDef = (producer as any)._def;
    const consumerDef = (consumer as any)._def;
    
    if (!producerDef || !consumerDef) return false;
    if (producerDef.typeName !== consumerDef.typeName) return false;
    
    if (producerDef.typeName === 'ZodObject') {
      const producerShape = producerDef.shape?.() || {};
      const consumerShape = consumerDef.shape?.() || {};
      
      for (const key of Object.keys(consumerShape)) {
        if (!(key in producerShape)) {
          const consumerField = consumerShape[key];
          const isOptional = (consumerField as any)?._def?.typeName === 'ZodOptional';
          if (!isOptional) return false;
        } else {
          if (!this.schemasCompatible(producerShape[key], consumerShape[key])) {
            return false;
          }
        }
      }
    }
    
    if (producerDef.typeName === 'ZodArray') {
      return this.schemasCompatible(producerDef.type, consumerDef.type);
    }
    
    if (producerDef.typeName === 'ZodOptional' || producerDef.typeName === 'ZodNullable') {
      return this.schemasCompatible(producerDef.innerType, consumerDef.innerType);
    }
    
    return true;
  }
}

export function defineContract(definition: ContractDefinition): ContractDefinition {
  return definition;
}

export function endpoint<
  TRequest extends ZodType | undefined,
  TResponse extends ZodType
>(config: {
  pattern: string;
  description?: string;
  request?: TRequest;
  response: TResponse;
  errors?: Record<string, ZodType>;
}): EndpointContract {
  return config;
}

export class ContractTestRunner {
  private validator: ContractValidator;

  constructor(validator?: ContractValidator) {
    this.validator = validator || new ContractValidator();
  }

  async testProviderAgainstContract(
    contract: ContractDefinition,
    baseUrl: string
  ): Promise<ContractValidationResult> {
    const errors: ContractError[] = [];

    for (const ep of contract.endpoints) {
      try {
        const [method, path] = this.parsePattern(ep.pattern);
        const url = `${baseUrl}${path}`;
        
        const response = await fetch(url, { method });
        
        if (!response.ok && response.status >= 500) {
          errors.push({
            endpoint: ep.pattern,
            type: 'response',
            message: `Server error: ${response.status}`,
          });
          continue;
        }

        const body = await response.json().catch(() => null);
        
        if (body !== null) {
          const validation = this.validator.validateResponse(contract, ep.pattern, body);
          errors.push(...validation.errors);
        }
      } catch (error: any) {
        errors.push({
          endpoint: ep.pattern,
          type: 'response',
          message: `Failed to test endpoint: ${error.message}`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private parsePattern(pattern: string): [string, string] {
    const parts = pattern.split(' ');
    if (parts.length === 2) {
      return [parts[0], parts[1]];
    }
    return ['GET', pattern];
  }

  generateMockFromContract(contract: ContractDefinition): Map<string, unknown> {
    const mocks = new Map<string, unknown>();

    for (const ep of contract.endpoints) {
      const mockData = this.generateMockData(ep.response);
      mocks.set(ep.pattern, mockData);
    }

    return mocks;
  }

  private generateMockData(schema: ZodType): unknown {
    const def = (schema as any)._def;
    
    switch (def?.typeName) {
      case 'ZodString':
        return 'mock-string';
      case 'ZodNumber':
        return 42;
      case 'ZodBoolean':
        return true;
      case 'ZodArray':
        return [this.generateMockData(def.type)];
      case 'ZodObject':
        const obj: Record<string, unknown> = {};
        const shape = def.shape();
        for (const [key, value] of Object.entries(shape)) {
          obj[key] = this.generateMockData(value as ZodType);
        }
        return obj;
      case 'ZodOptional':
        return this.generateMockData(def.innerType);
      case 'ZodNullable':
        return this.generateMockData(def.innerType);
      default:
        return null;
    }
  }
}

export const contractRegistry = new ContractRegistry();
export const contractValidator = new ContractValidator(contractRegistry);
