# Token Inspect — Plugin Agnóstico — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalizar o Token Inspect para qualquer aplicação com Keycloak (incl. SPA public-client e API-valida-token), através de adaptadores por **ponto de observação** (client/server/BFF), um `TraceSource` plugável + schema comum, distribuição UMD self-mount + NuGet, config **inerte-por-defeito** com opt-in por capacidade, e o hardening de segurança aprovado.

**Architecture:** Três pacotes JS (`@token-inspect/core` schema+`TraceSource`, `@token-inspect/react` painel atual refatorado, `@token-inspect/browser` observador + UMD self-mount em Shadow DOM) + um pacote .NET (`TokenInspect` atual + `TokenInspect.AspNetCore` middleware drop-in). Merge client+server por `correlationId` com ordenação **lógica** (ordinal por fonte), limitado a 1+1 hop nesta versão. Segurança: ACL sem header-trust (fix do IDOR latente), inerte por defeito, `traceparent` same-origin off-by-default, hard-stop em produção, supply-chain (SRI/pin), teardown idempotente.

**Tech Stack:** .NET 10 (xUnit), React 18.3.1 + Vite 5.4.10 (vitest + @testing-library/react + jsdom), TypeScript, Rollup/Vite-lib para o bundle UMD, Docker Compose, smoke `scripts/smoke-test.ps1`, Playwright.

**Spec:** [docs/superpowers/specs/2026-05-29-token-inspect-agnostic-plugin-design.md](../specs/2026-05-29-token-inspect-agnostic-plugin-design.md)

**Convenções de commit (CLAUDE.md):** **um commit por etapa**; só o lead/orquestrador faz commit; `git add` com paths explícitos; sem push/tag sem indicação. Branch: continua em **`feat/token-inspect`** (worktree `C:/dev/KCaaIdP-token-inspect`).

---

## Para o orquestrador autónomo (ler primeiro)

Premissas e regras **não-negociáveis**:

1. **Decidir pelas premissas da PoC** — PoC didática (ver [poc-reference.md](../../poc-reference.md)). Em ambiguidade, escolher a opção mais simples que respeite as invariantes; não parar para perguntar.

2. **Desacoplamento total (INVARIANTE).** Os pacotes `@token-inspect/core`, `@token-inspect/react`, `@token-inspect/browser` e a lib .NET `TokenInspect`/`TokenInspect.AspNetCore` **não podem** referenciar Keycloak, Redis nem tipos do KCaaIdP. Verificação (Etapa 12): `grep -ri "keycloak\|redis\|StackExchange\|kcaaidp" backend/packages/TokenInspect*/ frontend/packages/token-inspect*/src/` → vazio (excepto comentários genéricos).

3. **Não ferir o já feito (INVARIANTE).** Smoke `scripts/smoke-test.ps1` **31/31** + Playwright do site + UI atual do inspector (rebuild dos 3 portais + login + ☰ funciona) verdes na baseline (Etapa 0) e no gate final (Etapa 12).

4. **Inerte por defeito (INVARIANTE).** Com config vazia / `enabled:false` ou capacidades a `false`: **zero** monkey-patching, **zero** painel montado, **zero** header injetado, **zero** rotas novas mapeadas. `window.fetch === original`. `sess:*`/`ti:*` intactos.

5. **Nunca quebrar o host (INVARIANTE).** Toda a instrumentação client em try/catch que engole erros; pass-through preserva `this`/args/retorno; não clona/consome corpos; deteta wrappers existentes. ACL **nunca** confia em header de request — posse derivada do contexto autenticado.

6. **Headers anonimizados (INVARIANTE).** Default `traceparent` (W3C, neutro); nome configurável; **nunca** um header que identifique a ferramenta (proibido `X-Token-Inspect-*` em outgoing). Path do endpoint dev configurável/ofuscável.

7. **Avaliar agentes/worktrees concorrentes ANTES de tocar em ficheiros partilhados.** `git worktree list` e `git branch -a` no arranque e antes de editar `frontend/shared/`, `docs/README.md`, `docker-compose.yml`, `.sln`. Se houver outro worktree ativo, isolar a alteração ao mínimo. Trabalho **dentro** de `C:/dev/KCaaIdP-token-inspect`.

8. **Inicialização de subagentes.** subagent-driven-development: subagente fresco por task, revisão entre tasks. As Etapas 2 e 4 (schemas TS+.NET) podem correr em paralelo (subagentes distintos). Etapas 5–8 dependem de 2/3. Etapa 9 depende de 4. Etapa 10 cruza tudo. Etapas 11/12 são finais.

9. **Capítulo de docs no fim (Etapa 12).** Editar `docs/13-token-inspect-plugin.md` para refletir o modelo agnóstico (3 adaptadores, matriz de cenários, secção de segurança).

**Ordem de dependências:**
```
Etapa 0 (baseline)
   │
Etapa 1 (fix ACL existente) ─────────────────────────────► pode ir SOZINHA já
   │
Etapa 2 (@token-inspect/core) ──┐
Etapa 4 (.NET schema parity) ───┤  (2 e 4 em paralelo)
                                ├─► Etapa 3 (react → TraceSource)
                                ├─► Etapa 5 (browser pkg skeleton)
                                ├─► Etapa 9 (.NET middleware)
                                │
Etapa 3 ─► Etapa 5 ─► Etapa 6 (observer fetch/XHR + auth.login + api.call)
                      ─► Etapa 7 (correlation traceparent same-origin)
                      ─► Etapa 8 (implicit/ROPC/refresh)
Etapa 9 ──────────────────────────► Etapa 10 (config + presets + auto-detect)
                                    Etapa 11 (distribution + hardening)
                                    Etapa 12 (AC + docs)
```

---

## File Structure

```text
backend/packages/TokenInspect/                      # EXISTENTE — adicionar:
├── TokenInspectOptions.cs                          #   EDIT — Authorize delegate, defaults
├── TokenInspectEndpoints.cs                        #   REWRITE — sem header-trust; usa Authorize
└── Model/{TraceStep.cs, FlowRun.cs}                #   EDIT — campos Short, Seq, Source, CorrelationId

backend/packages/TokenInspect.AspNetCore/           # NOVO — middleware drop-in
├── TokenInspect.AspNetCore.csproj
├── TokenInspectMiddleware.cs                       #   pipeline: principal+RBAC+downstream + emit FlowRun
├── DownstreamHandler.cs                            #   DelegatingHandler p/ HttpClient
├── AspNetCoreOptions.cs                            #   Enabled, AckExposesTokens, Loopback, EndpointPath
├── DevEndpoints.cs                                 #   GET <path> + hard-stop em Production
└── RingBuffer.cs                                   #   bounded + TTL

backend/session/Infrastructure/                     # EDIT (host wiring)
└── SessionContextAuthorize.cs                      #   delegate que valida cookie-resolved-session

backend/api-bff/Infrastructure/InspectEndpoints.cs   # EDIT — passa o delegate

frontend/packages/token-inspect-core/                # NOVO — pacote TS schema + TraceSource
├── package.json                                     #   "@token-inspect/core"
├── tsconfig.json
├── src/index.ts
├── src/schema.ts                                    #   tipos + JSON Schema (fonte única)
├── src/decode.ts                                    #   migrado de @token-inspect/react
├── src/TraceSource.ts                               #   interface
├── src/HttpTraceSource.ts                           #   poll a um endpoint
├── src/LiveTraceSource.ts                           #   in-memory + subscribe
├── src/CompositeTraceSource.ts                     #   merge logico por correlationId
└── src/__tests__/*

frontend/packages/token-inspect/                     # EXISTENTE — refator p/ TraceSource
├── src/trace-schema.ts                              #   re-export de @token-inspect/core (BWC)
├── src/TokenInspectPanel.tsx                        #   props: { source: TraceSource } (+ shim BWC)
├── src/snippet.tsx, SequenceDiagram.tsx, VariableCard.tsx, VariableModal.tsx, useTheme.ts, styles.css
└── src/__tests__/*                                  #   testes adaptados a TraceSource

frontend/packages/token-inspect-browser/             # NOVO — observer + UMD
├── package.json                                     #   "@token-inspect/browser"
├── vite.config.ts                                   #   build lib UMD + ESM; minify; gera hash SRI
├── src/index.ts                                     #   init(config) / teardown / window.TokenInspect
├── src/config.ts                                    #   types + presets + auto-detect helpers
├── src/install.ts                                   #   self-mount Shadow DOM + render painel React
├── src/observer/fetch.ts                            #   wrap fetch
├── src/observer/xhr.ts                              #   wrap XMLHttpRequest
├── src/observer/storage.ts                          #   wrap setItem + scan
├── src/observer/redirect.ts                         #   le code/state/fragment
├── src/observer/idp.ts                              #   discovery + matching de tráfego
├── src/observer/correlation.ts                      #   geração + injeção traceparent (allowlist)
├── src/observer/reconstruct.ts                      #   eventos → FlowRun (auth.login, api.call, …)
└── src/__tests__/* (jsdom)

frontend/{customer-portal,partner-portal,ops-portal}/  # EDIT — usar AppShell atualizado (mesmo alias)

docs/13-token-inspect-plugin.md                      # EDIT — modelo agnóstico, matriz, segurança
docs/superpowers/specs/2026-05-29-token-inspect-agnostic-plugin-design.md   # spec (já existe)
CHANGELOG.md                                          # EDIT
```

---

## Etapa 0 — Baseline (gate de entrada)

**Resultado verificável:** PoC + UI atual do inspector verdes ANTES de qualquer alteração.

### Task 0.1 — Confirmar baseline verde

- [ ] **Step 1: Subir o stack e correr o smoke**
```powershell
cd C:\dev\KCaaIdP-token-inspect
$env:COMPOSE_PROJECT_NAME = 'kcaaidp'
docker compose up -d --build session api-bff customer partner ops
./scripts/smoke-test.ps1
```
Expected: smoke **31/31 PASS**.

- [ ] **Step 2: Confirmar UI do inspector** — login em <http://localhost:8090/customer> com `customer.demo`, ☰ abre o dock no layout B, navegação ◀/▶, Decode num `access_token` mostra claims. Se algo destoa, PARAR e reportar.

- [ ] **Step 3: Registar a baseline** (nº de testes do package + smoke 31/31).

---

## Etapa 1 — Fix do IDOR latente no pacote existente (URGENTE)

**Resultado verificável:** o endpoint genérico `GET /internal/trace` deixa de confiar no header `X-Session-Id`. Sem delegate explícito de autorização do host, **nega**. Smoke 31/31 mantém-se (BFF intacto).

> Esta etapa **pode ser entregue sozinha** (PR isolado de segurança) sem qualquer dependência das restantes etapas.

### Task 1.1 — `Authorize` delegate em `TokenInspectOptions`

**Files:** Modify: `backend/packages/TokenInspect/TokenInspectOptions.cs`

- [ ] **Step 1: Adicionar o delegate (default-deny)**
```csharp
using System;
using Microsoft.AspNetCore.Http;
namespace TokenInspect;

public sealed class TokenInspectOptions
{
    public bool Enabled { get; set; } = false;
    public string SessionIdHeader { get; set; } = "X-Session-Id";

    /// <summary>
    /// REQUIRED for /internal/trace to return data. Receives the HttpContext and the
    /// session id pulled from the request, returns true ONLY if the caller is authorized
    /// to read that session's journal (i.e. owns it). Default: DENY EVERYTHING.
    /// The host wires this to a principal-derived check (e.g. cookie-resolved session ==
    /// requested session). Header-supplied id is treated as untrusted input.
    /// </summary>
    public Func<HttpContext, string, bool> Authorize { get; set; } = (_, _) => false;

    public TimeSpan RunTtl { get; set; } = TimeSpan.FromMinutes(10);
    public TimeSpan JournalTtl { get; set; } = TimeSpan.FromHours(8);
}
```

### Task 1.2 — `TokenInspectEndpoints` deixa de confiar no header

**Files:** Rewrite: `backend/packages/TokenInspect/TokenInspectEndpoints.cs`
Test: `backend/packages/TokenInspect.Tests/TokenInspectEndpointsTests.cs`

- [ ] **Step 1: Teste primeiro — 4 casos**
```csharp
// 1. Enabled=false → rota não mapeada → 404
// 2. Enabled=true, sem X-Session-Id → 401
// 3. Enabled=true, com X-Session-Id "s1" mas Authorize devolve false → 403
// 4. Enabled=true, X-Session-Id "s1" e Authorize devolve true → 200 com journal de s1
```
Usar `WebApplicationFactory` ou `WebApplication.CreateBuilder` in-proc + fake `ITraceStore`. Asserir status e payload de (4) só com journal de `s1`.

- [ ] **Step 2: Implementação**
```csharp
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
namespace TokenInspect;

public static class TokenInspectEndpoints
{
    public static IEndpointRouteBuilder MapTokenInspect(this IEndpointRouteBuilder app)
    {
        var opts = app.ServiceProvider.GetRequiredService<IOptions<TokenInspectOptions>>().Value;
        if (!opts.Enabled) return app; // closed door

        app.MapGet("/internal/trace", async (HttpContext ctx, ITraceStore store, IOptions<TokenInspectOptions> o, CancellationToken ct) =>
        {
            var options = o.Value;
            var sessionId = ctx.Request.Headers[options.SessionIdHeader].ToString();
            if (string.IsNullOrEmpty(sessionId)) return Results.Unauthorized();
            // PRINCIPAL-DERIVED ownership: host delegate must explicitly authorize THIS principal for THIS session.
            // Default delegate returns false; header alone NEVER grants access.
            if (!options.Authorize(ctx, sessionId)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var journal = await store.GetJournalAsync(sessionId, ct);
            return Results.Ok(new { sessionId, runs = journal });
        }).WithTags("token-inspect");
        return app;
    }
}
```

- [ ] **Step 3: Verificar** — `dotnet test backend/packages/TokenInspect.Tests` → PASS.

### Task 1.3 — Host (BFF) fornece o delegate ownership-of-session

**Files:**
- Create: `backend/session/Infrastructure/SessionContextAuthorize.cs`
- Modify: `backend/session/Program.cs` (wire AddTokenInspect)
- Modify: `backend/api-bff/Infrastructure/InspectEndpoints.cs` (já resolve a sessão via cookie; assegurar que `X-Session-Id` enviado ao SM corresponde ao cookie-resolved)

- [ ] **Step 1: Delegate ownership** (no `session`, que é onde `MapTokenInspect` corre)
```csharp
// SessionContextAuthorize.cs
using Microsoft.AspNetCore.Http;
namespace KCaaIdP.Session.Infrastructure;

public static class SessionContextAuthorize
{
    /// <summary>
    /// Authorize delegate for TokenInspectOptions.Authorize.
    /// Allows access ONLY when the caller's cookie-resolved session id matches the one
    /// being requested. The cookie is read server-side (HttpOnly) — header X-Session-Id
    /// is the request input but ownership is asserted against the cookie.
    /// </summary>
    public static bool Allow(HttpContext ctx, string requestedSessionId, string cookieName)
    {
        if (!ctx.Request.Cookies.TryGetValue(cookieName, out var ownSessionId)) return false;
        if (string.IsNullOrEmpty(ownSessionId)) return false;
        return string.Equals(ownSessionId, requestedSessionId, StringComparison.Ordinal);
    }
}
```

- [ ] **Step 2: Wire em `Program.cs`**
```csharp
builder.Services.AddTokenInspect(o =>
{
    o.Enabled = builder.Configuration.GetValue("TokenInspect:Enabled", false);
    o.Authorize = (ctx, requestedSid) =>
        SessionContextAuthorize.Allow(ctx, requestedSid, cookieName: builder.Configuration["Session:CookieName"] ?? "kcaaidp.sid");
});
```

- [ ] **Step 3: Smoke + curl manual** — `scripts/smoke-test.ps1` → 31/31. `curl -H "X-Session-Id: outra-sessao" http://session:8080/internal/trace` (do api-bff) → **403**. `GET /api/customer/inspect` autenticado → 200.

- [ ] **Step 4: COMMIT da Etapa 1**
```bash
git add backend/packages/TokenInspect backend/packages/TokenInspect.Tests backend/session backend/api-bff
git commit -m "fix(token-inspect): ACL sem header-trust — Authorize delegate default-deny no pacote; host wiring principal-derived"
```

---

## Etapa 2 — `@token-inspect/core` (extração + schema extensions)

**Resultado verificável:** novo pacote `@token-inspect/core` (TS) compila e testes vitest passam. Schema com campos novos (`correlationId`, `source`, `seq`, `sessionId?` opcional). `TraceSource` + impls `Http`/`Live`/`Composite`. `decodeJwt`/`shortPreview` migrados.

> Pode correr em paralelo com a Etapa 4.

### Task 2.1 — Scaffold do pacote + schema extendido

**Files:**
- Create: `frontend/packages/token-inspect-core/package.json`, `tsconfig.json`, `src/index.ts`, `src/schema.ts`
- Create: `frontend/packages/token-inspect-core/src/__tests__/schema.test.ts`

- [ ] **Step 1: package.json**
```json
{
  "name": "@token-inspect/core",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "devDependencies": { "vitest": "^2.0.0", "typescript": "^5.4.0" }
}
```

- [ ] **Step 2: schema.ts (com campos novos)**
```ts
export type VariableKind = "Jwt" | "Opaque" | "Code" | "Url" | "Hash" | "Plain" | "Json";
export type FlowStatus = "Running" | "Completed" | "Failed";
export type TraceOrigin = "client" | "server" | "bff" | "merged";

export interface TraceVariable { name: string; kind: VariableKind; value: string; redacted?: boolean; }
export interface TraceStep {
  ordinal: number; label: string; short?: string | null;
  from: string; to: string; timestamp: string; vars: TraceVariable[]; note?: string | null;
  source?: Exclude<TraceOrigin, "merged">; seq?: number;   // LOGICAL ordinal per source
}
export interface FlowRun {
  id: string; flowKind: string; title: string; status: FlowStatus;
  startedAt: string; endedAt?: string | null; error?: string | null;
  participants: string[]; steps: TraceStep[];
  correlationId?: string; source?: TraceOrigin;
}
export interface TraceJournal { sessionId?: string; runs: FlowRun[]; }
```

- [ ] **Step 3: Teste round-trip** — `JSON.stringify` + `JSON.parse` de um `FlowRun` com `correlationId`/`source`/`seq` preserva todos os campos.

### Task 2.2 — `TraceSource` + impls Http/Live

**Files:** Create `src/TraceSource.ts`, `src/HttpTraceSource.ts`, `src/LiveTraceSource.ts` + testes.

- [ ] **Step 1: `TraceSource.ts`**
```ts
import type { TraceJournal } from "./schema";
export interface TraceSource {
  getJournal(): TraceJournal | Promise<TraceJournal>;
  subscribe(cb: (j: TraceJournal) => void): () => void;
}
```

- [ ] **Step 2: `HttpTraceSource.ts`** — polling parametrizável (default 4000ms quando `subscribe` está ativo); `getJournal()` chama `client.get(endpoint)`; `subscribe` cria interval e devolve unsub que faz `clearInterval`. Mantém estado da última `TraceJournal` para devolver em `getJournal` síncrono se cacheada.
```ts
import type { TraceJournal } from "./schema";
import type { TraceSource } from "./TraceSource";

export interface HttpClient { get<T = TraceJournal>(path: string): Promise<T>; }

export class HttpTraceSource implements TraceSource {
  private cache: TraceJournal = { runs: [] };
  constructor(private client: HttpClient, private endpoint: string, private refreshMs = 4000) {}
  async getJournal(): Promise<TraceJournal> { const j = await this.client.get<TraceJournal>(this.endpoint); this.cache = j; return j; }
  subscribe(cb: (j: TraceJournal) => void): () => void {
    let stopped = false;
    const tick = async () => { try { const j = await this.getJournal(); if (!stopped) cb(j); } catch { /* swallow */ } };
    void tick();
    const id = setInterval(tick, this.refreshMs);
    return () => { stopped = true; clearInterval(id); };
  }
}
```

- [ ] **Step 3: `LiveTraceSource.ts`** — store em memória com `setJournal`/`patchRun` API. `subscribe` regista callback; emite a cada mutação. Usada pelo ClientObserver.
```ts
import type { FlowRun, TraceJournal } from "./schema";
import type { TraceSource } from "./TraceSource";

export class LiveTraceSource implements TraceSource {
  private journal: TraceJournal = { runs: [] };
  private subs = new Set<(j: TraceJournal) => void>();
  getJournal() { return this.journal; }
  subscribe(cb: (j: TraceJournal) => void) { this.subs.add(cb); cb(this.journal); return () => { this.subs.delete(cb); }; }
  upsertRun(run: FlowRun) {
    const idx = this.journal.runs.findIndex(r => r.id === run.id);
    if (idx >= 0) this.journal.runs[idx] = run; else this.journal.runs.push(run);
    this.emit();
  }
  private emit() { this.subs.forEach(cb => { try { cb(this.journal); } catch { /* swallow */ } }); }
}
```

- [ ] **Step 4: Teste de subscribe/emit** — `LiveTraceSource.upsertRun(r1)` → callback recebido com runs=[r1]; segundo upsert mesmo id → atualiza, não duplica; unsub para de receber.

### Task 2.3 — `CompositeTraceSource` (merge lógico, 1+1 hop)

**Files:** Create `src/CompositeTraceSource.ts` + testes.

- [ ] **Step 1: Teste de merge lógico**
```ts
// Dado: client emite run { correlationId:"c1", source:"client", steps:[ {seq:1,label:"A"}, {seq:2,label:"B"} ] }
//       server emite run { correlationId:"c1", source:"server", steps:[ {seq:1,label:"X"}, {seq:2,label:"Y"} ] }
// Merge: 1 run source:"merged" com 4 steps ordenados por (source ordem c→s) + seq → [A, B, X, Y]
// Cada step preserva o seu source.
// runs com correlationId distintos NÃO fundem.
// fan-out detetado quando >2 fontes para o mesmo correlationId → flag fanOut=true no run (didactic warning).
```

- [ ] **Step 2: Implementação** — `CompositeTraceSource(sources: TraceSource[])`: subscribe a todas; mantém um `Map<correlationId, FlowRun[]>`; emite o journal merged. Função `mergeByCorrelation(runs: FlowRun[]): FlowRun[]` faz o merge lógico. Em runs sem `correlationId`, mantêm-se independentes.

### Task 2.4 — `decode.ts` migrado + COMMIT

- [ ] **Step 1: Migrar `decodeJwt` + `shortPreview` de `@token-inspect/react/src/decode.ts`** para `@token-inspect/core/src/decode.ts` (mesma implementação; testes passam idênticos).

- [ ] **Step 2: `src/index.ts`** exporta tudo: schema types, `TraceSource`, `HttpTraceSource`, `LiveTraceSource`, `CompositeTraceSource`, `decodeJwt`, `shortPreview`.

- [ ] **Step 3: Verificar** — `npm --prefix frontend/packages/token-inspect-core test` → PASS.

- [ ] **Step 4: COMMIT da Etapa 2**
```bash
git add frontend/packages/token-inspect-core
git commit -m "feat(token-inspect): @token-inspect/core — schema extensions + TraceSource (Http/Live/Composite) + decode"
```

---

## Etapa 3 — Refator `@token-inspect/react` para consumir `TraceSource`

**Resultado verificável:** `<TokenInspectPanel>` aceita `source: TraceSource` (mantém shim de BWC para `client`/`endpoint`). Testes existentes adaptados, 15+ verdes. 3 portais compilam.

### Task 3.1 — Refator do painel + hook

**Files:** Modify: `frontend/packages/token-inspect/src/{TokenInspectPanel.tsx, useTokenInspect.ts, trace-schema.ts}`; ajustar `package.json` para depender de `@token-inspect/core` via workspace.

- [ ] **Step 1: `trace-schema.ts` re-exporta de `@token-inspect/core`** (zero alterações nos tipos visíveis, só a fonte muda):
```ts
export * from "@token-inspect/core";
```

- [ ] **Step 2: `useTokenInspect.ts` aceita `TraceSource`**
```ts
import { useEffect, useState } from "react";
import type { FlowRun, TraceJournal, TraceSource } from "@token-inspect/core";

export interface UseTokenInspectOptions { source: TraceSource; open: boolean; }
export interface UseTokenInspectResult { runs: FlowRun[]; loading: boolean; error: string | null; refresh: () => void; }

export function useTokenInspect({ source, open }: UseTokenInspectOptions): UseTokenInspectResult {
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setLoading(true); setError(null);
    const unsub = source.subscribe((j: TraceJournal) => { setRuns(j.runs); setLoading(false); });
    return unsub;
  }, [open, source]);
  return { runs, loading, error, refresh: () => Promise.resolve(source.getJournal()).then(j => setRuns(j.runs)) };
}
```

- [ ] **Step 3: `TokenInspectPanel.tsx` — novas props + shim BWC**
```ts
export interface TokenInspectPanelProps {
  source?: TraceSource;
  // BWC (deprecated): equivalente a source = new HttpTraceSource(client, endpoint)
  client?: { get: (path: string) => Promise<TraceJournal> };
  endpoint?: string;
  app?: string;
}
// Resolver `effectiveSource`: source ?? new HttpTraceSource(client!, endpoint!).
// Memoizar para não recriar a cada render.
```

- [ ] **Step 4: Atualizar testes** (TokenInspectPanel.test.tsx) — usar um fake `TraceSource` síncrono em vez de mock `client.get`. Manter as 5 asserções existentes (toggle, heading, flowKind text, decode, reveal). Testar também o shim BWC com client.get continua a passar.

- [ ] **Step 5: Verificar** — `npm --prefix frontend/packages/token-inspect test` → todos PASS.

### Task 3.2 — AppShell e portais usam o shim (zero alterações até Etapa 5)

**Files:** Modify (zero-line se possível): `frontend/shared/src/components/AppShell.tsx` — continua a passar `client`+`endpoint`; o shim cria `HttpTraceSource` internamente. **Não tocar nos portais.**

- [ ] **Step 1: Verificar build dos 3 portais** — `npm run build` em customer/partner/ops, todos verdes (verificação de não-regressão visual).

- [ ] **Step 2: COMMIT da Etapa 3**
```bash
git add frontend/packages/token-inspect
git commit -m "refactor(token-inspect): painel consome TraceSource (shim BWC client/endpoint preservado)"
```

---

## Etapa 4 — .NET schema parity (Short, Seq, Source, CorrelationId)

**Resultado verificável:** os records .NET ganham os campos novos; serialização JSON usa `JsonStringEnumConverter` para `source` casar com a forma TS (string lowercase). Tests `backend/packages/TokenInspect.Tests` passam.

> Pode correr em paralelo com a Etapa 2.

### Task 4.1 — Records + recorder

**Files:** Modify: `backend/packages/TokenInspect/Model/TraceStep.cs`, `Model/FlowRun.cs`, `IFlowRecorder.cs`, `FlowRecorder.cs`, `NullFlowRecorder.cs`

- [ ] **Step 1: TraceStep + FlowRun**
```csharp
public sealed record TraceStep(
    int Ordinal, string Label, string From, string To,
    DateTimeOffset Timestamp, IReadOnlyList<TraceVariable> Vars,
    string? Note = null, string? Short = null, int? Seq = null, string? Source = null);

public sealed class FlowRun {
    // ...existing fields...
    public string? CorrelationId { get; init; }
    public string? Source { get; init; }   // "client"|"server"|"bff"|"merged"
}
```

- [ ] **Step 2: `IFlowRecorder.Step` ganha `shortLabel`** (não-quebrável, último param)
```csharp
void Step(FlowRun run, string label, string from, string to,
          IReadOnlyList<TraceVariable> vars, string? note = null, string? shortLabel = null);
```
`FlowRecorder.Step` passa `shortLabel` para `TraceStep.Short` e auto-incrementa `Seq` por `Source` do run. `NullFlowRecorder` aceita o novo param e é no-op.

- [ ] **Step 3: Serialização JsonStringEnumConverter** — no endpoint `/internal/trace` e no `RedisTraceStore` (já existe; assegurar).

- [ ] **Step 4: Atualizar a instrumentação do host** — `AuthEndpoints.cs` passa shorts: `"PKCE"`, `"Redirect"`, `"Auth Code"`, `"Exchange"`, `"Tokens"`, `"Session"` nas chamadas `Step(...)`. Idem para `token.exchange` (`"Request"`, `"Token"`) e `auth.refresh`. `FlowRun.Source = "bff"`.

- [ ] **Step 5: Verificar** — `dotnet test backend/packages/TokenInspect.Tests` + `backend/session.Tests` → PASS.

- [ ] **Step 6: COMMIT da Etapa 4**
```bash
git add backend/packages/TokenInspect backend/packages/TokenInspect.Tests backend/session
git commit -m "feat(token-inspect): .NET schema parity (Short, Seq, Source, CorrelationId) + shorts no host"
```

---

## Etapa 5 — `@token-inspect/browser` — skeleton inert + UMD self-mount

**Resultado verificável:** novo pacote `@token-inspect/browser` compila e expõe `window.TokenInspect.init(config)` / `teardown()`. Com `enabled:false` (default), `init` é no-op total: `window.fetch === original`, nada é montado. Com `enabled:true` monta o painel React num Shadow DOM (vazio de adaptadores ainda).

### Task 5.1 — Scaffold + build UMD

**Files:** Create `frontend/packages/token-inspect-browser/{package.json, tsconfig.json, vite.config.ts, src/index.ts, src/config.ts, src/install.ts}` + test setup vitest+jsdom.

- [ ] **Step 1: package.json + vite.config (lib UMD)**
```json
// package.json
{
  "name": "@token-inspect/browser", "version": "0.1.0", "type": "module",
  "main": "dist/token-inspect.umd.cjs", "module": "dist/token-inspect.es.js",
  "scripts": { "build": "vite build", "test": "vitest run" },
  "dependencies": { "@token-inspect/core": "*", "@token-inspect/react": "*", "react": "^18", "react-dom": "^18" }
}
```
```ts
// vite.config.ts — lib mode UMD + ESM, single file, integrate React in the bundle.
export default { build: {
  lib: { entry: 'src/index.ts', name: 'TokenInspect', fileName: f => `token-inspect.${f}.${f==='umd'?'cjs':'js'}`, formats: ['umd','es'] },
  rollupOptions: { /* React/ReactDOM BUNDLED (no externals) for true drop-in */ }
}};
```

- [ ] **Step 2: `config.ts` — types (mirror da spec §6) + `defaultConfig` 100% inerte**
```ts
export interface TokenInspectConfig {
  enabled: boolean;                                       // master, default false
  ackExposesTokens: boolean;                              // required to enable in prod (host policy)
  capabilities: {
    clientObserver: boolean;                              // default false
    storageScan: boolean;                                 // default false
    correlation: { enabled: boolean; header: string; allowlist: string[] };  // header "traceparent"; allowlist ["self"]
  };
  idp?: { issuer?: string };
  apis?: Array<{ match: string; lane: string }>;
  redaction: "didactic" | "mask";
  mount: { dock: "bottom" | "right" | "left"; shadowDom: boolean };
  egress?: { endpoint: string };                           // fixed at load (frozen)
  preset?: "public-client-spa" | "bff-sessionmanager" | "api-validates-token";
}
export const defaultConfig: TokenInspectConfig = {
  enabled: false, ackExposesTokens: false,
  capabilities: { clientObserver: false, storageScan: false, correlation: { enabled: false, header: "traceparent", allowlist: ["self"] } },
  redaction: "didactic", mount: { dock: "bottom", shadowDom: true }
};
```

- [ ] **Step 3: `install.ts` — self-mount + teardown**
```ts
// installPanel(config, source): cria um div top-level, attachShadow({mode:"closed"}),
// monta dentro um React root renderizando <TokenInspectPanel source={source} app={config?.preset}/>.
// Retorna teardown() que React-unmounta e remove o div + restaura body.style padding.
// Se config.mount.shadowDom === false (debug), monta em document.body sem Shadow DOM.
```

- [ ] **Step 4: `index.ts` — entry point**
```ts
import { defaultConfig, type TokenInspectConfig } from "./config";
import { LiveTraceSource } from "@token-inspect/core";
import { installPanel } from "./install";

let teardownFn: (() => void) | null = null;
let liveSource: LiveTraceSource | null = null;
let frozenConfig: Readonly<TokenInspectConfig> | null = null;   // anti-runtime-mutation

export function init(userConfig: Partial<TokenInspectConfig>): void {
  if (teardownFn) return;                                       // idempotent
  const cfg: TokenInspectConfig = { ...defaultConfig, ...userConfig };
  if (!cfg.enabled) return;                                     // INERT
  // (Etapa 11) Prod hard-stop: refuse if window.location.host suggests prod and !cfg.ackExposesTokens
  frozenConfig = Object.freeze({ ...cfg });
  liveSource = new LiveTraceSource();
  teardownFn = installPanel(frozenConfig, liveSource);
  // (Etapa 6+) when capabilities.clientObserver → install observer; capabilities.correlation.enabled → start injection
}

export function teardown(): void { try { teardownFn?.(); } finally { teardownFn = null; liveSource = null; frozenConfig = null; } }

// Standalone-bundle entry: expose on window
if (typeof window !== "undefined") (window as any).TokenInspect = { init, teardown };
```

### Task 5.2 — Inertness + mount tests (jsdom)

**Files:** Create `src/__tests__/{inert.test.ts, mount.test.tsx}`.

- [ ] **Step 1: Teste inertness**
```ts
import { init, teardown } from "../index";
import { test, expect } from "vitest";
test("inert by default", () => {
  const originalFetch = window.fetch;
  init({});                                  // no config: all defaults → enabled:false
  expect(window.fetch).toBe(originalFetch);  // NO patching
  expect(document.querySelector("[data-ti-root]")).toBeNull();  // NO mount
  teardown();
});
test("inert when capabilities off even if enabled:true", () => {
  const originalFetch = window.fetch;
  init({ enabled: true });                    // panel may mount, but observer off
  expect(window.fetch).toBe(originalFetch);   // observer didn't patch
  teardown();
});
```

- [ ] **Step 2: Teste mount** — `init({ enabled:true })` cria um host element no document; teardown remove-o; chamar init duas vezes é idempotente.

- [ ] **Step 3: Verificar** — `npm --prefix frontend/packages/token-inspect-browser test` → PASS.

- [ ] **Step 4: COMMIT da Etapa 5**
```bash
git add frontend/packages/token-inspect-browser
git commit -m "feat(token-inspect): @token-inspect/browser — skeleton inert + UMD self-mount Shadow DOM"
```

---

## Etapa 6 — ClientObserver: wrap `fetch`/XHR + auth.login (PKCE) + api.call

**Resultado verificável:** com `capabilities.clientObserver:true`, simular no jsdom (a) um redirect-callback PKCE + um POST ao token endpoint e (b) uma chamada de API com Bearer → o `LiveTraceSource` ganha um `auth.login` + um `api.call` corretamente formados, e `window.fetch` continua passthrough (uma exceção forçada na instrumentação não quebra a chamada).

### Task 6.1 — Wrap reversível de `fetch`/XHR (pass-through)

**Files:** Create `src/observer/{fetch.ts, xhr.ts}` + testes.

- [ ] **Step 1: `fetch.ts` — pass-through, instrumentação em try/catch**
```ts
export function installFetchWrap(onEvent: (e: NetEvent) => void): () => void {
  const original = window.fetch;
  if ((original as any).__tokenInspectWrapped) return () => {};   // refuse double-wrap
  const wrapped = async function (this: any, input: RequestInfo | URL, init?: RequestInit) {
    const promise = original.call(this, input, init);             // host call FIRST, untouched
    try {
      const req = normalizeRequest(input, init);
      promise.then(res => { try { onEvent({ kind: "fetch", req, res: cloneMeta(res) }); } catch { /* swallow */ } },
                   () => { /* swallow rejection in instrumentation */ });
    } catch { /* swallow */ }
    return promise;
  };
  (wrapped as any).__tokenInspectWrapped = true;
  window.fetch = wrapped as typeof fetch;
  return () => { if (window.fetch === wrapped) window.fetch = original; };
}
```
> `cloneMeta(res)` extrai status/headers SEM consumir `res.body` (clones somente metadados; o body do host fica intacto).

- [ ] **Step 2: `xhr.ts`** — wrap análogo de `XMLHttpRequest.prototype.{open, setRequestHeader, send}`, com referências originais e teardown reversível.

- [ ] **Step 3: Testes (jsdom)**
```ts
test("fetch pass-through preserves response", async () => {
  const stop = installFetchWrap(() => {});
  // mock original fetch first
  const r = await fetch("/x");                // must resolve normally
  expect(r).toBeDefined(); stop();
});
test("instrumentation throw does NOT break host call", async () => {
  const stop = installFetchWrap(() => { throw new Error("bad observer"); });
  await expect(fetch("/x")).resolves.toBeDefined();   // host still gets the response
  stop();
});
test("teardown restores original", () => {
  const orig = window.fetch;
  const stop = installFetchWrap(() => {});
  stop();
  expect(window.fetch).toBe(orig);
});
```

### Task 6.2 — Reconstrução de `auth.login` (code+PKCE) e `api.call`

**Files:** Create `src/observer/{idp.ts, redirect.ts, reconstruct.ts}` + testes.

- [ ] **Step 1: `idp.ts` — recognize KC token endpoint** — heurística: URL contém `/protocol/openid-connect/token` OU casa `config.idp.issuer`; opcional discovery via `.well-known/openid-configuration`.

- [ ] **Step 2: `redirect.ts` — lê `?code&state` ou `#access_token=`** de `window.location` no init e em `popstate`/`hashchange`; emite eventos `redirect-callback`.

- [ ] **Step 3: `reconstruct.ts` — máquina de estados por `state`**
```ts
// 1) state observed in storage (or in authorize redirect) → BeginRun auth.login, correlationId=state
//    Step "Generated PKCE pair" (vars: code_verifier from sessionStorage if visible, code_challenge inferred, state)
// 2) redirect callback with ?code → Step "Authorization code received" (code)
// 3) POST to token endpoint with grant_type=authorization_code → Step "Exchange code for tokens" (req body sanitized)
// 4) token response → Step "Tokens received" (jwt vars), then Step "Storage write" if observed
// 5) Complete run.
// For api.call: every fetch/XHR to non-IdP host carrying Authorization: Bearer → BeginRun api.call
//   Steps: "Request" (method, url), "Response" (status), decoded claims as vars.
```

- [ ] **Step 4: Teste end-to-end no jsdom**
```ts
test("PKCE flow reconstruction", () => {
  const live = new LiveTraceSource();
  const stop = installObserver(live, { idp: { issuer: "https://idp" } });
  sessionStorage.setItem("oidc.code_verifier", "abc...");
  // simulate authorize-redirect callback
  history.pushState({}, "", "/cb?code=XYZ&state=S1");
  window.dispatchEvent(new PopStateEvent("popstate"));
  // simulate token POST
  // ...
  const runs = live.getJournal().runs;
  expect(runs.find(r => r.flowKind === "auth.login" && r.correlationId === "S1")).toBeTruthy();
  stop();
});
```

- [ ] **Step 5: Wire em `index.ts`** — quando `capabilities.clientObserver:true`, instalar `installFetchWrap`+`installXhrWrap`+`installRedirect` e cablar no `reconstruct`.

- [ ] **Step 6: COMMIT da Etapa 6**
```bash
git add frontend/packages/token-inspect-browser
git commit -m "feat(token-inspect): client observer — fetch/XHR wrap + auth.login (PKCE) + api.call"
```

---

## Etapa 7 — Correlation: `traceparent` same-origin (opt-in)

**Resultado verificável:** com `correlation.enabled:true` e `allowlist:["self"]`, chamadas de API same-origin recebem `traceparent`; chamadas cross-origin NÃO recebem; com `allowlist:["self","api.example.com"]`, esse host também recebe; com `correlation.enabled:false` (default), zero injeção.

### Task 7.1 — `correlation.ts`

**Files:** Create `src/observer/correlation.ts` + testes.

- [ ] **Step 1: Geração + injeção**
```ts
// generateTraceparent(): "00-" + 32hex(traceId) + "-" + 16hex(spanId) + "-01"  (W3C)
// shouldInject(url, allowlist): same-origin (URL.origin === location.origin) || allowlist.includes(host)
//   allowlist value "self" === same-origin; explicit hosts otherwise; wildcards NOT permitted.
// injectHeader(init, name, value): clone init.headers, set if absent (don't overwrite host's header).
```

- [ ] **Step 2: Testes**
```ts
test("same-origin gets traceparent when enabled", () => { /* ... */ });
test("cross-origin does NOT get traceparent", () => { /* ... */ });
test("disabled → no header anywhere", () => { /* ... */ });
test("allowlist explicit host gets header", () => { /* ... */ });
test("never overrides a header the host already set", () => { /* ... */ });
test("header NAME is configurable; defaults to 'traceparent'; refuses names starting with x-token-inspect (case-insensitive)", () => { /* ... */ });
```

- [ ] **Step 3: COMMIT da Etapa 7**
```bash
git add frontend/packages/token-inspect-browser
git commit -m "feat(token-inspect): correlation traceparent same-origin allowlist (opt-in, default off)"
```

---

## Etapa 8 — Outros flows (implicit / ROPC / refresh)

**Resultado verificável:** o observer reconstrói `auth.implicit` (token no fragmento), `auth.ropc` (POST token grant_type=password) e `auth.refresh` (POST grant_type=refresh_token). Testes jsdom para cada.

### Task 8.1 — Implementação + testes

**Files:** Modify: `src/observer/reconstruct.ts`; add `src/__tests__/flows.test.ts`.

- [ ] **Step 1: Implicit** — `window.location.hash` com `#access_token=...` no callback → BeginRun `auth.implicit`, Step "Token in fragment" (Jwt var) + Step "Storage write" se observado. Complete.
- [ ] **Step 2: ROPC** — POST ao token endpoint com `grant_type=password` → BeginRun `auth.ropc`, Step "Password grant request" (sanitized — username sim, password REDACTED por defeito), Step "Tokens received". Complete.
- [ ] **Step 3: Refresh** — POST ao token endpoint com `grant_type=refresh_token` → BeginRun `auth.refresh`, Step "Refresh grant", Step "New tokens (rotated)". Complete.
- [ ] **Step 4: Verificar** — `npm test` → PASS.
- [ ] **Step 5: COMMIT da Etapa 8**
```bash
git add frontend/packages/token-inspect-browser
git commit -m "feat(token-inspect): observer cobre auth.implicit, auth.ropc, auth.refresh"
```

---

## Etapa 9 — `TokenInspect.AspNetCore` middleware drop-in

**Resultado verificável:** novo projeto .NET `TokenInspect.AspNetCore` compila e testes xUnit verdes. `app.UseTokenInspect()` num projecto exemplo grava: token recebido, claims decodificadas, decisão RBAC, chamadas downstream (via DelegatingHandler). Endpoint dev `GET /__ti/trace?id=` (path configurável) flag-gated + loopback por defeito + Authorize delegate principal-derived + hard-stop em Production sem `AckExposesTokens`.

### Task 9.1 — Scaffold + ring buffer + middleware

**Files:** Create `backend/packages/TokenInspect.AspNetCore/*` + tests `backend/packages/TokenInspect.AspNetCore.Tests/*`.

- [ ] **Step 1: `AspNetCoreOptions`**
```csharp
public sealed class AspNetCoreOptions {
    public bool Enabled { get; set; } = false;
    public bool AckExposesTokens { get; set; } = false;
    public string EndpointPath { get; set; } = "/__ti/trace";       // configurable/obscure
    public bool LoopbackOnly { get; set; } = true;
    public string CorrelationHeader { get; set; } = "traceparent";  // anonymized default
    public int RingCapacity { get; set; } = 256;
    public TimeSpan Ttl { get; set; } = TimeSpan.FromMinutes(15);
    /// <summary>Default: deny. Host wires principal-derived check.</summary>
    public Func<HttpContext, string, bool> Authorize { get; set; } = (_, _) => false;
}
```

- [ ] **Step 2: `RingBuffer<T>`** — bounded list com TTL eviction; thread-safe; teste.

- [ ] **Step 3: `TokenInspectMiddleware`**
```csharp
public sealed class TokenInspectMiddleware(RequestDelegate next, IOptions<AspNetCoreOptions> opts, RingBuffer<FlowRun> ring) {
    public async Task InvokeAsync(HttpContext ctx) {
        var o = opts.Value;
        if (!o.Enabled) { await next(ctx); return; }
        var corr = ValidateOrGenerate(ctx.Request.Headers[o.CorrelationHeader].ToString());
        var run = NewRun("api.server", "API hop", new[] { "API","RBAC","Core","DB" }, corr, "server");
        try {
            // Step: incoming token (claims) — read principal AFTER auth has run downstream;
            // we wrap a post-action recorder by registering OnStarting / using HttpContext.Items.
            ctx.Items["__ti_run"] = run;
            await next(ctx);
            run.Status = FlowStatus.Completed;
        } catch (Exception ex) { run.Status = FlowStatus.Failed; run.Error = ex.Message; throw; }
        finally { try { ring.Append(run); } catch { /* swallow */ } }
    }
}
```

- [ ] **Step 4: `DownstreamHandler : DelegatingHandler`** — para `HttpClient`s registados; adiciona Step "Downstream call" + Step "Response" no run corrente do contexto. Nunca altera a request.

- [ ] **Step 5: `DevEndpoints.MapTokenInspectDev(opts)`** — só mapeia se `Enabled`; em `IHostEnvironment.IsProduction()` aborta a menos que `AckExposesTokens=true` e regista warning ruidoso no startup; opcionalmente filtra IP por loopback. Endpoint: lê `id` da query, chama `opts.Authorize(ctx, id)` (default false), devolve runs do ring com esse `correlationId`. Anonimizado.

- [ ] **Step 6: Testes** — TestServer:
  - Enabled=false → middleware NO-OP, sem ring writes, endpoint 404.
  - Enabled=true, Production env, sem Ack → endpoint não mapeado.
  - Enabled=true + Ack=true → endpoint responde mas com `Authorize` default → **403**.
  - Authorize custom devolve true → 200 com runs do `correlationId`.
  - Header corrompido (`bad\r\ninjection`) → rejeitado/sanitizado, não vai para o ring key.

### Task 9.2 — COMMIT
```bash
git add backend/packages/TokenInspect.AspNetCore backend/packages/TokenInspect.AspNetCore.Tests
git commit -m "feat(token-inspect): TokenInspect.AspNetCore — middleware drop-in (principal-derived ACL, ring+TTL, dev endpoint flag/loopback/ack)"
```

---

## Etapa 10 — Config + presets + auto-detect

**Resultado verificável:** os 3 presets aplicam defaults sãos e podem ser override; auto-detect funciona dentro de cada capacidade ativa.

### Task 10.1 — Presets + auto-detect

**Files:** Create `frontend/packages/token-inspect-browser/src/presets.ts`, `src/observer/autodetect.ts` + testes.

- [ ] **Step 1: `presets.ts`**
```ts
export const presets = {
  "public-client-spa": (cfg) => deepMerge(cfg, { capabilities: { clientObserver: true, storageScan: true, correlation: { enabled: false } } }),
  "bff-sessionmanager": (cfg) => deepMerge(cfg, { capabilities: { clientObserver: false } }),  // panel only, server records
  "api-validates-token": (cfg) => deepMerge(cfg, { capabilities: { clientObserver: true, correlation: { enabled: true, allowlist: ["self"] } } }),
};
```

- [ ] **Step 2: `autodetect.ts`** — utilitários: `findIdpFromTraffic`, `findTokensInStorage`, `labelLaneByHost`. **Não** liga capacidades sozinho; só refina dentro de capacidades ON.

- [ ] **Step 3: Testes** — preset aplica defaults e o utilizador faz override; com `clientObserver:false` o auto-detect NÃO patcha nada.

- [ ] **Step 4: COMMIT**
```bash
git add frontend/packages/token-inspect-browser
git commit -m "feat(token-inspect): config presets + auto-detect dentro de capacidades ON"
```

---

## Etapa 11 — Distribution + security hardening final

**Resultado verificável:** o bundle UMD é construído com SRI publicado no `dist/`; `egress.endpoint` congelado no load (mutar em runtime é rejeitado); prod hard-stop ativo; teardown self-test passa.

### Task 11.1 — Build UMD + SRI + frozen egress

**Files:** Modify: `vite.config.ts`; add `scripts/postbuild-sri.mjs`; `src/index.ts` (prod gate + frozen config + teardown self-test).

- [ ] **Step 1: SRI** — pós-build, gerar `dist/token-inspect.umd.cjs` + ficheiro `dist/integrity.json` com `sha384-...`. Documentar uso: `<script src="..." integrity="sha384-..." crossorigin="anonymous">`.

- [ ] **Step 2: Frozen egress** — em `init`, `Object.freeze(config.egress)` + capturar `const egressEndpoint = config.egress?.endpoint`. Qualquer pedido para mutar config após init é rejeitado (config é readonly).

- [ ] **Step 3: Prod hard-stop**
```ts
function looksLikeProd(): boolean {
  // Conservative heuristic: explicit override via config wins; else if window.location.hostname is not localhost/127.0.0.1/*.local AND no ?ti-dev=1, treat as prod.
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(h) || h.endsWith(".local")) return false;
  return !/[?&]ti-dev=1\b/.test(window.location.search);
}
// In init: if (looksLikeProd() && !cfg.ackExposesTokens) { console.warn("[TokenInspect] refusing to enable in prod without ackExposesTokens"); return; }
```

- [ ] **Step 4: Teardown self-test**
```ts
export function selfTest(): { fetchRestored: boolean; xhrRestored: boolean; noResidualListeners: boolean } { /* ... */ }
// Test asserts after teardown: window.fetch === origFetch, etc.
```

- [ ] **Step 5: Testes** — refusal em prod-like hostname sem ack; ack=true permite; egress não mutável; selfTest verde após teardown.

- [ ] **Step 6: COMMIT**
```bash
git add frontend/packages/token-inspect-browser
git commit -m "feat(token-inspect): distribuicao+hardening — SRI no build, egress frozen, prod hard-stop, teardown self-test"
```

---

## Etapa 12 — Aceitação + docs

**Resultado verificável:** as 9 ACs da spec passam; PoC intacta; capítulo 13 atualizado.

### Task 12.1 — Verificação dos 9 critérios da spec

- [ ] **AC1 (inerte por defeito):** teste e2e — `<script>` carregado, `init({})` chamado → `window.fetch === original`, nenhum painel no DOM.
- [ ] **AC2 (public-client SPA):** preset `public-client-spa` + login PKCE simulado num jsdom de portal stub → `auth.login` + `api.call` no `LiveTraceSource`.
- [ ] **AC3 (API valida token):** TestServer .NET com `UseTokenInspect()` + um portal stub com `correlation:enabled` → 1 `FlowRun` `source:"merged"` com steps de client e server.
- [ ] **AC4 (não quebra host):** wrappers throw → chamadas do host resolvem; cross-origin NÃO recebe header; chamadas simples não passam a sofrer preflight inesperado.
- [ ] **AC5 (ACL):** `curl -H "X-Session-Id: outra"` ao `/internal/trace` ou ao `/__ti/trace?id=...` sem cookie → **403**.
- [ ] **AC6 (prod fail-safe):** `Production` + `Enabled=true` sem `AckExposesTokens` → middleware NO-OP + endpoint não mapeado + warning no log.
- [ ] **AC7 (remoção limpa):** após `teardown()` + remoção do `<script>`, globais restaurados, listeners removidos, ring vazio (server).
- [ ] **AC8 (desacoplamento):** `grep -ri "keycloak\|redis\|StackExchange\|kcaaidp" backend/packages/TokenInspect*/ frontend/packages/token-inspect*/src/` → vazio.
- [ ] **AC9 (BFF mode intacto):** `scripts/smoke-test.ps1` → **31/31 PASS**.

### Task 12.2 — Capítulo 13 atualizado + CHANGELOG

**Files:** Modify: `docs/13-token-inspect-plugin.md`, `docs/README.md`, `CHANGELOG.md`.

- [ ] **Step 1:** reescrever §1–§4 do cap. 13 para o modelo "adaptadores por ponto de observação" + matriz de cenários + matriz de alterações Front/Back/KC.
- [ ] **Step 2:** adicionar §X "Adoptar em outro projeto" — passos com `<script>` + SRI + preset + ACK em prod.
- [ ] **Step 3:** §Y "Segurança e isolamento" alinhada com a §7 da spec.
- [ ] **Step 4:** CHANGELOG — entradas por feature.

- [ ] **Step 5: COMMIT da Etapa 12**
```bash
git add docs/13-token-inspect-plugin.md docs/README.md CHANGELOG.md
git commit -m "docs(token-inspect): capitulo 13 atualizado para o modelo agnostico + CHANGELOG"
```

---

## Self-review do plano (cobertura da spec)

- §1 princípios / matriz de adaptadores → §0 preâmbulo + Etapas 5/9. ✔
- §2 decisões → encarnado nas Etapas 2,3,4,5,7,9,10,11. ✔
- §3 TraceSource + pacotes → Etapas 2 e 3. ✔
- §4 schema extensions → Etapas 2 (TS) e 4 (.NET). ✔
- §5.1 ClientObserver → Etapas 5,6,8. ✔
- §5.2 ServerMiddleware → Etapa 9. ✔
- §5.3 fix ACL no existente → Etapa 1 (entregável SOZINHA). ✔
- §6 Config → Etapas 5 (types/defaults) e 10 (presets+autodetect). ✔
- §7 Segurança (1–8 + anon headers) → Etapas 1 (1), 11 (2/3/4), 9 (4/5), 5/10 (6), 7 (7), 2/4 (8). ✔
- §8 decoupling/remoção limpa → invariante + Etapas 5,11. ✔
- §9 fora de âmbito → respeitado (1+1 hop; sem spans aninhados; sem publish real). ✔
- §10 critérios de aceitação 1–9 → Etapa 12. ✔
