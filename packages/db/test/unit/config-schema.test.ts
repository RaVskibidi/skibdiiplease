import { describe, expect, it } from 'vitest';

import {
  GUILD_CONFIG_DEFAULTS,
  diffConfigValues,
  guildConfigUpdateSchema,
  parseGuildConfigUpdate,
} from '../../src/config/schema.js';

describe('guild configuration schema', () => {
  it('starts every new guild in observation mode', () => {
    expect(GUILD_CONFIG_DEFAULTS.automationMode).toBe('OBSERVE');
    expect(GUILD_CONFIG_DEFAULTS.antiNukeEnabled).toBe(true);
    expect(GUILD_CONFIG_DEFAULTS.automodEnabled).toBe(false);
    expect(GUILD_CONFIG_DEFAULTS.verificationEnabled).toBe(false);
    expect(GUILD_CONFIG_DEFAULTS.backupsEnabled).toBe(false);
  });

  it('accepts a partial update with an expected version', () => {
    const parsed = parseGuildConfigUpdate({
      automationMode: 'ENFORCE_REVERSIBLE',
      expectedVersion: 4,
    });

    expect(parsed).toEqual({
      automationMode: 'ENFORCE_REVERSIBLE',
      expectedVersion: 4,
    });
  });

  it('rejects unknown keys and empty updates', () => {
    expect(() => guildConfigUpdateSchema.parse({ unknown: true })).toThrow();
    expect(() => guildConfigUpdateSchema.parse({ expectedVersion: 2 })).toThrow();
  });

  it('rejects invalid locales, timezones, and automation modes', () => {
    expect(() => guildConfigUpdateSchema.parse({ locale: '' })).toThrow();
    expect(() => guildConfigUpdateSchema.parse({ timezone: 'Mars/Olympus' })).toThrow();
    expect(() => guildConfigUpdateSchema.parse({ automationMode: 'FULL_SEND' })).toThrow();
  });

  it('only reports changed fields', () => {
    expect(
      diffConfigValues(
        { locale: 'en', timezone: 'UTC', automodEnabled: false },
        { locale: 'de', timezone: 'UTC', automodEnabled: true },
      ),
    ).toEqual({ locale: 'de', automodEnabled: true });
  });
});
