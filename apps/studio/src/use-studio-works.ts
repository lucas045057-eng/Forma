import { useEffect, useRef, useState } from 'react';
import type { Candidate, ModelStatusView, Task, WorkSummary, WorksState } from '@spatial/shared';
import type { CreatedWorkResult } from './NewWorkModal.tsx';
import type { CenterEvent } from './EventCenter.tsx';
import { api, mutation } from './api.ts';

export interface UseStudioWorksOptions {
  tasks: Task[];
  candidates: Candidate[];
  subscribe: (listener: (event: CenterEvent) => void) => () => void;
  reload: (explicit?: boolean) => Promise<void>;
  onBeforeWorkChange: () => void;
  onWorkChangedSurface: () => void;
  onWorkCreatedSurface: (openInspector: boolean) => void;
  onAutoOpenCandidate: (candidateId: string) => void;
  onError: (message: string) => void;
  onResetReady: () => void;
  onSetModeCurrent: () => void;
}

/** Manages multi-work list switching, work creation flows, and live model status indicators. */
export function useStudioWorks({
  tasks,
  candidates,
  subscribe,
  reload,
  onBeforeWorkChange,
  onWorkChangedSurface,
  onWorkCreatedSurface,
  onAutoOpenCandidate,
  onError,
  onResetReady,
  onSetModeCurrent,
}: UseStudioWorksOptions) {
  const [worksState, setWorksState] = useState<WorksState>({
    activeId: 'default',
    works: [{ id: 'default', name: '木间香薰', starter: 'product-page', createdAt: '', updatedAt: '', active: true }],
  });
  const [modelStatus, setModelStatus] = useState<ModelStatusView | null>(null);
  const [switchingWork, setSwitchingWork] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const onAutoOpenCandidateRef = useRef(onAutoOpenCandidate);
  onAutoOpenCandidateRef.current = onAutoOpenCandidate;
  const onResetReadyRef = useRef(onResetReady);
  onResetReadyRef.current = onResetReady;

  useEffect(() => {
    let active = true;
    const loadWorks = () => {
      void api<WorksState>('/works')
        .then(value => {
          if (!active || !value || !Array.isArray(value.works) || typeof value.activeId !== 'string') return;
          setWorksState(previous => {
            if (previous.activeId !== value.activeId) {
              onResetReadyRef.current();
              setPreviewRevision(rev => rev + 1);
            }
            return value;
          });
        })
        .catch(() => {});
    };
    const loadModelStatus = () => {
      void api<ModelStatusView>('/models/status')
        .then(value => {
          if (!active || !value || !value.coding) return;
          setModelStatus(value);
        })
        .catch(() => {});
    };
    loadWorks();
    loadModelStatus();
    const unsubscribe = subscribe(event => {
      if (event.type === 'work.changed' || event.type === 'work.updated') loadWorks();
      if (event.type === 'models.updated') loadModelStatus();
      if (event.type === 'candidate.ready' && typeof event.candidate === 'object' && event.candidate !== null) {
        const candidateId = Reflect.get(event.candidate, 'id');
        const candidateTaskId = Reflect.get(event.candidate, 'taskId');
        const relatedTask = tasksRef.current.find(t => t.id === candidateTaskId || t.id === candidateId);
        if (typeof candidateId === 'string' && candidateId && relatedTask?.bootstrap) {
          onAutoOpenCandidateRef.current(candidateId);
        }
      }
    });
    return () => { active = false; unsubscribe(); };
  }, [subscribe]);

  async function selectWork(nextId: string) {
    if (!nextId || nextId === worksState.activeId || switchingWork) return;
    setSwitchingWork(true);
    onError('');
    try {
      onBeforeWorkChange();
      onWorkChangedSurface();
      onSetModeCurrent();
      onResetReady();
      await api(`/works/${encodeURIComponent(nextId)}/select`, mutation('POST', {}));
      setPreviewRevision(rev => rev + 1);
      await reload(true);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '切换作品失败');
    } finally {
      setSwitchingWork(false);
    }
  }

  async function handleWorkCreated(created: CreatedWorkResult) {
    onBeforeWorkChange();
    onWorkCreatedSurface(!created.task && (created.work.starter === 'blank' || created.work.starter === 'free-web'));
    onSetModeCurrent();
    onResetReady();
    setWorksState(previous => {
      const others = previous.works.filter(item => item.id !== created.work.id).map(item => ({ ...item, active: false }));
      return { activeId: created.activeId, works: [...others, { ...created.work, active: true }] };
    });
    setPreviewRevision(rev => rev + 1);
    await reload(true).catch(() => {});
  }

  const activeWorkSummary: WorkSummary | undefined = worksState.works.find(item => item.id === worksState.activeId) ?? worksState.works[0];
  const blankBootstrap = (activeWorkSummary?.starter === 'blank' || activeWorkSummary?.starter === 'free-web') && !candidates.some(item => item.decision === 'adopted');
  const modelStatusTooltip = modelStatus
    ? [
        `编码模型：${modelStatus.coding.mode === 'real' ? `${modelStatus.coding.model} (${modelStatus.coding.providerHost})` : modelStatus.coding.mode === 'mock' ? '本地模拟' : '未配置'}`,
        `语音识别：${modelStatus.speech.mode === 'real' ? `百炼 ${modelStatus.speech.model}` : modelStatus.speech.mode === 'mock' ? '本地模拟' : '未配置'}`,
        `3D 生成：${modelStatus.lux3d.mode === 'real' ? `Lux3D (${modelStatus.lux3d.gateway})` : modelStatus.lux3d.mode === 'mock' ? '本地模拟' : '未配置'}`,
      ].join(' · ')
    : '';

  return {
    worksState,
    modelStatus,
    setModelStatus,
    switchingWork,
    previewRevision,
    activeWorkSummary,
    blankBootstrap,
    modelStatusTooltip,
    selectWork,
    handleWorkCreated,
  };
}
