import { expect } from '@playwright/test';

export interface TaskLike { id: string; status: string; candidateId?: string }

export type JsonCall = (method: 'GET' | 'POST', pathname: string, data?: unknown) => Promise<{ status: number; body: unknown }>;

/**
 * 模块放置任务的真实审批步骤（测试侧唯一入口，只处理传入的本次 task.id）。
 *
 * 断言：任务仍 awaiting_approval、尚无公开候选；审批列表里该 task 的 pending 卡唯一；
 * POST 该卡 {option:0} 恰好一次；用响应里的 task（不是旧 confirm 对象）断言 id 不变、
 * status=done、candidateId===task.id；最后 GET 公开候选并断言 id 一致。
 */
export async function approvePlacementTaskOnce<T extends TaskLike>(call: JsonCall, task: T): Promise<T> {
  expect(task.status, `本任务应等待审批，实际 ${task.status}`).toBe('awaiting_approval');
  expect(task.candidateId, '审批前不应已有公开候选').toBeUndefined();

  const hidden = await call('GET', `/candidates/${task.id}`);
  expect(hidden.status, `审批前候选应不可见：${JSON.stringify(hidden.body)}`).toBe(404);

  const listed = await call('GET', '/approvals');
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  expect(Array.isArray(listed.body), `审批列表必须是数组：${JSON.stringify(listed.body)}`).toBe(true);
  const cards = (listed.body as Array<{ id: string; taskId: string; status: string }>).filter((card) => card.taskId === task.id && card.status === 'pending');
  expect(cards, `本次任务应恰有一张 pending 审批卡：${JSON.stringify(listed.body)}`).toHaveLength(1);

  const answered = await call('POST', `/approvals/${cards[0].id}`, { option: 0 });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  const body = answered.body as { approval?: { id?: string; status?: string }; task?: TaskLike };
  expect(body.approval?.id).toBe(cards[0].id);
  expect(body.approval?.status).toBe('approved');
  const updated = body.task;
  expect(updated, JSON.stringify(answered.body)).toBeTruthy();
  expect(updated!.id).toBe(task.id);
  expect(updated!.status).toBe('done');
  expect(updated!.candidateId).toBe(task.id);

  const candidate = await call('GET', `/candidates/${task.id}`);
  expect(candidate.status, JSON.stringify(candidate.body)).toBe(200);
  expect((candidate.body as { id?: string }).id).toBe(task.id);
  return updated! as T;
}
