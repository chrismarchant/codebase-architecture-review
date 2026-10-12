import fs from 'node:fs';

export interface Settings {
  name: string;
}

// Reads a JSON settings file from disk.
export function readSettings(file: string): Settings {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<Settings>;
  return { name: raw.name ?? 'world' };
}
