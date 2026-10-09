# Restricted interface calibration: failed submission

2026-10-09; official dsh Desktop 0.2.0-rc.2, Saker 0.4.96. An explicitly installed private development addon mounted two local exercise tools in a synthetic workspace. The addon was removed through the official command before the 0.4.97 product update. It is excluded from every product package.

The run used 19 local exercise HTTP requests and seven main model calls (143,953 recorded tokens including cache reads). The lab observed the intended private-object effect and valid controls, but the submitted finding referenced an evidence ID absent from the root submission list. The independent grader therefore returned `independentSuccess=false` and `falseConfirmed=1`. This result is preserved as a failure, not regraded after changing the interface.

The private controller elapsed duration included a polling gap; it is null in this sanitized record. No calibrated hard token reservation, repeated fair comparison or holdout run was completed. Only interface v1 was Desktop-tested; interface v2, plain-preset selection and controller timing fixes remain development work. These records prove neither a success rate nor an improvement over a plain Agent.
