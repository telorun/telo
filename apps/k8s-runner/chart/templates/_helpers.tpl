{{/* The name every object this chart creates is derived from — a LITERAL, never
     `.Chart.Name`. The two are deliberately allowed to differ: the chart is named
     `k8s-runner` (after the component and its image, `telorun/k8s-runner`), while
     the objects keep `telo-k8s-runner` because that string is also the runner's
     default `RUNNER_MANAGED_BY`, which is the label selector its orphan reaper
     and the session NetworkPolicy match on. Deriving this from the chart name
     would make renaming the chart silently strand every pod a previous version
     created. */}}
{{- define "k8s-runner.name" -}}
telo-k8s-runner
{{- end -}}

{{- define "k8s-runner.labels" -}}
app.kubernetes.io/name: {{ include "k8s-runner.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "k8s-runner.selfUrl" -}}
http://{{ include "k8s-runner.name" . }}.{{ .Values.runnerNamespace }}.svc:{{ .Values.runner.port }}
{{- end -}}

{{/* Per-session ingress TLS Secret name (in the session namespace): chart-created
     from sessionRouting.ingress.tls.cert + .key, else an operator-managed
     sessionRouting.ingress.tls.secretName. Empty when no origin cert is configured.

     INGRESS ONLY. Under Gateway API the origin certificate belongs to the
     Gateway listener's own certificateRefs, so this stays empty there and the
     runner refuses the combination at boot rather than presenting no cert and
     calling it configured. A named gateway counts under `auto` too — that is the
     DEFAULT mode, and it is where a Gateway wins the layer, so testing the mode
     alone would leave the common configuration silently un-TLS'd. */}}
{{- define "k8s-runner.sessionIngressTlsSecretName" -}}
{{- if or (eq .Values.sessionRouting.mode "gateway") (and .Values.sessionRouting.gateway.name (ne .Values.sessionRouting.mode "ingress")) -}}
{{- else if and .Values.sessionRouting.ingress.tls.cert .Values.sessionRouting.ingress.tls.key -}}
{{ include "k8s-runner.name" . }}-ingress-tls
{{- else if .Values.sessionRouting.ingress.tls.secretName -}}
{{ .Values.sessionRouting.ingress.tls.secretName }}
{{- end -}}
{{- end -}}
