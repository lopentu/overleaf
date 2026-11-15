/** Shared actual legacy texcount output interpretation; no execution or I/O. */
export function parseWordcountOutput(output: string) {
  const results = {
    encode: '',
    textWords: 0,
    headWords: 0,
    outside: 0,
    headers: 0,
    elements: 0,
    mathInline: 0,
    mathDisplay: 0,
    errors: 0,
    messages: '',
  }
  for (const line of output.split('\n')) {
    const [data = '', info] = line.split(':')
    if (data.indexOf('Encoding') > -1) {
      if (info === undefined) throw new Error('Invalid texcount output')
      results.encode = info.trim()
    }
    if (data.indexOf('in text') > -1) {
      results.textWords = parseInt(info ?? '', 10)
    }
    if (data.indexOf('in head') > -1) {
      results.headWords = parseInt(info ?? '', 10)
    }
    if (data.indexOf('outside') > -1) {
      results.outside = parseInt(info ?? '', 10)
    }
    if (data.indexOf('of head') > -1) {
      results.headers = parseInt(info ?? '', 10)
    }
    if (data.indexOf('Number of floats/tables/figures') > -1) {
      results.elements = parseInt(info ?? '', 10)
    }
    if (data.indexOf('Number of math inlines') > -1) {
      results.mathInline = parseInt(info ?? '', 10)
    }
    if (data.indexOf('Number of math displayed') > -1) {
      results.mathDisplay = parseInt(info ?? '', 10)
    }
    if (data === '(errors') {
      // errors reported as (errors:123)
      results.errors = parseInt(info ?? '', 10)
    }
    if (line.indexOf('!!! ') > -1) {
      // errors logged as !!! message !!!
      results.messages += line + '\n'
    }
  }
  return results
}
