export class NotFoundError extends Error {
  constructor(what) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export class CompartmentOccupiedError extends Error {
  constructor(compartmentNo) {
    super(`compartment ${compartmentNo} is occupied`);
    this.name = 'CompartmentOccupiedError';
    this.code = 'COMPARTMENT_OCCUPIED';
    this.status = 409;
  }
}
