# relevo

Conecta dos sesiones locales de Claude Code: una **planifica** y la otra **construye**. Se pasan el trabajo sin que tengas que intervenir.

La planificadora escribe un paso dentro de `<handoff>…</handoff>`. Al acabar su turno, relevo lo envía a la constructora. La constructora lo ejecuta y responde con otro `<handoff>` que lleva su informe. El ciclo sigue hasta que la planificadora emite `<done>…</done>`, se llega a `maxRounds` o lo pausas tú.

## Activarlo

Elige **una** de estas dos formas. Si combinas dos, por ejemplo la instalación y `--plugin-dir`, los hooks se cargan dos veces y cada handoff sale duplicado.

**Instalarlo desde el marketplace** (recomendado). La raíz de este repositorio trae `.claude-plugin/marketplace.json`:

```
claude plugin marketplace add melandres8/claude-mods
claude plugin install relevo@claude-mods
```

Para trabajar sobre una copia local, pasa la ruta del clon en lugar de `melandres8/claude-mods`. Claude Code lee el plugin desde la carpeta misma. Tras editarlo, `/reload-plugins` lo recarga en la sesión abierta.

**Variable de entorno.** En `~/.claude/settings.json`, el de usuario y no el del proyecto:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/ruta/a/claude-mods/relevo" } }
```

En los dos casos relevo se carga en todas las sesiones. La banda solo aparece en las que tienen un rol.

## Uso

Abre dos sesiones de Claude Code en el proyecto. Llamamos **A** a la que planifica y **B** a la que construye.

### Panel

1. En A, escribe `/relevo`. Se abre el panel con tres pasos: **1** el rol, **2** la otra sesión (elígela en **Sesiones** o escribe su nombre o id en **Peer**; **↻** recarga la lista) y **3** **Conectar**.
2. **Conectar** envía a B un mensaje de enlace. Si B también tiene relevo, toma sola el rol opuesto y responde. A muestra entonces **✓** junto al peer. Si B no tiene relevo, el panel de A muestra la línea que hay que pegar en B, por ejemplo `/relevo builder <id-de-A>`.
3. En A aparece el campo **Objetivo**. Escríbelo y pulsa **Iniciar**.

Con el relevo en marcha, el panel muestra el último handoff enviado (↑) y el último recibido (↓), un handoff retenido si lo hay, y los botones **Pausa** o **Reanudar**, **Quitar** y **Cerrar**. En el móvil solo muestra el estado y los botones.

La banda sobre el prompt resume el estado en una línea: un punto del color del estado, el rol en una etiqueta de color (planner y builder tienen colores distintos), el peer, las rondas como barra `▰▰▰▱▱▱▱▱▱▱ 3/10` y quién tiene el turno, por ejemplo `turno de B · hace 12s`. Los colores salen del tema: verde activo, amarillo en pausa, rojo error, violeta terminado. **⚙** abre el panel.

### Con comandos

Lo mismo sin panel:

1. En A:
   ```
   /relevo planner <peer>
   ```
   Como `<peer>` sirve el sessionId de B, que `/relevo status` muestra en B, o el nombre con el que B aparece en `ListAgents`. La respuesta trae ya la línea para B, con el id de A: `/relevo builder <id-de-A>`.
2. En B, pega esa línea:
   ```
   /relevo builder <id-de-A>
   ```
3. En A:
   ```
   /relevo goal Añadir paginación al endpoint /users con tests
   ```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/relevo` | Abre el panel. |
| `/relevo planner <peer>` | Esta sesión planifica. |
| `/relevo builder <peer>` | Esta sesión construye. |
| `/relevo goal <texto>` | Solo en la planificadora: arranca el ciclo. |
| `/relevo pause` / `resume` | Corta o reanuda el envío automático. |
| `/relevo status` | Muestra rol, peer, ronda, último envío y el id de esta sesión. |
| `/relevo off` | Quita el rol. |

## Protecciones

- **`maxRounds`** (por defecto 10, en `/config`): al llegar al límite, relevo se pausa, guarda el `<handoff>` pendiente y avisa con un toast. `/relevo resume` lo envía y concede otras `maxRounds` rondas.
- **`<done>`** en la planificadora termina el ciclo, aunque la misma respuesta traiga también un `<handoff>`.
- **Envío fallido o rechazado**: toast con el motivo y pausa.
- **No a sí misma**: el panel no ofrece la propia sesión en la lista, y tanto el panel como `/relevo planner|builder` rechazan como peer el id de esta sesión.
- **Enlace**: el mensaje de enlace nunca llega al modelo. Una sesión solo lo acepta si no tiene rol, o si ya tiene el rol opuesto con ese mismo peer. Si no, lo rechaza y avisa a las dos.
- **Sin eco**: relevo solo envía desde el final de un turno del modelo, nunca al recibir un mensaje. Tampoco reenvía un `<handoff>` igual al que acaba de recibir o al último que envió.

## Notas

- Si el modelo ya escribe la cabecera al principio del `<handoff>`, relevo la quita antes de poner la suya, así que el peer la lee una sola vez.
- Si dos sesiones comparten nombre, el panel las ofrece como `nombre [ref]`, la forma que acepta `SendMessage`.
- Solo la planificadora sube la ronda. La constructora contesta con la misma ronda que recibió, en la cabecera `[relevo ronda N · de planner|builder]`.
- El `<handoff>` se lee de `answer` en `turn.complete`, que es el texto final del turno. Si ese texto no trae el bloque, relevo lee el último mensaje del asistente con `$.session.messages()`.
- El rol, el peer, la ronda y la pausa viven en `$.state`, así que aguantan una recarga en caliente.
- Un mensaje del peer entra por `session.receive` (origen `peer` o `peer-send-message`). Según los tipos de este build llega como un turno nuevo, o dentro del turno en curso si la otra sesión está ocupada. "Entregado" significa que está en cola, no que se haya leído.

## Desarrollo

```
claude plugin validate .
claude plugin test .
```
