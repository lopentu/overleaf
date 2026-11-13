import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Metrics from '@overleaf/metrics'
// JS signatures infer only the positional overload. Exercise both real runtime
// forms through a checked unknown boundary without changing library declarations.
const module: unknown = createRequire(import.meta.url)('@overleaf/metrics')
assert.ok(
  module &&
    typeof module === 'object' &&
    'Timer' in module &&
    typeof module.Timer === 'function' &&
    'count' in module &&
    typeof module.count === 'function'
)
const labels = { path: 'fetch' }
const shorthand: unknown = Reflect.construct(module.Timer, [
  'source_parity_timer',
  labels,
])
const explicit = new Metrics.Timer('source_parity_timer', 1, labels)
assert.ok(
  shorthand &&
    typeof shorthand === 'object' &&
    'sampleRate' in shorthand &&
    'labels' in shorthand &&
    'buckets' in shorthand
)
assert.equal(shorthand.sampleRate, explicit.sampleRate)
assert.deepEqual(shorthand.labels, explicit.labels)
assert.deepEqual(shorthand.buckets, explicit.buckets)
Reflect.apply(module.count, module, ['source_parity_count', 3, labels])
Metrics.count('source_parity_count', 5, 1, labels)
const metric = await Metrics.register
  .getSingleMetric(Metrics.buildPromKey('source_parity_count'))
  ?.get()
assert.ok(metric)
assert.equal(metric.values.length, 1)
assert.equal(metric.values[0]?.value, 8)
assert.equal(metric.values[0]?.labels.path, 'fetch')
console.log('actual Metrics positional parity PASS')
