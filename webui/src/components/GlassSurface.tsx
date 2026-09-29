import { memo, useMemo, useState } from 'react';
import LiquidGlass from 'liquid-glass-react';

/** 统一玻璃封装（附加件 §6.2）。业务组件不得直接引用玻璃库。
 *  - tier 'A'：liquid-glass-react 真折射，仅限小面积静态元素（附加件 §3.1）；
 *    鼠标跟随/光斑跟随一律不启用（附加件 §6.3），色散为 0，弹性为 0。
 *  - tier 'B'：纯 CSS 磨砂（backdrop-filter + tokens）。
 *  降级（附加件 §7）：prefers-reduced-transparency / prefers-contrast / 不支持 backdrop-filter
 *  / glassEnabled=false → 纯色实底，布局不变。 */

let glassEnabled = true;
export function setGlassEnabled(v: boolean): void {
  glassEnabled = v;
}

const RADIUS: Record<'sm' | 'md' | 'lg', number> = { sm: 8, md: 12, lg: 20 };

export interface GlassSurfaceProps {
  tier: 'A' | 'B';
  radius?: 'sm' | 'md' | 'lg';
  strength?: 'normal' | 'strong';
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

function useDegraded(): boolean {
  const [degraded] = useState(() => {
    if (!glassEnabled) return true;
    if (typeof window === 'undefined' || typeof CSS === 'undefined' || !CSS.supports?.('backdrop-filter', 'blur(1px)')) {
      return true;
    }
    if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return true;
    if (window.matchMedia('(prefers-contrast: more)').matches) return true;
    return false;
  });
  return degraded;
}

export const GlassSurface = memo(function GlassSurface({
  tier,
  radius = 'md',
  strength = 'normal',
  children,
  className,
  style,
}: GlassSurfaceProps) {
  const degraded = useDegraded();
  const radiusPx = RADIUS[radius];
  const base = useMemo<React.CSSProperties>(
    () => ({
      borderRadius: `var(--radius-${radius})`,
      ...(degraded
        ? { background: 'var(--bg)', border: '1px solid var(--border)' }
        : {
            background: strength === 'strong' ? 'var(--glass-bg-strong)' : 'var(--glass-bg)',
            backdropFilter: `blur(var(--glass-blur)) saturate(var(--glass-saturate))`,
            WebkitBackdropFilter: `blur(var(--glass-blur)) saturate(var(--glass-saturate))`,
            border: '1px solid var(--glass-border)',
            boxShadow: 'var(--glass-shadow)',
          }),
      ...style,
    }),
    [radius, degraded, strength, style],
  );

  if (tier === 'A' && !degraded) {
    return (
      <LiquidGlass
        className={className}
        cornerRadius={radiusPx}
        displacementScale={0}
        blurAmount={0.4}
        saturation={1.15}
        aberrationIntensity={0}
        elasticity={0}
        mode="standard"
        style={base}
      >
        {children}
      </LiquidGlass>
    );
  }
  return (
    <div className={className} data-degraded={degraded} data-tier={tier} style={base}>
      {children}
    </div>
  );
});
