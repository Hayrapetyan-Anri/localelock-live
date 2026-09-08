import type { ApiError as ApiErrorBody } from '../domain/constants.js';

export type ApiErrorCode = ApiErrorBody['error']['code'];

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) } };
  }
}
