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

{{/* The runner's own image: the runner container runs it, and every session
     pod's `supervisor` init container copies the session supervisor out of it. */}}
{{- define "k8s-runner.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
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

{{/* A Kubernetes quantity (plain, m, k/K/M/G/T/P/E, Ki..Ei) as a number, so two
     can be compared; empty for any other spelling (the runner refuses it at boot). */}}
{{- define "k8s-runner.quantityValue" -}}
{{- $q := toString . -}}
{{- if regexMatch "^[0-9]+(\\.[0-9]+)?(m|[KMGTPE]i?|k)?$" $q -}}
{{- $number := float64 (regexFind "^[0-9]+(\\.[0-9]+)?" $q) -}}
{{- $suffix := regexReplaceAll "^[0-9.]+" $q "" -}}
{{- $scale := dict "" 1.0 "m" 0.001 "k" 1000.0 "K" 1000.0 "M" 1000000.0 "G" 1000000000.0 "T" 1000000000000.0 "P" 1000000000000000.0 "E" 1000000000000000000.0 "Ki" 1024.0 "Mi" 1048576.0 "Gi" 1073741824.0 "Ti" 1099511627776.0 "Pi" 1125899906842624.0 "Ei" 1152921504606846976.0 -}}
{{- printf "%.6f" (mulf $number (index $scale $suffix)) -}}
{{- end -}}
{{- end -}}
