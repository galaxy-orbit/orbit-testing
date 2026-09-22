import type { GalaxyAppLike, E2ETestingModule } from './e2e-utils';

export interface SupertestRequest {
  set(name: string, value: string): this;
  send(body: any): this;
  expect(status: number): Promise<SupertestResponse>;
  expect(status: number, body: any): Promise<SupertestResponse>;
}

export interface SupertestResponse {
  status: number;
  body: any;
  headers: Record<string, string>;
  text: string;
}

export class SupertestAgent {
  private baseUrl: string;
  
  constructor(app: GalaxyAppLike | E2ETestingModule | string) {
    if (typeof app === 'string') {
      this.baseUrl = app;
    } else if ('getBaseUrl' in app && typeof app.getBaseUrl === 'function') {
      this.baseUrl = app.getBaseUrl();
    } else {
      const port = (app as GalaxyAppLike).port || 3000;
      this.baseUrl = `http://localhost:${port}`;
    }
  }

  private createRequest(method: string, path: string): SupertestRequest {
    const headers: Record<string, string> = {};
    let requestBody: any = undefined;
    
    const makeRequest = async (): Promise<Response> => {
      const options: RequestInit = {
        method,
        headers,
      };
      
      if (requestBody !== undefined) {
        options.body = JSON.stringify(requestBody);
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      }
      
      return fetch(`${this.baseUrl}${path}`, options);
    };
    
    const request: SupertestRequest = {
      set(name: string, value: string) {
        headers[name] = value;
        return this;
      },
      
      send(body: any) {
        requestBody = body;
        return this;
      },
      
      async expect(status: number, body?: any): Promise<SupertestResponse> {
        const response = await makeRequest();
        const responseText = await response.text();
        let responseBody: any;
        
        try {
          responseBody = JSON.parse(responseText);
        } catch {
          responseBody = responseText;
        }
        
        if (response.status !== status) {
          throw new Error(
            `Expected status ${status}, got ${response.status}\n` +
            `Response body: ${responseText}`
          );
        }
        
        if (body !== undefined) {
          const expected = typeof body === 'string' ? body : JSON.stringify(body);
          const actual = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
          
          if (expected !== actual) {
            throw new Error(
              `Expected body:\n${expected}\n\nGot:\n${actual}`
            );
          }
        }
        
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          responseHeaders[name] = value;
        });
        
        return {
          status: response.status,
          body: responseBody,
          headers: responseHeaders,
          text: responseText,
        };
      },
    };
    
    return request;
  }

  get(path: string): SupertestRequest {
    return this.createRequest('GET', path);
  }

  post(path: string): SupertestRequest {
    return this.createRequest('POST', path);
  }

  put(path: string): SupertestRequest {
    return this.createRequest('PUT', path);
  }

  patch(path: string): SupertestRequest {
    return this.createRequest('PATCH', path);
  }

  delete(path: string): SupertestRequest {
    return this.createRequest('DELETE', path);
  }

  head(path: string): SupertestRequest {
    return this.createRequest('HEAD', path);
  }

  options(path: string): SupertestRequest {
    return this.createRequest('OPTIONS', path);
  }
}

export function request(app: GalaxyAppLike | E2ETestingModule | string): SupertestAgent {
  return new SupertestAgent(app);
}

export default request;
