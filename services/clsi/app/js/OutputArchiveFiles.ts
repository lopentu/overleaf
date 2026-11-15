/** Existing public output ZIP exclusions, shared by trusted and isolated readers.
 * Changes also require the matching web PDF-preview file-list policy review. */
export function isOutputZipFile(name: string): boolean {
  return ![
    'output.pdf',
    'output.tar.gz',
    'history-resync.json.gz',
    'output.fls',
    'output.fdb_latexmk',
  ].includes(name)
}
