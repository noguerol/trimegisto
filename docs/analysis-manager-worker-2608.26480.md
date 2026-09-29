# Análisis: arXiv:2608.26480 → Trimegisto

**Paper:** *Zero-Shot Self-Orchestration with Ledger-Based Control for Improved LLM Coding Performance*
Victor Gao, Vida Khosrowshahi, Ali Khosrowshahi, Xihao Sun, Juhyun Lee, Simon (Sang Won) Lee — Persis Capital Inc. · arXiv:2608.26480v1 [cs.MA] · 27 ago 2026.

**Pregunta del usuario:** estudiar en profundidad el paper y evaluar las posibilidades de importar su arquitectura *manager–worker* a Trimegisto. Sin implementar nada.

---

## 0. Resumen ejecutivo (lo que importa para Trimegisto)

1. El paper **valida empíricamente la tesis de Trimegisto**, pero con un matiz que señala una carencia concreta: el andamiaje que gana es **un manager que itera** sobre un **ledger persistente en disco** (plan.md, tasks.json, notes.md, solution.py), no un orquestador que reparte un DAG fijo y reconcilia una vez.
2. Trimegisto hoy es un **orquestador de lotes (batches) estático y determinista**: un plan-graph calculado una sola vez, olas topológicas, una reconciliación. La parte que el paper mide como ganancia principal — *el manager re-cura la lista de tareas tras cada ronda y decide el siguiente paso* — **no existe** en Trimegisto.
3. La buena noticia: Trimegisto ya tiene **casi todas las piezas primitivas** (workspace por instancia, notas compartidas, read-registry, locks, dedup por similitud, gate de lanes, scheduler de olas, reconciliación determinista, control por agente). Importar el ledger y un modo "loop" es **más integración que invención**.
4. La ganancia del paper es **mayor justo en el régimen de Trimegisto**: modelos locales pequeños/medianos con gestión de contexto débil (Example-27B +23.4 puntos es el resultado estrella). Y el coste marginal de tokens con modelos locales (electricidad) hace que el "triple del bill" del paper importe mucho menos.
5. El punto filosófico: Trimegisto es *control freak, determinista, nada oculto*. El manager del paper es un bucle libre y no determinista que **regresa** en casos como Qwen3.6-35B (−9). La síntesis correcta no es copiar el manager libre, sino añadirlo como **proponente acotado** validado por el gate determinista existente.

---

## 1. El paper, en profundidad

### 1.1 Pregunta y método

Compara, **con el mismo modelo, mismo benchmark y misma temperatura de solver**, dos condiciones:
- **Single call**: una única llamada, sin herramientas, sin bucle.
- **Manager**: el mismo modelo repartido en roles (manager / worker / verifier / finalizer), cada rol en **contexto fresco**, coordinados **solo** por un workspace de ficheros compartido.

Es *zero-shot*: sin entrenamiento y sin ajuste por benchmark. Esto es clave para Trimegisto: no hay pesos nuevos, es pura orquestación en tiempo de inferencia.

Benchmark: LiveCodeBench release_v6, 100 problemas hard más recientes. Nueve modelos (Qwen3.5-9B, Qwen3.6-35B-A3B, Example-27B, Minimax-M3, Kimi-K3, Opus-5, GPT-5.6-Terra, GPT-5.6-Luna, Claude Fable 5).

### 1.2 La arquitectura real (scaffold v2, §3.1) — el corazón

**Estado = 5 ficheros en el workspace:**

| Fichero | Contenido |
|---|---|
| `<ws>/task.md` | enunciado del problema |
| `<ws>/plan.md` | plan general del manager |
| `<ws>/tasks.json` | `[{id, desc, status, result}]` |
| `<ws>/notes.md` | ideas, hallazgos, pruebas parciales |
| `<ws>/solution.py` | **mejor solución actual** |

**Control (6 pasos):**
1. **Manager – plan**: lee el problema, escribe estrategia de 3–6 frases + 3–6 tareas semilla. Temp 0.3.
2. **Worker – brainstorm (ideación)**: el primer worker *no* escribe código; identifica la dificultad central, enumera enfoques candidatos y trampas, y **lo añade a notes.md**, proponiendo siguientes pasos. Temp 0.4.
3. **Manager – manage (bucle)**: fusiona plan + brainstorm en una lista curada (merge de duplicados, marca hechos, añade solo sub-tareas genuinamente nuevas), y **o declara resuelto o nombra la ÚNICA siguiente tarea**. Temp 0.2.
4. **Worker – do the task**: un worker fresco ejecuta esa tarea, reescribe `solution.py`, añade lo hecho a `notes.md` y propone pasos restantes. Temp 0.2.
5. **Verifier – ejecuta los sample tests** (ausente en el scaffold original): si el worker produjo candidato nuevo, se **ejecuta** contra los tests públicos de ejemplo (cubren 73/100); el veredicto pass/fail, con el primer caso fallido, se realimenta al manager y **se trata como ground truth**: un fallo invalida el "done" y fuerza otra ronda.
6. **Finalizer**: un worker final emite la solución definitiva si el bucle termina sin un cierre limpio. **Se omite si el manager declaró done y ya hay solución usable** (para no sobrescribir una respuesta correcta).

**Guardas:** presupuesto de rondas `MAX_ITERS = 10`; guarda de no-progreso (si el manager reemite la misma tarea, para); **summarizer de truncamiento** (si un worker se corta por límite de tokens, una llamada corta resume su pensamiento parcial para que sus ideas lleguen al manager).

**Original vs v2:** el original corría el mismo bucle con `MAX_ITERS=4` y sin verifier, sin summarizer y con prompts de workspace sin acotar el tamaño.

### 1.3 Resultados principales

**Pinned backend, 128k, thinking ON, 5 pasadas (Tabla 1):**

| Modelo | Single | Manager | Δ |
|---|---|---|---|
| Claude Fable 5 | 87.4 ± 1.1 | — (single-only) | — |
| GPT-5.6-Terra | 77.0 ± 1.0 | 85.0 ± 1.0 | **+8.0** |
| GPT-5.6-Luna | 67.2 ± 4.3 | 77.8 ± 2.0 | **+10.6 ± 5.1** |
| Example-27B | 63.0 ± 4.1 | 86.4 ± 2.7 | **+23.4 ± 6.6** |

El manager también **reduce la varianza** (Luna 4.3→2.0 SD; Qwen 4.1→2.7 SD).

**Conjunto OpenRouter (scaffold original, §2.4):**
- Opus-5: 85 → **91** (+6), la mejor puntuación del estudio (1 pasada).
- Kimi-K3: 83 → 82 con thinking ON, pero **32 → 74 (+42)** con thinking OFF a 128k, y +30.4 a 16k×5 (p<2e-5).
- Minimax-M3: 60→66 ON; +11.0 OFF a 16k (p=6e-5).
- Qwen3.5-9B: inutilizable con thinking ON; +7.2 OFF a 16k (p=4e-4).
- **Qwen3.6-35B: 25→43 ON, pero 35→26 (−9) OFF a 128k y −1.2 n.s. a 16k → la regresión del paper.**

**Coste (Tabla 3):** el manager **~triplica la factura**:
- Example-27B: $20.44 → $51.75 (+153%)
- GPT-5.6-Luna: $0.41 → $1.50 (+266%)
- GPT-5.6-Terra: $3.41 → $11.71 (+244%)
- Fable 5 single: $61.11

Pero **es más barato que subir de modelo**: Terra+manager (85.0, $11.71) ≈ Fable 5 (87.4, $61.11), p=0.59 en precisión y p<1e-4 en coste. Y Luna+manager (77.8, $1.50) ≈ Terra single (77.0, $3.41) al 44% del precio.

### 1.4 Mecanismos (por qué gana) — §4

1. **Gestión de contexto / memoria externa.** El estado vive en disco (plan/tasks/notes), no en un transcript creciente. Cada worker ve una vista compacta y curada. Esto reduce longitud por llamada, evita truncamiento y evita el colapso de razonamiento: Example-27B single repitió una línea 7.743 veces y gastó 250k tokens sin emitir código; el manager lo evita porque cada llamada corta "llega al disco".
2. **Decomposición.** Separar objetivos acoplados en sub-DPs independientes (ejemplo Minimax-M3, LCB 3701).
3. **Plan en disco para modelos sin thinking.** Con reasoning OFF, el brainstorm-then-plan sobre disco sustituye la planificación interna ausente (Kimi +42, Minimax +12).
4. **Restar, no sumar.** En Terra/LCB 3688 el manager produjo una solución **2.5× más pequeña** y correcta donde el single había sobre-ingenierizado.
5. **Rescate de truncamiento.** De 35 celdas "sin código" de Qwen single, el manager pasó 25 → **+5.0 puntos**, ~1/5 del +23.4 total.

**Reglas empíricas:** la ganancia es **mayor cuanto más débil es el modelo sin andamiaje** (ordenado por single: +23.4, +10.6, +8.0) y **menor para modelos grandes con reasoning ON**.

### 1.5 Regresiones y límites

- **Puede deliberar hacia un plan peor** (LCB 3765: la ideación descartó la optimización correcta y eligió una O(n³) lenta y con bug).
- **Qwen3.6-35B con reasoning OFF** empeora: el código compacto y correcto se "perturba" más de lo que se ayuda.
- El manager **acepta al worker y las notas a valor nominal** (v2 solo hace sanity check con sample tests): un DP confiadamente erróneo se propaga.
- Dos remedios que el propio paper propone (training-free): **(a) fresh-perspective workers** — lanzar algunos workers con el problema crudo y sin contexto previo, para tener un intento independiente que comparar; **(b) verificación en lugar de confianza** — runner de tests generados / verificación formal antes de aceptar.
- Límites: un solo benchmark (programación competitiva); el set §2.4 es 1 pasada; confound de OpenRouter; Fable sin brazo manager; refusals contados como fallo.
- Marco teórico (Tran & Kiela): *Data Processing Inequality* → multi-agente gana cuando la **utilización de contexto de un solo agente se degrada** o cuando **se gasta más cómputo**. Los resultados del paper son consistentes con eso.

---

## 2. Qué es Trimegisto hoy (mapa preciso)

### 2.1 Modelo de ejecución

- El **modelo principal (main model) es el coordinador**. Llama a la tool `trimegisto` **una vez por lote**: `goal` + hasta 8 tareas, cada una con `tier`, `task`, `why`, `needs`, `writes`, `lane`, `cwd` (`src/index.ts`).
- **Plan-graph determinista y estático** (`src/plan-graph.ts` → `planBatch`): dedup intra-lote (similitud), dedup cross-llamada (registro 5 min), detección de duplicados, orden topológico en **olas** por `needs`, **serialización same-file** por `writes`, **capping por `maxParallel`** por tier, y clasificación de **lane**:
  - `closed` (irreversible: deploy, drop, force-push, credenciales) → **el lote entero se rechaza**;
  - `gated` (superficie ancha reversible: utils compartidos, API pública, config) → flagged pero se lanza;
  - `open` → normal.
- El **wave-scheduler** (`src/wave-scheduler.ts`) lanza **una ola a la vez**; la siguiente solo cuando la actual es terminal. El veredicto upstream (700 chars, `UPSTREAM_VERDICT_CHARS`) se **antepone** a la tarea dependiente.
- **Reconciliación determinista** (`src/reconcile.ts`): destila el veredicto de cada agente (`finalOutput` > último bloque > stderr), cuenta estados, detecta salidas duplicadas, y emite **UN** mensaje (`followUp` + `triggerTurn`) que da al modelo principal **exactamente un turno** de síntesis. Nunca hay polling.
- Deadline de lote: **30 min** por defecto (`TRIMEGISTO_BATCH_DEADLINE_MS`).

### 2.2 Workers

- Cada agente es un **proceso pi real, aislado y one-shot**: `pi --mode json -p --no-session --model <tier>` (con `--tools`, `--extension` del subagente, `--append-system-prompt <tmpfile>` y `Task: <task>`). Contexto fresco.
- Pueden **auto-spawnear** descendientes vía `trimegisto_spawn` (escriben requests IPC que procesa el proceso principal), con **cap de profundidad 5**.
- Control por agente: `steer` in-place (mailbox → `pi.sendUserMessage(..., {deliverAs:"followUp"})`), `compact` (reinicia con digest acotado head+tail 6 KB), `kill`.
- Watchdogs: primera respuesta (90 s), idle (120 s, suspendido durante compactación nativa), max runtime (off). Circuit breaker por modelo. Pools de modelos redundantes con failover.

### 2.3 Estado compartido (lo más cercano a un ledger)

- `src/shared-context.ts`: preamble inyectado en el system prompt de cada nuevo agente con
  - **ficheros ya leídos por otros agentes** (read-registry `file_read_track`), y
  - **hechos publicados** vía `trimegisto_note`.
  - Tope: **2400 chars** (40 ficheros, 12 notas).
- `file_lock` (advisory) + alertas de fichero obsoleto (si `t3a` reescribe algo que `t2b` leyó, se avisa a `t2b`).
- La **lista de tareas y sus estados viven en memoria** (`PendingBatch` / `batch.results`), **no en disco**, y los workers **no actualizan estado**.

---

## 3. Comparación componente a componente

| Componente del paper | Trimegisto hoy | Gap | Dificultad de importar |
|---|---|---|---|
| **Ledger**: plan.md / tasks.json / notes.md / solution | notes/ + read-registry + locks + verdicts de 700 chars; goal y task list **en memoria** | no hay ledger mutable en disco, ni `tasks.json` con estados, ni artefacto "mejor solución" | **Media** (workspace por lote + tools) |
| **Manager – plan** (paso 1) | el main model llama `trimegisto` con goal+tasks; `planBatch` valida | el plan es una tool-call puntual, no se persiste ni se revisa | **Baja** (persistir) |
| **Worker – brainstorm** (paso 2) | no existe; los workers van directos a su tarea | falta fase de ideación | **Baja** (tipo de tarea / primer nodo t1) |
| **Manager – manage (bucle)** (paso 3) | **no existe**: olas fijas, un solo settle | no hay re-curación iterativa de tareas ni "siguiente tarea" | **Alta** (modo loop + agente manager + presupuesto) |
| **Worker – do the task** (paso 4) | `launchAgent` one-shot, contexto fresco, tareas disjuntas | encaja bien | **Ya está** |
| **Verifier – ejecuta tests** (paso 5) | no hay: la reconciliación es **solo texto** | falta gate de aceptación por ejecución | **Media** (campo `verify` por tarea + integración con lanes) |
| **Finalizer** (paso 6) | el main model sintetiza en su único turno post-reconciliación | el finalizador es el main model, no una llamada fresca; y **ya hay protección** (el main model no re-spawnea) | **Baja/Media** |
| **Guardas**: MAX_ITERS=10, no-progreso, cut-off summarizer | deadline wall-clock 30 min, dedup, reaper, `compact` por agente | no hay presupuesto de **rondas**, ni guarda de no-progreso a nivel de plan, ni summarizer dentro del bucle | **Media**; hay piezas (`similarity.ts`, dedup) |
| **Mismo modelo, contexto fresco por rol** | modelos heterogéneos por tier, contexto fresco | mismatch (pero es **ventaja**: el paper deja modelos heterogéneos como trabajo futuro) | n/a |
| **Temperaturas por rol** (0.2/0.3/0.4) | no expuesto | trivial de añadir por fase | **Baja** |
| **Instrumentación de coste/tokens** | usage/coste por agente + reconciliación | encaja | **Ya está** |

**Observación clave del mapeo:** el `plan-graph` de Trimegisto es, en la práctica, *más estricto y más seguro* que la coordinación libre del paper: el manager del paper **puede** reemitir tareas duplicadas (lo que el paper solo detecta con "no-progress guard") y **puede** dejar que dos workers toquen lo mismo; el gate de Trimegisto lo hace imposible por construcción. Las regresiones del paper (§4.4) son precisamente fallos de coordinación que el gate ya cubriría.

---

## 4. Las posibilidades de importación, ordenadas por valor/coste

### 4.1 Importaciones naturales (alto valor, riesgo bajo)

**(A) Ledger de lote como artefacto de primera clase.**
Materializar `<instanceDir>/batches/<batchId>/` con `plan.md`, `tasks.json`, `notes.md`, `solution.<ext>`. El manager lo escribe antes de la ola 1; los workers lo **leen al arrancar** (en vez del preamble de 2400 chars) y lo **actualizan** con una tool tipo `trimegisto_note`. Esto ataca directamente el **mecanismo #1 del paper** (memoria externa / contexto acotado) y mejora el handoff entre olas, que hoy pasa por 700 + 2400 chars.
- *Coste:* medio. *Riesgo:* bajo (es un workspace más, con las primitivas ya existentes).
- *Matiz importante:* el ledger del paper asume **una sola `solution.py`**; Trimegisto reparte ficheros disjuntos. El ledger debe modelar *el objetivo del lote*, no una única solución.

**(B) Fresh-perspective workers (flag por tarea).**
El propio paper lo propone como remedio a la regresión #1. Trimegisto puede expresarlo con un campo `context: "ledger" | "fresh"` en la tarea: los `fresh` arrancan sin preamble ni notas. Sirve para tener un **intento independiente** contra el que comparar el intento evolucionado.
- *Coste:* bajo. *Riesgo:* bajo. *Encaje:* perfecto con la filosofía de control explícito.

**(C) Gate de verificación por ejecución.**
Campo `verify: "<comando>"` (o `verify: {command, expect}`) por tarea: al terminar el worker, Trimegisto ejecuta el comando; un fallo **invalida el `done`** y se realimenta al manager/coordinador. Es la importación del paso 5 y es **la de mayor palanca**, porque la causa raíz de las regresiones del paper es "el manager se cree al worker".
- *Coste:* medio. *Riesgo:* bajo-medio (sandboxing, timeouts, no ejecutar en lanes `closed`).
- *Ventaja sobre el paper:* el verifier del paper solo existe en 73/100 problemas (los otros 27 no son ejecutables); un `verify` genérico suministrado por el usuario sería **más potente** que el del paper.

### 4.2 La importación nuclear (alto valor, coste alto, cambia el contrato)

**(D) Modo "loop": manager iterativo dentro de un lote.**
Un modo opt-in `mode: "loop"` en el que, tras asentarse cada ola, Trimegisto **no settlea**, sino que invoca a un **agente manager en contexto fresco** (tier t1/t2 barato, no el main model) con el ledger + veredictos, y le pide: curar `tasks.json` y **nombrar la única siguiente tarea**, hasta `MAX_ITERS` rondas, con guarda de no-progreso (ya hay `similarity.ts`) y finalizer. Solo al final se emite la reconciliación única.
- *Coste:* **alto**. Es un cambio de arquitectura, no una feature.
- *Conflictos a resolver:*
  1. **Contrato actual**: el tool dice "ONE reconciliation… do not re-spawn". El modo loop debe cambiar ese contrato explícitamente para ese lote.
  2. **Filosofía**: "nada automático que no hayas encendido". Debe ser opt-in, visible en dashboard y con presupuesto explícito.
  3. **Coste de spawn**: cada llamada del manager sería un **proceso pi nuevo** (~600 ms+ de arranque y contexto completo), no una llamada API directa como en el paper. Un bucle de 10 rondas = 10 manager spawns + N worker spawns. Hay que decidir: (a) manager como agente re-spawneado por ronda (simple, caro), (b) manager persistente alimentado por `steer` (encaja con la mailbox, pero los agentes son one-shot y terminan su turno), o (c) llamada LLM **in-process** desde la extensión (la más eficiente, pero convierte a Trimegisto en un invocador de LLM, no solo un supervisor de procesos). **Este es el mayor interrogante de ingeniería.**
  4. **Interacción con el gate**: el manager **propone**, el `planBatch` **dispone**. Esto conserva las garantías de dedup/same-file/lane y convierte el modo loop en "manager acotado" — lo que además corrige el fallo del paper (el manager libre regresa).

### 4.3 Lo que NO conviene importar tal cual

- **Manager = main model en la sesión longeva.** En el paper el manager corre en contexto fresco y corto; ese es justamente el beneficio de gestión de contexto. En Trimegisto el coordinador es el actor **más cargado** de contexto. Copiar el bucle sin mover la orquestación fuera del main model invertiría el beneficio.
- **Un solo `solution.py`.** No encaja con lotes multi-fichero.
- **Verifier dependiente de tests públicos.** Es específico de programación competitiva; en Trimegisto debe ser genérico y suministrado por la tarea.
- **Manager libre sin gate.** Reproduce las regresiones que el plan-graph ya evita.

---

## 5. Cómo lo veo (valoración honesta)

**El paper no describe algo que Trimegisto deba copiar; describe algo que Trimegisto está a medio camino de ser.** El paper es un trabajo *mono-objetivo, mono-workspace, iterativo*; Trimegisto es *multi-objetivo, multi-fichero, por lotes*. Son puntos distintos del espacio de diseño, y eso explica por qué el mapeo tiene huecos justo en el bucle y el ledger.

**Lo que el paper demuestra y a Trimegisto le conviene:**
- Que la orquestación **zero-shot, sin entrenamiento**, produce mejoras grandes y estadísticamente sólidas. Eso legitima la existencia de Trimegisto.
- Que la ganancia es **mayor en modelos locales con gestión de contexto débil** — el régimen exacto de los tiers locales de Trimegisto (el mismo Example-27B que aparece en los ejemplos de tiers de llama-infra es el modelo con Δ +23.4).
- Que el coste marginal del andamiaje **se paga solo** cuando el token es barato: con modelos locales (electricidad) el "+triple del bill" del paper es casi irrelevante; con tiers cloud sí es real y hay que medirlo.
- Que **verificar en vez de confiar** y **tener intentos frescos** son los dos remedios que el propio paper propone a sus propios fallos — y ambos son importables a bajo coste.

**Lo que el paper revela como carencia de Trimegisto:**
- No hay **ledger persistente con estados** ni **mejor solución actual**.
- No hay **gate de verificación por ejecución**.
- No hay **bucle de re-planificación adaptativa** dentro de un lote (hoy hay que re-llamar a `trimegisto` manualmente, y el prompt lo desaconseja).
- No hay **presupuesto de rondas** ni **guarda de no-progreso a nivel de plan** (solo dedup y deadline wall-clock).

**Lo que Trimegisto ya hace mejor que el paper:**
- Gate determinista (dedup, same-file, lanes `closed`, capacity) que previene por construcción las regresiones que el paper sufre.
- Modelos heterogéneos por tier (el paper lo deja como trabajo futuro).
- Control por agente (`steer`/`compact`/`kill`), watchdogs, circuit breaker, reaper, modelo de coste/tokens por agente.
- Un contrato de garantías (una reconciliación, nunca polling) que el paper no tiene.

**Recomendación de secuencia (si algún día se implementa):**
1. **(C) Gate de verificación + (B) fresh-perspective workers** — baratos, atacan los fallos conocidos, no cambian el contrato. Empezaría aquí.
2. **(A) Ledger de lote** — habilita el mecanismo #1 del paper y prepara el terreno del bucle.
3. **(D) Modo loop opt-in** — solo después, y con el manager como **proponente validado por `planBatch`**, presupuesto de rondas, guarda de no-progreso y finalizer. Resolver antes el interrogante del coste de spawn (¿agente re-spawneado, persistente vía steer, o llamada in-process?).

**Veredicto:** la importación es **viable y conceptualmente alineada**, pero **no es un port**: es una extensión en tres capas (verificación → ledger → bucle). La capa más valiosa para el coste es la verificación; la más transformadora es el bucle; la más barata es el ledger. Ninguna exige tocar el modelo ni entrenar nada.

---

## 6. Preguntas abiertas para decidir

1. ¿El modo loop debe vivir **dentro** de un lote (una reconciliación al final) o ser explícitamente un tipo de lote distinto (`mode: "loop"`) con su propio contrato?
2. ¿El manager de bucle se implementa como agente re-spawneado, agente persistente vía `steer`, o llamada LLM in-process? (impacta coste, latencia y arquitectura).
3. ¿El `verify` es un comando shell por tarea, o un contrato estructurado (comando + expectativa + tolerancia)? ¿Cómo se integra con el lane `closed` (nunca ejecutar workflows irreversibles)?
4. ¿El ledger es por lote o por sesión? ¿Sobrevive a `/new`, `/resume`, `/fork`?
5. ¿Cómo se mide el coste/beneficio del modo loop en el dashboard sin inflar la factura silenciosamente (el paper triplica el coste)?
6. ¿La guarda de no-progreso reutiliza `similarity.ts` sobre `tasks.json` (similitud de tareas) o sobre veredictos?

---

## 7. Propuesta de alcance acordada (v1): verify + fresh, sin loop

**Decisión propuesta por el usuario:** implementar (1) `verify` por tarea + flag *fresh-perspective*, y (2) ledger de lote en disco. **Dejar fuera el modo loop** para evitar recursividad de planificación.

**Validación del argumento de recursividad:** correcto. Ni `verify` (subproceso lanzado por la extensión) ni el `ledger` (pasivo) añaden recursión. Solo el loop lo haría, porque un manager que decide spawnear es recursión de *planificación* — una capa nueva sobre el `maxSpawnDepth=5` y el auto-spawn de workers que ya existe. Aplazar el loop es la forma barata de no abrir esa caja.

### 7.1 Matiz: sin el loop, verify y ledger no valen lo mismo

- **`verify`**: valor inmediato y autónomo. Convierte `done` en veredicto verificado y ataca la causa raíz de las regresiones del paper (el coordinador se cree al worker). Funciona entero dentro del modelo de lote actual.
- **`ledger`**: sin un consumidor que re-planifique, es sobre todo **memoria/observabilidad + mejor handoff entre olas**. La parte `notes` + estados de tarea vale ya; el artefacto "mejor solución actual" casi solo vale para el futuro loop. Es **cimiento**, no mejora de accuracy a corto plazo: no venderlo como lo segundo.

### 7.2 El trabajo de diseño está en verify y fresh, no en el ledger

**`verify` — decisiones reales:**
- *Quién ejecuta*: la **extensión** (determinista; el agente no puede mentir) >> el propio agente. Encaja con "nada oculto".
- *Trust boundary*: el agente puede editar el test para que pase. El paper corría tests que el modelo no controlaba. Decidir: comando fijado por el llamador, detección de cambios en ficheros de test, o verificación sobre copia limpia.
- *Semántica de fallo*: recomendado **metadato estructurado** `verification:{ran,passed,exitCode,command,output}` + que la reconciliación muestre `✅ done (verify FAILED)` y no lo cuente como éxito. Evita romper los ~900 checks que comprueban `done`.
- *Lane `closed`*: verify es **post-hoc**; no puede impedir una acción irreversible ya ejecutada. La protección sigue siendo el rechazo pre-launch. No permitir que verify dé falsa confianza.
- *Alcance*: opt-in por tarea, con timeout, captura de salida y sin asumir que toda tarea es testeable (prosa, diseño, análisis).

**`fresh` — conflicto real:** el gate de dedup **bloquea los gemelos de diversidad**. Un fresh twin es deliberadamente no-disjunto, así que `dedupeTasks`, el merge intra-lote y `dedupeCrossAgent` lo matan o lo marcan como redundante. Hace falta un flag explícito (`purpose: "diversity"`) que exima, con tope de gemelos, resolver `writes` (los gemelos no deben escribir el mismo fichero) y **cambiar el contrato del prompt** del main model, que hoy dice "assign DISJOINT subtasks". Coste: duplicar intentos duplica factura en esas tareas → opt-in y visible en dashboard.

### 7.3 No construir un segundo sistema de contexto compartido

El ledger solapa con `shared-context.ts` (notas + read-registry, 2400 chars). **Evolucionar `shared-context` hacia el ledger**, no dejarlos en paralelo: dos fuentes de verdad de "lo que saben los otros agentes" es deuda inmediata. Ciclo de vida pendiente: dirs por lote + política de limpieza (el reaper purga agentes, no dirs), y qué pasa con `/new`, `/resume`, `/fork`.

### 7.4 Secuencia recomendada

1. **`verify`** — autocontenido, mayor valor/coste. Primero.
2. **`fresh`** — pequeño, pero exige la exención del gate de dedup.
3. **`ledger`** — en último lugar, cuando ya hay veredictos machine-readable que meter en él.

**Diseñar la costura ahora:** aunque el loop quede fuera, el schema del ledger debe anticipar los campos que un futuro manager escribiría (`status`, `next_task`, `attempts`) y `verify` debe emitir veredictos que un futuro manager pueda accionar. Cuesta poco ahora y ahorra un rediseño después.

### 7.5 El "loop manual" como término medio

Dejar fuera el loop **no elimina toda la adaptividad**: el main model ya recibe la reconciliación y puede emitir un lote de seguimiento. Si `verify` hace visible el fallo, se obtiene un **loop manual explícito, visible y no recursivo** — exactamente la filosofía de Trimegisto (adaptividad en el humano/main model, no escondida). El loop automático solo aporta sobre eso si se quiere iterar **sin** el main model. Ese es el criterio para decidir *si y cuándo* añadirlo.

---

## 8. Estado de implementación (v1) — completado

Implementados los puntos 1 y 2; el loop queda fuera. **Todas las suites en verde (18 ficheros de test; nuevas: `test-verify.ts` 64, `test-diversity.ts` 26, `test-ledger.ts` 48).**

**`verify` por tarea**
- `src/verify.ts`: `runVerification()` (subproceso propio, `shell:true`, cwd de la tarea, timeout 120 s con override `TRIMEGISTO_VERIFY_TIMEOUT_MS`, captura stdout+stderr, head+tail truncation, redacción ligera de prefijos de credencial, **nunca rechaza ni lanza**), `normalizeVerify`, `verifyTimeoutMs`, `truncateVerifyOutput`, `verificationBadge`, `waveHasPendingVerification`.
- La **extensión** ejecuta el comando, no el worker. Gate de wave: `batch.verifyByAgent` se puebla **antes** de `resolve`, y `waveFinished()` no da por terminal una ola con verificación en vuelo (evita el settle prematuro, porque `notifyStateChange` va antes que `resolve`).
- `reconcile.ts`: `distillConclusion` prefija `🚫 VERIFY FAILED`; `reconcileBatch` añade icono, línea `verify ✅/❌`, sección y `counts.{verified,verifyFailed}`; un `done` con verify fallido **no cuenta como éxito** y no se duplica como "unverified". El veredicto fallido viaja también por los `needs` upstream.
- Seguridad: solo se verifica un worker con `status === "done"`; las tareas `closed` ya se rechazan antes.
- **Límite v1:** no aplica a spawns anidados (`trimegisto_spawn`); solo al lote de nivel superior.

**`context: "fresh"` + `diversity: true`**
- `plan-graph.ts`: campos en `PlanTaskInput`/`PlanNode`, y **exención del merge de duplicados** para nodos `diversity` (con **tope 3/lote** + warnings: nunca es un bypass de dedup). En `index.ts`, exención también del dedup cross-llamada.
- `agent-manager.ts`: `launchAgent(..., freshContext)` omite el preamble de `shared-context`; los `needs` explícitos se siguen inyectando.
- Contrato del prompt actualizado (`RULE_VERIFY`, `RULE_FRESH`) en la descripción de la tool y en la directiva por turno.

**Ledger de lote**
- `src/ledger.ts`: `plan.md` + `tasks.json` + `notes.md` en `<instanceDir>/batches/<batchId>/`, escritura atómica, `readLedger`, `pruneLedgers` (24 h), saneado de `batchId` sin escape de path. **Todas las escrituras son best-effort y nunca lanzan** (un disco de solo lectura no rompe un lote).
- `index.ts`: se crea al registrar el lote (`plan.launch` → tareas), se actualiza en cada `recordResult` (estado, veredicto acotado, verificación), se marca `running` al lanzar y `error` en fallos de modelo/lanzamiento; en el settle se vuelca `notes.md` (desde `readNotesSnapshot`) y se añade la ruta del ledger a la reconciliación.
- `tasks.json` es **loop-ready**: es el array que un futuro manager curaría. No se ha creado un segundo almacén de notas: `shared-context` sigue siendo la fuente de verdad de hechos; el ledger solo la fotografía.

**Pendiente / fuera de alcance**
- Modo loop automático (aplazado a propósito).
- `verify` en spawns anidados; sandboxing del verifier (v1 reporta, no aísla).
- El ledger es efímero por instancia (se purga con ella); persistencia entre sesiones sería un follow-up.
