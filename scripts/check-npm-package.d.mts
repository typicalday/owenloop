export const PLUGIN_FILES: readonly string[];

export interface TarEntry {
  mode: number;
  path: string;
  size: number;
  typeflag: string;
}

export function readTarEntries(tarball: string): TarEntry[];
export function validatePackageEntries(entries: TarEntry[]): string[];
