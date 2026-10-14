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

{{/* Accounts' https origin; it is written verbatim into nginx's /config.json. */}}
{{- define "studio-web.accountsUrl" -}}
{{- if not (regexMatch "^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$" .Values.accountsUrl) -}}
{{- fail (printf "accountsUrl must be an https origin with no path, e.g. https://accounts.telo.run (got %q)" .Values.accountsUrl) -}}
{{- end -}}
{{ .Values.accountsUrl }}
{{- end -}}

{{/* By digest when one is given, else by tag — the chart's appVersion unless overridden. */}}
{{- define "studio-web.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
{{- end -}}
