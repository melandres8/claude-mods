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
2. **Conectar** envía a B una petición de enlace. B no toma ningún rol por su cuenta: muestra un aviso con el id de A y el comando que la acepta, por ejemplo `/relevo builder <id-de-A>`. El panel de B (`/relevo`) muestra la misma petición con un botón **Aceptar**. Acepta solo si ese id es de verdad tu otra sesión. Al aceptar, B responde y A muestra **✓** junto al peer.
3. En A aparece el campo **Objetivo**. Escríbelo y pulsa **Iniciar**.

Con el relevo en marcha, el panel muestra el último handoff enviado (↑) y el último recibido (↓), un handoff retenido si lo hay, y los botones **Pausa** o **Reanudar**, **Quitar** y **Cerrar**. En el móvil solo muestra el estado y los botones.

La banda sobre el prompt resume el estado en una línea: un punto del color del estado, el rol en una etiqueta de color (planner y builder tienen colores distintos), el peer, las rondas como barra `▰▰▰▱▱▱▱▱▱▱ 3/10` y quién tiene el turno, por ejemplo `turno de B · hace 12s`. Los colores salen del tema: verde activo, amarillo en pausa, rojo error, violeta terminado. **⚙** abre el panel.

### Con comandos

Lo mismo sin panel:

1. En A:
   ```
   /relevo planner <peer>
   ```
   Como `<peer>` sirve el sessionId de B, que `/relevo status` muestra en B, o el nombre con el que B aparece en `ListAgents` (también `nombre [ref]` si dos sesiones comparten nombre). La respuesta trae ya la línea para B, con el id de A: `/relevo builder <id-de-A>`.
2. En B, pega esa línea. Es la confirmación: acepta la petición de A y enlaza las dos sesiones.
   ```
   /relevo builder <id-de-A>
   ```
   Si B ejecuta la línea antes de que llegue la petición de A, la petición sale de B hacia A, y A la acepta igual, con `/relevo planner <id-de-B>` o con **Aceptar** en su panel. Si las dos peticiones se cruzan, acepta en una sola de las dos sesiones. Al enlazarse, la petición sobrante se descarta. Si las dos aceptan a la vez, las rondas se descartan como no verificadas: ejecuta `/relevo off` en las dos y enlázalas de nuevo desde una.
3. En A:
   ```
   /relevo goal Añadir paginación al endpoint /users con tests
   ```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/relevo` | Abre el panel. |
| `/relevo planner <peer>` | Esta sesión planifica. Si `<peer>` ya pidió enlazar como builder, acepta su petición. |
| `/relevo builder <peer>` | Esta sesión construye. Si `<peer>` ya pidió enlazar como planner, acepta su petición. |
| `/relevo goal <texto>` | Solo en la planificadora: arranca el ciclo. |
| `/relevo pause` / `resume` | Corta o reanuda el envío automático. `resume` envía el handoff retenido y pasa al modelo la ronda que llegó en pausa. |
| `/relevo status` | Muestra rol, peer, ronda, último envío, el id de esta sesión (con rol o sin él) y la petición de enlace pendiente, si la hay. |
| `/relevo off` | Quita el rol. Una sesión enlazada rechaza `/relevo planner\|builder` hasta que ejecutas `/relevo off`. |

## Protecciones

- **`maxRounds`** (por defecto 10, en `/config`), en las dos sesiones: al llegar al límite, relevo se pausa, guarda el `<handoff>` pendiente y avisa con un toast. `/relevo resume` lo envía y concede otras `maxRounds` rondas. Si la planificadora reanuda pasado el límite, la constructora también se pausa al llegar al suyo y hay que reanudarla allí.
- **`<done>`** en la planificadora termina el ciclo, aunque la misma respuesta traiga también un `<handoff>`.
- **Sin enlace no se envía nada**: hasta que el peer acepta, o si los roles chocan (dos builders, por ejemplo), el `<handoff>` queda retenido y relevo se pausa. Cuando el peer acepta, `/relevo resume` lo envía.
- **Envío fallido o rechazado**: toast con el motivo y pausa. El `<handoff>` queda retenido, y `/relevo resume` lo reenvía con la misma ronda.
- **No a sí misma**: el panel no ofrece la propia sesión en la lista, y tanto el panel como `/relevo planner|builder` rechazan como peer el id de esta sesión.
- **Enlace con confirmación**: una petición de enlace nunca da un rol por sí sola. Queda pendiente hasta que la persona la acepta con `/relevo <rol> <id>` o con **Aceptar** en el panel. relevo no responde nunca a una petición que nadie aceptó, así que quien la envía no sabe nada de esta sesión ni de su peer. Una sesión ya enlazada ignora las peticiones nuevas.
- **Solo mensajes de relevo**: un mensaje de enlace o de ronda cuenta solo si lo compuso el relevo de la otra sesión (origen `peer` con `plugin` `relevo`). Un texto igual escrito por un modelo con `SendMessage`, un mensaje `peer-send-message` o una entrada de buzón sin verificar se descarta con un toast, y no llega al modelo.
- **Nonce por enlace**: quien pide el enlace genera un nonce aleatorio. La aceptación lo devuelve, y cada cabecera de ronda lo lleva. Una ronda cuenta solo si trae el nonce del enlace y viene del rol opuesto. La ronda recibida nunca baja la cuenta, así que una cabecera `ronda 0` no la reinicia ni se salta `maxRounds`.
- **En pausa o terminado**: una ronda que llega entonces no abre un turno del modelo. Queda retenida (toast y línea en `/relevo status`), y `/relevo resume` se la pasa al modelo.
- **Sin eco**: relevo solo envía desde el final de un turno del modelo, nunca al recibir un mensaje. Tampoco reenvía un `<handoff>` igual al que acaba de recibir o al último que envió.

## Notas

- Si el modelo ya escribe la cabecera al principio del `<handoff>`, relevo la quita antes de poner la suya, así que el peer la lee una sola vez.
- Si dos sesiones comparten nombre, el panel las ofrece como `nombre [ref]`, la forma que acepta `SendMessage`. `/relevo planner|builder nombre [ref]` también la acepta.
- Solo la planificadora sube la ronda. La constructora contesta con la misma ronda que recibió. En el envío, la cabecera es `[relevo ronda N · de planner|builder · <nonce>]`. El modelo la lee sin el nonce, `[relevo ronda N · de planner|builder]`, así que no lo ve nunca.
- Una cabecera o una línea de enlace cuentan solo al principio del mensaje (una línea de enlace, además, solo si es el mensaje entero). Un `<handoff>` que cita una de las dos sigue siendo un handoff.
- El `<handoff>` se lee de `answer` en `turn.complete`, que es el texto final del turno. Si ese texto no trae el bloque, relevo lee el último mensaje del asistente con `$.session.messages()`.
- El rol, el peer, la ronda y la pausa viven en `$.state`, así que aguantan una recarga en caliente.
- Un mensaje del peer entra por `session.receive`. Los de relevo llegan con origen `peer` y `plugin` `relevo`. Según los tipos, ese nombre de plugin lo declara el motor que envía, no es una prueba de identidad. Por eso relevo lo usa solo como filtro, y la garantía la dan la confirmación de la persona y el nonce. Según los tipos de este build llega como un turno nuevo, o dentro del turno en curso si la otra sesión está ocupada. "Entregado" significa que está en cola, no que se haya leído.

## Desarrollo

```
claude plugin validate .
claude plugin test .
```
