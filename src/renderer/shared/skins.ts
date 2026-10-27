// ---------- 皮肤（配色）系统 ----------
//
// 2026-10-27 起，皮肤的语义变了：以前是「一只 CSS 画的圆猫换配色」，
// 现在是「6 个立绘角色各自一套配色」。配色仍然只用 6 个颜色，
// 因为渲染层只消费 --pet-* 这组 CSS 变量（光晕、气泡描边、进度条），
// 角色立绘本身是图片，不需要额外主题系统。
//
// 角色清单在 pet/characters/index.ts（那边要 import 图片，属于渲染层资产，
// 不适合放在 shared 里被管理端一起打包）。

export interface PetSkin {
  id: string;
  name: string;
  colors: {
    body: string;       // 主体色
    bodyLight: string;  // 高光色
    bodyDark: string;   // 阴影色
    eye: string;        // 深色文字/描边
    blush: string;      // 腮红（保留：自定义色板仍在用）
    accent: string;     // 强调色（光晕、气泡边、进度条）
  };
  isCustom: boolean;
  /** 立绘（透明底 webp）。自定义色板没有立绘 ⇒ undefined，渲染层退化为纯配色 */
  portrait?: string;
  /** 名牌用的小头像 */
  face?: string;
  /** 一句话定位 */
  role?: string;
  /** 待机台词 */
  greeting?: string;
}

/** 生成 CSS 变量，应用到 pet 容器上 */
export function getSkinCSSVariables(skin: PetSkin): Record<string, string> {
  return {
    '--pet-body': skin.colors.body,
    '--pet-body-light': skin.colors.bodyLight,
    '--pet-body-dark': skin.colors.bodyDark,
    '--pet-eye': skin.colors.eye,
    '--pet-blush': skin.colors.blush,
    '--pet-accent': skin.colors.accent,
  };
}

/** AI 生成皮肤：根据颜色方案创建自定义皮肤 */
export function createCustomSkin(
  name: string,
  bodyColor: string,
  bodyLightColor: string,
  bodyDarkColor: string,
  accentColor?: string
): PetSkin {
  return {
    id: `custom-${Date.now()}`,
    name,
    colors: {
      body: bodyColor,
      bodyLight: bodyLightColor,
      bodyDark: bodyDarkColor,
      eye: '#1a1a2e',
      blush: 'rgba(255, 105, 180, 0.5)',
      accent: accentColor || bodyColor,
    },
    isCustom: true,
  };
}

/** 从AI返回的颜色方案解析皮肤 */
export function parseSkinFromAI(aiResponse: string): PetSkin | null {
  try {
    // 支持格式: "body: #xxx, bodyLight: #xxx, bodyDark: #xxx"
    const colorRegex = /(?:body|主体)[：:]\s*(#[0-9a-fA-F]{3,8})/i;
    const lightRegex = /(?:bodyLight|高光)[：:]\s*(#[0-9a-fA-F]{3,8})/i;
    const darkRegex = /(?:bodyDark|阴影)[：:]\s*(#[0-9a-fA-F]{3,8})/i;
    const accentRegex = /(?:accent|强调)[：:]\s*(#[0-9a-fA-F]{3,8})/i;

    const body = aiResponse.match(colorRegex)?.[1];
    const bodyLight = aiResponse.match(lightRegex)?.[1];
    const bodyDark = aiResponse.match(darkRegex)?.[1];
    const accent = aiResponse.match(accentRegex)?.[1];

    if (!body) return null;

    return createCustomSkin('AI生成皮肤', body, bodyLight || body, bodyDark || body, accent);
  } catch {
    return null;
  }
}
