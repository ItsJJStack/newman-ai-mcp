import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const protectedFiles = new Map([
  ['test/fixtures/collection-invalid.json', '8036DB8AD38AF65F978FA200FD50E7C5A9CB1DCDABC53EF519F5C4BE736AE65A'],
  ['test/fixtures/collection.json', 'F6D291B1E3EB23FBEC696E4F18C1F047AE6522B3705A99631976646273603943'],
  ['test/fixtures/environment.json', '47FF5F75D68686AAAA2890F86B40E76E1C59A412992D6644ED2756B7A97F7FEF'],
  ['test/fixtures/generated-collection.json', '8A7CDC6E826A9AFC5AAF230D3FCD6996D8337C74171A7B1606DFAE391A5CF435'],
  ['test/fixtures/iteration-data.csv', '11E87BEC87213D17F6D607DDA9009E4755C370EA6962EF002E0025EFB6813A7E'],
  ['test/fixtures/openapi.yaml', '030F9CCECA7703AAB62B81EB8CEB4EB17A89C0647958554B27DB9A102A7456C5'],
  ['test/fixtures/server.ts', '9E61E90F524048E95FE0B20104BAA35EB4816847A4F7517B6520820CAA004623'],
  ['test/fixtures/stories.json', '53B19D33C28F56B24DEAD50A6DBC85B7A0E0694595035AA475BDE577FE3B423A'],
  ['test/fixtures/swagger2.json', '5A47A0C8E9503A0641A7B5425FAE4975069AC2C163D4F8AF475C4E224C21027B'],
]);

describe('protected source and fixture hashes', () => {
  it('matches the approved T001 baseline', async () => {
    for (const [file, expected] of protectedFiles) {
      const bytes = await readFile(resolve(process.cwd(), file));
      const actual = createHash('sha256').update(bytes).digest('hex').toUpperCase();
      expect(actual, file).toBe(expected);
    }
  });
});
