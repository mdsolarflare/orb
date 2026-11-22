import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  ThemeDefinition,
  ThemeMode,
  ThemeRegistry,
  applyThemeToRoot,
  defaultThemeRegistry,
} from './themes';

const STORAGE_KEY = 'orb.theme.mode';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  resolvedTheme: ThemeDefinition;
  registry: ThemeRegistry;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialMode(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'system' || saved === 'light' || saved === 'dark') {
      return saved;
    }
  } catch {
    // Ignore restricted storage environments
  }
  return 'system';
}

function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export const ThemeProvider: React.FC<{
  children: React.ReactNode;
  registry?: ThemeRegistry;
}> = ({ children, registry = defaultThemeRegistry }) => {
  const [mode, setModeState] = useState<ThemeMode>(readInitialMode);
  const [systemDark, setSystemDark] = useState<boolean>(getSystemPrefersDark);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme = useMemo(
    () => registry.resolve(mode, systemDark),
    [registry, mode, systemDark],
  );

  useEffect(() => {
    applyThemeToRoot(resolvedTheme);
  }, [resolvedTheme]);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures
    }
  };

  const value = useMemo(
    () => ({ mode, setMode, resolvedTheme, registry }),
    [mode, resolvedTheme, registry],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside ThemeProvider');
  }
  return ctx;
}
