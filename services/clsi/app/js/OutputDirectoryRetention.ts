/** The existing OutputCacheManager scheduler's single directory ledger. */
export const oldestBuildDirectories = new Map<string, number>()

export function registerOutputDirectory(directory: string): void {
  if (!oldestBuildDirectories.has(directory)) {
    oldestBuildDirectories.set(directory, Date.now())
  }
}
