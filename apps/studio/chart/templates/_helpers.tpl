{{- define "studio-web.name" -}}
telo-studio-web
{{- end -}}

{{- define "studio-web.selectorLabels" -}}
app.kubernetes.io/name: {{ include "studio-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "studio-web.labels" -}}
{{ include "studio-web.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* By digest when one is given, else by tag — the chart's appVersion unless overridden. */}}
{{- define "studio-web.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
{{- end -}}
