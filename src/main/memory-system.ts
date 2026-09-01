import * as fs from 'fs';
import * as path from 'path';

// 聊天消息接口
export interface MemoryMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  images?: string[];
}

// 会话接口
export interface Conversation {
  id: string;
  title: string;
  messages: MemoryMessage[];
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

// 短期记忆（内存中）
const shortTermMemory: MemoryMessage[] = [];
const MAX_SHORT_TERM_MEMORY = 50;

// 长期记忆（文件存储）
interface LongTermMemory {
  id: string;
  key: string; // 记忆的key，如"用户生日"、"用户喜好"等
  content: string;
  createdAt: string;
  updatedAt: string;
  confidence: number; // 0-100 置信度
}

let longTermMemory: LongTermMemory[] = [];

// 记忆类型
export type MemoryType = 'short' | 'long';

// 初始化
export function initMemory(dataDir: string): void {
  const memoryFile = path.join(dataDir, 'long_term_memory.json');
  try {
    if (fs.existsSync(memoryFile)) {
      const raw = fs.readFileSync(memoryFile, 'utf-8');
      longTermMemory = JSON.parse(raw);
    }
  } catch (e: any) {
    console.error('[Memory] 加载长期记忆失败:', e.message);
    longTermMemory = [];
  }
}

// 保存长期记忆
function saveLongTermMemory(): void {
  try {
    const memoryFile = path.join(dataDir, 'long_term_memory.json');
    fs.writeFileSync(memoryFile, JSON.stringify(longTermMemory, null, 2), 'utf-8');
  } catch (e: any) {
    console.error('[Memory] 保存长期记忆失败:', e.message);
  }
}

// 添加短期记忆
export function addShortTermMemory(message: MemoryMessage): void {
  shortTermMemory.push(message);
  if (shortTermMemory.length > MAX_SHORT_TERM_MEMORY) {
    shortTermMemory.shift(); // 移除最旧的
  }
}

// 获取短期记忆
export function getShortTermMemory(): MemoryMessage[] {
  return shortTermMemory.slice(-MAX_SHORT_TERM_MEMORY);
}

// 清空短期记忆
export function clearShortTermMemory(): void {
  shortTermMemory.length = 0;
}

// 添加长期记忆
export function addLongTermMemory(key: string, content: string, confidence: number = 80): void {
  const existing = longTermMemory.find(m => m.key === key);
  const now = new Date().toISOString();
  
  if (existing) {
    // 更新现有记忆
    existing.content = content;
    existing.updatedAt = now;
    existing.confidence = Math.max(existing.confidence, confidence);
  } else {
    // 创建新记忆
    longTermMemory.push({
      id: `mem_${Date.now()}`,
      key,
      content,
      createdAt: now,
      updatedAt: now,
      confidence,
    });
  }
  
  saveLongTermMemory();
  console.log('[Memory] 添加长期记忆:', key);
}

// 获取长期记忆
export function getLongTermMemory(key?: string): LongTermMemory | LongTermMemory[] {
  if (key) {
    return longTermMemory.find(m => m.key === key);
  }
  return longTermMemory;
}

// 删除长期记忆
export function removeLongTermMemory(key: string): boolean {
  const index = longTermMemory.findIndex(m => m.key === key);
  if (index >= 0) {
    longTermMemory.splice(index, 1);
    saveLongTermMemory();
    console.log('[Memory] 删除长期记忆:', key);
    return true;
  }
  return false;
}

// 从对话中提取记忆
export function extractMemoryFromConversation(messages: MemoryMessage[]): void {
  const text = messages.map(m => `${m.role}: ${m.content}`).join('\n').toLowerCase();
  
  // 识别常见的记忆模式
  const memoryPatterns = [
    { key: '用户生日', patterns: ['生日', '出生日期', 'birthday'], regex: /(\d{4}[-年]\d{1,2}[-月]\d{1,2}日?)/ },
    { key: '用户邮箱', patterns: ['邮箱', 'email', '@'], regex: /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/ },
    { key: '用户喜好', patterns: ['喜欢', '爱', '偏好', '爱好'], regex: /喜欢(的)?(.{1,50})/ },
    { key: '工作内容', patterns: ['工作', '职位', '公司', '职业'], regex: /(在|担任|是)(.{1,30})/ },
  ];

  for (const pattern of memoryPatterns) {
    if (pattern.patterns.some(p => text.includes(p))) {
      const match = text.match(pattern.regex);
      if (match && match[0]) {
        addLongTermMemory(pattern.key, match[0].substring(0, 100), 90);
      }
    }
  }
}

// 构建记忆上下文
export function buildMemoryContext(): string {
  if (longTermMemory.length === 0) return '';
  
  const context = longTermMemory
    .filter(m => m.confidence >= 70)
    .slice(-10) // 最多10条
    .map(m => `- ${m.key}: ${m.content}`)
    .join('\n');
  
  return `\n\n【记忆上下文】\n${context}`;
}

// 重置记忆
export function resetMemory(): void {
  shortTermMemory.length = 0;
  longTermMemory = [];
  saveLongTermMemory();
  console.log('[Memory] 所有记忆已重置');
}
