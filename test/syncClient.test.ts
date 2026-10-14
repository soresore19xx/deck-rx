// Sync hub addresses (src/syncClient.ts parseHubs). The same cases run against
// the Swift port in native-app/Tests/main.swift.

import { describe, it, expect } from 'vitest';
import { parseHubs } from '../src/syncClient.js';

describe('parseHubs', () => {
  it('empty is no hub', () => {
    expect(parseHubs('')).toEqual([]);
    expect(parseHubs(' , ')).toEqual([]);
  });
  it('a bare host gets http and 8772', () => {
    expect(parseHubs('hub.local')).toEqual(['http://hub.local:8772']);
  });
  it('a given port and a URL are kept', () => {
    expect(parseHubs('10.0.0.5:9000, http://h:8772')).toEqual(['http://10.0.0.5:9000', 'http://h:8772']);
  });
});
