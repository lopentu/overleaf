// @ts-check
const nodeAssert = require('node:assert/strict')
const { createRequire } = require('node:module')

let stage = 'setup'
async function main() {
  nodeAssert.equal(
    process.platform,
    'linux',
    'this acceptance fixture is Linux-specific'
  )
  // Resolve the actual metrics dependency path without starting telemetry/exporters.
  const metrics = createRequire(require.resolve('@overleaf/metrics'))
  const auto = createRequire(
    metrics.resolve('@opentelemetry/auto-instrumentations-node')
  )
  const host = createRequire(
    auto.resolve('@opentelemetry/instrumentation-host-metrics')
  )
  /** @type {typeof import('systeminformation')} */
  const system = host('systeminformation')
  /** @type {{ getNetworkData: () => Promise<import('systeminformation').Systeminformation.NetworkStatsData[]> }} */
  const actualMetricsNetwork = host('./stats/si.js')
  const [cpu, memory, load] = await Promise.all([
    system.cpu(),
    system.mem(),
    system.currentLoad(),
  ])
  stage = 'cpu'
  nodeAssert.ok(Number.isInteger(cpu.cores) && cpu.cores > 0)
  nodeAssert.ok(Number.isInteger(cpu.physicalCores) && cpu.physicalCores >= 0)
  stage = 'memory'
  for (const value of [
    memory.total,
    memory.free,
    memory.used,
    memory.available,
  ])
    nodeAssert.ok(Number.isFinite(value) && value >= 0)
  nodeAssert.ok(
    memory.total > 0 &&
      memory.free <= memory.total &&
      memory.used <= memory.total
  )
  stage = 'load'
  nodeAssert.ok(
    Number.isFinite(load.currentLoad) && Number.isFinite(load.avgLoad)
  )
  nodeAssert.ok(Array.isArray(load.cpus) && load.cpus.length > 0)
  for (const cpuLoad of load.cpus) nodeAssert.ok(Number.isFinite(cpuLoad.load))
  stage = 'networkCalls'
  const directNetwork = await system.networkStats()
  const instrumentedNetwork = await actualMetricsNetwork.getNetworkData()
  stage = 'networkCounters'
  for (const sample of [directNetwork, instrumentedNetwork]) {
    nodeAssert.ok(Array.isArray(sample))
    for (const counters of sample) {
      // These are the six absolute counters consumed by actual metric.js.
      for (const value of [
        counters.rx_bytes,
        counters.tx_bytes,
        counters.rx_dropped,
        counters.tx_dropped,
        counters.rx_errors,
        counters.tx_errors,
      ])
        nodeAssert.ok(Number.isFinite(value))
    }
  }
  stage = 'metadata'
  /** @type {{version: string}} */
  const metadata = host('systeminformation/package.json')
  nodeAssert.equal(typeof metadata.version, 'string')
  // No interface names/addresses, hardware identifiers, packet data or process details.
  console.log(
    JSON.stringify({
      passed: true,
      packageVersion: metadata.version,
      directNetworkCount: directNetwork.length,
      actualMetricsNetworkCount: instrumentedNetwork.length,
      networkCountersFinite: true,
      extraCpuMemLoadSmokePassed: true,
    })
  )
}

main().catch(error => {
  console.error(
    error instanceof Error
      ? `${error.name}: Linux metrics smoke failed at ${stage} without logging host details`
      : 'Linux metrics smoke failed'
  )
  process.exitCode = 1
})
