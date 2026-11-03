## 1. Terminado

Rule broken: Goal: the relay can finish after reading two workers' reports together. Checked as "never", expected broken: the path that breaks it is the way there.
Why: la planificadora reparte a dos workers a la vez, lee sus informes juntos y termina.
In the model, one step leads into this bug: "escribe done: objetivo cumplido". The steps below are the shortest path that TLC found.

0. Start: Sin objetivo
1. /relevo goal. Now: Planificando
2. Abre builder y researcher en Herdr. Now: Esperando · builder arrancando, researcher arrancando
3. Researcher se enlaza y recibe su paso. Now: Esperando · builder arrancando, researcher trabajando
4. Builder se enlaza y recibe su paso. Now: Esperando · builder trabajando, researcher trabajando
5. Informa researcher; se retiene. Now: Esperando · builder trabajando, researcher entregó (retenido)
6. Informa builder, el último: todos juntos. Now: Decidiendo con todos los informes · ronda 1
7. Escribe done: objetivo cumplido. Now: Terminado
