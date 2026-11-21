import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { readCheckEvidence } from './api.ts';
import type { CandidateSummary, ThumbnailSource } from './candidate-overview.ts';

type ThumbState = Record<string, { url?: string; failed?: boolean }>;

/** Reads each finished run's hash-verified smoke screenshot once; no live iframe per card. */
function useThumbnails(sources: ThumbnailSource[], enabled: boolean) {
  const [thumbs, setThumbs] = useState<ThumbState>({});
  const cache = useRef(new Map<string, string>());
  const wanted = sources.map(source => source.key).join('|');
  useEffect(() => {
    const keys = new Set(sources.map(source => source.key));
    for (const [key, url] of cache.current) {
      if (keys.has(key)) continue;
      URL.revokeObjectURL(url);
      cache.current.delete(key);
    }
    setThumbs(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => keys.has(key))));
    if (!enabled) return;
    const controller = new AbortController();
    for (const source of sources) {
      if (cache.current.has(source.key)) continue;
      void readCheckEvidence(source.runId, source.ref, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(result.blob);
        cache.current.set(source.key, url);
        setThumbs(previous => ({ ...previous, [source.key]: { url } }));
      }).catch(() => {
        if (!controller.signal.aborted) setThumbs(previous => ({ ...previous, [source.key]: { failed: true } }));
      });
    }
    return () => controller.abort();
    // `wanted` fully identifies the sources (run id + artifact hash).
  }, [wanted, enabled]);
  useEffect(() => () => {
    for (const url of cache.current.values()) URL.revokeObjectURL(url);
    cache.current.clear();
    setThumbs({});
  }, []);
  return thumbs;
}

const placeholderText = { unchecked: '未运行检查 · 暂无截图', checking: '检查中 · 截图待生成', unavailable: '暂无可用截图' } as const;

export default function CandidateOverview({ summaries, selectedId, comparing, ready, onOpen }: {
  summaries: CandidateSummary[];
  selectedId: string;
  /** Whether the selected candidate is currently shown next to / instead of the live work. */
  comparing: boolean;
  ready: boolean;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const list = useRef<HTMLUListElement>(null);
  const thumbs = useThumbnails(summaries.flatMap(summary => summary.thumbnail ? [summary.thumbnail] : []), ready && open);
  if (summaries.length === 0) return null;

  function move(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const cards = [...(list.current?.querySelectorAll<HTMLButtonElement>('button.candidate-card') ?? [])];
    const index = cards.indexOf(event.currentTarget);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + cards.length) % cards.length;
    cards[next]?.focus();
  }

  return <section className={`candidate-overview${open ? '' : ' is-collapsed'}`} data-testid="candidate-overview" aria-label="待定候选总览">
    <div className="candidate-overview-head">
      <span className="section-label">CANDIDATES</span>
      <span className="candidate-overview-count">{summaries.length} 个待定 · 点卡片进入并排对比</span>
      <button type="button" className="inline-link-btn" data-testid="candidate-overview-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '收起' : '展开'}</button>
    </div>
    {open && <ul ref={list} className="candidate-overview-list" role="list">
      {summaries.map(summary => {
        const selected = summary.id === selectedId;
        const thumb = summary.thumbnail ? thumbs[summary.thumbnail.key] : undefined;
        const thumbState = thumb?.url ? 'image' : summary.thumbnail ? (thumb?.failed ? 'error' : ready && open ? 'loading' : 'waiting') : 'none';
        return <li key={summary.id}>
          <button
            type="button"
            className={`candidate-card${selected ? ' is-selected' : ''}${selected && comparing ? ' is-open' : ''}`}
            data-testid="candidate-card"
            data-candidate-id={summary.id}
            data-selected={selected}
            aria-current={selected ? 'true' : undefined}
            aria-label={`候选 ${summary.shortId}：${summary.files} 个文件，新增 ${summary.added} 行，删除 ${summary.deleted} 行，${summary.checkLabel}${summary.outOfScope ? `，超出选中范围 ${summary.outOfScope} 处` : ''}${summary.staleBase ? '，基于旧版本' : ''}。打开并排对比`}
            onClick={() => onOpen(summary.id)}
            onKeyDown={move}
          >
            <span className="candidate-card-thumb" data-testid="candidate-card-thumb" data-thumb-state={thumbState}>
              {thumb?.url
                ? <img src={thumb.url} alt="" title="检查截图 · 首屏（来自页面冒烟检查）"/>
                : <span className="candidate-card-placeholder">{thumbState === 'loading' ? '读取截图…' : thumbState === 'error' ? '截图无法读取' : thumbState === 'waiting' ? '状态同步后读取截图' : placeholderText[summary.placeholder]}</span>}
              {thumb?.url && <span className="candidate-card-thumb-tag">检查截图 · 首屏</span>}
            </span>
            <span className="candidate-card-body">
              <span className="candidate-card-title">
                <b>候选 {summary.shortId}</b>
                {selected && <span className="candidate-card-current">{comparing ? '对比中' : '已选中'}</span>}
              </span>
              {summary.instruction && <span className="candidate-card-instruction" title={summary.instruction}>{summary.instruction}</span>}
              <span className="candidate-card-stats" data-testid="candidate-card-stats">
                {summary.files} 个文件 · <span className="candidate-card-add">+{summary.added}</span> <span className="candidate-card-del">−{summary.deleted}</span>
              </span>
              <span className="candidate-card-flags">
                <span className={`candidate-card-check tone-${summary.checkTone}`} data-testid="candidate-card-check">{summary.checkLabel}</span>
                {summary.outOfScope > 0 && <span className="candidate-card-flag">超出范围 {summary.outOfScope}</span>}
                {summary.staleBase && <span className="candidate-card-flag">基于旧版本</span>}
              </span>
            </span>
          </button>
        </li>;
      })}
    </ul>}
  </section>;
}
