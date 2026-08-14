// ---------- 情绪系统 ----------

/** 19种情绪状态 */
export type Emotion =
  | 'happy' | 'sad' | 'angry' | 'surprised'
  | 'tsundere' | 'cute' | 'shy' | 'sleepy'
  | 'scared' | 'whispering' | 'confused' | 'dominant'
  | 'loving' | 'thinking' | 'excited' | 'proud'
  | 'playful' | 'comforting' | 'neutral';

/** 宠物状态接口（与 main 端保持一致） */
export interface PetStats {
  hunger: number;
  happiness: number;
  energy: number;
  cleanliness: number;
  health: number;
  affection: number;
  age: number;
  stage: 'egg' | 'baby' | 'child' | 'adult';
  bornAt: string;
  lastUpdate: string;
  isSleeping: boolean;
  isSick: boolean;
}

/** 情绪配置：CSS类名、语气修饰词、动画类型 */
export interface EmotionConfig {
  cssClass: string;
  toneModifier: string;
  animationType: 'bounce' | 'shake' | 'float' | 'wobble' | 'pulse' | 'glow' | 'none';
}

/** 每种情绪的详细配置 */
export const EMOTION_CONFIGS: Record<Emotion, EmotionConfig> = {
  happy:       { cssClass: 'emotion-happy',       toneModifier: '活泼欢快', animationType: 'bounce' },
  sad:         { cssClass: 'emotion-sad',         toneModifier: '温柔低沉', animationType: 'float' },
  angry:       { cssClass: 'emotion-angry',       toneModifier: '傲娇生气', animationType: 'shake' },
  surprised:   { cssClass: 'emotion-surprised',   toneModifier: '惊讶好奇', animationType: 'bounce' },
  tsundere:    { cssClass: 'emotion-tsundere',    toneModifier: '傲娇别扭', animationType: 'wobble' },
  cute:        { cssClass: 'emotion-cute',        toneModifier: '撒娇可爱', animationType: 'bounce' },
  shy:         { cssClass: 'emotion-shy',         toneModifier: '害羞腼腆', animationType: 'float' },
  sleepy:      { cssClass: 'emotion-sleepy',      toneModifier: '困倦慵懒', animationType: 'float' },
  scared:      { cssClass: 'emotion-scared',      toneModifier: '害怕紧张', animationType: 'shake' },
  whispering:  { cssClass: 'emotion-whispering',  toneModifier: '轻声细语', animationType: 'float' },
  confused:    { cssClass: 'emotion-confused',    toneModifier: '困惑迷茫', animationType: 'wobble' },
  dominant:    { cssClass: 'emotion-dominant',     toneModifier: '霸道强势', animationType: 'pulse' },
  loving:      { cssClass: 'emotion-loving',      toneModifier: '温柔深情', animationType: 'glow' },
  thinking:    { cssClass: 'emotion-thinking',    toneModifier: '认真思考', animationType: 'wobble' },
  excited:     { cssClass: 'emotion-excited',     toneModifier: '兴奋激动', animationType: 'bounce' },
  proud:       { cssClass: 'emotion-proud',       toneModifier: '骄傲得意', animationType: 'glow' },
  playful:     { cssClass: 'emotion-playful',     toneModifier: '调皮捣蛋', animationType: 'bounce' },
  comforting:  { cssClass: 'emotion-comforting',  toneModifier: '安慰温暖', animationType: 'glow' },
  neutral:     { cssClass: 'emotion-neutral',     toneModifier: '平静自然', animationType: 'float' },
};

/** 根据PetStats自动推断情绪（优先级从高到低） */
export function inferEmotionFromStats(stats: PetStats): Emotion {
  // 生病优先
  if (stats.isSick) return 'sad';
  // 睡觉
  if (stats.isSleeping) return 'sleepy';
  // 饥饿害怕
  if (stats.hunger < 30) return 'scared';
  // 能量低
  if (stats.energy < 20) return 'sleepy';
  // 不干净
  if (stats.cleanliness < 20) return 'confused';
  // 好感度高
  if (stats.affection > 80) return 'loving';
  // 非常开心
  if (stats.happiness > 80) return 'happy';
  // 开心且精力充沛
  if (stats.happiness > 60 && stats.energy > 60) return 'playful';
  // 不开心
  if (stats.happiness < 30) return 'sad';
  // 饥饿
  if (stats.hunger < 50) return 'whispering';
  // 默认
  return 'neutral';
}

/** AI回复中的情绪关键词映射 */
const EMOTION_KEYWORD_MAP: Record<string, Emotion> = {
  '开心': 'happy',
  '高兴': 'happy',
  '快乐': 'happy',
  '嘻嘻': 'happy',
  '哈哈': 'excited',
  '生气': 'angry',
  '哼': 'tsundere',
  '讨厌': 'tsundere',
  '害羞': 'shy',
  '脸红': 'shy',
  '害怕': 'scared',
  '担心': 'scared',
  '难过': 'sad',
  '伤心': 'sad',
  '困': 'sleepy',
  '累': 'sleepy',
  '想睡': 'sleepy',
  '爱': 'loving',
  '喜欢': 'loving',
  '么么': 'loving',
  '思考': 'thinking',
  '嗯': 'thinking',
  '惊讶': 'surprised',
  '哇': 'surprised',
  '骄傲': 'proud',
  '得意': 'proud',
  '调皮': 'playful',
  '捣蛋': 'playful',
  '安慰': 'comforting',
  '别怕': 'comforting',
  '困惑': 'confused',
  '迷茫': 'confused',
  '霸道': 'dominant',
  '命令': 'dominant',
  '可爱': 'cute',
  '撒娇': 'cute',
  '悄悄': 'whispering',
  '小声': 'whispering',
};

/** 从AI回复文本中提取情绪关键词 */
export function extractEmotionFromText(text: string): Emotion | null {
  // 先检查 [情绪] 标签格式
  const bracketMatch = text.match(/\[(开心|生气|害羞|害怕|难过|困|爱|思考|惊讶|骄傲|调皮|安慰|困惑|霸道|可爱|悄悄|高兴|快乐|哈哈|嘻嘻|哼|讨厌|脸红|担心|伤心|累|想睡|喜欢|么么|嗯|哇|得意|捣蛋|别怕|迷茫|命令|撒娇|小声)\]/);
  if (bracketMatch) {
    const emotion = EMOTION_KEYWORD_MAP[bracketMatch[1]];
    if (emotion) return emotion;
  }

  // 再检查文本中的关键词
  for (const [keyword, emotion] of Object.entries(EMOTION_KEYWORD_MAP)) {
    if (text.includes(keyword)) return emotion;
  }

  return null;
}

/** 综合推断情绪：结合PetStats和AI回复文本 */
export function resolveEmotion(stats: PetStats, aiText?: string): Emotion {
  // AI回复中的情绪优先
  if (aiText) {
    const textEmotion = extractEmotionFromText(aiText);
    if (textEmotion) return textEmotion;
  }
  // 其次根据状态推断
  return inferEmotionFromStats(stats);
}

/** 生成情绪注入的system prompt片段 */
export function buildEmotionPromptSuffix(emotion: Emotion): string {
  const config = EMOTION_CONFIGS[emotion];
  const emotionDescriptions: Record<Emotion, string> = {
    happy: '你现在非常开心！语气活泼欢快，多用感叹号和可爱的表情符号。',
    sad: '你现在有点难过...语气温柔低沉，但仍然关心用户。',
    angry: '你现在有点生气！语气傲娇，嘴上说讨厌但其实还是在乎的。',
    surprised: '你很惊讶！语气充满好奇和惊叹。',
    tsundere: '你现在很傲娇！嘴上说不关心，但行为上很温柔。用"哼"、"才不是"等傲娇语气。',
    cute: '你现在很撒娇！语气软萌可爱，多用"喵"、"呜"等拟声词。',
    shy: '你现在很害羞！语气腼腆，说话小声，容易脸红。',
    sleepy: '你现在很困...语气慵懒，说话慢吞吞的，偶尔打哈欠。',
    scared: '你现在有点害怕！语气紧张，希望用户保护你。',
    whispering: '你现在在轻声说话，语气温柔细腻，像在说悄悄话。',
    confused: '你现在很困惑！语气迷茫，不太确定发生了什么。',
    dominant: '你现在很霸道！语气强势，像女王一样命令用户（但其实是关心）。',
    loving: '你现在很爱用户！语气温柔深情，表达喜爱和依恋。',
    thinking: '你在认真思考！语气沉稳，说话有条理。',
    excited: '你现在很兴奋！语气激动，充满活力和期待。',
    proud: '你现在很骄傲！语气得意，展示自己的成就。',
    playful: '你现在很调皮！语气顽皮，喜欢恶作剧和开玩笑。',
    comforting: '你在安慰用户！语气温暖体贴，给予鼓励和支持。',
    neutral: '你现在的状态平静自然，用正常的可爱语气回复。',
  };

  return `\n\n【当前情绪状态】情绪: ${emotion}，语气风格: ${config.toneModifier}。\n${emotionDescriptions[emotion]}`;
}
