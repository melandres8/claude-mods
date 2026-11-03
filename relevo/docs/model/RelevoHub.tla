---- MODULE RelevoHub ----
\* relevo 0.3: a planner session hands steps to named workers, starts the
\* ones it lacks in Herdr, runs them in parallel and reads their reports
\* together. register.tsx is the code; each action names the hook it models.
EXTENDS Naturals, FiniteSets

CONSTANTS Workers, MaxRounds

\* together: some planner turn read two or more reports at once.
VARIABLES planner, worker, round, held, together

vars == <<planner, worker, round, held, together>>

PlannerStates == {"idle", "planning", "waiting", "paused", "done"}
WorkerStates == {"absent", "starting", "idle", "busy", "crashed"}

TypeOK ==
  /\ planner \in PlannerStates
  /\ worker \in [Workers -> WorkerStates]
  /\ round \in 0..MaxRounds
  /\ held \subseteq Workers
  /\ together \in BOOLEAN

\* Workers the planner still waits on: given work, not yet answered. A dead
\* one still counts: nothing tells the planner (isBusy stays set).
Pending == {w \in Workers : worker[w] \in {"starting", "busy", "crashed"}}

Init ==
  /\ planner = "idle"
  /\ worker = [w \in Workers |-> "absent"]
  /\ round = 0
  /\ held = {}
  /\ together = FALSE

\* The person runs /relevo goal (startGoal).
Goal ==
  /\ planner = "idle"
  /\ planner' = "planning"
  /\ UNCHANGED <<worker, round, held, together>>

\* The planner's turn ends with one <handoff to="..."> per worker in S
\* (turn.complete -> dispatch): one round however many workers it feeds.
\* A worker it lacks is started in Herdr (spawnWorker); the rest get it now.
Dispatch ==
  /\ planner = "planning"
  /\ round < MaxRounds
  /\ \E S \in SUBSET {w \in Workers : worker[w] \in {"absent", "idle"}} :
       /\ S # {}
       /\ worker' = [w \in Workers |->
                       IF w \in S
                       THEN IF worker[w] = "absent" THEN "starting" ELSE "busy"
                       ELSE worker[w]]
  /\ round' = round + 1
  /\ planner' = "waiting"
  /\ UNCHANGED <<held, together>>

\* The started worker's /relevo join asks back from the session id the
\* planner chose; the planner links it and sends its held step (answerLink,
\* flush).
Link(w) ==
  /\ worker[w] = "starting"
  /\ worker' = [worker EXCEPT ![w] = "busy"]
  /\ UNCHANGED <<planner, round, held, together>>

\* A report while another worker still works is held (session.receive).
HoldReport(w) ==
  /\ planner = "waiting"
  /\ worker[w] = "busy"
  /\ Pending \ {w} # {}
  /\ worker' = [worker EXCEPT ![w] = "idle"]
  /\ held' = held \cup {w}
  /\ UNCHANGED <<planner, round, together>>

\* The last report brings every held one in one planner turn.
LastReport(w) ==
  /\ planner = "waiting"
  /\ worker[w] = "busy"
  /\ Pending \ {w} = {}
  /\ worker' = [worker EXCEPT ![w] = "idle"]
  /\ held' = {}
  /\ planner' = "planning"
  /\ together' = (together \/ held # {})
  /\ UNCHANGED round

\* A worker dies or never joins (the person closes it, relevo is not loaded).
Crash(w) ==
  /\ worker[w] \in {"starting", "busy"}
  /\ worker' = [worker EXCEPT ![w] = "crashed"]
  /\ UNCHANGED <<planner, round, held, together>>

\* The 90 s watchdog, or the person's /relevo resume, gives up on the
\* workers that never answered and hands the held reports over
\* (resumeRelay): a dead worker can be started again next round.
Resume ==
  /\ planner = "waiting"
  /\ \E w \in Workers : worker[w] = "crashed"
  /\ worker' = [w \in Workers |->
                  CASE worker[w] = "crashed" -> "absent"
                    [] worker[w] = "starting" -> "absent"
                    [] worker[w] = "busy" -> "idle"
                    [] OTHER -> worker[w]]
  /\ held' = {}
  /\ planner' = "planning"
  /\ UNCHANGED <<round, together>>

\* At maxRounds relevo pauses instead of sending (dispatch's cap).
Cap ==
  /\ planner = "planning"
  /\ round = MaxRounds
  /\ planner' = "paused"
  /\ UNCHANGED <<worker, round, held, together>>

\* The planner writes <done>.
Finish ==
  /\ planner = "planning"
  /\ planner' = "done"
  /\ UNCHANGED <<worker, round, held, together>>

Next ==
  \/ Goal
  \/ Dispatch
  \/ \E w \in Workers : Link(w)
  \/ \E w \in Workers : HoldReport(w)
  \/ \E w \in Workers : LastReport(w)
  \/ \E w \in Workers : Crash(w)
  \/ Resume
  \/ Cap
  \/ Finish

Spec == Init /\ [][Next]_vars

\* The planner never decides while a worker it gave work to is still working.
DecidesWithEveryReport == planner = "planning" => Pending = {}

\* A report is held only while the planner waits for the others.
HeldOnlyWhileWaiting == held # {} => planner = "waiting"

\* No planner turn ever goes past maxRounds.
RoundsCapped == round <= MaxRounds

\* Goal: the relay can finish after reading two workers' reports together.
\* Checked as "never", expected broken: the path that breaks it is the way there.
NeverFinishesInParallel == ~(planner = "done" /\ together)
====
