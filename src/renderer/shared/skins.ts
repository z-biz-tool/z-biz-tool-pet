// ---------- 皮肤系统 ----------

export interface PetSkin {
  id: string;
  name: string;
  colors: {
    body: string;       // 主体渐变色
    bodyLight: string;  // 高光色
    bodyDark: string;   // 阴影色
    eye: string;        // 眼睛色
    blush: string;      // 腮红色
    accent: string;     // 强调色(声波等)
  };
  isCustom: boolean;
}

// ---------- 预设皮肤 ----------

export const PRESET_SKINS: PetSkin[] = [
  {
    id: 'default-purple',
    name: '默认紫',
    colors: {
      body: '#722ed1',
      bodyLight: '#b794f6',
      bodyDark: '#531dab',
      eye: '#1a1a2e',
      blush: 'rgba(255, 105, 180, 0.5)',
      accent: '#722ed1',
    },
    isCustom: false,
  },
  {
    id: 'forest-green',
    name: '森林绿',
    colors: {
      body: '#237804',
      bodyLight: '#52c41a',
      bodyDark: '#135200',
      eye: '#1a1a2e',
      blush: 'rgba(250, 173, 20, 0.4)',
      accent: '#52c41a',
    },
    isCustom: false,
  },
  {
    id: 'ocean-blue',
    name: '海洋蓝',
    colors: {
      body: '#003a8c',
      bodyLight: '#1890ff',
      bodyDark: '#002766',
      eye: '#1a1a2e',
      blush: 'rgba(255, 105, 180, 0.4)',
      accent: '#1890ff',
    },
    isCustom: false,
  },
  {
    id: 'sakura-pink',
    name: '樱花粉',
    colors: {
      body: '#9e1068',
      bodyLight: '#eb2f96',
      bodyDark: '#6e0f4e',
      eye: '#1a1a2e',
      blush: 'rgba(255, 182, 193, 0.6)',
      accent: '#eb2f96',
    },
    isCustom: false,
  },
  {
    id: 'lava-red',
    name: '岩浆红',
    colors: {
      body: '#820014',
      bodyLight: '#ff4d4f',
      bodyDark: '#5c0011',
      eye: '#1a1a2e',
      blush: 'rgba(255, 182, 193, 0.5)',
      accent: '#ff4d4f',
    },
    isCustom: false,
  },
  {
    id: 'galaxy-gray',
    name: '银河灰',
    colors: {
      body: '#434343',
      bodyLight: '#bfbfbf',
      bodyDark: '#1f1f1f',
      eye: '#1a1a2e',
      blush: 'rgba(114, 46, 209, 0.4)',
      accent: '#bfbfbf',
    },
    isCustom: false,
  },
  {
    id: 'golden',
    name: '金色',
    colors: {
      body: '#ad6800',
      bodyLight: '#faad14',
      bodyDark: '#874d00',
      eye: '#1a1a2e',
      blush: 'rgba(255, 105, 180, 0.4)',
      accent: '#faad14',
    },
    isCustom: false,
  },
];

// ---------- 皮肤工具函数 ----------

/** 根据id获取皮肤 */
export function getSkinById(id: string): PetSkin | undefined {
  return PRESET_SKINS.find((s) => s.id === id);
}

/** 生成CSS变量字符串，应用到pet容器 */
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

/** AI生成皮肤：根据颜色方案创建自定义皮肤 */
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
    // 尝试从AI响应中提取颜色信息
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

    return createCustomSkin(
      'AI生成皮肤',
      body,
      bodyLight || body,
      bodyDark || body,
      accent
    );
  } catch {
    return null;
  }
}
