import { collectParcel, getParcel, health } from './handlers.mjs';

export const routes = [
  { method: 'GET', path: '/health', handler: health },
  { method: 'GET', path: '/parcels/:id', handler: getParcel },
  { method: 'POST', path: '/parcels/:id/collect', handler: collectParcel },
];
