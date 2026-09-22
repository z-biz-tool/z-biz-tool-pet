import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * 工具风险分级（doc/优化方案/04 §3.3）
 * SAFE      自动执行
 * SENSITIVE 首次确认，可选择"总是允许"
 * DANGEROUS 每次必须确认，不接受"总是允许"
 */
export enum ToolRiskLevel {
  SAFE = 0,
  SENSITIVE = 1,
  DANGEROUS = 2,
}

const RISK_BY_TOOL: Record<string, ToolRiskLevel> = {
  get_datetime: ToolRiskLevel.SAFE,
  get_weather: ToolRiskLevel.SAFE,
  control_pet: ToolRiskLevel.SAFE,
  get_pet_stats: ToolRiskLevel.SAFE,
  web_search: ToolRiskLevel.SENSITIVE,
  read_url: ToolRiskLevel.SENSITIVE,
  clipboard_read: ToolRiskLevel.SENSITIVE,
  clipboard_write: ToolRiskLevel.SENSITIVE,
  screenshot_analyze: ToolRiskLevel.SENSITIVE,
  set_reminder: ToolRiskLevel.SENSITIVE,
  open_app: ToolRiskLevel.DANGEROUS,
  execute_command: ToolRiskLevel.DANGEROUS,
};

export function toolRiskLevel(name: string): ToolRiskLevel {
  // 未知工具按最危险处理
  return RISK_BY_TOOL[name] ?? ToolRiskLevel.DANGEROUS;
}

export function allowAlwaysOnApproval(name: string): boolean {
  return toolRiskLevel(name) === ToolRiskLevel.SENSITIVE;
}

/**
 * 直接拒绝的命令特征。命中即不进入确认流程，也不传给 shell。
 */
const FORBIDDEN_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+|--recursive\b|--force\b)/i,
  /\bformat(\s+|\/x|$)/i,
  /\bmkfs(\.|\s)/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bdel\s+\/[sqf]/i,
  /\brmdir\s+\/s/i,
  /\bdiskpart\b/i,
  /\)\s*\{[^}]*\|[^}]*&/, // fork bomb: :(){ :|:& };:
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh/i,
  /\bsudo\s+/i,
  /\bchown\s+-R\s+root/i,
  /\/etc\/(passwd|shadow|sudoers)/i,
  /\bdefaults\s+write\s+(com\.apple\.loginwindow|SystemPolicy)/i,
];

export interface CommandGuard {
  allowed: boolean;
  reason?: string;
}

export function guardCommand(command: string): CommandGuard {
  const trimmed = (command || '').trim();
  if (!trimmed) return { allowed: false, reason: '命令为空' };
  if (trimmed.length > 2000) return { allowed: false, reason: '命令长度超过限制' };
  for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `命中禁止执行的高危命令特征: ${pattern.source}` };
    }
  }
  return { allowed: true };
}

/** 人类可读的操作描述，用于确认对话框 */
export function describeToolCall(name: string, args: Record<string, any>): string {
  switch (name) {
    case 'execute_command':
      return `执行系统命令：${args.command ?? ''}`;
    case 'open_app':
      return `打开应用程序：${args.appName ?? ''}`;
    case 'clipboard_read':
      return '读取系统剪贴板内容（剪贴板可能包含密码等敏感信息）';
    case 'clipboard_write':
      return `写入系统剪贴板：${String(args.text ?? '').slice(0, 80)}`;
    case 'screenshot_analyze':
      return '截取当前屏幕并交给 AI 分析（屏幕内容会发送给所配置的 AI 服务）';
    case 'web_search':
      return `联网搜索：${args.query ?? ''}（查询内容会发送到外部服务）`;
    case 'read_url':
      return `访问网址：${args.url ?? ''}`;
    default:
      return `${name} ${JSON.stringify(args).slice(0, 200)}`;
  }
}

/**
 * 文件读取白名单（doc/优化方案/04 §2.1，修复 D05）
 * 仅允许应用数据目录、系统临时目录与用户显式授权的目录。
 */
export interface PathGuard {
  allowed: boolean;
  resolved?: string;
  reason?: string;
}

function realDir(dir: string): string | null {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

export function buildAllowedRoots(extra: string[] = []): string[] {
  const roots = [
    path.join(os.homedir(), '.z-bot'),
    os.tmpdir(),
    path.join(os.tmpdir(), ''),
    ...extra,
  ];
  return roots
    .map((r) => realDir(r) ?? path.resolve(r))
    .filter((r, i, arr) => arr.indexOf(r) === i);
}

export function guardReadPath(filePath: string, allowedRoots: string[]): PathGuard {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { allowed: false, reason: '路径为空' };
  }
  if (filePath.includes('\0')) {
    return { allowed: false, reason: '路径包含非法字符' };
  }
  const resolved = path.resolve(filePath);
  // 符号链接指向的位置以 realpath 为准，防止白名单目录内的软链接逃逸
  const real = realDir(resolved) ?? resolved;
  const hit = allowedRoots.some((root) => {
    const rel = path.relative(root, real);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!hit) {
    return { allowed: false, reason: '路径不在允许读取的目录内' };
  }
  return { allowed: true, resolved: real };
}

/** 应用名称合法性校验：拒绝任何 shell 元字符与路径分隔（修复 D04 注入面） */
export function guardAppName(appName: string): PathGuard {
  const name = (appName || '').trim();
  if (!name) return { allowed: false, reason: '应用名为空' };
  if (name.length > 200) return { allowed: false, reason: '应用名过长' };
  if (/[;&|`$(){}<>\n\r"'\\/]/.test(name)) {
    return { allowed: false, reason: '应用名包含非法字符' };
  }
  return { allowed: true, resolved: name };
}

export const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;
