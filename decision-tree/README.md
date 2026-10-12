# decision-tree

Convierte la pregunta con la que Claude cierra su respuesta, o su llamada a `AskUserQuestion`, en un **panel lateral**. Cada opción aparece con lo que conlleva. Además, puedes **probar cualquier respuesta en una rama**, una sesión bifurcada de verdad, antes de confirmarla.

La rama investiga en sólo lectura y te deja un informe: qué haría, qué cambiaría, riesgos y lo que aún no sabe. Tú decides después. La respuesta que confirmas llega como tu próximo mensaje.

## Activarlo

**Instalarlo desde el marketplace.** La raíz de este repositorio trae `.claude-plugin/marketplace.json`:

```
claude plugin marketplace add melandres8/claude-mods
claude plugin install decision-tree@claude-mods
```

Para trabajar sobre una copia local, pasa la ruta del clon en lugar de `melandres8/claude-mods`. Claude Code lee el plugin desde la carpeta misma. Tras editarlo, `/reload-plugins` lo recarga en la sesión abierta.

Usa una sola forma de cargarlo. Si lo instalas y además lo pasas con `--plugin-dir`, los hooks se cargan dos veces.

## Uso

No hay que hacer nada para que funcione: decision-tree escucha cada turno.

- **`AskUserQuestion`**: cuando Claude abre su diálogo de preguntas, el panel lo toma en su lugar. En la conversación queda una tarjeta que apunta al panel. Si el panel no se puede colocar, sigue el diálogo nativo de siempre.
- **Pregunta final**: si la respuesta de Claude termina con una pregunta, un modelo pequeño (haiku) la lee y propone de 2 a 4 opciones. Con el panel acoplado junto a la conversación, se abre solo. En la pantalla principal no se abre: la línea de estado avisa (`decision-tree: una pregunta para explorar · /decision-tree`).
- **`/decision-tree`** abre el panel cuando quieras.

### El panel

1. **Pregunta y opciones.** Con varias preguntas, una fila de pestañas las separa; **✓** marca las ya respondidas.
2. **⌥ Lo que conlleva**: al elegir una opción, Claude analiza qué haría después, a favor, en contra o riesgos, y si es reversible. El análisis se hace una sola vez por opción. Si falla, lo dice en lugar de quedarse en «Analizando…».
3. **✎ Otra respuesta**: escribe la tuya y pulsa Enter. Se añade como opción y también se analiza. En el móvil no hay campo de texto.
4. **⑂ Probar en rama**: arranca una rama con esa respuesta. Mientras trabaja, la opción muestra **◐ rama en curso**. Al terminar verás **✓ rama lista**, un aviso y su informe en el panel.
5. **✓ Confirmar** envía la respuesta como tu mensaje. Con varias preguntas, **✓ Confirmar todas** envía una lista con cada respuesta. **✎ Editar** la deja en el prompt para que la retoques.

**Ramas anteriores**: cuando llega una pregunta nueva, los informes de las ramas ya terminadas siguen en el panel, bajo «Ramas anteriores». Se muestran los tres últimos y se guardan los diez últimos.

Si respondes por tu cuenta, escribiendo en el prompt, desde el móvil o desde el SDK, la pregunta del panel se da por respondida y desaparece. Así **Confirmar** nunca envía una respuesta pasada.

## Qué puede hacer una rama

Una rama es un fork de la sesión: hereda la conversación y el modo de permisos. Para que pueda probar una respuesta sin consecuencias, decision-tree vigila cada llamada a herramienta que hace la rama y **rechaza todo lo que no sea leer**. El rechazo le pide que describa el cambio en su informe en lugar de aplicarlo.

### Herramientas

| Permitidas | Rechazadas |
| --- | --- |
| `Read`, `Grep`, `Glob`, `LSP`, `ToolSearch` y `Bash` sólo con los comandos de abajo | Todas las demás: `Write`, `Edit`, `NotebookEdit`, `Agent`, `AskUserQuestion`, cualquier herramienta MCP y también **`WebFetch` y `WebSearch`** |

Por qué no hay red: una rama puede leer secretos, como un `.env`. Una URL o una búsqueda los sacaría fuera.

### Bash

Cada comando se lee como lo leería el shell (bash o zsh). Si algo no encaja con estas reglas, se rechaza.

**Cómo se lee la línea**

- Se divide en comandos simples por `|`, `||`, `&&`, `;`, `&` y el salto de línea. Cada comando simple debe estar permitido.
- **Comillas**: se aceptan, porque los patrones las necesitan (`jq '.x'`, `grep 'a|b'`). El flag se juzga ya sin comillas: `find . '-delete'` es `-delete` y se rechaza. Dentro de comillas simples todo es literal. Dentro de comillas dobles se rechazan `$`, el acento grave y `\`. Una comilla sin cerrar se rechaza.
- **Fuera de comillas** sólo pasan letras, dígitos y `_ . / : = , @ % + ~ -`, más `!` como palabra suelta (para `find`). Por tanto, no hay expansión de variables, sustitución de comandos, redirecciones, globs (`* ? [ ]`), llaves (`{a,b}`) ni barras invertidas.
- **Sin globs**: un glob puede expandirse a un archivo con nombre de flag (`--pre=./x`). Por eso `ls src/*.ts` se rechaza. Para listar por patrón, la rama usa `Glob`, o pasa el patrón entre comillas a la herramienta que lo interpreta: `find . -name '*.ts'`, `rg -g '*.ts'`, `grep --include='*.ts'`.
- **Redirecciones**: sólo las de stderr, `2>&1`, `2>/dev/null` y `2> /dev/null`.
- No se aceptan asignaciones delante (`FOO=1 ls`), rutas a binarios (`/bin/ls`) ni envoltorios (`env`, `command`, `xargs`, `sudo`).

**Flags**

Cada binario tiene su lista cerrada de flags. Cualquier otro se rechaza.

- Los flags cortos pueden ir juntos (`-la`). Una letra que lleva valor toma el resto de la palabra (`-n5`) o la palabra siguiente (`-n 5`).
- Los flags largos deben coincidir exactos, nunca por prefijo: GNU y git aceptarían `--out` por `--output`.
- El valor de un flag largo sólo se lee con `=` (`--glob=x`). La palabra siguiente se juzga siempre por separado.
- `--` termina los flags. Después de `--`, todo cuenta como operando, y un `-` suelto también.

| Comando | Flags permitidos | Notas |
| --- | --- | --- |
| `echo`, `true` | cualquiera | sólo escriben en la salida |
| `pwd` | `-L -P` | sin operandos |
| `ls` | `-aAbBcCdfFgGhHiklLmnopqQrRsStTuUvwx1`, `--all --almost-all --human-readable --recursive --reverse --color --classify --directory`, `--color= --sort= --time-style=` | |
| `cat` | `-AbeEnstTuv`, `--number --number-nonblank --show-all --squeeze-blank` | |
| `head` | `-q -v`, `-n N -c N`, `-N`, `--quiet --silent --verbose`, `--lines= --bytes=` | |
| `tail` | `-q -r -v`, `-n N -c N`, `-N`, `--quiet --silent --verbose`, `--lines= --bytes=` | sin `-f`, `-F`, `--follow` ni `--retry`: no terminaría nunca. Tampoco operandos que empiecen por `+`, porque la forma tradicional `tail +5f` también sigue el archivo |
| `grep` | `-rRnilLcvwxoqsHhEFGIPabU`, `-e -f -m -A -B -C -d -D` con valor, `-N`, `--recursive --line-number --ignore-case --files-with-matches --files-without-match --count --word-regexp --line-regexp --fixed-strings --extended-regexp --perl-regexp --only-matching --no-filename --with-filename --invert-match --color --colour --quiet --no-messages`, `--include= --exclude= --exclude-dir= --color= --colour= --max-count= --context= --binary-files=` | |
| `rg` | `-nNiIsSlcwxvFuoHLpq0.UPabh`, `-e -f -t -T -g -A -B -C -m -M -j -E -r -d` con valor, `--files --hidden --no-ignore --no-ignore-vcs --no-heading --heading --count --json --vimgrep --line-number --no-line-number --ignore-case --smart-case --case-sensitive --fixed-strings --word-regexp --files-with-matches --files-without-match --follow --type-list --multiline --only-matching --invert-match --no-messages --count-matches --with-filename`, `--glob= --iglob= --type= --type-not= --max-count= --max-depth= --max-columns= --color= --sort= --sortr= --context= --after-context= --before-context= --max-filesize=` | sin `--pre`, `--pre-glob` ni `--hostname-bin` (ejecutan programas), ni `-z` (ejecuta descompresores) |
| `find` | delante: `-H -L -P -E`; luego las rutas; en la expresión: `-print -print0 -prune -empty -depth -xdev -mount -follow -readable -executable -nouser -nogroup -true -false -not -a -o -and -or ! ( ) -ls` y, con valor, `-name -iname -path -ipath -wholename -iwholename -regex -iregex -type -xtype -maxdepth -mindepth -size -mtime -mmin -atime -amin -ctime -cmin -newer -perm -user -group -uid -gid -links -inum -samefile -lname -ilname` | sin `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint*` ni `-fls` |
| `wc` | `-lwcmL`, `--lines --words --bytes --chars --max-line-length` | |
| `which` | `-a -s` | |
| `file` | `-bhiLkN`, `--mime --mime-type --mime-encoding --brief --dereference --no-dereference` | sin `-C` ni `-m` (compilan o eligen archivos magic), ni `-z` |
| `stat` | `-LflrsxFtq`, `-c` con valor, `--dereference --terse`, `--format= --printf=` | |
| `tree` | `-adfilspugDFCnNqvrtUxAShJX`, `-L -I -P` con valor, `--dirsfirst --noreport --gitignore --prune` | sin `-o` (escribe el listado), `-H` ni `-R` (escriben HTML) |
| `du` | `-ahcskmxLHP0`, `-d` con valor, `--human-readable --summarize --apparent-size`, `--max-depth=` | |
| `df` | `-hHkilTPa`, `--human-readable` | |
| `date` | `-u -R -j -I`, `-r -v` con valor, `--utc --universal --iso-8601 --rfc-email`, `--iso-8601= --rfc-3339= --reference= --date=` | sólo operandos `+FORMATO`: en BSD un operando suelto cambia la hora; sin `-s`, `--set` ni `-d` |
| `sort` | `-bdfgiMhnRrVuscCmz`, `-t -k -S` con valor, `--reverse --unique --numeric-sort --human-numeric-sort --version-sort --ignore-case --general-numeric-sort --month-sort --stable --check --merge --zero-terminated --dictionary-order --ignore-leading-blanks --random-sort`, `--key= --field-separator= --buffer-size= --sort=` | sin `-o`/`--output`, `-T`/`--temporary-directory` ni `--compress-program` (ejecuta un programa) |
| `uniq` | `-cdDuiz`, `-f -s -w` con valor, `--count --repeated --unique --ignore-case`, `--skip-fields= --skip-chars= --check-chars=` | como mucho un operando: el segundo sería el archivo de salida |
| `cut` | `-snw`, `-b -c -f -d` con valor, `--complement --only-delimited`, `--delimiter= --fields= --characters= --bytes=` | |
| `tr` | `-cCdsu` | como mucho dos operandos |
| `nl` | `-p`, `-b -d -f -h -i -l -n -s -v -w` con valor | |
| `diff` | `-uaBbdEeiNnpqrsTtwy`, `-U -C -D -I -L -F -S -W -x -X` con valor, `--unified --recursive --brief --side-by-side --ignore-all-space --ignore-space-change --new-file --text`, `--unified= --color= --exclude= --label=` | como mucho dos operandos |
| `jq` | `-rcensSjaCMRf`, `--raw-output --compact-output --slurp --null-input --sort-keys --join-output --exit-status --raw-input --ascii-output --tab --indent --arg --argjson --slurpfile --rawfile --args --jsonargs` | |
| `basename` | `-a -z`, `-s` con valor, `--multiple --zero`, `--suffix=` | |
| `dirname` | `-z`, `--zero` | |
| `realpath` | `-eEmLPqsz`, `--relative-to= --relative-base=` | |

**git**: el subcomando va justo después de `git`. Así quedan fuera `-c`, `-C`, `--exec-path` y similares.

| Subcomando | Flags permitidos |
| --- | --- |
| `status` | `-s -b -z`, `--short --branch --porcelain --long --ignored --untracked-files`, `--porcelain= --untracked-files= --ignored=` |
| `diff` | `-p -R -w -b -z`, `--stat --shortstat --numstat --name-only --name-status --cached --staged --patch --word-diff --color --no-color --minimal --patience --histogram --ignore-all-space --ignore-space-change --check --summary --raw --relative --exit-code --quiet --no-ext-diff --no-textconv`, `--unified= --diff-filter= --stat= --color= --word-diff= --relative=` |
| `log` | `-p -z`, `-n -S -G` con valor, `-N`, `--oneline --stat --shortstat --numstat --name-only --name-status --graph --decorate --no-decorate --all --branches --tags --remotes --patch --follow --reverse --no-merges --merges --abbrev-commit --no-abbrev-commit --first-parent --color --no-color --summary --raw --topo-order --date-order --relative-date --pretty --format --full-history --source --left-right`, `--format= --pretty= --since= --until= --after= --before= --author= --committer= --grep= --max-count= --skip= --date= --decorate= --color= --abbrev= --diff-filter= --stat=` |
| `show` | `-p -w -z`, `-n` con valor, `-N`, y los largos de `log` y `diff` |
| `blame` | `-wslefnpct`, `-L` con valor, `--porcelain --line-porcelain --show-email` |
| `ls-files` | `-cdmoiksutvfz`, `--others --cached --modified --deleted --exclude-standard --error-unmatch --stage --full-name --directory`, `--exclude=` |
| `rev-parse` | `-q`, `--show-toplevel --abbrev-ref --short --git-dir --git-common-dir --absolute-git-dir --is-inside-work-tree --is-bare-repository --verify --symbolic-full-name --show-prefix --show-cdup`, `--short=` |
| `describe` | `--tags --always --dirty --long --all --contains --exact-match`, `--abbrev= --match= --exclude= --dirty=` |
| `branch` | `-a -r -v`, `--all --remotes --list --show-current --verbose`; sin operandos |
| `remote` | `-v`, `--verbose`; sin operandos |

Ejemplos que funcionan: `ls -la`, `grep -rn foo src`, `rg -n foo -g '*.ts'`, `find . -name '*.ts' -type f`, `git log --oneline -5`, `git diff --stat`, `head -n 20 f`, `wc -l f`, `sort f | uniq -c | sort -rn`, `jq '.scripts' package.json`.

## Protecciones

- **Desde la primera llamada**: una rama puede llamar herramientas antes de que `$.agent.spawn` devuelva su id. El guardia la reconoce de tres formas. Si su id ya está guardado, la vigila. Si `$.agent.list()` la nombra como lanzada por decision-tree, también. Y mientras haya un arranque en curso, rechaza a cualquier agente que la lista aún no nombra. Los subagentes que lanzan el modelo u otros plugins siguen con todas sus herramientas.
- **Sin caducidad**: los ids de las ramas se guardan sin límite. Una rama vieja sigue vigilada.
- **Si la comprobación falla** (la lista no responde, por ejemplo), el guardia decide con lo que recuerda. A una rama conocida le aplica las mismas reglas. A un agente desconocido lo rechaza sólo mientras arranca una rama. A cualquier otro lo deja pasar.
- **Ramas huérfanas**: si llega una pregunta nueva, las ramas que siguen trabajando para la anterior se detienen con `TaskStop` y quedan marcadas como detenidas. Lo mismo ocurre con una rama que termina de arrancar cuando su pregunta ya cambió.
- **Avisos de las ramas**: el aviso de fin de una rama no llega a la conversación principal, porque su informe ya está en el panel. Sólo se descarta si el panel tiene esa rama. Cualquier otro aviso pasa.
- **Preguntas viejas**: si una lectura de la pregunta termina tarde (llegó otro turno o respondiste tú), se descarta. Una pregunta más vieja nunca reemplaza a una más nueva.
- **Un clic, una acción**: pulsar dos veces una opción o **Probar en rama** no lanza dos análisis ni dos ramas.

## Notas

- `git diff`, `git log -p` y `git show` pueden ejecutar programas que **tú** configuraste en git, como `diff.external`, `textconv` o filtros. La rama no puede cambiar esa configuración, pero hereda la tuya.
- `TaskStop` pasa por la comprobación de permisos como cualquier herramienta. Si tu configuración la pide, puede aparecer un diálogo al cambiar de pregunta.
- El estado (pregunta, opciones, análisis, ramas e ids) vive en `$.state`, así que aguanta una recarga en caliente. Los arranques en curso y las lecturas en curso viven en memoria del módulo: una recarga los olvida y descarta esas lecturas.

## Desarrollo

```
claude plugin validate .
claude plugin test .
```

`.claude-plugin/types` lo genera Claude Code con los tipos del motor que usan el editor y los tests. No se sube al repositorio: la carpeta trae su propio `.gitignore`, que la excluye entera.
