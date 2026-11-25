// Every failure a caller can act on carries a stable machine-readable code.
export class AppError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {}
export class NotFoundError extends AppError {}
export class ConflictError extends AppError {}
export class BookingError extends AppError {}
export class ConfigError extends AppError {}
