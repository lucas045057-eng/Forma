import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyM2State } from './m2-state.ts';
import PointSpeak from './PointSpeak.tsx';

const center = vi.hoisted(() => ({
  state: {} as typeof emptyM2State,
  syncReady: true,
  status: 'connected',
  syncEpoch: 1,
  locked: vi.fn(() => false),
  acquire: vi.fn(),
  awaiting: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('./EventCenter.tsx', () => ({ useEventCenter: () => center }));

beforeEach(() => {
  center.syncReady = true;
  center.state = { ...emptyM2State, version: 'v1' };
});

describe('PointSpeak batch variant controls and progress strip', () => {
  it('renders the 1/2/3 variant count selector and defaults to single candidate CTA', () => {
    const html = renderToStaticMarkup(<PointSpeak pick={{ kind: 'none' }}/>);
    expect(html).toContain('data-testid="composer-variants"');
    expect(html).toContain('data-testid="variant-count-1"');
    expect(html).toContain('data-testid="variant-count-2"');
    expect(html).toContain('data-testid="variant-count-3"');
    expect(html).toContain('生成候选版本');
  });

  it('renders the batch progress strip with variant pills when active task belongs to a multi-variant batch', () => {
    center.state = {
      ...emptyM2State,
      version: 'v1',
      tasks: [
        {
          id: 'task0001aaaa',
          batchId: 'batch123',
          variantLabel: '方案 A · 稳健精致',
          variantIndex: 1,
          variantTotal: 3,
          instruction: '生成三种方案',
          status: 'done',
          candidateId: 'task0001aaaa',
          events: [{ type: 'task.updated', ts: '2026-11-22T00:00:00Z', sequence: 1, message: '已完成' }],
        },
        {
          id: 'task0002bbbb',
          batchId: 'batch123',
          variantLabel: '方案 B · 对比张力',
          variantIndex: 2,
          variantTotal: 3,
          instruction: '生成三种方案',
          status: 'running',
          events: [],
        },
        {
          id: 'task0003cccc',
          batchId: 'batch123',
          variantLabel: '方案 C · 编排重构',
          variantIndex: 3,
          variantTotal: 3,
          instruction: '生成三种方案',
          status: 'queued',
          events: [],
        },
      ],
    };

    const html = renderToStaticMarkup(<PointSpeak pick={{ kind: 'none' }}/>);
    expect(html).toContain('data-testid="task-batch-strip"');
    expect(html).toContain('同批对比 · 1/3 已就绪');
    expect(html.match(/data-testid="task-batch-pill"/g)).toHaveLength(3);
    expect(html).toContain('data-testid="task-variant-tag"');
    expect(html).toContain('方案 A · 稳健精致');
  });
});
