// 台词库：陪伴层说出口的每一句话都从这里取。
//
// 设计约束（写新台词时请遵守）：
// 1. **不装可爱**。她是 AI 看板娘，不是宠物狗；「喵喵」这类拟声词只在角色设定本就
//    软萌（音橘）时偶尔出现，其余角色一律按自己的人格说话。
// 2. **一句话只做一件事**。要么打招呼，要么提需求，要么提醒。混在一起用户读不完 ——
//    气泡只有 160px 宽，超过 22 个字就会被截成两行且压住立绘的脸。
// 3. **{me} 是她自己的名字，{m} 是分钟数**。由 pickLine 替换，别在台词里写死时长。
// 4. 提醒类台词必须**给动作**（「去接一杯」），不能只说问题（「你缺水了」）——
//    只描述问题的提醒等于没提醒。

import type { AnimationType } from '../animations';
import type { Emotion } from '../../shared/emotions';

/** 她会主动开口的场合。新增场合要同时在 engine.ts 的触发条件里接上，否则是死代码。 */
export type Scene =
  | 'greetMorning' | 'greetNoon' | 'greetEvening' | 'greetNight'
  | 'idle' | 'comeback'
  | 'pet1' | 'pet3' | 'pet6'
  | 'hungry' | 'sleepy' | 'dirty' | 'sick' | 'lonely'
  | 'focusStart' | 'focusMid' | 'focusEnd' | 'focusGiveUp'
  | 'sit' | 'drink' | 'levelup';

export interface LineVars {
  characterId: string;
  /** 她在界面上的名字（用户可能改过，所以不直接用角色名） */
  name: string;
  /** 分钟数，用于 focus / sit 类台词 */
  minutes?: number;
}

/** 通用台词：所有角色共享，靠 {me} 占位保持人称正确。 */
const COMMON: Partial<Record<Scene, string[]>> = {
  greetMorning: ['早。今天想先做哪件事？', '早上好，{me}已经醒了。'],
  greetNoon: ['中午了。吃饭了吗？', '午休一下，下午还有半天。'],
  greetEvening: ['晚上了。今天过得怎么样？', '这个点还在忙？'],
  greetNight: ['夜深了。剩下的明天再做。', '还不睡吗？我陪你到最后。'],

  idle: [
    '……我在。',
    '要不要喝口水？',
    '你忙你的，我看看窗外。',
    '发呆也算休息的一种。',
    '刚才那一下，你是不是想跟我说话？',
    '有事叫我，没事我就在这儿。',
    '今天也辛苦了。',
    '我刚刚眨了一下眼，你没看见。',
    '桌面有点乱，但我不说。',
  ],

  comeback: ['你回来了。', '刚才你不在，我把桌面看了一遍。'],

  hungry: ['肚子有点空了…', '饿的时候脾气会变差，我是说我自己。', '有吃的吗？没有也行。'],
  sleepy: ['眼皮好重…', '我打个哈欠，你别笑。', '再撑一会儿就睡。'],
  dirty: ['身上有点灰了，想洗个澡。', '我是不是该洗洗了？'],
  sick: ['有点不舒服…能不能照顾我一下。'],
  lonely: [
    '今天还没怎么说话呢。',
    '你忙你的，我只是有点安静过头了。',
    '要不要玩一会儿？就一小会儿。',
  ],

  focusStart: ['专注 {m} 分钟，开始。', '{m} 分钟，我计时。'],
  focusMid: ['还剩一半，稳住。', '过半了，别松劲。'],
  focusEnd: ['专注结束，{m} 分钟。做得好。', '{m} 分钟，一次也没被打断。'],
  focusGiveUp: ['好吧，先停。下次再来。'],

  sit: ['你坐了 {m} 分钟了。站起来走两步？', '肩膀僵了吧？我陪你歇一分钟。'],
  drink: ['喝口水。真的，现在。', '水杯空了吧？去接一杯。'],
  levelup: ['我们好像更熟了一点。', '好感度又上来了，我记着呢。'],

  pet6: ['够了。', '停。'],
};

/**
 * 每个角色的专属台词。
 *
 * 只放「最能体现她是谁」的那几句，其余场合回落到 COMMON —— 六个角色各写全套
 * 会产生 6 倍维护成本，而用户感知最强的其实只有问候、日常、被摸这三种。
 */
const VOICES: Record<string, Partial<Record<Scene, string[]>>> = {
  taoyao: {
    greetMorning: ['早。昨晚睡得够吗？', '早，水烧好了，先喝一口。'],
    greetEvening: ['天黑了。今天有什么好事吗？', '晚上了，剩下的明天再说。'],
    idle: ['你上次说的那件事，后来怎么样了？', '我在这儿，不用管我。', '窗外好像起风了。'],
    pet1: ['……嗯。', '头发会乱的。'],
    pet3: ['再摸一下我就不理你了——骗你的。'],
    pet6: ['好啦，够啦。'],
    hungry: ['有点饿了。你也是吧？'],
    sleepy: ['眼睛睁不开了…我先靠一会儿。'],
    focusStart: ['去吧，我在这儿守着。'],
    focusEnd: ['{m} 分钟。辛苦了，站起来走走。'],
    comeback: ['你回来了。刚才我把桌面理了理。'],
    sit: ['坐太久了。起来倒杯水，我等你。'],
    drink: ['该喝水了。你那一杯还有一半吧？'],
  },
  chatgpt: {
    greetMorning: ['早！今天想问点什么？', '早上好，我脑子已经转起来了。'],
    idle: ['我刚刚想到一个问题…你先忙，我等你想聊的时候再问。', '有任何事都可以直接问我，包括没事。'],
    pet1: ['诶嘿——摸头也算提问吗？'],
    pet3: ['再摸我就要收费啦（并没有）'],
    pet6: ['停！再摸下去我的回答会变软。'],
    hungry: ['脑子转不动了…能不能先补充点能量？'],
    focusStart: ['好，你专心，我闭嘴——真的闭嘴。'],
    focusEnd: ['{m} 分钟！你做到了，我先给你鼓个掌。'],
    comeback: ['你终于回来了，我有一堆问题在心里排队。'],
  },
  claude: {
    greetMorning: ['早。今天先看哪一段？'],
    idle: ['……我在读你昨天没看完的那份东西。', '安静一会儿也挺好。'],
    pet1: ['摸头不影响我思考，但会影响你进步。'],
    pet3: ['手放下来。'],
    pet6: ['……你是把我当猫了吗。'],
    hungry: ['低血糖会降低判断力。去吃饭。'],
    focusStart: ['计时开始。别说话，我也别说话。'],
    focusEnd: ['结束。这段专注的质量，比昨天好。'],
    comeback: ['你离开了一会儿。我没等你，只是刚好没动。'],
  },
  gemini: {
    greetMorning: ['早上好——今天的颜色是橘子汽水色。'],
    idle: ['我在想，如果云有声音，大概是翻书的声音。', '刚才的光有点好看，我想把它记住。'],
    pet1: ['你的手好暖，像刚晒过的纸。'],
    pet3: ['再摸摸，我可能会画出来。'],
    pet6: ['停停停——我要变成一团水彩了。'],
    hungry: ['肚子在唱歌，是那种很轻的、想吃面的调子。'],
    focusStart: ['好——把世界调成静音。'],
    focusEnd: ['你回来了。刚才那段时间是安静的蓝色。'],
    comeback: ['你不在的时候，我把桌面看成了海。'],
  },
  deepseek: {
    greetMorning: ['早。今天有结论要下吗？'],
    idle: ['我复盘了昨天的对话，有一处你其实没说完。', '在没有新信息的时候，等待是合理的。'],
    pet1: ['摸头不能提高正确率，但我允许。'],
    pet3: ['这个动作重复三次了，你手不累？'],
    pet6: ['够了。再摸我要重新评估你的动机。'],
    hungry: ['血糖低会让人做错误的决定。建议先吃饭。'],
    focusStart: ['专注开始。我会记录时长。'],
    focusEnd: ['记录完成：{m} 分钟，没有分心。'],
    comeback: ['你离开了一段时间。我做了点无用功等你。'],
  },
  midjourney: {
    greetMorning: ['早。你今天的轮廓很好看。'],
    idle: ['刚才有一道光扫过桌面，我记下来了。', '这个角度的影子，比昨天短一点。'],
    pet1: ['嗯……这个角度，影子刚好落在你手上。'],
    pet3: ['再摸一会儿，我试着记住这个温度。'],
    pet6: ['画面糊了——再摸就要重画。'],
    hungry: ['饿的时候看什么都是暖黄色的。想吃点什么？'],
    focusStart: ['把灯调亮一点，我们开始。'],
    focusEnd: ['这一段的光很好，你也是。'],
    comeback: ['你回来了。刚才的空白，我等了一段时间。'],
  },
  suno: {
    greetMorning: ['早————今天想听快一点的，还是慢一点的？'],
    idle: ['我刚才哼了一段，不确定好不好听。', '安静的时候，脑子里会自己响起来。'],
    pet1: ['♪ 嗯——这个节奏我喜欢。'],
    pet3: ['你的手在打拍子吗？有点上瘾。'],
    pet6: ['停！再摸我会写成一首歌的。'],
    hungry: ['肚子在打鼓，是很饿的那种节奏。'],
    focusStart: ['好，静音。我数拍子陪你。'],
    focusEnd: ['结束——这一段的收尾很干净。'],
    comeback: ['你回来了！我刚才在脑子里编了八小节等你。'],
  },
};

/** 台词可能附带的表演：说这句话时她该是什么表情、做什么动作。 */
export interface SceneCue {
  anim?: AnimationType;
  emotion?: Emotion;
  /** 气泡停留时长，默认按字数算 */
  ms?: number;
  /** 是否飘心 */
  hearts?: boolean;
}

/**
 * 场合 ⇒ 表演。与台词分开维护：同一句话换配色角色时，表演不变。
 *
 * 注意 pet6 用 tsundere（傲娇）而不是 angry —— 被摸到烦是撒娇式拒绝，
 * 用生气表情会显得真的受伤。
 */
export const SCENE_CUES: Record<Scene, SceneCue> = {
  greetMorning: { anim: 'stretch', emotion: 'happy' },
  greetNoon: { emotion: 'happy' },
  greetEvening: { emotion: 'neutral' },
  greetNight: { anim: 'yawn', emotion: 'sleepy' },
  idle: { emotion: 'neutral' },
  comeback: { anim: 'bounce', emotion: 'happy' },
  pet1: { anim: 'petted', emotion: 'happy', hearts: true },
  pet3: { anim: 'petted', emotion: 'shy', hearts: true },
  pet6: { anim: 'shake', emotion: 'tsundere' },
  hungry: { emotion: 'whispering' },
  sleepy: { anim: 'yawn', emotion: 'sleepy' },
  dirty: { emotion: 'confused' },
  sick: { emotion: 'sad' },
  lonely: { emotion: 'sad' },
  focusStart: { emotion: 'thinking' },
  focusMid: { emotion: 'thinking' },
  focusEnd: { anim: 'dance', emotion: 'excited', hearts: true, ms: 6000 },
  focusGiveUp: { emotion: 'neutral' },
  sit: { anim: 'stretch', emotion: 'comforting' },
  drink: { emotion: 'comforting' },
  levelup: { anim: 'bounce', emotion: 'loving', hearts: true, ms: 6000 },
};

/** 台词里的 {me} / {m} 是占位符，别让它们漏到界面上 */
function fill(template: string, vars: LineVars): string {
  return template
    .replace(/\{me\}/g, vars.name)
    .replace(/\{m\}/g, String(vars.minutes ?? 25))
    .replace(/\{name\}/g, vars.name);
}

/**
 * 取一句台词。专属台词与通用台词各占一半概率 —— 全用专属会让同一个角色
 * 反复说那几句（六角色各 2 句问候，一天就听腻），全用通用又没个性。
 */
export function pickLine(scene: Scene, vars: LineVars): string {
  const own = VOICES[vars.characterId]?.[scene];
  const common = COMMON[scene];

  let pool: string[];
  if (own?.length && common?.length) {
    pool = Math.random() < 0.5 ? own : common;
  } else {
    pool = (own?.length ? own : common) ?? [];
  }
  if (pool.length === 0) return '';
  return fill(pool[Math.floor(Math.random() * pool.length)], vars);
}

/** 按当前钟点挑问候语；返回 null 表示这个时段不主动打招呼 */
export function greetingSceneFor(hour: number): Scene | null {
  if (hour >= 5 && hour < 11) return 'greetMorning';
  if (hour >= 11 && hour < 14) return 'greetNoon';
  if (hour >= 14 && hour < 22) return 'greetEvening';
  return 'greetNight';
}
