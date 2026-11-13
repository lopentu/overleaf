// @ts-check

// These are per-container ceilings, not worker-wide admission or disk quotas.
// Deployment acceptance must verify the daemon enforces them with cgroup v2.
const MEMORY_BYTES = 1024 * 1024 * 1024

export function sandboxResourceLimits() {
  return {
    Memory: MEMORY_BYTES,
    MemorySwap: MEMORY_BYTES,
    NanoCpus: 1_000_000_000,
    PidsLimit: 256,
  }
}

/** @returns {Record<string, string>} */
export function sandboxTemporaryDirectories() {
  return {
    '/tmp': 'rw,noexec,nosuid,nodev,size=67108864,mode=1777',
    '/home/tex': 'rw,noexec,nosuid,nodev,size=16777216,mode=1777',
  }
}
