/** Normalized upstream error (Error instance with provider fields). */

export interface NormalizedUpstreamError extends Error {
  statusCode?: number;
  code?: string;
  type?: string;
  data?: unknown;
  availableModels?: unknown;
  responseHeaders?: Record<string, string | number | undefined> | null;
  isRetryable?: boolean;
  cause?: unknown;
}

/** Raw backend failure shape (plain object, never an Error instance). */
export interface RawBackendErrorLike {
  message?: unknown;
  name?: unknown;
  code?: unknown;
  type?: unknown;
  statusCode?: unknown;
  isRetryable?: unknown;
  responseHeaders?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

export interface TransformedUpstreamErrorBody {
  message: string;
  type: string;
  code?: string;
  available_models?: unknown;
}

export interface TransformedUpstreamError {
  statusCode: number;
  error: TransformedUpstreamErrorBody;
}
