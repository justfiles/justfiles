# Dictionary — design

Dictionary has one state machine and two clients: its GUI and the JustFiles agent.

The public `lookup` procedure accepts only a word or short term. It uses the AI capability with the
learning context, then commits one bounded dictionary entry. The state stores the submitted term, the
last entry, its result status, and a request token that blocks a slow old result from replacing a newer
one.

The GUI keeps typing and in-flight state local. It renders model text as text nodes, so model output
cannot become HTML.
