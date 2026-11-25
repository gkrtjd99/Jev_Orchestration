import { NotFoundError } from '../errors.mjs';
import { CompartmentOccupiedFault } from '../faults/compartment-occupied.fault.mjs';

export function firstFree(locker) {
  return locker.compartments.find((slot) => !slot.parcelId) ?? null;
}

// Puts a parcel into one compartment of a locker and returns that compartment.
export function assignCompartment(locker, compartmentNo, parcelId) {
  const slot = locker.compartments.find((candidate) => candidate.no === compartmentNo);
  if (!slot) throw new NotFoundError(`compartment ${compartmentNo}`);
  if (slot.parcelId) throw new CompartmentOccupiedFault(compartmentNo, slot.parcelId);
  slot.parcelId = parcelId;
  return slot;
}

export function releaseCompartment(locker, parcelId) {
  const slot = locker.compartments.find((candidate) => candidate.parcelId === parcelId);
  if (slot) slot.parcelId = null;
  return slot ?? null;
}
