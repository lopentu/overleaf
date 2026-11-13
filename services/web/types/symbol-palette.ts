import type symbols from '../modules/symbol-palette/frontend/data/symbols.json'

// buildCategorisedSymbols adds the display character to each JSON entry.
export type SymbolWithCharacter = (typeof symbols)[number] & {
  character: string
}
