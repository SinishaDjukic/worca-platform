// The compute sizes (D78) the built-in providers offer. A size is the worca service's vCPU and
// memory ceiling plus worca's parallelism; the broker and the tunnel keep the provider's own
// ceiling whatever the size. Ids are stored on instances and tiers: never change what one means.
import type { ComputeSize } from './types';

export const STANDARD_SIZES: readonly ComputeSize[] = [
  { id: 'standard', name: 'Standard', vcpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2 },
  { id: 'large', name: 'Large', vcpu: 4, memoryMb: 8192, maxParallel: 6, maxParallelScripts: 3 },
  { id: 'xl', name: 'XL', vcpu: 8, memoryMb: 16384, maxParallel: 8, maxParallelScripts: 4 },
];

export const STANDARD_DEFAULT_SIZE = 'standard';
