import { randomUUID } from 'node:crypto';
import {
  parseVoiceCopilotActions,
  type VoiceCopilotAction,
  type VoiceCopilotConfigView,
  type VoiceCopilotContextPayload,
  type VoiceCopilotProbeResult,
  type VoiceCopilotSession,
  type VoiceCopilotVendor,
} from '@spatial/shared';
import { AgoraCopilotClient, AgoraCopilotError } from './copilot-agora.ts';
import {
  buildJarvisSystemPrompt,
  buildVoiceCopilotConfigView,
  getVoiceCopilotPreset,
  loadVoiceCopilotRuntimeConfig,
  normalizeVoiceVendor,
  persistVoiceCopilotConfig,
  resolveVoiceCopilotMode,
  validateCopilotUrl,
  type VoiceCopilotRuntimeConfig,
} from './copilot-config.ts';

export interface UpdateVoiceCopilotConfigInput {
  vendor?: VoiceCopilotVendor;
  model?: string;
  voice?: string;
  url?: string;
  agoraAppId?: string;
  agoraAppCertificate?: string;
  clearAppCertificate?: boolean;
  agoraCustomerId?: string;
  clearCustomerId?: boolean;
  agoraCustomerSecret?: string;
  clearCustomerSecret?: boolean;
  mllmApiKey?: string;
  clearMllmApiKey?: boolean;
  persist?: boolean;
}

export interface ThinkResult {
  ok: true;
  mode: 'mock' | 'real';
  replyText?: string;
  actions?: VoiceCopilotAction[];
}

export interface VoiceCopilotServiceOptions {
  config?: Partial<VoiceCopilotRuntimeConfig>;
  envFilePath?: string;
  fetchImpl?: typeof fetch;
  agoraRestBaseUrl?: string;
  timeoutMs?: number;
}

interface ActiveSessionRecord {
  session: VoiceCopilotSession;
}

function buildContextMessage(payload: VoiceCopilotContextPayload): string {
  const lines: string[] = [];
  if (payload.workName) lines.push(`[作品] ${payload.workName}`);
  if (payload.selection) {
    lines.push(
      `[当前选中元素] 组件 ${payload.selection.cid} (${payload.selection.src})，同源码实例 ${payload.selection.instances} 处${
        payload.selection.text ? `，文案 "${payload.selection.text.slice(0, 60)}"` : ''
      }`,
    );
  }
  if (payload.candidateSummary) {
    lines.push(
      `[候选状态] ${payload.candidateSummary.id.slice(0, 8)} (${payload.candidateSummary.decision}) · 质量门禁 ${payload.candidateSummary.passedChecks}/${payload.candidateSummary.totalChecks}`,
    );
  }
  lines.push(`[事件:${payload.kind}] ${payload.text}`);
  return lines.join('\n');
}

function parseMockReply(raw: string): { replyText: string; actions: VoiceCopilotAction[] } {
  const parsed = parseVoiceCopilotActions(raw);
  return { replyText: parsed.cleanText, actions: parsed.actions };
}

function buildMockJarvisReply(payload: VoiceCopilotContextPayload): { replyText: string; actions: VoiceCopilotAction[] } {
  if (payload.kind === 'selection') {
    if (!payload.selection) {
      return { replyText: '已取消局部锁定，现在默认作用于整页。有想法随时开口。', actions: [] };
    }
    const shareNote = payload.selection.instances > 1 ? `（共享 ${payload.selection.instances} 处实例）` : '';
    return {
      replyText: `已锁定 ${payload.selection.cid}${shareNote}。要直接告诉我怎么改，还是先出几个对比方案？`,
      actions: [],
    };
  }
  if (payload.kind === 'candidate_ready' && payload.candidateSummary) {
    const idShort = payload.candidateSummary.id.slice(0, 8);
    return {
      replyText: `候选 ${idShort} 已生成并跑完检查（${payload.candidateSummary.passedChecks}/${payload.candidateSummary.totalChecks} 通过）。需要我切到并排对比视图看看差异吗？`,
      actions: [],
    };
  }
  if (payload.kind === 'checks_done' && payload.candidateSummary) {
    const allPass = payload.candidateSummary.passedChecks === payload.candidateSummary.totalChecks;
    return {
      replyText: allPass
        ? `全部 ${payload.candidateSummary.totalChecks} 项质量门禁已绿灯通过，可以随时采用，也可以让我再出备选方向。`
        : `检查完成，目前 ${payload.candidateSummary.passedChecks}/${payload.candidateSummary.totalChecks} 项通过，建议打开右侧检查详情核对未过项。`,
      actions: [],
    };
  }
  if (payload.kind === 'work_switched') {
    return {
      replyText: `已切换至「${payload.workName ?? '新作品'}」。画布上下文已同步。`,
      actions: [],
    };
  }

  const spoken = payload.text.trim();
  const normalized = spoken.toLowerCase();
  const targetPrefix = payload.selection ? `针对 ${payload.selection.cid}` : '对当前页面';

  if (/(开启选取|开始选取|点选元素|我要点选)/.test(spoken)) {
    return parseMockReply(
      '好，已开启元素选取模式，请在画布中点一下想调整的区域。[FORMA_ACTION]{"type":"toggle_picking","active":true}[/FORMA_ACTION]',
    );
  }
  if (/(退出选取|关闭选取|取消选取|停止选取)/.test(spoken)) {
    return parseMockReply(
      '已退出选取模式，页面恢复正常交互。[FORMA_ACTION]{"type":"toggle_picking","active":false}[/FORMA_ACTION]',
    );
  }
  if (/(并排对比|横向对比|打开对比|切到对比|对比看看)/.test(spoken)) {
    return parseMockReply(
      '收到，已为你切到 1:1 并排对比视图。[FORMA_ACTION]{"type":"switch_candidate","mode":"compare"}[/FORMA_ACTION]',
    );
  }
  if (/(查看候选|预览候选|看候选|切到候选)/.test(spoken)) {
    return parseMockReply(
      '已切到候选预览画面。[FORMA_ACTION]{"type":"switch_candidate","mode":"candidate"}[/FORMA_ACTION]',
    );
  }
  if (/(回到原版|看当前版本|看原版|恢复预览)/.test(spoken)) {
    return parseMockReply(
      '好，已切回当前正式版本预览。[FORMA_ACTION]{"type":"switch_candidate","mode":"current"}[/FORMA_ACTION]',
    );
  }
  if (/(3d\s*资产|模型库|导入模型|上传\s*glb|上传模型)/.test(normalized)) {
    return parseMockReply(
      '已打开 3D 资产抽屉，可以直接上传本地 GLB 模型或拖拽进画布。[FORMA_ACTION]{"type":"open_surface","surface":"assets"}[/FORMA_ACTION]',
    );
  }
  if (/(3d\s*场景|调光|打光|场景编辑|色温)/.test(normalized)) {
    return parseMockReply(
      '已打开 3D 场景与灯光调节抽屉。[FORMA_ACTION]{"type":"open_surface","surface":"scene"}[/FORMA_ACTION]',
    );
  }
  if (/(改写面板|打开面板|检查面板|看\s*diff)/.test(normalized)) {
    return parseMockReply(
      '已展开右侧画室改写面板。[FORMA_ACTION]{"type":"open_surface","surface":"inspector"}[/FORMA_ACTION]',
    );
  }
  if (/(收起面板|关掉抽屉|收起抽屉|回到画布)/.test(spoken)) {
    return parseMockReply(
      '已收起侧边抽屉，保持画布全景视野。[FORMA_ACTION]{"type":"open_surface","surface":"canvas"}[/FORMA_ACTION]',
    );
  }
  if (/(改成|调整|优化|重做|生成|换成|增加|去掉|加一个|加个|设计一个|出.*方案|来.*版)/.test(spoken)) {
    const variantCount: 1 | 2 | 3 =
      /(3\s*个|三个|三版|3\s*套)/.test(spoken) ? 3 : /(2\s*个|两个|两版|2\s*套)/.test(spoken) ? 2 : 1;
    const actionPayload = JSON.stringify({
      type: 'submit_edit',
      instruction: spoken,
      variantCount,
    });
    const planLabel = variantCount > 1 ? `并行生成 ${variantCount} 个差异化候选` : '生成 1 个修改候选';
    return parseMockReply(
      `明白，我已${targetPrefix}派发「${planLabel}」，后台写完代码并跑完 4 项质量检查后会立刻向你汇报。[FORMA_ACTION]${actionPayload}[/FORMA_ACTION]`,
    );
  }

  return {
    replyText: `收到「${spoken}」。目前处于模拟贾维斯模式，你可以直接说“把主按钮改成暖金色出 2 个方案”、“并排对比”或“打开 3D 资产”来联动真实画布。`,
    actions: [],
  };
}

export class VoiceCopilotService {
  private config: VoiceCopilotRuntimeConfig;
  private readonly envFilePath?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly agoraRestBaseUrl?: string;
  private readonly timeoutMs?: number;
  private active?: ActiveSessionRecord;
  private closing = false;

  constructor(options: VoiceCopilotServiceOptions = {}) {
    this.config = loadVoiceCopilotRuntimeConfig(options.config);
    this.envFilePath = options.envFilePath;
    this.fetchImpl = options.fetchImpl;
    this.agoraRestBaseUrl = options.agoraRestBaseUrl;
    this.timeoutMs = options.timeoutMs;
  }

  getConfigView(): VoiceCopilotConfigView {
    return buildVoiceCopilotConfigView(this.config);
  }

  private createAgoraClient(cfg: VoiceCopilotRuntimeConfig = this.config): AgoraCopilotClient {
    return new AgoraCopilotClient(cfg, {
      fetchImpl: this.fetchImpl,
      restBaseUrl: this.agoraRestBaseUrl ?? cfg.agoraRestBaseUrl,
      timeoutMs: this.timeoutMs,
    });
  }

  private mergeConfig(input: UpdateVoiceCopilotConfigInput): VoiceCopilotRuntimeConfig {
    const nextVendor = normalizeVoiceVendor(input.vendor ?? this.config.vendor);
    const presetChanged = nextVendor !== this.config.vendor;
    const preset = getVoiceCopilotPreset(nextVendor);

    const nextModel =
      input.model !== undefined
        ? input.model.trim() || preset.defaultModel
        : presetChanged
          ? preset.defaultModel
          : this.config.model;
    const nextVoice =
      input.voice !== undefined
        ? input.voice.trim() || preset.defaultVoice
        : presetChanged
          ? preset.defaultVoice
          : this.config.voice;
    const rawUrl =
      input.url !== undefined
        ? input.url.trim() || preset.defaultUrl
        : presetChanged
          ? preset.defaultUrl
          : this.config.url;

    let validatedUrl = '';
    try {
      validatedUrl = validateCopilotUrl(rawUrl) || preset.defaultUrl;
    } catch (error) {
      throw new AgoraCopilotError(
        'INVALID_COPILOT_CONFIG',
        error instanceof Error ? error.message : 'MLLM 地址配置不合法',
        400,
      );
    }

    const pickSecret = (nextVal: string | undefined, clearFlag: boolean | undefined, prevVal: string) => {
      if (clearFlag) return '';
      if (typeof nextVal === 'string' && nextVal.trim()) return nextVal.trim();
      return prevVal;
    };

    return {
      vendor: nextVendor,
      model: nextModel,
      voice: nextVoice,
      url: validatedUrl,
      agoraAppId: input.agoraAppId !== undefined ? input.agoraAppId.trim() : this.config.agoraAppId,
      agoraAppCertificate: pickSecret(input.agoraAppCertificate, input.clearAppCertificate, this.config.agoraAppCertificate),
      agoraCustomerId: pickSecret(input.agoraCustomerId, input.clearCustomerId, this.config.agoraCustomerId),
      agoraCustomerSecret: pickSecret(input.agoraCustomerSecret, input.clearCustomerSecret, this.config.agoraCustomerSecret),
      mllmApiKey: pickSecret(input.mllmApiKey, input.clearMllmApiKey, this.config.mllmApiKey),
      agoraRestBaseUrl: this.config.agoraRestBaseUrl,
    };
  }

  updateConfig(input: UpdateVoiceCopilotConfigInput): VoiceCopilotConfigView {
    const nextConfig = this.mergeConfig(input);
    this.config = nextConfig;
    if (input.persist !== false && this.envFilePath) {
      persistVoiceCopilotConfig(this.envFilePath, nextConfig);
    }
    return this.getConfigView();
  }

  async testConfig(overrides: UpdateVoiceCopilotConfigInput = {}): Promise<VoiceCopilotProbeResult> {
    const candidateConfig = this.mergeConfig(overrides);
    return this.createAgoraClient(candidateConfig).probeConfig();
  }

  async startSession(input: { workName?: string; preferMock?: boolean } = {}): Promise<VoiceCopilotSession> {
    if (this.closing) {
      throw new AgoraCopilotError('SERVICE_CLOSING', '后端正在关闭，无法开启语音会话', 503);
    }
    if (this.active) {
      await this.stopSession(this.active.session.sessionId).catch(() => {});
    }

    const sessionId = randomUUID();
    const channel = `forma_${sessionId.replace(/-/g, '').slice(0, 16)}`;
    const userUid = 1001;
    const agentUid = 2001;
    const configuredMode = resolveVoiceCopilotMode(this.config);

    if (input.preferMock || configuredMode !== 'real') {
      const mockSession: VoiceCopilotSession = {
        sessionId,
        mode: 'mock',
        vendor: this.config.vendor,
        model: this.config.model,
        voice: this.config.voice,
        agentId: `mock-${sessionId.slice(0, 8)}`,
        appId: '',
        channel,
        userUid,
        agentUid,
        rtcToken: '',
        rtmToken: '',
        createdAt: new Date().toISOString(),
        notice: input.preferMock
          ? '已启动本地 Mock 贾维斯演练模式（零费用），可体验画布联动与指令解析。'
          : '尚未配置声网国际版或 MLLM 密钥，已自动切换本地 Mock 贾维斯演练模式；点击设置图标填入密钥即可连真声网。',
      };
      this.active = { session: mockSession };
      return mockSession;
    }

    const client = this.createAgoraClient();
    const tokens = client.generateTokens(channel, userUid, agentUid);
    const { agentId } = await client.joinAgent({
      name: `forma_jarvis_${sessionId.slice(0, 8)}`,
      channel,
      agentRtcToken: tokens.agentRtcToken,
      agentUid,
      userUid,
      systemPrompt: buildJarvisSystemPrompt(input.workName),
    });

    const realSession: VoiceCopilotSession = {
      sessionId,
      mode: 'real',
      vendor: this.config.vendor,
      model: this.config.model,
      voice: this.config.voice,
      agentId,
      appId: this.config.agoraAppId,
      channel,
      userUid,
      agentUid,
      rtcToken: tokens.userRtcToken,
      rtmToken: tokens.userRtmToken,
      createdAt: new Date().toISOString(),
    };
    this.active = { session: realSession };
    return realSession;
  }

  private requireSession(sessionId: string): ActiveSessionRecord {
    if (!this.active || this.active.session.sessionId !== sessionId) {
      throw new AgoraCopilotError('SESSION_NOT_FOUND', '实时语音会话不存在或已结束', 404);
    }
    return this.active;
  }

  async think(sessionId: string, payload: VoiceCopilotContextPayload): Promise<ThinkResult> {
    const active = this.requireSession(sessionId);
    if (active.session.mode === 'mock') {
      const { replyText, actions } = buildMockJarvisReply(payload);
      return { ok: true, mode: 'mock', replyText, actions };
    }
    const client = this.createAgoraClient();
    await client.thinkAgent(active.session.agentId, buildContextMessage(payload));
    return { ok: true, mode: 'real' };
  }

  async interrupt(sessionId: string): Promise<{ ok: true }> {
    const active = this.requireSession(sessionId);
    if (active.session.mode === 'real') {
      await this.createAgoraClient().interruptAgent(active.session.agentId);
    }
    return { ok: true };
  }

  async stopSession(sessionId: string): Promise<{ ok: true }> {
    const active = this.requireSession(sessionId);
    this.active = undefined;
    if (active.session.mode === 'real') {
      await this.createAgoraClient().leaveAgent(active.session.agentId);
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    this.closing = true;
    const current = this.active;
    this.active = undefined;
    if (current && current.session.mode === 'real') {
      await this.createAgoraClient().leaveAgent(current.session.agentId).catch(() => {});
    }
  }
}
