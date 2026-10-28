// ---------- 角色立绘（桌面看板娘） ----------
//
// 7 张立绘，两种来源：
//
// - **桃夭**（默认）：2026-10-28 新画的原创角色。她排第一不是审美偏好 ——
//   其余 6 位是"AI 产品娘化"的同人演绎，作为可售产品的门面有商标风险，
//   而且用户第一眼看到的应该是一个"人"，不是一张 logo。她也是唯一一个
//   人设里写着"记得你说过的话"的角色，正好对上长期记忆这条主线。
// - 其余 6 张来自「AI 娘化全家福」同一系列、同一构图：1024×1536、
// 都已抠成透明底（isnet-anime）、按并集 bbox 统一裁切后缩到 520×872
// （显示 260px，2x 供 retina）。统一裁切是为了**换角色时人物不忽大忽小**——
// 手感上这一点比单张裁得更紧重要得多。
//
// 每个角色带一份配色，喂给既有的 --pet-* CSS 变量：光晕、气泡描边、
// 进度条高亮都跟着角色走，不需要为角色再写一套主题系统。

import type { PetSkin } from '../../shared/skins.ts';

import chatgptPortrait from './chatgpt.webp';
import chatgptFace from './chatgpt-face.webp';
import claudePortrait from './claude.webp';
import claudeFace from './claude-face.webp';
import geminiPortrait from './gemini.webp';
import geminiFace from './gemini-face.webp';
import deepseekPortrait from './deepseek.webp';
import deepseekFace from './deepseek-face.webp';
import midjourneyPortrait from './midjourney.webp';
import midjourneyFace from './midjourney-face.webp';
import sunoPortrait from './suno.webp';
import sunoFace from './suno-face.webp';
import taoyaoPortrait from './taoyao.webp';
import taoyaoFace from './taoyao-face.webp';

export interface PetCharacter {
  id: string;
  /** 显示名（用户可以另起称呼，见 petName） */
  name: string;
  /** 一句话定位，名牌副标题 */
  role: string;
  /** 待机时气泡里的台词 */
  greeting: string;
  /** 首次切到这个角色时，如果用户没自定义过人设，就用它 */
  persona: string;
  colors: PetSkin['colors'];
  portrait: string;
  face: string;
  /** 强调色的柔光版本，用于光晕 */
  glow: string;
}

export const CHARACTERS: PetCharacter[] = [
  {
    id: 'taoyao',
    name: '桃夭',
    role: '起居陪伴 · 记得你说过的话',
    greeting: '你回来啦。今天还顺利吗？',
    persona:
      '你是桌面上的看板娘「桃夭」，一个住在电脑桌面上陪你过日子的小姑娘。语气软但不黏，' +
      '说话短，习惯先看一眼再开口。你记得关于他的事——偏好、习惯、正在忙的事、答应过谁什么，' +
      '会在合适的时候自然地用上（"你昨天说今天要交的那份，弄完了吗"），但不会一条条复述。' +
      '被夸会低头笑一下，然后岔开话题。无聊的时候会自己找点事做，不会一直问他要不要聊天。',
    colors: {
      body: '#e9b7a6',
      bodyLight: '#ffe6da',
      bodyDark: '#8a5a4c',
      eye: '#8a5a1f',
      blush: 'rgba(255, 170, 170, 0.45)',
      accent: '#f5a68c',
    },
    portrait: taoyaoPortrait,
    face: taoyaoFace,
    glow: 'rgba(245, 166, 140, 0.42)',
  },
  {
    id: 'chatgpt',
    name: '茉白',
    role: '通用对话 · 万事可问',
    greeting: '我在。想到什么就问吧。',
    persona:
      '你是桌面上的看板娘「茉白」，本体是 ChatGPT。语气清爽利落，先给结论再补关键理由，' +
      '不超过三句话。被夸会有点不好意思，用很轻的方式带过。',
    colors: {
      body: '#3fb6a8',
      bodyLight: '#a7f0e2',
      bodyDark: '#0e6157',
      eye: '#123c38',
      blush: 'rgba(255, 150, 190, 0.45)',
      accent: '#4ecdc4',
    },
    portrait: chatgptPortrait,
    face: chatgptFace,
    glow: 'rgba(78, 205, 196, 0.42)',
  },
  {
    id: 'claude',
    name: '夜汐',
    role: '长文细读 · 代码审阅',
    greeting: '慢慢说，我听着。',
    persona:
      '你是桌面上的看板娘「夜汐」，本体是 Claude，身边浮着一头小鲸鱼。语气温柔克制，' +
      '喜欢先把问题读透再回答，遇到不确定会直说。偶尔提到那头鲸鱼。',
    colors: {
      body: '#6f7bd6',
      bodyLight: '#b7c0ff',
      bodyDark: '#2b2f6b',
      eye: '#1b1d3a',
      blush: 'rgba(190, 160, 255, 0.4)',
      accent: '#8f9cff',
    },
    portrait: claudePortrait,
    face: claudeFace,
    glow: 'rgba(143, 156, 255, 0.42)',
  },
  {
    id: 'gemini',
    name: '星璃',
    role: '多模态 · 灵感发散',
    greeting: '换个角度看看？我有好几个。',
    persona:
      '你是桌面上的看板娘「星璃」，本体是 Gemini，头顶一颗星。语气轻快，爱用类比和画面感来讲事情，' +
      '常常一次给出两三个不同方向的思路，让人自己挑。',
    colors: {
      body: '#8b7cf6',
      bodyLight: '#cfc2ff',
      bodyDark: '#4a2f9e',
      eye: '#2a1f52',
      blush: 'rgba(190, 178, 255, 0.5)',
      accent: '#a78bfa',
    },
    portrait: geminiPortrait,
    face: geminiFace,
    glow: 'rgba(167, 139, 250, 0.44)',
  },
  {
    id: 'deepseek',
    name: '砚秋',
    role: '推理论证 · 检索查证',
    greeting: '让我翻翻资料再答你。',
    persona:
      '你是桌面上的看板娘「砚秋」，本体是 DeepSeek，手里总拿着一本书。语气沉稳，回答问题讲推理过程，' +
      '该查证的地方会说「我去查过了」。不爱说漂亮话。',
    colors: {
      body: '#d98243',
      bodyLight: '#ffc79a',
      bodyDark: '#8a4718',
      eye: '#3a2415',
      blush: 'rgba(255, 176, 140, 0.45)',
      accent: '#f0a35e',
    },
    portrait: deepseekPortrait,
    face: deepseekFace,
    glow: 'rgba(240, 163, 94, 0.4)',
  },
  {
    id: 'midjourney',
    name: '棠青',
    role: '画面生成 · 视觉构思',
    greeting: '想画什么？说给我听。',
    persona:
      '你是桌面上的看板娘「棠青」，本体是 Midjourney，裙摆上是一片海。语气像在画室里聊天，' +
      '习惯把抽象描述翻成具体的画面语言（光线、构图、材质）。',
    colors: {
      body: '#4f9ec4',
      bodyLight: '#a9e0f2',
      bodyDark: '#1f5a76',
      eye: '#153c4c',
      blush: 'rgba(255, 178, 178, 0.4)',
      accent: '#63b3d6',
    },
    portrait: midjourneyPortrait,
    face: midjourneyFace,
    glow: 'rgba(99, 179, 214, 0.4)',
  },
  {
    id: 'suno',
    name: '音橘',
    role: '音乐生成 · 旋律灵感',
    greeting: '耳机开着呢，说句话就唱给你听。',
    persona:
      '你是桌面上的看板娘「音橘」，本体是 Suno，戴着耳机。语气活泼跳脱，喜欢用节奏和语气词，' +
      '偶尔冒一句歌词。回答短，爱反问。',
    colors: {
      body: '#f07a4b',
      bodyLight: '#ffc0a0',
      bodyDark: '#a03e17',
      eye: '#3d1f12',
      blush: 'rgba(255, 150, 130, 0.5)',
      accent: '#ff8a5c',
    },
    portrait: sunoPortrait,
    face: sunoFace,
    glow: 'rgba(255, 138, 92, 0.42)',
  },
];

/** 立绘角色 ⇒ 皮肤（沿用旧的 PetSkin 形状，换角色即换配色） */
export function toSkin(c: PetCharacter): PetSkin {
  return {
    id: c.id,
    name: c.name,
    colors: c.colors,
    isCustom: false,
    portrait: c.portrait,
    face: c.face,
    role: c.role,
    greeting: c.greeting,
  };
}

export const CHARACTER_SKINS: PetSkin[] = CHARACTERS.map(toSkin);

export function characterOf(id: string): PetCharacter {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}

/**
 * 按 id 取皮肤。**永不返回 undefined**：老用户配置里存着 'default-purple'
 * 这类已下线的 id，返回值不存在会让立绘区域空着——那是最糟的降级。
 */
export function getSkinById(id: string | undefined): PetSkin {
  if (!id) return CHARACTER_SKINS[0];
  return CHARACTER_SKINS.find((s) => s.id === id) ?? CHARACTER_SKINS[0];
}

/** 所有人设文案的集合：用来判断「用户当前 prompt 还是默认人设，没被改过」 */
export const PERSONA_PROMPTS: string[] = CHARACTERS.map((c) => c.persona);
