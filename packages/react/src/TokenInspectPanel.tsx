import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { HttpTraceSource } from "@token-inspect/core";
import type { HttpClient, TraceSource, TraceJournal } from "@token-inspect/core";
import type { FlowRun, TraceVariable } from "./trace-schema";
import { useTokenInspect } from "./useTokenInspect";
import { useTheme } from "./useTheme";
import { SequenceDiagram } from "./SequenceDiagram";
import { VariableCard } from "./VariableCard";
import { VariableModal } from "./VariableModal";

export interface TokenInspectPanelProps {
  source?: TraceSource;
  /** @deprecated BWC — pass a `source` instead. Wrapped in an HttpTraceSource. */
  client?: { get: (path: string) => Promise<TraceJournal> };
  /** @deprecated BWC — pass a `source` instead. */
  endpoint?: string;
  app?: string;
}

type DockPos = "bottom" | "right" | "left";

function selectCurrentRun(runs: FlowRun[]): FlowRun | null {
  if (runs.length === 0) return null;
  const running = [...runs].reverse().find((r) => r.status === "Running");
  return running ?? runs[runs.length - 1];
}

function defaultSize(pos: DockPos): number {
  if (typeof window === "undefined") return 360;
  return Math.round((pos === "bottom" ? window.innerHeight : window.innerWidth) * 0.46);
}

export function TokenInspectPanel({ source, client, endpoint, app }: TokenInspectPanelProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<DockPos>("bottom");
  const [size, setSize] = useState<number>(() => defaultSize("bottom"));
  const [flowsBasis, setFlowsBasis] = useState(230);
  const [varsBasis, setVarsBasis] = useState(340);
  const [hideDetails, setHideDetails] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState(0);
  const [modalVar, setModalVar] = useState<TraceVariable | null>(null);

  const { mode, isDark, cycle } = useTheme();
  const effectiveSource = useMemo<TraceSource>(
    () => source ?? new HttpTraceSource(client as HttpClient, endpoint!),
    [source, client, endpoint],
  );
  const { runs, loading, error } = useTokenInspect({ source: effectiveSource, open });

  const currentRun = selectCurrentRun(runs);
  const activeRunId = selectedRunId ?? currentRun?.id ?? null;
  const activeRun = runs.find((r) => r.id === activeRunId) ?? null;

  useEffect(() => {
    setSelectedStep(0);
  }, [activeRunId]);

  // Split the host page: reserve space so the dock never covers content.
  useEffect(() => {
    const b = document.body.style;
    b.paddingBottom = open && pos === "bottom" ? `${size}px` : "";
    b.paddingRight = open && pos === "right" ? `${size}px` : "";
    b.paddingLeft = open && pos === "left" ? `${size}px` : "";
    return () => {
      b.paddingBottom = b.paddingRight = b.paddingLeft = "";
    };
  }, [open, pos, size]);

  const changeDock = (p: DockPos) => {
    setPos(p);
    setSize(defaultSize(p));
  };

  // Drag the outer dock edge → resize, keeping it full-width/height.
  const startDockResize = () => {
    const move = (e: MouseEvent) => {
      if (pos === "bottom") setSize(Math.max(170, Math.min(window.innerHeight - 60, window.innerHeight - e.clientY)));
      else if (pos === "right") setSize(Math.max(320, window.innerWidth - e.clientX));
      else setSize(Math.max(320, e.clientX));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Drag a splitter between panes → resize the flows/vars pane.
  const startPaneResize = (which: "flows" | "vars", el: HTMLElement | null) => {
    if (!el) return;
    const horiz = pos === "bottom";
    const rect = el.getBoundingClientRect();
    const move = (e: MouseEvent) => {
      const v =
        which === "flows"
          ? horiz
            ? e.clientX - rect.left
            : e.clientY - rect.top
          : horiz
            ? rect.right - e.clientX
            : rect.bottom - e.clientY;
      const clamped = Math.max(120, v);
      if (which === "flows") setFlowsBasis(clamped);
      else setVarsBasis(clamped);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const flowsRef = useRef<HTMLDivElement>(null);
  const varsRef = useRef<HTMLDivElement>(null);

  const rootClass = `ti-root${isDark ? " ti-dark" : ""}`;

  if (!open) {
    return (
      <div className={rootClass}>
        <button type="button" className="ti-toggle" aria-label="Token Inspect" onClick={() => setOpen(true)}>
          <span aria-hidden>☰</span>
          {app ? `${app} Inspect` : "Token Inspect"}
        </button>
      </div>
    );
  }

  const dockStyle = pos === "bottom" ? { height: size } : { width: size };
  const stepCount = activeRun?.steps.length ?? 0;
  const themeLabel = mode === "auto" ? "Auto" : mode === "dark" ? "Dark" : "Light";

  return (
    <div className={rootClass}>
      <div className={`ti-dock pos-${pos}${hideDetails ? " ti-hide-details" : ""}`} style={dockStyle}>
        <div className="ti-resizer" onMouseDown={startDockResize} />

        <div className="ti-toolbar">
          <h2 className="ti-title">
            <span className="ti-sq" aria-hidden />
            Token Inspect
          </h2>
          {app && <span className="ti-app">{app}</span>}
          <span className="ti-spacer" />
          <button type="button" className="ti-btn" onClick={cycle} title="Tema (segue o sistema por defeito)">
            🌓 <span className="ti-lbl">{themeLabel}</span>
          </button>
          <button
            type="button"
            className={`ti-btn${hideDetails ? "" : " active"}`}
            onClick={() => setHideDetails((v) => !v)}
            title="Mostrar/ocultar detalhes"
          >
            👁 <span className="ti-lbl">Detalhes</span>
          </button>
          <span className="ti-sep" />
          <button type="button" className={`ti-btn${pos === "left" ? " active" : ""}`} aria-label="Ancorar à esquerda" onClick={() => changeDock("left")}>
            ⊣
          </button>
          <button type="button" className={`ti-btn${pos === "bottom" ? " active" : ""}`} aria-label="Ancorar em baixo" onClick={() => changeDock("bottom")}>
            ⊥
          </button>
          <button type="button" className={`ti-btn${pos === "right" ? " active" : ""}`} aria-label="Ancorar à direita" onClick={() => changeDock("right")}>
            ⊢
          </button>
          <span className="ti-sep" />
          <button type="button" className="ti-btn" aria-label="Fechar" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>

        <div className="ti-panes">
          {/* Flows */}
          <div className="ti-pane ti-pane-flows" ref={flowsRef} style={{ flex: `0 0 ${flowsBasis}px` }}>
            <div className="ti-pane-head">
              Flows <span className="sub">· {runs.length}</span>
            </div>
            <div className="ti-scroll">
              {loading && runs.length === 0 && <div className="ti-empty">A carregar…</div>}
              {error && <div className="ti-err">{error}</div>}
              {!loading && !error && runs.length === 0 && <div className="ti-empty">Sem dados de trace.</div>}
              {runs.map((run) => {
                const cls = ["ti-flow", run.id === currentRun?.id ? "cur" : "", run.id === activeRunId ? "sel" : ""].join(" ").trim();
                return (
                  <button
                    key={run.id}
                    type="button"
                    className={cls}
                    onClick={() => {
                      setSelectedRunId(run.id);
                      setSelectedStep(0);
                    }}
                  >
                    <span className="k">{run.flowKind}</span>
                    <span className="t">{run.title}</span>
                    <span className="meta">
                      <span className={`ti-pill ${run.status === "Running" ? "run" : run.status === "Failed" ? "fail" : "done"}`}>{run.status}</span>
                      {run.id === currentRun?.id && <span className="ti-now">● agora</span>}
                      <span className="ts">{new Date(run.startedAt).toLocaleTimeString()}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="ti-psplit" onMouseDown={() => startPaneResize("flows", flowsRef.current)} />

          {/* Sequence */}
          <div className="ti-pane ti-pane-seq">
            <div className="ti-pane-head">Sequência</div>
            <div className="ti-seqbar">
              <span className="lbl">
                {activeRun && stepCount > 0 ? `${selectedStep + 1}/${stepCount} · ${activeRun.steps[selectedStep]?.label ?? ""}` : "—"}
              </span>
              <div className="ti-nav">
                <button type="button" className="ti-navb" aria-label="Passo anterior" disabled={selectedStep === 0} onClick={() => setSelectedStep((s) => Math.max(0, s - 1))}>
                  ◀
                </button>
                <button
                  type="button"
                  className="ti-navb"
                  aria-label="Passo seguinte"
                  disabled={selectedStep >= stepCount - 1}
                  onClick={() => setSelectedStep((s) => Math.min(stepCount - 1, s + 1))}
                >
                  ▶
                </button>
              </div>
            </div>
            <div className="ti-scroll">
              {activeRun && activeRun.steps.length > 0 ? (
                <SequenceDiagram participants={activeRun.participants} steps={activeRun.steps} current={selectedStep} onSelect={setSelectedStep} />
              ) : (
                <div className="ti-empty">Sem passos.</div>
              )}
            </div>
          </div>

          <div className="ti-psplit" onMouseDown={() => startPaneResize("vars", varsRef.current)} />

          {/* Variables */}
          <div className="ti-pane ti-pane-vars" ref={varsRef} style={{ flex: `0 0 ${varsBasis}px` }}>
            <div className="ti-pane-head">
              Variáveis <span className="sub">{activeRun?.steps[selectedStep] ? `· ${activeRun.steps[selectedStep].label}` : ""}</span>
            </div>
            <div className="ti-scroll">
              <div className="ti-vars">
                {activeRun?.steps[selectedStep]?.vars.length ? (
                  activeRun.steps[selectedStep].vars.map((v) => <VariableCard key={v.name} variable={v} onExpand={setModalVar} />)
                ) : (
                  <div className="ti-empty">Sem variáveis neste passo.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {modalVar && <VariableModal variable={modalVar} onClose={() => setModalVar(null)} />}
    </div>
  );
}
