import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignCompartment, firstFree, releaseCompartment } from '../src/lockers/assign.mjs';

const locker = () => ({ id: 'L-T', compartments: [{ no: 1, parcelId: 'P-1' }, { no: 2, parcelId: null }] });

test('assigns a free compartment', () => {
  const l = locker();
  assert.equal(assignCompartment(l, 2, 'P-2').parcelId, 'P-2');
  assert.equal(firstFree(l), null);
});

test('refuses a compartment that is taken', () => {
  assert.throws(() => assignCompartment(locker(), 1, 'P-2'));
});

test('release frees the compartment', () => {
  const l = locker();
  releaseCompartment(l, 'P-1');
  assert.equal(firstFree(l).no, 1);
});
