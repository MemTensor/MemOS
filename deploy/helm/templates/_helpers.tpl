{{- define "memos.name" -}}
memos
{{- end }}

{{- define "memos.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "memos.labels" -}}
app.kubernetes.io/name: {{ include "memos.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
{{- end }}

{{- define "memos.neo4j.fullname" -}}
{{- printf "%s-neo4j" (include "memos.fullname" .) }}
{{- end }}

{{- define "memos.qdrant.fullname" -}}
{{- printf "%s-qdrant" (include "memos.fullname" .) }}
{{- end }}

{{- define "memos.memos.fullname" -}}
{{- printf "%s-api" (include "memos.fullname" .) }}
{{- end }}
