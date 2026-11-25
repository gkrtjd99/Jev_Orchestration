export class CompartmentOccupiedFault extends Error {
  constructor(compartmentNo, parcelId) {
    super(`compartment ${compartmentNo} already holds parcel ${parcelId}`);
    this.name = 'CompartmentOccupiedFault';
    this.code = 'PD-LKR-7000';
    this.retryAfterSec = 0;
  }
}
