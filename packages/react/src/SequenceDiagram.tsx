import type { KeyboardEvent } from "react";
import type { TraceStep } from "./trace-schema";

const LANE_COLORS = ["#0891b2", "#2563eb", "#7c3aed", "#dc2626", "#059669", "#d97706"];
const LABEL_W = 150;
const LANE_MIN = 72;

const STOP = new Set(["to", "for", "of", "the", "a", "with", "from", "and", "into"]);

function deriveShort(step: TraceStep): string {
  if (step.short) return step.short;
  const cleaned = step.label.replace(/\([^)]*\)/g, "").trim(); // drop parentheticals
  const words = cleaned.split(/\s+/).slice(0, 2);
  while (words.length > 1 && STOP.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(" ") || step.label;
}

export interface SequenceDiagramProps {
  participants: string[];
  steps: TraceStep[];
  current: number;
  onSelect: (index: number) => void;
}

/**
 * Unified sequence diagram: sticky participant heads at the top, then one
 * clickable row per step. Each row shows a short label (left column) plus a
 * horizontal message arrow drawn between the from/to lifelines (column centres).
 */
export function SequenceDiagram({ participants, steps, current, onSelect }: SequenceDiagramProps) {
  const n = participants.length || 1;
  const minWidth = LABEL_W + n * LANE_MIN;
  const centre = (i: number) => ((i + 0.5) / n) * 100;
  const gridCols = `repeat(${n}, 1fr)`;

  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(i);
    }
  };

  return (
    <div>
      <div className="ti-heads" style={{ minWidth }}>
        <div className="spc" />
        <div className="hd" style={{ gridTemplateColumns: gridCols }}>
          {participants.map((p, i) => (
            <span key={p + i} className="h" style={{ background: LANE_COLORS[i % LANE_COLORS.length] }}>
              {p}
            </span>
          ))}
        </div>
      </div>

      {steps.map((s, i) => {
        const fromIdx = Math.max(0, participants.indexOf(s.from));
        const toIdx = Math.max(0, participants.indexOf(s.to));
        const self = fromIdx === toIdx;
        const cls = ["ti-srow", i < current ? "done" : "", i === current ? "cur" : ""].join(" ").trim();
        const a = Math.min(centre(fromIdx), centre(toIdx));
        const w = Math.abs(centre(toIdx) - centre(fromIdx));
        return (
          <div
            key={i}
            role="button"
            tabIndex={0}
            aria-label={s.label}
            aria-current={i === current}
            title={s.label}
            className={cls}
            style={{ minWidth }}
            onClick={() => onSelect(i)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <div className="ti-slabel">
              <span className="ti-dot">{i < current ? "✓" : i + 1}</span>
              <span className="txt">
                <span className="s">{deriveShort(s)}</span>
                <span className="full">{s.label}</span>
              </span>
            </div>
            <div className="ti-sdiag" style={{ gridTemplateColumns: gridCols }}>
              {participants.map((_, c) => (
                <div key={c} className="ti-lane" />
              ))}
              {self ? (
                <span className="ti-self" style={{ left: `${centre(fromIdx)}%` }}>
                  ↺
                </span>
              ) : (
                <span
                  className={`ti-arw ${toIdx > fromIdx ? "r" : "l"}`}
                  style={{ left: `${a}%`, width: `${w}%` }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
