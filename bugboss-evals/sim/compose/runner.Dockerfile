# The fan-out runner: the sim image plus the scenarios, which the sim image
# deliberately leaves out. It drives the host's docker daemon through the
# mounted socket, so every run gets the same compose stack as a local run.
ARG SIM_IMAGE
FROM ${SIM_IMAGE}
COPY bugboss-evals/scenarios /app/bugboss-evals/scenarios
ENTRYPOINT []
