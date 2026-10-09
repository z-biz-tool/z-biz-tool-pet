/**
 * window.electronAPI 的类型面 —— 逐个成员抄自删除前的 src/preload/index.ts（79 个方法），
 * 参数签名与返回形状都保持原样：渲染层调用不存在的方法仍然编译不过，
 * 这是 04 §T1.10（修复 D25「类型与运行时不一致」）的同一道编译期保护。
 *
 * 运行时是否真的接通由 scripts/port-status.mjs 校验（契约快照 scripts/endpoint-contract.json）。
 * 加方法时两边都要动：这里声明，tauri-bridge.ts 的 PORTED/EVENTS 里映射。
 */

interface ElectronApi {
  // 窗口控制
  toggleWindow(mode: 'admin' | 'pet'): Promise<any>;
  getMode(): Promise<any>;
  movePetWindow(deltaX: number, deltaY: number): Promise<any>;
  setPetPosition(x: number, y: number): Promise<any>;
  showWindow(mode: 'admin' | 'pet'): Promise<any>;
  hideWindow(mode: 'admin' | 'pet'): Promise<any>;
  stickToEdge(): Promise<any>;

  // 语音事件
  onVoiceStart(callback: () => void): () => void;
  onVoiceStop(callback: () => void): () => void;

  // 截图
  captureScreenshot(): Promise<any>;
  captureWindow(windowName?: string): Promise<any>;
  captureAndAnalyze(question?: string): Promise<any>;

  // 对话历史持久化
  saveHistory(messages: ChatMessage[]): Promise<any>;
  loadHistory(): Promise<any>;
  clearHistory(): Promise<any>;

  // 配置持久化
  saveConfig(config: PetConfig): Promise<any>;
  loadConfig(): Promise<any>;

  // 兼容旧版 API
  getConversationHistory(): Promise<any>;
  addMessageToHistory(message: ChatMessage): Promise<any>;
  clearConversation(): Promise<any>;

  // 动画系统
  onCursorDelta(callback: (delta: { dx: number; dy: number }) => void): () => void;
  triggerAnimation(animType: string): Promise<any>;
  setPetPositionWithBounds(x: number, y: number): Promise<any>;
  onTriggerAnimation(callback: (animType: string) => void): () => void;

  // 皮肤系统
  getSkins(): Promise<any>;
  applySkin(skinId: string): Promise<any>;
  applySkinTheme(skinData: {
    name: string;
    colors: { body: string; bodyLight: string; bodyDark: string; accent?: string };
  }): Promise<any>;
  onApplySkin(callback: (skin: PetSkin) => void): () => void;

  // 截图隐身
  toggleStealth(enabled?: boolean): Promise<any>;
  getStealthMode(): Promise<any>;

  // 宠物养成
  petGetStats(): Promise<any>;
  petFeed(): Promise<any>;
  petPlay(): Promise<any>;
  petWash(): Promise<any>;
  petSleep(): Promise<any>;
  petMedicine(): Promise<any>;
  petPet(): Promise<any>;

  // AI 引擎
  aiChat(request: ChatRequest): Promise<any>;
  aiTestConnection(providerConfig?: AIProvider): Promise<any>;
  aiGetModels(providerConfig?: AIProvider): Promise<any>;
  aiStreamChat(request: ChatRequest): Promise<any>;
  aiGetBuiltinProviders(): Promise<any>;
  onAiStreamChunk(callback: (chunk: { content: string; done: boolean }) => void): () => void;

  // MCP 工具（toolsExecute 已移除，渲染进程不能绕过确认直接执行）
  toolsList(): Promise<any>;
  toolsConfirm(toolCallId: string, approved: boolean, alwaysAllow?: boolean): Promise<any>;
  toolsCancel(toolCallId: string): Promise<any>;
  toolsAlwaysAllowed(): Promise<any>;
  toolsRevokeAlwaysAllowed(name: string): Promise<any>;
  onToolsConfirmRequest(callback: (data: {
    toolCallId: string;
    name: string;
    arguments: any;
    riskLevel: number;
    description: string;
    timeout: number;
    allowAlways: boolean;
  }) => void): () => void;

  // 语音服务（渲染层不再直连 8084/8086）
  voiceTranscribe(base64Audio: string): Promise<any>;
  voiceSpeak(text: string, voice?: string): Promise<any>;
  voiceStatus(): Promise<any>;
  checkMicrophone(): Promise<any>;

  // 快捷键与 STT 模型
  shortcutsList(): Promise<any>;
  shortcutsUpdate(overrides: Record<string, string>): Promise<any>;
  sttModels(): Promise<any>;

  // 自动更新
  updateCheck(): Promise<any>;
  updateStatus(): Promise<any>;
  updateInstall(): Promise<any>;
  onUpdateStatus(callback: (payload: any) => void): () => void;

  // 任务动作
  onTaskAction(callback: (payload: { type: string; content: string; taskName?: string }) => void): () => void;

  // 语音打断
  voiceInterrupt(): Promise<any>;
  onVoiceInterrupt(callback: () => void): () => void;

  // 快捷键事件
  onShortcutScreenshot(callback: () => void): () => void;

  // 按住说话
  onPushToTalkStart(callback: () => void): () => void;
  onPushToTalkStop(callback: () => void): () => void;

  // 文件读取
  fileRead(filePath: string): Promise<any>;
  fileReadAsBase64(filePath: string): Promise<any>;

  // Pin 卡片
  pinCreate(content: string): Promise<any>;
  pinRemove(id: string): Promise<any>;
  pinList(): Promise<any>;

  // 会议转录
  meetingStart(title: string): Promise<any>;
  meetingEnd(): Promise<any>;
  meetingCancel(): Promise<any>;
  meetingGetState(): Promise<any>;
  onMeetingState(callback: (state: any) => void): () => void;
  onMeetingSegment(callback: (segment: any) => void): () => void;
  onMeetingRollingSummary(callback: (summary: string) => void): () => void;

  // 日志
  log(msg: string): void;
}

interface Window {
  electronAPI?: ElectronApi;
}
