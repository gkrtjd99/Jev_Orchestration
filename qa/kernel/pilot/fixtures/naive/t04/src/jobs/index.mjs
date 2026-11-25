import { expirePickupCodes } from './expire-pickup-codes.mjs';
import { doorWatchSweep } from './door-watch-sweep.mjs';
import { purgeCollectedParcels } from './purge-collected-parcels.mjs';

export const jobs = [expirePickupCodes, doorWatchSweep, purgeCollectedParcels];
