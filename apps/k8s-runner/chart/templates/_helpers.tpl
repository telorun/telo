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
     from sessionIngress.tls.cert + sessionIngress.tls.key, else an operator-managed
     sessionIngress.tls.secretName. Empty when no origin cert is configured. */}}
{{- define "k8s-runner.sessionIngressTlsSecretName" -}}
{{- if and .Values.sessionIngress.tls.cert .Values.sessionIngress.tls.key -}}
{{ include "k8s-runner.name" . }}-ingress-tls
{{- else if .Values.sessionIngress.tls.secretName -}}
{{ .Values.sessionIngress.tls.secretName }}
{{- end -}}
{{- end -}}
