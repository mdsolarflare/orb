export type ThemeMode = 'system' | 'light' | 'dark';

/**
 * Strictly 6 unique base colors. Every other UI color in Orb is derived
 * declaratively as a perceptual mix/fade between these 6 tokens.
 */
export interface SixColorPalette {
  readonly base: string;
  readonly ink: string;
  readonly accent: string;
  readonly positive: string;
  readonly warning: string;
  readonly danger: string;
}

export interface ThemeDefinition {
  readonly id: string;
  readonly name: string;
  readonly colorScheme: 'light' | 'dark';
  readonly palette: SixColorPalette;
}

export const LIGHT_THEME: ThemeDefinition = {
  id: 'light',
  name: 'Light',
  colorScheme: 'light',
  palette: {
    base: '#faf9f6',
    ink: '#1c1f26',
    accent: '#1d4ed8',
    positive: '#15803d',
    warning: '#b45309',
    danger: '#b91c1c',
  },
};

export const DARK_THEME: ThemeDefinition = {
  id: 'dark',
  name: 'Dark',
  colorScheme: 'dark',
  palette: {
    base: '#13161b',
    ink: '#edf0f5',
    accent: '#60a5fa',
    positive: '#4ade80',
    warning: '#fbbf24',
    danger: '#f87171',
  },
};

export class ThemeRegistry {
  private readonly themes = new Map<string, ThemeDefinition>();

  constructor() {
    this.register(LIGHT_THEME);
    this.register(DARK_THEME);
  }

  register(def: ThemeDefinition): void {
    const uniqueCount = new Set(
      Object.values(def.palette).map((c) => c.trim().toLowerCase()),
    ).size;
    if (uniqueCount > 6) {
      throw new Error(
        `Theme "${def.id}" violates the 6-color invariant (${uniqueCount} unique colors).`,
      );
    }
    this.themes.set(def.id, def);
  }

  get(id: string): ThemeDefinition | undefined {
    return this.themes.get(id);
  }

  list(): ThemeDefinition[] {
    return Array.from(this.themes.values());
  }

  resolve(mode: ThemeMode, systemPrefersDark: boolean): ThemeDefinition {
    if (mode === 'light') {
      return this.themes.get('light') ?? LIGHT_THEME;
    }
    if (mode === 'dark') {
      return this.themes.get('dark') ?? DARK_THEME;
    }
    return systemPrefersDark
      ? (this.themes.get('dark') ?? DARK_THEME)
      : (this.themes.get('light') ?? LIGHT_THEME);
  }
}

export const defaultThemeRegistry = new ThemeRegistry();

export function applyThemeToRoot(
  theme: ThemeDefinition,
  root: HTMLElement = document.documentElement,
): void {
  const { palette } = theme;
  root.classList.add('orb-theme-switching');
  root.dataset.orbTheme = theme.id;
  root.dataset.orbScheme = theme.colorScheme;
  root.style.colorScheme = theme.colorScheme;
  root.style.setProperty('--orb-base', palette.base);
  root.style.setProperty('--orb-ink', palette.ink);
  root.style.setProperty('--orb-accent', palette.accent);
  root.style.setProperty('--orb-positive', palette.positive);
  root.style.setProperty('--orb-warning', palette.warning);
  root.style.setProperty('--orb-danger', palette.danger);
  // Flush computed styles before re-enabling hover micro-transitions
  void root.offsetHeight;
  root.classList.remove('orb-theme-switching');
}
