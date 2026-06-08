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

{{/* In-cluster registry Service host:port (only meaningful when registry.enabled). */}}
{{- define "telo-k8s-runner.registryHost" -}}
{{ include "telo-k8s-runner.name" . }}-registry.{{ .Values.runnerNamespace }}.svc.cluster.local:{{ .Values.registry.port }}
{{- end -}}

{{/* Image repository for per-app builds: explicit build.repository wins, else
     derive from the in-cluster registry. Empty when neither is configured. */}}
{{- define "telo-k8s-runner.imageRepository" -}}
{{- if .Values.build.repository -}}
{{ .Values.build.repository }}
{{- else if .Values.registry.enabled -}}
{{ include "telo-k8s-runner.registryHost" . }}/telo-sessions
{{- end -}}
{{- end -}}

{{/* Registry HTTP(S) base for the existence check: explicit value wins, else
     derive from the in-cluster registry. Empty when neither is configured. */}}
{{- define "telo-k8s-runner.registryApiUrl" -}}
{{- if .Values.build.registryApiUrl -}}
{{ .Values.build.registryApiUrl }}
{{- else if .Values.registry.enabled -}}
http://{{ include "telo-k8s-runner.registryHost" . }}
{{- end -}}
{{- end -}}

{{/* Push-secret name (in the build namespace): chart-created from
     registry.dockerconfigjson, else an operator-managed build.pushSecretName.
     Empty when the registry needs no auth. */}}
{{- define "telo-k8s-runner.pushSecretName" -}}
{{- if .Values.registry.dockerconfigjson -}}
{{ include "telo-k8s-runner.name" . }}-registry-push
{{- else if .Values.build.pushSecretName -}}
{{ .Values.build.pushSecretName }}
{{- end -}}
{{- end -}}

{{/* Pull-secret name (in the session namespace): chart-created from
     registry.dockerconfigjson, else an operator-managed build.pullSecretName.
     Empty when the registry needs no auth. */}}
{{- define "telo-k8s-runner.pullSecretName" -}}
{{- if .Values.registry.dockerconfigjson -}}
{{ include "telo-k8s-runner.name" . }}-registry-pull
{{- else if .Values.build.pullSecretName -}}
{{ .Values.build.pullSecretName }}
{{- end -}}
{{- end -}}
