import { useState } from "react";
import type { TraceVariable } from "./trace-schema";
import { SnippetView } from "./snippet";

export interface VariableCardProps {
  variable: TraceVariable;
  /** Opens the full content in a modal (didactic — view a long token comfortably). */
  onExpand: (v: TraceVariable) => void;
}

export function VariableCard({ variable, onExpand }: VariableCardProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const canDecode = variable.kind === "Jwt";
  const canReveal = variable.kind === "Opaque";
  const label = open ? "Hide" : canDecode ? "Decode" : "Reveal";

  return (
    <div className="ti-vcard">
      <div className="ti-vhead">
        <span className="ti-vname">{variable.name}</span>
        <span className={`ti-kind ${variable.kind.toLowerCase()}`}>{variable.kind}</span>
        {(canDecode || canReveal) && (
          <button type="button" className={`ti-deco ${canReveal ? "rev" : ""}`} onClick={() => setOpen((v) => !v)}>
            {label}
          </button>
        )}
      </div>
      <div className="ti-snippet">
        <button
          type="button"
          className="ti-expand"
          title="Abrir em modal"
          aria-label="Expandir"
          onClick={() => onExpand(variable)}
        >
          ⤢
        </button>
        <SnippetView variable={variable} expanded={open} />
      </div>
    </div>
  );
}
