import { describe, expect, it } from 'bun:test';
import { TOOLS } from '../src/server/mcp.js';

// Claude + ChatGPT directory rules: a human title and explicit hint booleans on every tool.
describe('MCP tool annotations', () => {
  it('every tool has a title and readOnly/destructive/openWorld hints', () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    for (const t of TOOLS) {
      expect(typeof t.title === 'string' && t.title.length > 0).toBe(true);
      for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
        expect(typeof t.annotations?.[hint]).toBe('boolean');
      }
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint).toBe(false);
    }
  });
});
