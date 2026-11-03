// Chart labels for RelevoHub, in the words of someone who runs relevo.
export const readerActions = ["Goal", "Resume"];

const WORD = { starting: "arrancando", busy: "trabajando", crashed: "caído" };
const names = v => Object.keys(v.worker).sort();

function crew(v) {
	return names(v)
		.map(w => (v.held.includes(w) ? `${w} entregó (retenido)` : WORD[v.worker[w]] ? `${w} ${WORD[v.worker[w]]}` : null))
		.filter(Boolean)
		.join(", ");
}

export function state(v) {
	if (v.planner === "idle") return "Sin objetivo";
	if (v.planner === "done") return "Terminado";
	if (v.planner === "paused") return `En pausa: ${v.round} rondas, el límite`;
	if (v.planner === "planning") return v.round === 0 ? "Planificando" : `Decidiendo con todos los informes · ronda ${v.round}`;

	return `Esperando · ${crew(v)}`;
}

export function group(v) {
	return { idle: "Sin objetivo", planning: "La planificadora decide", waiting: "Los workers trabajan", paused: "En pausa", done: "Terminado" }[v.planner];
}
export const groupColors = {
	"Sin objetivo": "#eef0f3",
	"La planificadora decide": "#e4dcff",
	"Los workers trabajan": "#d9f2e6",
	"En pausa": "#fff1cc",
	Terminado: "#dbeafe",
};

const changed = (before, after) => names(after).filter(w => before.worker[w] !== after.worker[w]);

export function step(action, before, after) {
	const ws = changed(before, after);
	const who = ws.join(" y ");
	switch (action) {
		case "Goal":
			return "/relevo goal";
		case "Dispatch": {
			const fresh = ws.filter(w => after.worker[w] === "starting");
			const sent = ws.filter(w => after.worker[w] === "busy");
			return [
				sent.length ? `reparte a ${sent.join(" y ")}` : null,
				fresh.length ? `abre ${fresh.join(" y ")} en Herdr` : null,
			].filter(Boolean).join("; ");
		}
		case "Link":
			return `${who} se enlaza y recibe su paso`;
		case "HoldReport":
			return `informa ${who}; se retiene`;
		case "LastReport":
			return `informa ${who}, el último: todos juntos`;
		case "Crash":
			return `${who} muere o no se une`;
		case "Resume":
			return "/relevo resume tras el aviso";
		case "Cap":
			return "agota las rondas";
		case "Finish":
			return "escribe done: objetivo cumplido";
	}
	return action;
}

export function cause() {
	return "la planificadora reparte a dos workers a la vez, lee sus informes juntos y termina";
}

export const legend = { works: "Cumple las reglas", wrong: "Rompe una regla", mixed: "Meta alcanzada" };
