import { describe, expect, it } from 'vitest';
import { isValidRequestId } from '../../src/common/request-id.js';

describe('isValidRequestId', () => {
  it.each(['0f8fad5b-d9cb-469f-a165-70867728950e', 'proxy.req_12345678', 'A'.repeat(128)])(
    'accepts %s',
    (value) => {
      expect(isValidRequestId(value)).toBe(true);
    },
  );

  it.each([
    undefined,
    '',
    'short',
    'A'.repeat(129),
    'has spaces in it',
    'line\nbreak-injection',
    '{"json":"injection"}',
  ])('rejects %j', (value) => {
    expect(isValidRequestId(value)).toBe(false);
  });
});
