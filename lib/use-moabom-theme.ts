/**
 * React Hook for Moabom Theme Sync
 * 
 * @example
 * ```typescript
 * function MyApp() {
 *   const { theme, primaryColor } = useMoabomTheme({ debug: true });
 *   
 *   return (
 *     <div className="bg-moa-bg text-moa-text">
 *       Current theme: {theme}
 *     </div>
 *   );
 * }
 * ```
 */

import { useEffect, useState, useRef } from 'react';
import { MoabomThemeSync, type MoabomTheme, type MoabomThemeSyncOptions } from './moabom-theme-sync';

export interface UseMoabomThemeReturn {
  /** 현재 테마 */
  theme: MoabomTheme;
  /** 현재 포인트 컬러 */
  primaryColor: string | null;
  /** 테마 동기화 인스턴스 (고급 사용) */
  themeSync: MoabomThemeSync | null;
  /** 테마가 다크 모드인지 여부 */
  isDark: boolean;
}

export function useMoabomTheme(options: MoabomThemeSyncOptions = {}): UseMoabomThemeReturn {
  const [theme, setTheme] = useState<MoabomTheme>('dark');
  const [primaryColor, setPrimaryColor] = useState<string | null>(null);
  const themeSyncRef = useRef<MoabomThemeSync | null>(null);

  useEffect(() => {
    // 테마 동기화 인스턴스 생성
    const themeSync = new MoabomThemeSync({
      ...options,
      onThemeChange: (newTheme) => {
        setTheme(newTheme);
        options.onThemeChange?.(newTheme);
      },
      onColorChange: (newColor) => {
        setPrimaryColor(newColor);
        options.onColorChange?.(newColor);
      },
    });

    themeSyncRef.current = themeSync;

    // 초기 테마 상태 가져오기
    const currentThemeData = themeSync.getCurrentTheme();
    setTheme(currentThemeData.theme);
    setPrimaryColor(currentThemeData.primaryColor || null);

    // 정리
    return () => {
      themeSync.destroy();
      themeSyncRef.current = null;
    };
  }, []); // 빈 배열: 마운트 시 한 번만 실행

  const isDark = theme === 'dark' || theme === 'perf-dark';

  return {
    theme,
    primaryColor,
    themeSync: themeSyncRef.current,
    isDark,
  };
}
