import type { VoiceCopilotAction, VoiceCopilotAgentState, VoiceCopilotSession, VoiceCopilotTranscriptItem } from '@spatial/shared';
import type { IAgoraRTCClient, IMicrophoneAudioTrack } from 'agora-rtc-sdk-ng';
import { parseAgoraStreamPacket } from './voice-copilot-state.ts';

export interface AgoraVoiceTransportCallbacks {
  onAgentState: (state: VoiceCopilotAgentState) => void;
  onVolumeLevel: (level: number) => void;
  onTranscript: (item: VoiceCopilotTranscriptItem, actions: VoiceCopilotAction[]) => void;
  onError: (message: string) => void;
}

export interface AgoraVoiceTransportHandle {
  setMuted: (muted: boolean) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Dynamically imports `agora-rtc-sdk-ng` only when starting a real Agora voice session,
 * keeping the ~700KB WebRTC SDK strictly out of Studio's initial main bundle.
 */
export async function startAgoraVoiceTransport(
  session: VoiceCopilotSession,
  callbacks: AgoraVoiceTransportCallbacks,
): Promise<AgoraVoiceTransportHandle> {
  const { default: AgoraRTC } = await import('agora-rtc-sdk-ng');
  AgoraRTC.setLogLevel(3);

  const client: IAgoraRTCClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  const assembler = new Map<string, string[]>();
  const deliveredTurnActions = new Set<string>();
  let micTrack: IMicrophoneAudioTrack | null = null;
  let stopped = false;

  client.on('user-published', async (user, mediaType) => {
    if (stopped || mediaType !== 'audio') return;
    try {
      await client.subscribe(user, mediaType);
      user.audioTrack?.play();
      callbacks.onAgentState('listening');
    } catch (error) {
      callbacks.onError(error instanceof Error ? error.message : '订阅声网语音流失败');
    }
  });

  client.on('user-unpublished', (_user, mediaType) => {
    if (!stopped && mediaType === 'audio') {
      callbacks.onAgentState('listening');
    }
  });

  client.on('volume-indicator', volumes => {
    if (stopped) return;
    let peak = 0;
    for (const item of volumes) {
      if (item.level > peak) peak = item.level;
    }
    callbacks.onVolumeLevel(peak);
  });

  client.on('stream-message', (_uid, payload) => {
    if (stopped) return;
    const parsed = parseAgoraStreamPacket(payload, assembler);
    if (!parsed) return;
    if (parsed.agentState) {
      callbacks.onAgentState(parsed.agentState);
    }
    if (parsed.transcript) {
      let freshActions: VoiceCopilotAction[] = [];
      if (parsed.actions.length > 0 && parsed.transcript.status === 'completed') {
        const key = `${parsed.transcript.role}:${parsed.transcript.turnId}`;
        if (!deliveredTurnActions.has(key)) {
          deliveredTurnActions.add(key);
          freshActions = parsed.actions;
        }
      }
      callbacks.onTranscript(parsed.transcript, freshActions);
    }
  });

  try {
    client.enableAudioVolumeIndicator();
    await client.join(session.appId, session.channel, session.rtcToken || null, session.userUid);
    micTrack = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
    if (stopped) {
      micTrack.close();
      await client.leave().catch(() => {});
      return { setMuted: async () => {}, stop: async () => {} };
    }
    await client.publish(micTrack);
  } catch (error) {
    micTrack?.close();
    await client.leave().catch(() => {});
    throw error;
  }

  return {
    async setMuted(muted: boolean) {
      if (!stopped && micTrack) {
        await micTrack.setMuted(muted);
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      assembler.clear();
      try {
        micTrack?.stop();
        micTrack?.close();
      } catch {
        // Ignore teardown failures when microphone permission was revoked mid-call.
      }
      micTrack = null;
      await client.leave().catch(() => {});
    },
  };
}
