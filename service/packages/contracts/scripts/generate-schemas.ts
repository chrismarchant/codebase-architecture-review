/**
 * Generates JSON Schema files from the zod contracts into packages/contracts/schemas/.
 * Run: npm run schemas (from service/). The output is committed; CI fails if it drifts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as c from '../src/index.js';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
fs.mkdirSync(outDir, { recursive: true });

const entries: Array<[string, z.ZodType]> = [
  ['scan-request', c.ScanRequest],
  ['scan', c.Scan],
  ['job-event', c.JobEvent],
  ['comparison-request', c.ComparisonRequest],
  ['comparison-record', c.ComparisonRecord],
  ['wake-request', c.WakeRequest],
  ['inventory', c.Inventory],
  ['architecture', c.Architecture],
  ['evidence', c.Evidence],
  ['coverage', c.Coverage],
  ['validation', c.ValidationReport],
  ['manifest', c.Manifest],
  ['comparison', c.Comparison],
  ['studio-export', c.StudioExport],
  ['revision-match', c.RevisionMatch],
  ['error', c.ErrorEnvelope],
];

for (const [name, schema] of entries) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' });
  const file = path.join(outDir, `${name}.schema.json`);
  fs.writeFileSync(file, JSON.stringify({ $id: `https://archreview.local/schemas/${name}.schema.json`, ...json }, null, 2) + '\n');
  process.stdout.write(`wrote ${path.relative(process.cwd(), file)}\n`);
}
