{{- define "telo-k8s-runner.name" -}}
telo-k8s-runner
{{- end -}}

{{- define "telo-k8s-runner.labels" -}}
app.kubernetes.io/name: {{ include "telo-k8s-runner.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "telo-k8s-runner.selfUrl" -}}
http://{{ include "telo-k8s-runner.name" . }}.{{ .Values.runnerNamespace }}.svc:{{ .Values.runner.port }}
{{- end -}}
