# claude-mods

Mods for [Claude Code](https://claude.com/claude-code) by Melkin Mosquera. Each mod is a Claude Code plugin with hooks and a panel in the terminal.

| Mod | What it does |
|---|---|
| [relevo](relevo/) | Links two local Claude Code sessions: one plans, the other builds. They pass the work back and forth with `<handoff>` blocks until the goal is done, `maxRounds` is reached, or you pause them. |
| [decision-tree](decision-tree/) | Turns Claude's closing question, or its `AskUserQuestion` call, into a side panel: each option with what it implies, and a read-only forked session to try an answer before you confirm it. |

## Install

```
claude plugin marketplace add melandres8/claude-mods
claude plugin install relevo@claude-mods
claude plugin install decision-tree@claude-mods
```

Each mod's README (in Spanish) explains its commands, its protections, and how to develop it.

## Develop

From a mod folder:

```
claude plugin validate .
claude plugin test .
```

Claude Code generates `.claude-plugin/types/` with the engine types when it loads a mod. The folder is not committed.

---

**Español.** Mods de Claude Code: [relevo](relevo/) conecta dos sesiones (una planifica y la otra construye) y [decision-tree](decision-tree/) convierte la pregunta final de Claude en un panel con las opciones, lo que implica cada una y una rama de prueba de solo lectura. Instálalos con los comandos de arriba. Cada mod tiene su README en español.

## License

[MIT](LICENSE)
