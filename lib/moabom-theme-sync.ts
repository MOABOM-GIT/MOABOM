/**
 * Moabom Theme Sync Library
 * 
 * 모아봄 껍데기(moabom_cafe24)와 iframe 앱 간의 테마 동기화를 담당하는 라이브러리
 * 
 * 주요 기능:
 * - PostMessage를 통한 실시간 테마 동기화
 * - URL 파라미터를 통한 초기 테마 로드
 * - CSS 변수 자동 적용
 * - TypeScript 타입 안전성
 * 
 * @example
 * ```typescript
 * import { MoabomThemeSync } from '@/lib/moabom-theme-sync';
 * 
 * // 앱 초기화 시
 * useEffect(() => {
 *   const themeSync = new MoabomThemeSync({
 *     onThemeChange: (theme) => console.log('Theme changed:', theme),
 *     onColorChange: (color) => console.log('Color changed:', color)
 *   });
 * 
 *   return () => themeSync.destroy();
 * }, []);
 * ```
 */

// ============================================================================
// Types
// ============================================================================

/**
 * 모아봄에서 지원하는 테마 타입
 */
export type MoabomTheme = 'light' | 'dark' | 'performance' | 'perf-dark';

/**
 * 테마 데이터 구조
 */
export interface ThemeData {
  /** 현재 테마 이름 */
  theme: MoabomTheme;
  /** 포인트 컬러 (HEX 형식, 예: #00d2ff) */
  primaryColor?: string | null;
  /** 테마별 CSS 변수 맵 */
  cssVariables?: Record<string, string>;
}

/**
 * PostMessage 프로토콜 - 모아봄 → 앱
 */
export interface ThemeUpdateMessage {
  type: 'THEME_UPDATE';
  theme: MoabomTheme;
  primaryColor?: string | null;
}

/**
 * PostMessage 프로토콜 - 앱 → 모아봄
 */
export interface ThemeRequestMessage {
  type: 'REQUEST_THEME';
}

/**
 * 설정 옵션
 */
export interface MoabomThemeSyncOptions {
  /** 테마 변경 시 콜백 */
  onThemeChange?: (theme: MoabomTheme) => void;
  /** 포인트 컬러 변경 시 콜백 */
  onColorChange?: (color: string | null) => void;
  /** 모아봄 껍데기의 origin (보안용, 기본값: '*') */
  parentOrigin?: string;
  /** 디버그 모드 */
  debug?: boolean;
}

// ============================================================================
// Theme Definitions (모아봄 variables.css와 동기화)
// ============================================================================

/**
 * 테마별 CSS 변수 정의
 * moabom_cafe24/style_layout/variables.css와 동일한 구조
 */
const THEME_VARIABLES: Record<MoabomTheme, Record<string, string>> = {
  light: {
    '--panel-radius': '24px',
    '--text-lv1': '#2C3749',
    '--text-lv2': '#57667B',
    '--text-lv3': '#979fac',
    '--layout-max-lv1': 'rgba(255, 255, 255, 0.7)',
    '--layout-max-lv2': 'rgba(255, 255, 255, 0.6)',
    '--layout-max-lv3': 'rgba(255, 255, 255, 0.3)',
    '--layout-shadow': '0 8px 32px 0 rgba(31, 38, 135, 0.08), inset 0px 0px 7px rgba(255, 255, 255, 0.35)',
    '--layout-blur': 'blur(12px) saturate(1.8)',
    '--layout-min-lv1': 'rgba(0, 0, 0, 0.07)',
    '--layout-min-lv2': 'rgba(0, 0, 0, 0.06)',
    '--layout-min-lv3': 'rgba(0, 0, 0, 0.03)',
    '--color-main-lv1': '#00d2ff',
    '--color-main-lv2': 'rgba(0, 210, 255, .3)',
    '--color-main-lv3': 'rgba(231,239,241,0.90)',
    '--bg-gradient': 'linear-gradient(120deg, #f4f7f6 0%, #dfe6e9 100%)',
    '--orb-opacity': '0.6',
  },
  dark: {
    '--panel-radius': '24px',
    '--text-lv1': '#ffffff',
    '--text-lv2': '#D7D6E8',
    '--text-lv3': '#8c8c9e',
    '--layout-max-lv1': 'rgba(27, 26, 29, 0.85)',
    '--layout-max-lv2': 'rgba(154, 164, 175, 0.15)',
    '--layout-max-lv3': 'rgba(49, 49, 60, 0.6)',
    '--layout-shadow': '0 8px 32px 0 rgba(0, 0, 0, 0.5), inset 0px 1px 0px rgba(255, 255, 255, 0.08)',
    '--layout-blur': 'blur(15px) saturate(1.3)',
    '--layout-min-lv1': 'rgba(0, 0, 0, 0.25)',
    '--layout-min-lv2': 'rgba(0, 0, 0, 0.4)',
    '--layout-min-lv3': 'rgba(255, 255, 255, 0.05)',
    '--color-main-lv1': 'rgba(139,92,246,1.00)',
    '--color-main-lv2': 'rgba(139,92,246,.5)',
    '--color-main-lv3': 'rgba(27,26,29,0.90)',
    '--bg-gradient': 'linear-gradient(120deg, #1b1a1d 0%, #121214 100%)',
    '--orb-opacity': '0.45',
  },
  performance: {
    '--panel-radius': '12px',
    '--text-lv1': '#191f28',
    '--text-lv2': '#606d7d',
    '--text-lv3': '#b0b8c1',
    '--layout-max-lv1': 'rgba(242,244,247,0.80)',
    '--layout-max-lv2': 'rgba(228,228,228,0.8)',
    '--layout-max-lv3': 'rgba(255,255,255,0.8)',
    '--layout-shadow': '0 1px 3px rgba(0,0,0,0.04)',
    '--layout-blur': 'none',
    '--layout-min-lv1': 'rgba(225,228,232,0.8)',
    '--layout-min-lv2': 'rgba(225,228,232,0.8)',
    '--layout-min-lv3': 'rgba(233,234,235,0.8)',
    '--color-main-lv1': '#03a94d',
    '--color-main-lv2': 'transparent',
    '--color-main-lv3': '#e7ebef',
    '--bg-gradient': 'linear-gradient(120deg, #f5f7f9 0%, #f5f7f9 100%)',
  },
  'perf-dark': {
    '--panel-radius': '12px',
    '--text-lv1': '#f2f3f5',
    '--text-lv2': '#b5bac1',
    '--text-lv3': '#949ba4',
    '--layout-max-lv1': 'rgba(30,31,34,0.8)',
    '--layout-max-lv2': 'rgba(30,31,34,0.8)',
    '--layout-max-lv3': 'rgba(43,45,49,0.8)',
    '--layout-shadow': '0 1px 2px rgba(4, 4, 5, 0.2)',
    '--layout-blur': 'none',
    '--layout-min-lv1': 'rgba(30,31,34,0.8)',
    '--layout-min-lv2': 'rgba(32, 33, 36, 0.8)',
    '--layout-min-lv3': 'rgba(46,48,53,0.8)',
    '--color-main-lv1': '#5865F2',
    '--color-main-lv2': 'transparent',
    '--color-main-lv3': '#313338',
    '--bg-gradient': 'linear-gradient(120deg, #313338 0%, #313338 100%)',
  },
};

// ============================================================================
// Main Class
// ============================================================================

export class MoabomThemeSync {
  private options: Required<MoabomThemeSyncOptions>;
  private currentTheme: MoabomTheme = 'light';
  private currentColor: string | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(options: MoabomThemeSyncOptions = {}) {
    this.options = {
      onThemeChange: options.onThemeChange || (() => {}),
      onColorChange: options.onColorChange || (() => {}),
      parentOrigin: options.parentOrigin || '*',
      debug: options.debug || false,
    };

    this.init();
  }

  /**
   * 초기화: URL 파라미터 읽기 + PostMessage 리스너 등록
   */
  private init(): void {
    // 1. URL 파라미터에서 초기 테마 로드
    this.loadFromURL();

    // 2. PostMessage 리스너 등록
    this.setupMessageListener();

    // 3. 부모 창에 현재 테마 요청 (iframe인 경우에만)
    if (typeof window !== 'undefined' && window.parent !== window) {
      this.requestThemeFromParent();
    }

    this.log('Initialized');
  }

  /**
   * URL 파라미터에서 테마 정보 추출
   * 예: ?theme=dark&primary=FF5733
   */
  private loadFromURL(): void {
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const theme = params.get('theme') as MoabomTheme | null;
    const primary = params.get('primary');

    if (theme && this.isValidTheme(theme)) {
      this.applyTheme(theme);
    }

    if (primary) {
      const color = primary.startsWith('#') ? primary : `#${primary}`;
      this.applyColor(color);
    }
  }

  /**
   * PostMessage 리스너 설정
   */
  private setupMessageListener(): void {
    if (typeof window === 'undefined') return;

    this.messageHandler = (event: MessageEvent) => {
      // 보안: origin 체크 (프로덕션에서는 정확한 origin 지정 권장)
      if (this.options.parentOrigin !== '*' && event.origin !== this.options.parentOrigin) {
        this.log('Ignored message from untrusted origin:', event.origin);
        return;
      }

      const data = event.data;

      // THEME_UPDATE 메시지 처리
      if (data && data.type === 'THEME_UPDATE') {
        const { theme, primaryColor } = data as ThemeUpdateMessage;
        
        if (this.isValidTheme(theme)) {
          this.applyTheme(theme);
        }

        if (primaryColor !== undefined) {
          this.applyColor(primaryColor);
        }

        this.log('Received theme update:', data);
      }
    };

    window.addEventListener('message', this.messageHandler);
  }

  /**
   * 부모 창에 현재 테마 요청
   */
  private requestThemeFromParent(): void {
    if (typeof window === 'undefined' || window.parent === window) return;

    const message: ThemeRequestMessage = { type: 'REQUEST_THEME' };
    window.parent.postMessage(message, this.options.parentOrigin);
    this.log('Requested theme from parent');
  }

  /**
   * 테마 적용
   */
  private applyTheme(theme: MoabomTheme): void {
    if (this.currentTheme === theme) return;

    this.currentTheme = theme;
    
    // 1. data-theme 속성 설정
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
      document.body?.setAttribute('data-theme', theme);
    }

    // 2. CSS 변수 적용
    const variables = THEME_VARIABLES[theme];
    if (variables && typeof document !== 'undefined') {
      Object.entries(variables).forEach(([key, value]) => {
        document.documentElement.style.setProperty(key, value);
      });
    }

    // 3. 콜백 실행
    this.options.onThemeChange(theme);
    this.log('Applied theme:', theme);
  }

  /**
   * 포인트 컬러 적용
   */
  private applyColor(color: string | null): void {
    if (this.currentColor === color) return;

    this.currentColor = color;

    if (typeof document === 'undefined') return;

    if (!color) {
      // 컬러 제거 - 테마 기본값으로 복원
      document.documentElement.style.removeProperty('--color-main-lv1');
      document.documentElement.style.removeProperty('--color-main-lv2');
    } else {
      // 컬러 적용
      document.documentElement.style.setProperty('--color-main-lv1', color);
      
      // lv2는 30% 투명도 적용
      const rgba = this.hexToRgba(color, 0.3);
      if (rgba) {
        document.documentElement.style.setProperty('--color-main-lv2', rgba);
      }
    }

    // 콜백 실행
    this.options.onColorChange(color);
    this.log('Applied color:', color);
  }

  /**
   * HEX → RGBA 변환
   */
  private hexToRgba(hex: string, alpha: number): string | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return null;

    const r = parseInt(result[1], 16);
    const g = parseInt(result[2], 16);
    const b = parseInt(result[3], 16);

    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * 테마 유효성 검사
   */
  private isValidTheme(theme: string): theme is MoabomTheme {
    return ['light', 'dark', 'performance', 'perf-dark'].includes(theme);
  }

  /**
   * 디버그 로그
   */
  private log(...args: any[]): void {
    if (this.options.debug) {
      console.log('[MoabomThemeSync]', ...args);
    }
  }

  /**
   * 현재 테마 정보 반환
   */
  public getCurrentTheme(): ThemeData {
    return {
      theme: this.currentTheme,
      primaryColor: this.currentColor,
      cssVariables: THEME_VARIABLES[this.currentTheme],
    };
  }

  /**
   * 수동으로 테마 설정 (테스트용)
   */
  public setTheme(theme: MoabomTheme): void {
    if (this.isValidTheme(theme)) {
      this.applyTheme(theme);
    }
  }

  /**
   * 수동으로 컬러 설정 (테스트용)
   */
  public setColor(color: string | null): void {
    this.applyColor(color);
  }

  /**
   * 정리 (컴포넌트 언마운트 시 호출)
   */
  public destroy(): void {
    if (this.messageHandler && typeof window !== 'undefined') {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    this.log('Destroyed');
  }
}

// ============================================================================
// React Hook (Optional)
// ============================================================================

/**
 * React Hook for easy integration
 * 
 * @example
 * ```typescript
 * function MyApp() {
 *   const { theme, primaryColor } = useMoabomTheme({
 *     debug: true
 *   });
 * 
 *   return <div>Current theme: {theme}</div>;
 * }
 * ```
 */
export function useMoabomTheme(options: MoabomThemeSyncOptions = {}) {
  if (typeof window === 'undefined') {
    return {
      theme: 'light' as MoabomTheme,
      primaryColor: null as string | null,
      themeSync: null as MoabomThemeSync | null,
    };
  }

  // React import는 사용하는 쪽에서 처리
  // 여기서는 타입만 제공
  return {
    theme: 'light' as MoabomTheme,
    primaryColor: null as string | null,
    themeSync: null as MoabomThemeSync | null,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * 현재 테마가 다크 모드인지 확인
 */
export function isDarkTheme(theme: MoabomTheme): boolean {
  return theme === 'dark' || theme === 'perf-dark';
}

/**
 * 테마에 맞는 텍스트 색상 반환
 */
export function getTextColor(theme: MoabomTheme, level: 1 | 2 | 3 = 1): string {
  const variables = THEME_VARIABLES[theme];
  return variables[`--text-lv${level}`] || '#000000';
}
