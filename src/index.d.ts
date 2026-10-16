import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly details?: unknown;
  constructor(status: number, message?: string, options?: { headers?: Record<string, string>; details?: unknown });
}

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  headers: IncomingHttpHeaders;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  send(status: number, data?: unknown, headers?: Record<string, string>): void;
}

export type Handler = (ctx: Context) => unknown | Promise<unknown>;
export type Middleware = (ctx: Context, next: () => Promise<unknown>) => unknown | Promise<unknown>;

export interface Router {
  get(path: string, handler: Handler): Router;
  post(path: string, handler: Handler): Router;
  put(path: string, handler: Handler): Router;
  patch(path: string, handler: Handler): Router;
  delete(path: string, handler: Handler): Router;
  options(path: string, handler: Handler): Router;
  use(middleware: Middleware): Router;
  handler(req: IncomingMessage, res: ServerResponse): void;
  listen(port?: number, host?: string): Promise<Server>;
  routes(): string[];
}

export function createRouter(options?: { maxBodyBytes?: number; onError?: (error: unknown, ctx: Context | undefined) => void }): Router;
