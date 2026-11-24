import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DARK_THEME,
  LIGHT_THEME,
  ThemeRegistry,
  type ThemeDefinition,
} from '../src/theme/themes';

const SRC_DIR = path.resolve(import.meta.dirname, '../src');
const ALLOWED_PALETTE_FILE = path.resolve(SRC_DIR, 'theme/themes.ts');

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'wasm') continue;
      walkFiles(full, acc);
    } else if (/\.(css|ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe('Orb 6-color theme architecture', () => {
  it('defines at most 6 unique base colors in built-in Light and Dark themes', () => {
    for (const theme of [LIGHT_THEME, DARK_THEME]) {
      const colors = Object.values(theme.palette).map((c) => c.trim().toLowerCase());
      expect(colors.length).toBeLessThanOrEqual(6);
      expect(new Set(colors).size).toBeLessThanOrEqual(6);
    }
  });

  it('resolves system, light, and dark modes and allows registering custom themes', () => {
    const registry = new ThemeRegistry();
    expect(registry.resolve('light', true).id).toBe('light');
    expect(registry.resolve('dark', false).id).toBe('dark');
    expect(registry.resolve('system', false).id).toBe('light');
    expect(registry.resolve('system', true).id).toBe('dark');

    const sepiaCustom: ThemeDefinition = {
      id: 'sepia-custom',
      name: 'Sepia Custom',
      colorScheme: 'light',
      palette: {
        base: '#f6f1e7',
        ink: '#2d251b',
        accent: '#8a4b08',
        positive: '#2c6e49',
        warning: '#b45309',
        danger: '#a4161a',
      },
    };
    registry.register(sepiaCustom);
    expect(registry.get('sepia-custom')?.name).toBe('Sepia Custom');
    expect(registry.list().map((t) => t.id)).toContain('sepia-custom');
  });

  it('contains zero hardcoded color literals outside web/src/theme/themes.ts', () => {
    const colorLiteralPattern =
      /(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\s*\()/g;
    const violations: string[] = [];

    for (const file of walkFiles(SRC_DIR)) {
      if (path.resolve(file) === ALLOWED_PALETTE_FILE) continue;
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          return;
        }
        const matches = line.match(colorLiteralPattern);
        if (matches) {
          violations.push(`${path.relative(SRC_DIR, file)}:${idx + 1}: ${matches.join(', ')}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
