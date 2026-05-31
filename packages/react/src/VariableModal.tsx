import type { MouseEvent } from "react";
import type { TraceVariable } from "./trace-schema";
import { SnippetView } from "./snippet";

export interface VariableModalProps {
  variable: TraceVariable;
  onClose: () => void;
}

/** Full-screen modal showing a variable's complete content (always expanded). */
export function VariableModal({ variable, onClose }: VariableModalProps): JSX.Element {
  const onBackdrop = (e: MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };
  return (
    <div className="ti-modal" onClick={onBackdrop}>
      <div className="ti-mbox" role="dialog" aria-label={`Variável ${variable.name}`}>
        <div className="ti-mhead">
          <span className="ti-vname">{variable.name}</span>
          <span className={`ti-kind ${variable.kind.toLowerCase()}`}>{variable.kind}</span>
          <button type="button" className="ti-mclose" aria-label="Fechar" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="ti-mbody">
          <div className="ti-snippet">
            <SnippetView variable={variable} expanded />
          </div>
        </div>
      </div>
    </div>
  );
}
