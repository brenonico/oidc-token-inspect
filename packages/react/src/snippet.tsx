import { Fragment } from "react";
import { decodeJwt, shortPreview } from "./decode";
import type { TraceVariable } from "./trace-schema";

function JsonLines({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  return (
    <>
      {"{\n"}
      {entries.map(([k, v], i) => (
        <Fragment key={k}>
          {"  "}
          <span className="ti-tok-k">"{k}"</span>: <span className="ti-tok-s">{JSON.stringify(v)}</span>
          {i < entries.length - 1 ? "," : ""}
          {"\n"}
        </Fragment>
      ))}
      {"}"}
    </>
  );
}

/** Renders a variable value inside a dark snippet — preview, decoded JWT, or raw. */
export function SnippetView({ variable, expanded }: { variable: TraceVariable; expanded: boolean }) {
  if (!expanded) {
    return (
      <pre>
        <span className="ti-tok-preview">{shortPreview(variable.value, 14, 8)}</span>
      </pre>
    );
  }
  if (variable.kind === "Jwt") {
    const decoded = decodeJwt(variable.value);
    if (decoded) {
      return (
        <pre>
          <span className="ti-tok-d">{"// header\n"}</span>
          <JsonLines obj={decoded.header} />
          {"\n\n"}
          <span className="ti-tok-d">{"// payload\n"}</span>
          <JsonLines obj={decoded.payload} />
          {"\n\n"}
          <span className="ti-tok-d">{"// raw token\n" + variable.value}</span>
        </pre>
      );
    }
  }
  return (
    <pre>
      <span className="ti-tok-s">{variable.value}</span>
    </pre>
  );
}
